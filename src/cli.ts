#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import { printWelcome, ROLLBACK_VERSION } from './utils/helpers';
import { runReview, type ReviewMode } from './review';
import { CONFIG_FILENAME, loadConfig, writeStarterConfig } from './rules/rules';

/**
 * Build and run the Rollback CLI.
 * Shows the welcome banner first, then dispatches to subcommands.
 */
async function main(): Promise<void> {
  printWelcome();

  const program = new Command();

  program
    .name('rollback')
    .description('AI-powered code reviewer that catches what humans miss')
    .version(ROLLBACK_VERSION, '-v, --version', 'show CLI version');

  program
    .command('review')
    .description('review a diff with NVIDIA Llama 3.3 70B')
    .option('--diff <path>', 'path to a unified diff file (defaults to `git diff HEAD`)')
    .option('--pr <number>', 'GitHub pull request number to review')
    .option('--repo <owner/name>', 'GitHub repo in owner/name form (required with --pr)')
    .option('--post', 'post the review back to the PR as comments + risk label (requires --pr)')
    .option('--mode <mode>', 'review mode: strict | balanced | mentor (overrides config)')
    .action(async (opts: { diff?: string; pr?: string; repo?: string; post?: boolean; mode?: string }) => {
      const allowedModes: ReviewMode[] = ['strict', 'balanced', 'mentor'];
      let mode: ReviewMode | undefined;
      if (opts.mode !== undefined) {
        if (!allowedModes.includes(opts.mode as ReviewMode)) {
          throw new Error(`Unknown mode "${opts.mode}". Use one of: ${allowedModes.join(', ')}.`);
        }
        mode = opts.mode as ReviewMode;
      }
      const prNumber = opts.pr !== undefined ? Number(opts.pr) : undefined;
      if (prNumber !== undefined && !Number.isInteger(prNumber)) {
        throw new Error(`--pr must be an integer, got "${opts.pr}".`);
      }
      if (opts.post && prNumber === undefined) {
        throw new Error('--post requires --pr <number> and --repo <owner/name>.');
      }
      await runReview({
        diffPath: opts.diff,
        prNumber,
        repo: opts.repo,
        post: opts.post,
        mode,
      });
    });

  program
    .command('init')
    .description(`create a ${CONFIG_FILENAME} config file in the current directory`)
    .action(async () => {
      console.log(chalk.gray('\n→ rollback init'));
      const path = await writeStarterConfig();
      console.log(chalk.green(`  ✓ Wrote ${path}`));
      console.log(chalk.gray('    Edit the file to add your project-specific rules, mode, and ignore patterns.'));
    });

  program
    .command('status')
    .description('show rollback configuration and provider status')
    .action(async () => {
      const config = await loadConfig();
      const hasKey = Boolean(process.env.NVIDIA_API_KEY);
      const hasGitHub = Boolean(process.env.GITHUB_TOKEN);

      console.log(chalk.bold('\n  Version:  ') + ROLLBACK_VERSION);
      console.log(chalk.bold('  Provider: ') + chalk.cyan('NVIDIA (meta/llama-3.3-70b-instruct)'));
      console.log(chalk.bold('  NVIDIA_API_KEY: ') + (hasKey ? chalk.green('set') : chalk.red('missing')));
      console.log(chalk.bold('  GITHUB_TOKEN:   ') + (hasGitHub ? chalk.green('set') : chalk.gray('not set (only needed for --pr)')));

      if (config) {
        console.log(chalk.bold('\n  .rollback.yml:'));
        console.log(`    rules:  ${config.rules.length}`);
        console.log(`    mode:   ${config.mode ?? 'balanced (default)'}`);
        console.log(`    ignore: ${config.ignore.length} pattern${config.ignore.length === 1 ? '' : 's'}`);
      } else {
        console.log(chalk.gray('\n  No .rollback.yml in current directory. Run `rollback init` to create one.'));
      }
    });

  program
    .command('help')
    .description('show all commands')
    .action(() => {
      program.help();
    });

  // No args - show help (after the banner)
  if (process.argv.length <= 2) {
    program.help();
  }

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`\n✖ rollback: ${message}`));
  process.exit(1);
});
