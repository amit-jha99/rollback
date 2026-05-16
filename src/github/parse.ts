/**
 * GitHub repo reference parsing.
 *
 * Lives in its own file with zero runtime dependencies so it can be unit-tested
 * without pulling in the (ESM-only) @octokit/rest package.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * Parse "owner/name" into structured parts.
 * Throws on malformed input (empty, missing slash, multiple slashes, internal whitespace).
 */
export function parseRepo(input: string): RepoRef {
  const m = input.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) {
    throw new Error(`Invalid repo "${input}". Expected format: owner/name.`);
  }
  return { owner: m[1], repo: m[2] };
}
