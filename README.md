# Gemini Plugin for Claude Code

A Claude Code plugin that integrates Google's Gemini CLI as an on-demand subagent for code review, task delegation, and Q&A — with built-in timing observability (v0.6.0).

## Prerequisites

- [Claude Code](https://claude.ai/code)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`npm install -g @google/gemini-cli`)
- Authenticated Gemini CLI (run `gemini` interactively once to log in)

## Install

```bash
claude plugin marketplace add bbingz/gemini-plugin-cc
claude plugin install gemini
```

Update later with:
```bash
claude plugin marketplace update gemini-plugin
claude plugin update gemini@gemini-plugin
```

## Commands

| Command | What it does |
|---|---|
| `/gemini:setup` | Check CLI install + auth + review-gate state |
| `/gemini:ask <question>` | Ask Gemini a question (streaming) |
| `/gemini:task <prompt>` | Delegate a task (supports `--background`, `--resume-last`, `--fresh`, `--prompt-file`, stdin) |
| `/gemini:review [--scope auto\|working-tree\|branch] [--base ref]` | Structured code review on current diff (schema-enforced output) |
| `/gemini:adversarial-review` | Second-opinion review finding flaws in prior suggestions |
| `/gemini:rescue <task>` | Foreground rescue via Agent tool (bypasses Skill recursion) |
| `/gemini:status [job-id] [--wait] [--all]` | Background job status + embedded timing summary |
| `/gemini:result [job-id]` | Fetch completed job output (includes `timing` field in `--json`) |
| `/gemini:cancel [job-id]` | Cancel running/queued background job (SIGINT) |
| **`/gemini:timing [job-id\|--history\|--stats] [--json]`** | **Per-job timing breakdown / history table / p50/p95/p99 aggregate (v0.6.0)** |

### Example: observe what's slow

```bash
/gemini:timing --stats
```

Emits a percentile table over all historical jobs:

```
all (n=34)
                 cold        ttft        gen         tool        retry       total
  p50            8.7s        12.2s       869ms       0ms         0ms         21.0s
  p95            3.1s        42.0s       8m 15s      4m 00s      1m 20s      9m 03s
  slowest        gt-xyz789 · 9m 48s · fallback
  fallback rate  23.5%
```

## How it works

- **Streaming** (ask/task): `gemini -p "..." -o stream-json --approval-mode auto_edit` → NDJSON events → TimingAccumulator → persisted result + global history
- **Sync** (review): `gemini -p "..." -o json --approval-mode plan` → schema-validated structured response
- **Background jobs**: spawned detached worker processes; timings write to per-job envelope + `~/.claude/plugins/data/gemini-gemini-plugin/timings.ndjson`
- **No MCP server**: each call is independent; history is append-only NDJSON under a dedicated file lock

## Architecture

```
plugins/gemini/
├── .claude-plugin/plugin.json     # Plugin identity (version)
├── agents/gemini-agent.md          # Subagent definition
├── commands/                       # Slash command files
├── hooks/hooks.json                # SessionStart / SessionEnd / Stop
├── prompts/                        # Prompt templates
├── schemas/review-output.schema.json
├── scripts/
│   ├── gemini-companion.mjs        # Main CLI entry point
│   ├── session-lifecycle-hook.mjs  # Workspace cleanup
│   ├── stop-review-gate-hook.mjs   # Pre-stop review gate
│   └── lib/
│       ├── gemini.mjs              # callGemini (sync) + callGeminiStreaming (async, instrumented)
│       ├── timing.mjs              # TimingAccumulator + dispatchTimingEvent + render/aggregate helpers
│       ├── job-control.mjs         # Background worker + phases + wait + cancel
│       ├── state.mjs               # State persistence + dedicated ndjson lock + trim
│       ├── render.mjs              # Output formatting (markdown-safe timing block)
│       ├── git.mjs                 # Structured review context + diff + scope
│       ├── process.mjs             # Child process management
│       ├── args.mjs                # Argument parser
│       └── prompts.mjs             # Template loader
├── skills/                         # Inside-Claude skills (runtime contract + result handling)
└── CHANGELOG.md

tests/                              # node:test, zero external deps
  timing-{accumulator,dispatch,render,aggregate,storage}.test.mjs
```

## Timing observability (v0.6.0)

Every streaming call (foreground or background `ask`/`task`) emits a 6-segment timing object:

| Segment | Measures |
|---|---|
| `firstEventMs` | CLI spawn → first parsed NDJSON event (cold-start cost) |
| `ttftMs` | First event → first assistant token (model TTFT) |
| `streamMs` | First token → last token (pure generation) |
| `toolMs` | Sum of `tool_use`/`tool_call` → `tool_result`/`tool_response` windows |
| `retryMs` | Sum of CLI-internal retry windows (non-fatal error events) |
| `tailMs` | Last token → process close |

Plus: `totalMs`, `requestedModel`, `usage[]` (per-model tokens), `tokensPerSec`, `coldStartPhases` (when CLI emits `startup_stats`), `terminationReason`, `invariantOk` (sum-invariant check on clean exits).

All records append to `~/.claude/plugins/data/gemini-gemini-plugin/timings.ndjson` (global, shared across workspaces) under a dedicated file lock with partial-line repair and trim-at-10MB.

## Alignment with Codex plugin

~95% feature parity with the Codex CLI plugin. The remaining gap is CLI cold-start: Codex has a persistent `app-server` process (cold ≈ 0ms); Gemini CLI spawns fresh each call (cold ≈ 8-10s empirically). Unblocked by [gemini-cli daemon-mode PRs #20700 / #21307](https://github.com/google-gemini/gemini-cli/pulls).

## License

MIT
