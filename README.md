# Rollback

> AI-powered code reviewer that catches what humans miss so you never have to rollback.

Rollback reviews pull requests with Llama 3.3 70B (via NVIDIA's hosted API), flagging bugs, security holes, and quality issues before they ship. Use it as a CLI on local diffs or as a GitHub Action that posts inline comments on every PR.

**Completely free. No usage limits. No payment checks.**

Created by **Amit Jha's Production**.

---

## What it does

- Reads a unified diff (local file, `git diff HEAD`, or a GitHub PR)
- Sends it to Meta's Llama 3.3 70B Instruct via NVIDIA's OpenAI-compatible API
- Returns a structured review: score (1–10), risk level, per-category findings (bugs / security / quality), summary, and an approve/reject verdict
- Optionally posts the review back to GitHub as inline comments + a risk label
- Built-in 40 requests/minute rate limiter so the NVIDIA free tier is never exceeded

## Install

```bash
npm install
npm run build
```

Set up credentials:

```bash
cp .env.example .env
# Then edit .env to add your keys:
#   NVIDIA_API_KEY=nvapi-...        (get one at build.nvidia.com)
#   GITHUB_TOKEN=ghp_...            (only needed for --pr / --post)
```

## Quick start

Review the diff in your working tree:

```bash
rollback review
```

Review a specific patch file:

```bash
rollback review --diff path/to/patch.diff --mode strict
```

Review a GitHub pull request:

```bash
rollback review --pr 42 --repo owner/repo
```

Review a PR and post the results back as inline comments + risk label:

```bash
rollback review --pr 42 --repo owner/repo --post
```

## Output

Every review prints a structured report to the terminal:

```
  Score:    7/10
  Risk:     🟡 Medium Risk (review carefully)
  Approved: no

  Bugs (1):
    • src/auth.ts:7: Race condition when refreshing the token
        fix: Wrap the refresh call in a mutex

  Security (1):
    • src/auth.ts:3: Hard-coded API key
        fix: Read from process.env.API_KEY

  ✓ Quality: none found

  Summary:
    Two blocking issues in auth flow. Address before merging.
```

## Configuration

Run `rollback init` to scaffold `.rollback.yml` in the current directory:

```yaml
# Plain-English rules — the model treats each as a hard requirement
rules:
  - "Never hardcode API keys, tokens, or other secrets"
  - "All async functions must handle errors (try/catch or .catch)"
  - "No console.log statements in production code"
  - "User input must be validated before use in queries or commands"

# Default review mode: strict | balanced | mentor
mode: balanced

# Files matching these globs are stripped from the diff before review
ignore:
  - "*.test.ts"
  - "*.spec.ts"
  - "node_modules/**"
  - "dist/**"
  - "package-lock.json"
```

**Precedence:** `--mode` flag > `mode:` in config > `balanced`.

## Commands

| Command              | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| `rollback review`    | Review a diff (local file, `git diff HEAD`, or GitHub PR)    |
| `rollback init`      | Write a starter `.rollback.yml` in the current directory     |
| `rollback status`    | Show CLI version, AI provider, env-var status, and config summary |
| `rollback help`      | Show all commands                                            |

### `rollback review` flags

| Flag                  | Description                                                          |
| --------------------- | -------------------------------------------------------------------- |
| `--diff <path>`       | Path to a unified diff file (defaults to `git diff HEAD`)            |
| `--pr <number>`       | GitHub PR number to fetch the diff from                              |
| `--repo <owner/name>` | GitHub repo, required with `--pr`                                    |
| `--post`              | Post the review back to the PR as inline comments + risk label       |
| `--mode <mode>`       | Override the review mode: `strict`, `balanced`, or `mentor`          |

## Review modes

- **strict** — Surfaces every issue including style nits. Approves only when zero findings.
- **balanced** — Default. Surfaces important issues. Approves if findings are minor and isolated.
- **mentor** — Educational. Every finding explains *why* the issue matters before describing the fix.

## Risk levels

Every review carries one of three risk levels. When used as a GitHub Action, the corresponding label is applied to the PR.

| Level     | Meaning            | Label         |
| --------- | ------------------ | ------------- |
| 🟢 Low    | Safe to merge      | `risk:low`    |
| 🟡 Medium | Review carefully   | `risk:medium` |
| 🔴 High   | Do not merge       | `risk:high`   |

The GitHub Action exits non-zero on `risk:high` so the check fails visibly in the PR UI.

## GitHub Action

Drop this into `.github/workflows/rollback.yml`:

```yaml
name: Rollback Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - name: Rollback PR review
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NVIDIA_API_KEY: ${{ secrets.NVIDIA_API_KEY }}
          ROLLBACK_MODE: balanced
        run: node dist/action/index.js
```

Add `NVIDIA_API_KEY` as a repo secret. `GITHUB_TOKEN` is provided automatically by Actions.

The action will:

1. Fetch the PR diff via the GitHub API
2. Strip ignored files (per `.rollback.yml`)
3. Send the diff to NVIDIA's Llama 3.3 70B model
4. Post a summary comment + inline comments on the affected lines
5. Apply the appropriate `risk:*` label (and strip any stale ones)
6. Exit non-zero if the risk is `high`

## Rate limiting

NVIDIA's hosted API caps free-tier traffic at **40 requests per minute**. Rollback wraps every model call in a [Bottleneck](https://github.com/SGrondin/bottleneck) limiter configured for `minTime: 1500ms` and `maxConcurrent: 1`, so back-to-back reviews are automatically spaced out and the cap is never exceeded — no matter how many reviews are queued.

When a review is held back, you'll see:

```
⏳ Rate limit reached, waiting before next review...
```

This happens transparently. You don't have to do anything; the queued review will run as soon as a slot is available.

## Status

```bash
$ rollback status

  Version:  1.0.0
  Provider: NVIDIA (meta/llama-3.3-70b-instruct)
  NVIDIA_API_KEY: set
  GITHUB_TOKEN:   set

  .rollback.yml:
    rules:  4
    mode:   balanced
    ignore: 6 patterns
```

## Environment variables

| Variable          | Purpose                                                        | Required          |
| ----------------- | -------------------------------------------------------------- | ----------------- |
| `NVIDIA_API_KEY`  | Authenticates with the NVIDIA OpenAI-compatible API            | Yes (for reviews) |
| `GITHUB_TOKEN`    | Authenticates with the GitHub API                              | Yes (for `--pr`)  |
| `ROLLBACK_MODE`   | Default mode for the action (`strict`/`balanced`/`mentor`)     | No                |

## Development

```bash
npm run build       # tsc → dist/
npm run dev         # ts-node src/cli.ts (skip the build step)
npm test            # jest (71 tests across 5 suites)
npm run test:watch  # jest in watch mode
npm run clean       # remove dist/
```

## Project structure

```
rollback/
├── src/
│   ├── cli.ts                # CLI entry point
│   ├── review.ts             # Core review orchestration
│   ├── ai/nvidia.ts          # NVIDIA API (OpenAI-compat) + Bottleneck limiter
│   ├── github/
│   │   ├── github.ts         # Octokit wrapper (fetch + post)
│   │   └── parse.ts          # parseRepo (deps-free)
│   ├── rules/rules.ts        # .rollback.yml loader + diff filter
│   └── utils/helpers.ts      # Welcome banner + risk formatter
├── action/
│   └── index.ts              # GitHub Action entry point
├── tests/                    # Jest test suites
├── .github/workflows/
│   └── rollback.yml          # PR review workflow
├── .rollback.yml             # User-facing config
├── package.json
├── tsconfig.json
└── README.md
```

## Tech stack

- **TypeScript** with strict mode
- **NVIDIA API** via the `openai` SDK — model: `meta/llama-3.3-70b-instruct`, base URL `https://integrate.api.nvidia.com/v1`
- **Bottleneck** for the 40 req/min rate limiter
- **GitHub API** (`@octokit/rest`)
- **Commander** for the CLI
- **Jest** + `ts-jest` for tests
- **js-yaml** for config parsing
- **minimatch** for ignore-pattern matching

## Roadmap

- Hosted dashboard at `rollback.dev`
- Support for additional NVIDIA-hosted models (Mixtral, DeepSeek)
- Per-language review specializations

## License

MIT © Amit Jha's Production
