import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  filterDiffByIgnore,
  buildRulesInstruction,
  writeStarterConfig,
  CONFIG_FILENAME,
} from '../src/rules/rules';

async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'rollback-rules-'));
}

async function writeConfig(dir: string, yaml: string): Promise<void> {
  await writeFile(join(dir, CONFIG_FILENAME), yaml, 'utf8');
}

const SAMPLE_DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  '@@ -1 +1,2 @@',
  '+const KEY = "secret";',
  ' export {};',
  'diff --git a/src/auth.test.ts b/src/auth.test.ts',
  '@@ -1 +1,2 @@',
  '+test("x", () => {});',
  ' export {};',
  'diff --git a/dist/bundle.js b/dist/bundle.js',
  '@@ -1 +1,2 @@',
  '+"use strict";',
  ' module.exports = {};',
  '',
].join('\n');

describe('loadConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when no config file exists', async () => {
    expect(await loadConfig(dir)).toBeNull();
  });

  it('parses a valid config with all fields', async () => {
    await writeConfig(
      dir,
      'rules:\n  - "No console.log"\n  - "Validate input"\nmode: strict\nignore:\n  - "*.test.ts"\n',
    );
    const config = await loadConfig(dir);
    expect(config).toEqual({
      rules: ['No console.log', 'Validate input'],
      mode: 'strict',
      ignore: ['*.test.ts'],
    });
  });

  it('treats an empty file as empty config', async () => {
    await writeConfig(dir, '');
    expect(await loadConfig(dir)).toEqual({ rules: [], ignore: [] });
  });

  it('throws on malformed YAML', async () => {
    await writeConfig(dir, 'rules: [\n  - unterminated\n');
    await expect(loadConfig(dir)).rejects.toThrow(/Could not parse \.rollback\.yml/);
  });

  it('throws on invalid mode value', async () => {
    await writeConfig(dir, 'mode: chaotic\n');
    await expect(loadConfig(dir)).rejects.toThrow(/mode must be one of/);
  });

  it('throws when rules contains a non-string', async () => {
    await writeConfig(dir, 'rules:\n  - "ok"\n  - 42\n');
    await expect(loadConfig(dir)).rejects.toThrow(/rules\[1\] must be a string/);
  });

  it('throws when top-level is not a mapping', async () => {
    await writeConfig(dir, '- just\n- a\n- list\n');
    await expect(loadConfig(dir)).rejects.toThrow(/top-level must be a mapping/);
  });

  it('accepts config with only rules (mode/ignore omitted)', async () => {
    await writeConfig(dir, 'rules:\n  - "Use TypeScript"\n');
    const config = await loadConfig(dir);
    expect(config?.rules).toEqual(['Use TypeScript']);
    expect(config?.mode).toBeUndefined();
    expect(config?.ignore).toEqual([]);
  });
});

describe('filterDiffByIgnore', () => {
  it('passes diff through unchanged when no patterns', () => {
    expect(filterDiffByIgnore(SAMPLE_DIFF, [])).toBe(SAMPLE_DIFF);
  });

  it('strips files matching *.test.ts', () => {
    const filtered = filterDiffByIgnore(SAMPLE_DIFF, ['*.test.ts']);
    expect(filtered).toContain('src/auth.ts');
    expect(filtered).not.toContain('src/auth.test.ts');
    expect(filtered).toContain('dist/bundle.js');
  });

  it('strips files matching dist/**', () => {
    const filtered = filterDiffByIgnore(SAMPLE_DIFF, ['dist/**']);
    expect(filtered).toContain('src/auth.ts');
    expect(filtered).not.toContain('dist/bundle.js');
  });

  it('strips multiple pattern matches', () => {
    const filtered = filterDiffByIgnore(SAMPLE_DIFF, ['*.test.ts', 'dist/**']);
    expect(filtered).toContain('src/auth.ts');
    expect(filtered).not.toContain('src/auth.test.ts');
    expect(filtered).not.toContain('dist/bundle.js');
  });

  it('returns empty when every file is ignored', () => {
    const filtered = filterDiffByIgnore(SAMPLE_DIFF, ['**']);
    expect(filtered.trim()).toBe('');
  });

  it('handles a diff with a single file', () => {
    const single = 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
    expect(filterDiffByIgnore(single, ['*.ts'])).toBe('');
    expect(filterDiffByIgnore(single, ['*.py'])).toBe(single);
  });
});

describe('buildRulesInstruction', () => {
  it('returns empty string for empty rules', () => {
    expect(buildRulesInstruction([])).toBe('');
  });

  it('numbers each rule and includes the source text', () => {
    const out = buildRulesInstruction(['First rule', 'Second rule']);
    expect(out).toContain('1. First rule');
    expect(out).toContain('2. Second rule');
    expect(out).toContain('hard requirement');
  });
});

describe('writeStarterConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a config file that loadConfig can read back', async () => {
    const path = await writeStarterConfig(dir);
    expect(path).toBe(join(dir, CONFIG_FILENAME));
    const content = await readFile(path, 'utf8');
    expect(content).toContain('rules:');
    expect(content).toContain('mode:');
    expect(content).toContain('ignore:');

    const config = await loadConfig(dir);
    expect(config?.rules.length).toBeGreaterThan(0);
    expect(config?.mode).toBe('balanced');
    expect(config?.ignore.length).toBeGreaterThan(0);
  });

  it('refuses to overwrite an existing file', async () => {
    await writeStarterConfig(dir);
    await expect(writeStarterConfig(dir)).rejects.toThrow(/already exists/);
  });
});
