# Gemini Timing Telemetry — Design Spec

- **Date**: 2026-04-20
- **Target version**: 0.6.0 (from 0.5.2)
- **Scope**: Observability-first. Add fine-grained timing telemetry to Gemini plugin calls, persist history, and surface via a new `/gemini:timing` command with cross-plugin comparison against Codex.
- **Non-goals**: Do not optimize performance yet. Data collected here will drive the next round of optimization decisions (CLI cold-start mitigation, model swap, prompt reduction, daemon mode).

## Motivation

Users report that Gemini-delegated tasks feel slower than Codex-delegated tasks — with observed runs up to ~10 minutes. The current job tracking (`job-control.mjs`) only records coarse phase transitions (`queued → starting → running → done`) and first/last timestamps. It is impossible to attribute the 10-minute total to any specific cause:

1. CLI cold-start (Gemini CLI is re-spawned per invocation; Codex keeps a persistent app-server)
2. Time-to-first-token (Gemini 3.1 Pro baseline 21–35s per vendor data)
3. Token generation throughput
4. Trailing close delay after final result event

Without data-driven attribution, any optimization is guessing. This spec adds the minimum reliable instrumentation to make the next decision informed.

## Data Model

Each job emits a `timing` object on completion (success OR failure OR timeout — failures are the most important case to instrument, never skip).

### Schema (per job)

```json
{
  "timing": {
    "spawnedAt":     "2026-04-20T12:34:56.789Z",
    "firstEventMs":  1830,
    "ttftMs":        18420,
    "streamMs":      432150,
    "tailMs":        210,
    "totalMs":       452610,
    "model":         "gemini-3-pro-preview",
    "promptBytes":   12034,
    "responseBytes": 28516,
    "inputTokens":   3180,
    "outputTokens":  7042,
    "tokensPerSec":  16.3,
    "exitCode":      0,
    "timedOut":      false
  }
}
```

### Segment definitions

| Field | Definition | Captures |
|---|---|---|
| `firstEventMs` | `t_firstEvent - t_spawn` | CLI cold-start cost |
| `ttftMs` | `t_firstToken - t_firstEvent` | Model latency to first token |
| `streamMs` | `t_lastToken - t_firstToken` | Generation duration |
| `tailMs` | `t_close - t_lastToken` | Trailing teardown |
| `totalMs` | `t_close - t_spawn` | End-to-end wall clock |

Where:

- `t_spawn`: immediately before `spawn("gemini", args, ...)`
- `t_firstEvent`: first successfully parsed NDJSON line from stdout (any event type)
- `t_firstToken`: first NDJSON event matching `{type: "message", role: "assistant", content: <non-empty>}`
- `t_lastToken`: last such event seen
- `t_close`: inside `child.on("close", ...)` handler

### Degraded capture for failures and sync calls

- **Timeout**: capture whatever segments were reached; nulls for the rest. `timedOut: true`.
- **Exit non-zero before first event**: only `firstEventMs` may be null; `totalMs` still recorded.
- **Synchronous `callGemini` (review)**: only `totalMs`, `model`, `promptBytes`, `responseBytes`, `inputTokens`, `outputTokens`, `exitCode`, `timedOut` are populated. Streaming-only fields (`firstEventMs`, `ttftMs`, `streamMs`, `tailMs`, `tokensPerSec`) are `null`. Rationale: `-o json` sync mode has no NDJSON stream to segment.

### Token source

- Prefer values from Gemini's own `result` event `stats.tokens` (when present). Field path may be `stats.tokens.input` / `stats.tokens.output` or `stats.tokens.promptTokens` / `stats.tokens.candidatesTokens` depending on CLI version.
- If neither path is present: fall back to byte-based estimate `Math.round(bytes / 4)` and mark the field with a sibling `inputTokensEstimated: true` / `outputTokensEstimated: true` so we never silently show fake numbers.
- `tokensPerSec` is computed only when `outputTokens` is real AND `streamMs > 0`; otherwise null.

## Storage

### Per-job (short-lived)

Extend each job record in `~/.claude/plugins/gemini/state/<workspace>/jobs.json` with the `timing` object. Old records without this field render as `—` in UI — no migration required.

