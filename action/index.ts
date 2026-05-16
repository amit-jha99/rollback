#!/usr/bin/env node
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { runReview, type ReviewMode } from '../src/review';
import { printWelcome } from '../src/utils/helpers';

/**
 * Shape of the minimal GitHub `pull_request` event payload we read.
 * The full schema is much larger; we only need these fields.
 */
interface PullRequestEvent {
  pull_request?: { number?: number };
  number?: number;
  repository?: { full_name?: string };
}

/**
 * Read GITHUB_EVENT_PATH and pull out (pr_number, repo_full_name).
 * Throws if either is missing - the action cannot proceed without them.
 */
async function readEvent(): Promise<{ prNumber: number; repo: string }> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repoEnv = process.env.GITHUB_REPOSITORY;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is not set - is this running inside a GitHub Action?');
  }
  const raw = await readFile(eventPath, 'utf8');
  const event = JSON.parse(raw) as PullRequestEvent;

  const prNumber = event.pull_request?.number ?? event.number;
  if (typeof prNumber !== 'number') {
    throw new Error('Could not find a pull request number in the event payload. Ensure the workflow triggers on `pull_request`.');
  }

  const repo = repoEnv ?? event.repository?.full_name;
  if (!repo) {
    throw new Error('GITHUB_REPOSITORY is not set and not present in the event payload.');
  }

  return { prNumber, repo };
}

/**
 * Parse review mode from the ROLLBACK_MODE env var, defaulting to "balanced".
 */
function readMode(): ReviewMode {
  const raw = (process.env.ROLLBACK_MODE ?? 'balanced').toLowerCase();
  if (raw === 'strict' || raw === 'balanced' || raw === 'mentor') return raw;
  throw new Error(`Invalid ROLLBACK_MODE="${raw}". Use strict | balanced | mentor.`);
}

/**
 * GitHub Action entry point. Reads PR context from env, runs the review,
 * posts results back to the PR, and exits non-zero on high risk so the
 * workflow check fails visibly.
 */
async function main(): Promise<void> {
  printWelcome();

  const { prNumber, repo } = await readEvent();
  const mode = readMode();

  console.log(`\n→ Running Rollback action on ${repo} PR #${prNumber} (mode=${mode})`);

  const result = await runReview({
    prNumber,
    repo,
    post: true,
    mode,
  });

  // Fail the workflow check on high risk so reviewers can't miss it.
  if (result.riskLevel === 'high') {
    console.error('\n✖ High risk detected - failing the check.');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n✖ rollback action: ${message}`);
  process.exit(1);
});
