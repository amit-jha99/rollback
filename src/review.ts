import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { reviewDiff } from './ai/nvidia';
import { formatRisk } from './utils/helpers';
import { createGitHubClient, fetchPRDiff, parseRepo, postReview } from './github/github';
import { buildRulesInstruction, filterDiffByIgnore, loadConfig } from './rules/rules';

const execFileAsync = promisify(execFile);

export type ReviewMode = 'strict' | 'balanced' | 'mentor';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface ReviewFinding {
  file?: string;
  line: number;
  description: string;
  fix: string;
}

export interface ReviewResult {
  score: number;
  riskLevel: RiskLevel;
  bugs: ReviewFinding[];
  security: ReviewFinding[];
  quality: ReviewFinding[];
  summary: string;
  approved: boolean;
}

export interface RunReviewOptions {
  diffPath?: string;
  /** GitHub PR number to fetch the diff from. Requires `repo` and GITHUB_TOKEN. */
  prNumber?: number;
  /** GitHub repo in owner/name form. Required when `prNumber` is set. */
  repo?: string;
  /** When true, post the review back to the GitHub PR (comments + label). */
  post?: boolean;
  /** Mode override; if undefined, config.mode (then "balanced") is used. */
  mode?: ReviewMode;
  cwd?: string;
}

/**
 * Load a unified diff from the best available source:
 *   1. GitHub PR (if --pr and --repo given)
 *   2. Local file path
 *   3. `git diff HEAD` in cwd
 */
async function loadDiff(opts: RunReviewOptions): Promise<string> {
  if (opts.prNumber !== undefined) {
    if (!opts.repo) {
      throw new Error('--pr requires --repo <owner/name>.');
    }
    const ref = parseRepo(opts.repo);
    const client = createGitHubClient();
    return await fetchPRDiff(client, ref, opts.prNumber);
  }
  if (opts.diffPath) {
    return await readFile(opts.diffPath, 'utf8');
  }
  try {
    const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], {
      cwd: opts.cwd ?? process.cwd(),
      maxBuffer: 50 * 1024 * 1024,
    });
    if (!stdout.trim()) {
      throw new Error('git diff HEAD is empty - no changes to review. Pass --diff <file> or make changes first.');
    }
    return stdout;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith('git diff HEAD is empty')) {
      throw err;
    }
    throw new Error(
      'Could not read a diff. Pass --diff <path-to-patch> or run from a git repo with uncommitted changes.',
    );
  }
}

/**
 * Print a single category of findings (bugs/security/quality) with color.
 */
function printFindings(label: string, findings: ReviewFinding[], color: (s: string) => string): void {
  if (findings.length === 0) {
    console.log(color(`\n  ✓ ${label}: none found`));
    return;
  }
  console.log(color(`\n  ${label} (${findings.length}):`));
  for (const f of findings) {
    const loc = f.file ? `${f.file}:${f.line}` : `line ${f.line}`;
    console.log(color(`    • ${loc}: ${f.description}`));
    console.log(chalk.gray(`        fix: ${f.fix}`));
  }
}

/**
 * Render a review result to the terminal.
 */
function printResult(result: ReviewResult): void {
  console.log(chalk.bold('\n  Score:    ') + chalk.cyan(`${result.score}/10`));
  console.log(chalk.bold('  Risk:     ') + formatRisk(result.riskLevel));
  console.log(chalk.bold('  Approved: ') + (result.approved ? chalk.green('yes') : chalk.red('no')));

  printFindings('Bugs', result.bugs, chalk.red);
  printFindings('Security', result.security, chalk.magenta);
  printFindings('Quality', result.quality, chalk.yellow);

  console.log(chalk.bold('\n  Summary:'));
  console.log(`    ${result.summary}`);
}

/**
 * Top-level entry point for the `rollback review` command.
 * Loads a diff, sends it to the AI provider, prints the structured review.
 */
export async function runReview(opts: RunReviewOptions): Promise<ReviewResult> {
  const cwd = opts.cwd ?? process.cwd();

  // Resolve config + mode precedence: CLI flag > config > "balanced".
  const config = await loadConfig(cwd);
  const mode: ReviewMode = opts.mode ?? config?.mode ?? 'balanced';

  if (config) {
    const ruleSummary = config.rules.length > 0 ? `${config.rules.length} rule${config.rules.length === 1 ? '' : 's'}` : 'no rules';
    const ignoreSummary = config.ignore.length > 0 ? `${config.ignore.length} ignore pattern${config.ignore.length === 1 ? '' : 's'}` : 'no ignore patterns';
    console.log(chalk.gray(`→ Loaded .rollback.yml: ${ruleSummary}, ${ignoreSummary}.`));
  }

  let source: string;
  if (opts.prNumber !== undefined) source = `PR #${opts.prNumber} on ${opts.repo}`;
  else if (opts.diffPath) source = opts.diffPath;
  else source = 'git diff HEAD';
  console.log(chalk.gray(`\n→ Loading diff from ${source}...`));

  let diff = await loadDiff(opts);
  const originalLines = diff.split('\n').length;

  if (config && config.ignore.length > 0) {
    diff = filterDiffByIgnore(diff, config.ignore);
    const filteredLines = diff.split('\n').length;
    if (filteredLines !== originalLines) {
      console.log(chalk.gray(`  Loaded ${originalLines} lines, ${filteredLines} after ignore patterns.`));
    } else {
      console.log(chalk.gray(`  Loaded ${originalLines} lines.`));
    }
  } else {
    console.log(chalk.gray(`  Loaded ${originalLines} lines.`));
  }

  if (!diff.trim()) {
    throw new Error('Diff is empty after applying ignore patterns. Nothing to review.');
  }

  console.log(chalk.gray(`→ Reviewing with NVIDIA (mode=${mode})...`));
  const rulesInstruction = buildRulesInstruction(config?.rules ?? []);
  const result = await reviewDiff(diff, mode, { rulesInstruction });

  printResult(result);

  if (opts.post && opts.prNumber !== undefined && opts.repo) {
    console.log(chalk.gray('\n→ Posting review to GitHub...'));
    const ref = parseRepo(opts.repo);
    const client = createGitHubClient();
    await postReview({ client, ref, prNumber: opts.prNumber, result });
    console.log(chalk.green('  ✓ Review posted to PR.'));
  }

  return result;
}
