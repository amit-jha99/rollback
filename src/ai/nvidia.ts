import OpenAI from 'openai';
import Bottleneck from 'bottleneck';
import chalk from 'chalk';
import type { ReviewMode, ReviewResult, RiskLevel, ReviewFinding } from '../review';

const MODEL = 'meta/llama-3.3-70b-instruct';
const BASE_URL = 'https://integrate.api.nvidia.com/v1';
const MAX_TOKENS = 2048;
const TEMPERATURE = 0.2;

// NVIDIA's free tier allows 40 calls/minute. minTime: 1500ms = exactly 40/min.
// maxConcurrent: 1 ensures we never overlap requests even if a caller fires
// reviews in parallel.
const RATE_LIMIT_MIN_MS = 1500;
const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: RATE_LIMIT_MIN_MS,
});

const BASE_SYSTEM_PROMPT =
  "You are Rollback, an expert code reviewer created by Amit Jha's Production. " +
  "You review code with the precision of a senior engineer with 10 years experience. " +
  "You catch bugs, security vulnerabilities, and code quality issues. " +
  "You are direct, helpful and always suggest exact fixes. " +
  "Return your response as structured JSON only.\n\n" +
  "Response schema (return ONLY valid JSON, no prose, no markdown fence):\n" +
  "{\n" +
  '  "score": <integer 1-10, where 10 is excellent>,\n' +
  '  "riskLevel": "low" | "medium" | "high",\n' +
  '  "bugs": [{"file": <str path from diff>, "line": <int>, "description": <str>, "fix": <str>}],\n' +
  '  "security": [{"file": <str>, "line": <int>, "description": <str>, "fix": <str>}],\n' +
  '  "quality": [{"file": <str>, "line": <int>, "description": <str>, "fix": <str>}],\n' +
  '  "summary": <str, 1-3 sentences>,\n' +
  '  "approved": <bool, true only if safe to merge>\n' +
  "}\n\n" +
  'For each finding, "file" must be the exact file path from the diff header (e.g. "src/auth.ts"). ' +
  '"line" is the new-file line number where the issue lives. ' +
  "Use empty arrays for categories with no findings. Never invent line numbers or file paths.";

const MODE_INSTRUCTIONS: Record<ReviewMode, string> = {
  strict:
    'Mode: strict. Surface every issue you can find, including style and minor quality nits. ' +
    'Lower scores aggressively. Approve only if there are zero findings across all categories.',
  balanced:
    'Mode: balanced. Surface important issues that affect correctness, security, or maintainability. ' +
    'Skip trivial style nits. Approve if findings are minor and isolated.',
  mentor:
    'Mode: mentor. For every finding, the "description" must explain WHY the issue matters ' +
    '(impact, consequences, real-world failure modes) before describing the fix. Be educational.',
};

/**
 * Defensive coercion for a single finding.
 * Exported for tests; not part of the public API.
 */
export function coerceFinding(raw: unknown): ReviewFinding | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const line = typeof r.line === 'number' ? r.line : Number(r.line);
  const description = typeof r.description === 'string' ? r.description : '';
  const fix = typeof r.fix === 'string' ? r.fix : '';
  const file = typeof r.file === 'string' && r.file.length > 0 ? r.file : undefined;
  if (!description) return null;
  return { file, line: Number.isFinite(line) ? line : 0, description, fix };
}

/**
 * Validate and coerce the model's JSON into a ReviewResult.
 * Throws if the shape is unrecoverable.
 * Exported for tests; not part of the public API.
 */
export function coerceResult(raw: unknown): ReviewResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('NVIDIA model did not return a JSON object.');
  }
  const r = raw as Record<string, unknown>;

  const score = typeof r.score === 'number' ? r.score : Number(r.score);
  if (!Number.isFinite(score)) {
    throw new Error('Missing or invalid "score" field in response.');
  }

  const allowedRisk: RiskLevel[] = ['low', 'medium', 'high'];
  const riskLevel = allowedRisk.includes(r.riskLevel as RiskLevel)
    ? (r.riskLevel as RiskLevel)
    : 'medium';

  const coerceList = (v: unknown): ReviewFinding[] => {
    if (!Array.isArray(v)) return [];
    return v.map(coerceFinding).filter((x): x is ReviewFinding => x !== null);
  };

  return {
    score: Math.max(1, Math.min(10, Math.round(score))),
    riskLevel,
    bugs: coerceList(r.bugs),
    security: coerceList(r.security),
    quality: coerceList(r.quality),
    summary: typeof r.summary === 'string' ? r.summary : '',
    approved: Boolean(r.approved),
  };
}

/**
 * Extract a JSON object substring from a chat-completion response.
 * Tolerates ```json fences and leading prose.
 * Exported for tests; not part of the public API.
 */
export function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

export interface ReviewDiffOptions {
  /** Project-specific rules rendered into the system prompt. */
  rulesInstruction?: string;
}

/**
 * Send a diff to the NVIDIA-hosted model and return a structured review.
 * All calls go through a Bottleneck limiter set to 40 requests/minute so we
 * never exceed NVIDIA's free-tier rate limit, even when reviews are queued.
 */
export async function reviewDiff(
  diff: string,
  mode: ReviewMode,
  opts: ReviewDiffOptions = {},
): Promise<ReviewResult> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error(
      'NVIDIA_API_KEY is not set. Add it to your .env file (see .env.example) or export it in your shell.',
    );
  }

  const client = new OpenAI({ apiKey, baseURL: BASE_URL });

  // System prompt is one string for OpenAI-compat chat completions.
  // Mode instruction + optional project rules are appended after the base prompt.
  const systemParts = [BASE_SYSTEM_PROMPT];
  if (opts.rulesInstruction) systemParts.push(opts.rulesInstruction);
  systemParts.push(MODE_INSTRUCTIONS[mode]);
  const systemPrompt = systemParts.join('\n\n');

  const userMessage =
    'Review the following unified diff. Return only the JSON object per the schema.\n\n' +
    '<diff>\n' +
    diff +
    '\n</diff>';

  // Warn the user if their request will be held back by the rate limiter.
  const counts = limiter.counts();
  if (counts.EXECUTING > 0 || counts.QUEUED > 0) {
    console.log(chalk.yellow('⏳ Rate limit reached, waiting before next review...'));
  }

  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    completion = await limiter.schedule(() =>
      client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
      }),
    );
  } catch (err: unknown) {
    if (err instanceof OpenAI.AuthenticationError) {
      throw new Error('NVIDIA_API_KEY is invalid. Generate a new key at build.nvidia.com.');
    }
    if (err instanceof OpenAI.RateLimitError) {
      throw new Error('Rate limited by NVIDIA. Wait a moment and try again.');
    }
    if (err instanceof OpenAI.APIError) {
      throw new Error(`NVIDIA API error (${err.status}): ${err.message}`);
    }
    throw err;
  }

  const text = completion.choices[0]?.message?.content;
  if (!text) {
    throw new Error('NVIDIA model returned no content.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    throw new Error(`Could not parse the model's response as JSON.\n\nRaw response:\n${text}`);
  }
  return coerceResult(parsed);
}