### Global history (long-lived)

**Path**: `~/.claude/plugins/gemini/timings.ndjson` (global, NOT per-workspace — user operates Gemini across multiple repos; trend analysis needs the union).

**Format**: One JSON object per line, appended on job completion:

```json
{"ts":"2026-04-20T12:42:29.399Z","jobId":"gt-abc123","kind":"task","workspace":"/Users/bing/-Code-/gemini-plugin-cc","timing":{...}}
```

**Concurrency**: Reuse `state.mjs` file-locking pattern — multiple Claude sessions across workspaces may append simultaneously.

**Size management**: Append-only; no time-based rotation. When file exceeds **10 MB** (checked on append), trim the oldest half (keep the newest 50%, rewrite atomically via temp file + rename). Rationale: 1 job record ≈ 300 bytes, so 10 MB ≈ 35k jobs — plenty for trend analysis, trim cost is bounded and rare.

**Corruption tolerance**: Reader skips any line that fails `JSON.parse`. One bad line never breaks history analysis.

## UI Surface

### 1. `/gemini:status` (existing, enriched)

Human-readable view adds one summary line per row:

```
gt-abc123 · task · done · 7m 32s
  cold 1.8s · ttft 18.4s · gen 7m 12s · tail 0.2s · 16 tok/s
```

If `timing` is missing (legacy job), show `—` in place of the summary line. Never throw.

### 2. `/gemini:result --json` (existing, enriched)

The JSON payload gains a top-level `timing` field (null for legacy jobs). No change to the existing schema otherwise.

### 3. `/gemini:timing` (new command)

Three invocation modes — mutually exclusive flags:

#### a) `/gemini:timing <job-id>` — single-job detail

```
Job gt-abc123 · task · done
  Prompt    12.0 KB → 3,180 tokens
  Response  28.5 KB ← 7,042 tokens
  Model     gemini-3-pro-preview

  cold   ████                    1.8s   ( 0.4%)
  ttft   ██████████             18.4s   ( 4.1%)
  gen    ███████████████████   432.1s   (95.5%)
  tail   ▏                       0.2s   ( 0.0%)
  ─────────────────────────────────────
  total                         452.6s    100%

  Throughput: 16.3 tokens/sec
```

Bars: 30-column width, proportional to segment duration. Characters: `█▉▊▋▌▍▎▏` for sub-character precision. Skip segments that are null.

#### b) `/gemini:timing --history [--kind K] [--last N]` — table

Defaults: `--last 20`, all kinds. Columns: `id · kind · total · cold · ttft · gen · tok/s · completedAt`.

#### c) `/gemini:timing --stats [--kind K]` — aggregate

```
task (n=34, window=last 30 days)
                  cold        ttft        gen         total
  p50             1.9s        19.2s       2m 10s      2m 35s
  p95             3.1s        42.0s       8m 15s      9m 03s
  p99             3.8s        58.0s       9m 40s      9m 58s
  slowest         gt-xyz789 · 9m 48s · prompt=48KB · out=12k tok
```

Percentile calculation: sort each column independently; use nearest-rank method (no interpolation) for simplicity.

Time window default: last 30 days. Override via `--since <iso-date>`.

#### d) `/gemini:timing --compare codex [--kind K]` — cross-plugin comparison (C1)

```
task · last 30 days
                   Gemini (n=34)      Codex (n=52)
  p50 total        2m 35s             34s
  p95 total        9m 03s             2m 10s
  ratio (p50)      4.6x slower
  ratio (p95)      4.2x slower
```

**Codex data source**: Read `~/.claude/plugins/codex/state/*/jobs.json` (or wherever Codex stores state — verify in implementation). Only the job-level elapsed time is available (Codex does not currently instrument segments — tracked for a future PR). Compare totals only.

**Graceful degradation**: If Codex state is missing or the directory does not exist, print `Codex history not detected — install & run Codex plugin to enable comparison.` Exit 0.

### 4. `/gemini:timing --json` flag

All three modes accept `--json` to emit machine-readable output for Claude to consume.

## Files to Change

