import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { minimatch } from 'minimatch';
import type { ReviewMode } from '../review';

export const CONFIG_FILENAME = '.rollback.yml';

export interface RollbackConfig {
  /** Plain-English review rules appended to the system prompt. */
  rules: string[];
  /** Default review mode when the user doesn't pass --mode. */
  mode?: ReviewMode;
  /** Glob patterns for files the model should not see. */
  ignore: string[];
}

const STARTER_CONFIG = `# Rollback config - written by \`rollback init\`
# Docs: https://github.com/

# Plain-English rules. The model treats each as a hard project requirement.
rules:
  - "Never hardcode API keys, tokens, or other secrets"
  - "All async functions must handle errors (try/catch or .catch)"
  - "No console.log statements in production code"
  - "User input must be validated before use in queries or commands"

# Default review mode: strict | balanced | mentor.
# Overridable per-invocation with --mode.
mode: balanced

# Files matching these globs are stripped from the diff before review.
ignore:
  - "*.test.ts"
  - "*.test.js"
  - "*.spec.ts"
  - "node_modules/**"
  - "dist/**"
  - "package-lock.json"
`;

const ALLOWED_MODES: ReviewMode[] = ['strict', 'balanced', 'mentor'];

/**
 * Load `.rollback.yml` from `cwd`. Returns `null` if no config exists.
 * Throws a descriptive error if the file is present but malformed.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<RollbackConfig | null> {
  const path = join(cwd, CONFIG_FILENAME);
  try {
    await access(path);
  } catch {
    return null;
  }

  let raw: unknown;
  try {
    const text = await readFile(path, 'utf8');
    raw = yamlLoad(text);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not parse ${CONFIG_FILENAME}: ${message}`);
  }

  return normalizeConfig(raw, path);
}

/**
 * Coerce raw YAML into a strict RollbackConfig. Unknown fields are ignored;
 * type mismatches throw so misconfiguration surfaces at load time, not review time.
 */
function normalizeConfig(raw: unknown, sourcePath: string): RollbackConfig {
  if (raw === null || raw === undefined) {
    return { rules: [], ignore: [] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    const got = Array.isArray(raw) ? 'list' : typeof raw;
    throw new Error(`${sourcePath}: top-level must be a mapping (got ${got}).`);
  }
  const r = raw as Record<string, unknown>;

  const rules = coerceStringList(r.rules, `${sourcePath}: rules`);
  const ignore = coerceStringList(r.ignore, `${sourcePath}: ignore`);

  let mode: ReviewMode | undefined;
  if (r.mode !== undefined && r.mode !== null) {
    if (typeof r.mode !== 'string' || !ALLOWED_MODES.includes(r.mode as ReviewMode)) {
      throw new Error(
        `${sourcePath}: mode must be one of ${ALLOWED_MODES.join(', ')} (got ${JSON.stringify(r.mode)}).`,
      );
    }
    mode = r.mode as ReviewMode;
  }

  return { rules, mode, ignore };
}

function coerceStringList(v: unknown, label: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new Error(`${label} must be a list of strings.`);
  }
  return v.map((item, i) => {
    if (typeof item !== 'string') {
      throw new Error(`${label}[${i}] must be a string (got ${typeof item}).`);
    }
    return item;
  });
}

/**
 * Drop diff hunks for files matching any ignore glob.
 * The unified diff is split on `diff --git a/<path> b/<path>` headers;
 * a hunk is kept only if its file path doesn't match any pattern.
 */
export function filterDiffByIgnore(diff: string, patterns: string[]): string {
  if (patterns.length === 0) return diff;

  const hunks = splitDiffIntoHunks(diff);
  const kept = hunks.filter((h) => !shouldIgnore(h.path, patterns));
  if (kept.length === hunks.length) return diff;

  return kept.map((h) => h.text).join('');
}

interface DiffHunk {
  path: string;
  text: string;
}

/**
 * Split a unified diff into per-file hunks. Each entry contains the raw text
 * (including the `diff --git` header) and the new-file path.
 */
function splitDiffIntoHunks(diff: string): DiffHunk[] {
  const lines = diff.split(/(?<=\n)/); // preserve newlines
  const hunks: DiffHunk[] = [];
  let current: { path: string; lines: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (m) {
      if (current) hunks.push({ path: current.path, text: current.lines.join('') });
      current = { path: m[2], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
    // Lines before the first `diff --git` header are dropped (e.g. git format-patch preamble).
  }
  if (current) hunks.push({ path: current.path, text: current.lines.join('') });
  return hunks;
}

function shouldIgnore(path: string, patterns: string[]): boolean {
  return patterns.some((p) => minimatch(path, p, { dot: true, matchBase: true }));
}

/**
 * Render the rules list as a system-prompt addendum so the model treats each
 * as a hard project requirement rather than a generic suggestion.
 */
export function buildRulesInstruction(rules: string[]): string {
  if (rules.length === 0) return '';
  const numbered = rules.map((r, i) => `  ${i + 1}. ${r}`).join('\n');
  return (
    'The user has configured the following project-specific rules. ' +
    'Treat each as a hard requirement and flag any violation under the appropriate category ' +
    '(bugs, security, or quality):\n' +
    numbered
  );
}

/**
 * Write the starter `.rollback.yml`. Errors if the file already exists.
 */
export async function writeStarterConfig(cwd: string = process.cwd()): Promise<string> {
  const path = join(cwd, CONFIG_FILENAME);
  try {
    await access(path);
    throw new Error(`${CONFIG_FILENAME} already exists. Remove it first or edit it directly.`);
  } catch (err: unknown) {
    // Re-throw the "already exists" error we just constructed.
    if (err instanceof Error && err.message.includes('already exists')) throw err;
    // Otherwise the file doesn't exist - proceed to write.
  }
  await writeFile(path, STARTER_CONFIG, 'utf8');
  return path;
}
