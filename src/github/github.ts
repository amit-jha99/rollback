import { Octokit } from '@octokit/rest';
import type { ReviewResult, ReviewFinding, RiskLevel } from '../review';
import { parseRepo, type RepoRef } from './parse';

export { parseRepo, type RepoRef };

const RISK_LABELS: Record<RiskLevel, { name: string; color: string; description: string }> = {
  low: { name: 'risk:low', color: '0e8a16', description: '🟢 Safe to merge' },
  medium: { name: 'risk:medium', color: 'fbca04', description: '🟡 Review carefully' },
  high: { name: 'risk:high', color: 'd73a4a', description: '🔴 Do not merge' },
};

/**
 * Create an authenticated Octokit client.
 * Reads GITHUB_TOKEN from env unless one is passed explicitly.
 */
export function createGitHubClient(token?: string): Octokit {
  const auth = token ?? process.env.GITHUB_TOKEN;
  if (!auth) {
    throw new Error('GITHUB_TOKEN is not set. Pass --token or export GITHUB_TOKEN.');
  }
  return new Octokit({ auth });
}

/**
 * Fetch a pull request's unified diff as text via the GitHub API.
 */
export async function fetchPRDiff(
  client: Octokit,
  ref: RepoRef,
  prNumber: number,
): Promise<string> {
  const response = await client.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: prNumber,
    mediaType: { format: 'diff' },
  });
  return response.data as unknown as string;
}

/**
 * Fetch the head commit SHA of a PR - needed when posting review comments
 * because GitHub anchors line comments to a specific commit.
 */
export async function fetchPRHeadSha(
  client: Octokit,
  ref: RepoRef,
  prNumber: number,
): Promise<string> {
  const response = await client.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: prNumber,
  });
  return response.data.head.sha;
}

/**
 * Format a finding as a markdown comment body.
 */
function formatComment(category: string, f: ReviewFinding): string {
  return `**🔁 Rollback — ${category}**\n\n${f.description}\n\n**Suggested fix:**\n${f.fix}`;
}

/**
 * Build the summary comment posted on the PR conversation.
 * Includes ungrouped findings (those without a file) so nothing is lost.
 */
function buildSummaryBody(result: ReviewResult, orphans: ReviewFinding[]): string {
  const riskEmoji = result.riskLevel === 'low' ? '🟢' : result.riskLevel === 'medium' ? '🟡' : '🔴';
  const totalFindings = result.bugs.length + result.security.length + result.quality.length;

  const lines: string[] = [];
  lines.push('## 🔁 Rollback Review');
  lines.push('');
  lines.push(`**Score:** ${result.score}/10  |  **Risk:** ${riskEmoji} ${result.riskLevel}  |  **Approved:** ${result.approved ? '✅' : '❌'}`);
  lines.push('');
  lines.push(`**Findings:** ${result.bugs.length} bug${result.bugs.length === 1 ? '' : 's'}, ${result.security.length} security, ${result.quality.length} quality (${totalFindings} total)`);
  lines.push('');
  lines.push('### Summary');
  lines.push(result.summary || '_(no summary provided)_');

  if (orphans.length > 0) {
    lines.push('');
    lines.push('### Additional findings (no inline location)');
    for (const f of orphans) {
      lines.push(`- **line ${f.line}:** ${f.description}`);
      lines.push(`  - _fix:_ ${f.fix}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push("_Reviewed by [Rollback](https://github.com/) — created by Amit Jha's Production_");
  return lines.join('\n');
}

export interface PostReviewOptions {
  client: Octokit;
  ref: RepoRef;
  prNumber: number;
  result: ReviewResult;
}

/**
 * Post a structured review to the PR:
 *   1. A pull-request review with inline comments where file+line are known.
 *   2. A summary issue comment with the score, risk, and orphan findings.
 *   3. The appropriate risk:* label (creating it if missing).
 */
export async function postReview(opts: PostReviewOptions): Promise<void> {
  const { client, ref, prNumber, result } = opts;

  const commit_id = await fetchPRHeadSha(client, ref, prNumber);

  type AnnotatedFinding = ReviewFinding & { category: string };
  const allFindings: AnnotatedFinding[] = [
    ...result.bugs.map((f) => ({ ...f, category: 'Bug' })),
    ...result.security.map((f) => ({ ...f, category: 'Security' })),
    ...result.quality.map((f) => ({ ...f, category: 'Quality' })),
  ];

  const inline = allFindings.filter((f): f is AnnotatedFinding & { file: string } =>
    typeof f.file === 'string' && f.line > 0,
  );
  const orphans = allFindings.filter((f) => !(typeof f.file === 'string') || f.line <= 0);

  // 1. Inline review (only if we have anchored findings).
  if (inline.length > 0) {
    try {
      await client.pulls.createReview({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: prNumber,
        commit_id,
        event: 'COMMENT',
        comments: inline.map((f) => ({
          path: f.file,
          line: f.line,
          side: 'RIGHT',
          body: formatComment(f.category, f),
        })),
      });
    } catch (err: unknown) {
      // If any comment fails to anchor (e.g., line not in diff), fall back to a
      // single review with the orphans + the failed comments rolled into summary.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: inline review failed (${message}); folding into summary.`);
      orphans.push(...inline);
    }
  }

  // 2. Summary issue comment.
  await client.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: prNumber,
    body: buildSummaryBody(result, orphans),
  });

  // 3. Risk label.
  await ensureLabelAndApply(client, ref, prNumber, result.riskLevel);
}

/**
 * Create the risk label if it doesn't exist, then apply it to the PR.
 * Removes prior risk:* labels so only the current level is set.
 */
async function ensureLabelAndApply(
  client: Octokit,
  ref: RepoRef,
  prNumber: number,
  level: RiskLevel,
): Promise<void> {
  const spec = RISK_LABELS[level];

  try {
    await client.issues.createLabel({
      owner: ref.owner,
      repo: ref.repo,
      ...spec,
    });
  } catch (err: unknown) {
    // 422 = already exists; ignore. Anything else, bubble up.
    if (err instanceof Error && !err.message.includes('already_exists') && !err.message.includes('422')) {
      throw err;
    }
  }

  // Strip any existing risk:* labels to keep state clean.
  for (const other of Object.values(RISK_LABELS)) {
    if (other.name === spec.name) continue;
    try {
      await client.issues.removeLabel({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: prNumber,
        name: other.name,
      });
    } catch {
      // Label wasn't present; ignore.
    }
  }

  await client.issues.addLabels({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: prNumber,
    labels: [spec.name],
  });
}