| File | Change | Est. lines |
|---|---|---|
| `plugins/gemini/scripts/lib/gemini.mjs` | Instrument `callGemini` (partial) and `callGeminiStreaming` (full); return `timing` object; read `stats.tokens` with fallback | +70 |
| `plugins/gemini/scripts/lib/job-control.mjs` | Worker persists `timing` to `jobs.json`; appends to global ndjson | +40 |
| `plugins/gemini/scripts/lib/state.mjs` | `appendTimingHistory()`, `readTimingHistory()`, trim-on-threshold | +35 |
| `plugins/gemini/scripts/lib/render.mjs` | Status view summary line | +15 |
| `plugins/gemini/scripts/gemini-companion.mjs` | Route `timing` subcommand | +30 |
| `plugins/gemini/scripts/lib/timing.mjs` | **new**: percentiles, bar rendering, history filtering | +90 |
| `plugins/gemini/scripts/lib/codex-compare.mjs` | **new**: read Codex state, compute ratio | +50 |
| `plugins/gemini/commands/timing.md` | **new**: slash command frontmatter + usage | new file |
| `plugins/gemini/CHANGELOG.md` | 0.6.0 entry | — |
| `plugins/gemini/.claude-plugin/plugin.json` | Version bump 0.5.2 → 0.6.0 | 1 |
| Root `CHANGELOG.md` | Append 0.6.0 entry | — |

**Total**: ~330 lines of code + 1 new command file + 2 new lib files.

## Implementation Phases

Each phase is independently testable. Not a PR boundary — all merged together.

1. **Capture layer** — instrument `callGemini` + `callGeminiStreaming`; unit-verify timing shape on happy path, failure path, timeout path
2. **Storage layer** — extend `jobs.json`; append to ndjson with locking; trim on threshold; run 2–3 real tasks to verify
3. **Render layer** — `/gemini:status` summary line; `/gemini:timing <id>` single-job view
4. **Aggregate layer** — `--history` and `--stats`
5. **Compare layer** — `--compare codex` with graceful degradation
6. (Optional, in-scope) Degraded capture for sync `callGemini` (review/adversarial-review)

## Compatibility & Risk

- **Schema additivity**: `timing` is a new field; legacy job records (absent or partial) render as `—`. No migration.
- **File lock contention**: The global ndjson is written from every workspace's worker. Reuse `state.mjs` lock retry logic. Append is a single write syscall so contention window is small.
- **Gemini CLI schema drift**: `stats.tokens.*` field names are not formally documented. Check multiple known paths; fall back to byte estimate when all fail. Never silently fabricate token numbers.
- **Codex state path drift**: If Codex plugin reorganizes its state layout, `--compare codex` gracefully prints "not detected" instead of crashing.
- **Performance overhead**: 5 `Date.now()` calls + 1 ndjson append per job = negligible (< 1 ms).
- **Privacy**: `prompt` content is NOT stored in timing history; only byte size. Consistent with existing `job.prompt` truncation to 200 chars.

## Out of Scope (deferred)

- **Codex segment-level instrumentation**: A future PR to Codex plugin would enable true side-by-side breakdown. Tracked separately.
- **Performance optimizations**: This spec ships only instrumentation. Optimization strategies (model swap, prompt compaction, CLI daemon mode adoption) are decided after the first weeks of data.
- **Live per-token rate during streaming**: Current streaming worker logs content in bulk; computing mid-stream tokens/sec requires additional parsing. Deferred unless data shows it's needed.
- **Historical import / backfill**: Jobs completed before 0.6.0 have no timing data. Acceptable — new data accumulates quickly.

## Success Criteria

After one week of real use, we should be able to answer:

1. For a typical task job, what is the median (p50) and tail (p95) breakdown across cold / ttft / gen / tail?
2. What fraction of total time is CLI cold-start vs. model latency vs. generation?
3. How much slower is Gemini than Codex at p50 and p95 for equivalent task kinds?
4. Is there a clear "slow" model fingerprint (e.g., `modelSteering` silently routing to a degraded variant)?
5. Do failed/timeout jobs cluster in any particular segment (e.g., all timeouts hit during `streamMs`, suggesting a specific generation issue)?

Only after these answers arrive do we design the optimization phase.
