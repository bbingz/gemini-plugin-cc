# Gemini Timing Telemetry — Design Spec (v2)

- **Date**: 2026-04-20
- **Target version**: 0.6.0 (from 0.5.2)
- **Revision**: v2 — revised after 3-way review (Codex / Gemini / Claude code-reviewer)
- **Scope**: Observability-first for **streaming** calls (`task`, `ask`). Add fine-grained timing, persist global history, surface via new `/gemini:timing` command.
- **Non-goals**: Do not optimize performance yet. Do not instrument synchronous `callGemini` (review) in this release — deferred to 0.6.1. Do not cross-compare against Codex — deferred to 0.6.1 (Codex lacks segment instrumentation; totals-only compare is low-signal).

## Motivation

Users report Gemini-delegated tasks feel much slower than Codex-delegated tasks — observed up to ~10 minutes per task. Current job tracking records only coarse phase transitions and first/last timestamps. We cannot attribute that 10 minutes to any cause.

**Empirical evidence from the review of this spec itself**: the Gemini subagent reviewing v1 took 16m 6s, and its `per_model_usage` showed a silent Pro→Flash downgrade — 68K tokens billed to Pro, 1,014K tokens billed to Flash — while the `init` event reported only `gemini-3.1-pro-preview`. **The thing we need to measure is already distorting our own operations.** v2 explicitly handles this.

### Decomposition target

Any 10-minute wall-clock should attributable to a union of these:

- **CLI cold-start** (Node boot + `gemini` binary startup + config + extensions)
- **Time-to-first-token** (network + model queueing + first inference)
- **Generation time** (token output at steady state)
- **Tool execution time** (mid-stream `tool_use` pauses — silently inflates `streamMs` if ignored)
- **Internal retry delay** (CLI's `ModelAvailabilityService` silently retries 429/503/504)
- **Reasoning-token time** (thoughts tokens are not in `output_token_count` — distorts tok/s)
- **Silent model fallback** (Pro→Flash mid-request — `init.model` does not reflect reality)
- **Tail close** (process teardown; expected near-zero; kept to falsify)

## Data Model

### Schema (per streaming job)

```json
{
  "timing": {
    "spawnedAt":      "2026-04-20T12:34:56.789Z",
    "firstEventMs":   1830,
    "ttftMs":         18420,
    "streamMs":       220000,
    "toolMs":         180000,
    "retryMs":        32000,
    "tailMs":         210,
    "totalMs":        452460,
    "requestedModel": "gemini-3-pro-preview",
    "usage": [
      { "model": "gemini-3.1-pro-preview",   "input": 12400, "output": 3200,  "thoughts": 900 },
      { "model": "gemini-3-flash-preview",   "input": 48000, "output": 7040,  "thoughts": 0   }
    ],
    "promptBytes":   12034,
    "responseBytes": 28516,
    "tokensPerSec":  16.3,
    "exitCode":      0,
    "terminationReason": "exit",
    "timedOut":      false,
    "coldStartPhases": [
      { "phase": "runtime",   "ms": 420 },
      { "phase": "config",    "ms": 180 },
      { "phase": "extensions","ms": 910 },
      { "phase": "other",     "ms": 320 }
    ]
  }
}
```

### Segment definitions

| Field | Definition | Captures |
|---|---|---|
| `firstEventMs` | `t_firstEvent - t_spawn` | CLI cold-start cost (detail in `coldStartPhases`) |
| `ttftMs` | `t_firstToken - t_firstEvent` | Model latency to first token (**excludes** `retryMs`) |
| `streamMs` | `t_lastToken - t_firstToken − toolMs − retryMs` | **Pure** generation duration |
| `toolMs` | Σ (`t_tool_result − t_tool_use`) over all tool cycles | Time the model waited on tool execution |
| `retryMs` | Σ internal-retry delays seen as non-fatal `{type:"error"}` events | CLI-internal retries (invisible to caller otherwise) |
| `tailMs` | `t_close - t_lastToken` | Trailing teardown (expected near-zero; tracked to falsify) |
| `totalMs` | `t_close - t_spawn` | End-to-end wall clock. **Invariant**: `firstEventMs + ttftMs + streamMs + toolMs + retryMs + tailMs == totalMs` (validated in tests) |

### Event boundaries (NDJSON)

- `t_spawn`: immediately before `spawn("gemini", args, ...)`
- `t_firstEvent`: first NDJSON line that parses (any type)
- `t_firstToken`: first `{type:"message", role:"assistant", content:<non-empty>}` event
- `t_lastToken`: last such event
- `t_tool_use` / `t_tool_result`: paired `{type:"tool_use"}` / `{type:"tool_result"}` boundaries; collect durations into `toolMs` bucket
- `{type:"error"}` (non-fatal, no close): treat as retry marker; start retry window, end on next non-error event. Accumulate into `retryMs`
- `t_close`: inside `child.on("close", ...)` handler

If an event shape is missing (e.g., CLI version emits `tool_use` under a different key), segment accumulators stay at 0 and `streamMs` absorbs the time. Log a one-time debug line per shape variant so we learn the schema.

### Model attribution — authoritative source

**`requestedModel`** comes from the `init` event. **`usage[]`** comes from the `result` event's `per_model_usage` (or equivalent) — this is the authoritative record of what actually ran. A silent Pro→Flash fallback will show as two entries in `usage`; `init.model` will look fine but will be contradicted by `usage`.

### Token source

Read from the final `result` event's `stats` block using the real field names:

- `input_token_count`
- `output_token_count`
- `thoughts_token_count` (reasoning tokens)
- `tool_token_count` (optional)

When `per_model_usage` is present, prefer its per-model breakdown and populate `usage[]`. Otherwise produce a single-element `usage[]` keyed to `requestedModel`.

**`tokensPerSec`** = `Σ(output_token_count + thoughts_token_count) / (streamMs / 1000)`. Rationale: thoughts tokens consume generation time; excluding them makes Pro look artificially slow on reasoning-heavy tasks.

Fallback: if all token fields missing (CLI schema drift), emit `tokensPerSec: null` and a debug log. **Never** byte-estimate silently — false precision is worse than null.

### Cold-start phases (free bonus)

Set `GEMINI_TELEMETRY_ENABLED=1` in the child env when spawning. The CLI emits a `gemini_cli.startup_stats` event with `phases[]`. Copy verbatim into `coldStartPhases`. If the env var is rejected by the user's CLI version (no event seen), leave the field absent — `firstEventMs` alone is still correct.

### Degraded capture — explicit cases

| Terminal state | What's captured | What's null |
|---|---|---|
| Exit code 0 | Everything | Nothing |
| Timeout (`timedOut: true`) | Whatever segments reached | Remaining segments, `exitCode` |
| Exit non-zero with events | Reached segments | Remaining segments |
| Exit before first event | `totalMs` only | Everything else |
| Cancelled (SIGINT/SIGTERM) | Everything reached | Final segments if interrupted mid-stream. `terminationReason: "signal"`, record signal name (`"SIGINT"`, `"SIGTERM"`) |

`terminationReason` discriminator: `"exit"` | `"timeout"` | `"signal"` | `"error"`.

### Synchronous `callGemini` (review / adversarial-review)

**NOT instrumented in 0.6.0.** `-o json` emits no NDJSON stream, so we cannot segment without duplicating work already tracked elsewhere. Deferred to 0.6.1 where we'll add wall-time `totalMs` only.

Resolves the v1 contradiction between the data model and Phase 6.

## Storage

### Per-job (short-lived) — aligned with actual state layout

The existing layout is `~/.claude/plugins/gemini/state/<workspace>/state.json` (job index) plus `~/.claude/plugins/gemini/state/<workspace>/jobs/<jobId>.json` (per-job result envelope). **v2 correction**: v1 incorrectly called this a single `jobs.json`.

- **Write**: the `timing` object is added to the per-job envelope in `jobs/<jobId>.json`, produced by the streaming worker on terminal transition. Existing `writeJobFile()` already handles this envelope — just include `timing` alongside `result`.
- **Read**: `/gemini:result --json` already returns `{ job, result }`. Add `timing` as a sibling (`{ job, result, timing }`). `enrichJob()` already runs on `state.json` records; when the summary line needs timing, it reads from the envelope file.
- **Legacy**: jobs completed before 0.6.0 have no envelope field; render `—`.

### Global history (long-lived)

**Path**: `~/.claude/plugins/gemini/timings.ndjson`. Global across workspaces — trend analysis needs the union.

**Concurrency — dedicated lock, not state.mjs's lock**

The existing `state.mjs` lock is per-state-file and, on retry exhaustion, bypasses the lock to avoid deadlock (`state.mjs:107-149`). That bypass is acceptable for its use case but **unsafe for append-then-trim on a shared global file**. Introduce a dedicated lock:

- Lock file: `~/.claude/plugins/gemini/timings.ndjson.lock`
- Acquisition: `fs.openSync(lockPath, "wx")`; on `EEXIST` retry with backoff for up to 10 seconds, then give up and **drop the record** (log to stderr of the worker log; do not block job completion). Dropped records are a minor analytics gap; a hung job completion is a user-visible failure.
- Release: unlink after write.

**Append integrity**: before appending, check the last byte of the file. If it is not `\n` (prior crash left a partial line), prepend `\n` to the new record. Prevents compound corruption.

**Read tolerance**: consumers parse line-by-line, `try { JSON.parse }`, skip bad lines silently.

**Size management**: on each append, check file size. If > 10 MB (≈ 35k records at ~300 bytes each), trim: read all, parse-and-filter to valid lines, keep newest 50%, write to `timings.ndjson.tmp`, rename. Rename is atomic on POSIX. Trim happens under the same dedicated lock as append.

## UI Surface

### 1. `/gemini:status` (existing, enriched)

Human-readable view adds one summary line per row when `timing` is present:

```
gt-abc123 · task · done · 7m 32s
  cold 1.8s · ttft 18.4s · gen 3m 40s · tool 3m 0s · retry 32s · 16 tok/s
```

Legacy jobs render `—`. Never throw.

### 2. `/gemini:result --json` (existing, enriched)

Returns `{ job, result, timing }`. `timing: null` for legacy jobs.

### 3. `/gemini:timing` (new command)

Three mutually-exclusive invocation modes. **Combining modes returns a usage error.**

#### a) `/gemini:timing <job-id>` — single-job detail

```
Job gt-abc123 · task · done
  Prompt     12.0 KB
  Response   28.5 KB
  Requested  gemini-3-pro-preview
  Actual     gemini-3.1-pro-preview  (68K tok)
             gemini-3-flash-preview  (1014K tok)   ⚠ silent fallback

  cold     ▍                     1.8s   ( 0.4%)
  ttft     ██                   18.4s   ( 4.1%)
  gen      █████████           220.0s   (48.6%)
  tool     ████████            180.0s   (39.8%)
  retry    ██                   32.0s   ( 7.1%)
  tail     ▏                     0.2s   ( 0.0%)
  ────────────────────────────────────
  total                        452.4s    100%

  Throughput: 16.3 tok/s  (includes thoughts)
  Cold-start breakdown: runtime 0.4s · config 0.2s · extensions 0.9s · other 0.3s
```

Bars: 20-column width, proportional. Null segments omitted. Silent-fallback warning when `usage[]` has >1 entry.

**JSON shape** (`--json`):
```json
{
  "job": { "id": "gt-abc123", "kind": "task", "status": "done" },
  "timing": { /* full schema above */ },
  "fallback": true
}
```

#### b) `/gemini:timing --history [--kind K] [--last N] [--since ISO]` — table

Defaults: `--last 20`, all kinds, no time filter. Columns: `id · kind · total · cold · ttft · gen · tool · retry · tok/s · fallback · completedAt`.

**JSON shape**:
```json
{
  "rows": [
    { "jobId": "gt-abc123", "kind": "task", "completedAt": "...", "timing": {...}, "fallback": true }
  ],
  "count": 20
}
```

#### c) `/gemini:timing --stats [--kind K] [--since ISO]` — aggregate

```
task (n=34, window=last 30 days)
                  cold      ttft      gen       tool      retry     total
  p50             1.9s      19.2s     2m 10s    0s        0s        2m 35s
  p95             3.1s      42.0s     8m 15s    4m 00s    1m 20s    9m 03s
  p99 (n<100)     —         —         —         —         —         —
  slowest         gt-xyz789 · 9m 48s · fallback · prompt=48KB · out=12k tok
  fallback rate   23.5% (8/34)
```

**Percentile rules**:
- p50 always shown
- p95 suppressed (`—`) when n < 20
- p99 suppressed when n < 100
- Null segments excluded from that column's sort
- Nearest-rank method, no interpolation

Time window default: last 30 days. Override via `--since <iso-date>`.

**JSON shape**:
```json
{
  "kind": "task",
  "n": 34,
  "since": "2026-03-21T00:00:00Z",
  "percentiles": {
    "p50": { "cold": 1900, "ttft": 19200, "gen": 130000, "tool": 0, "retry": 0, "total": 155000 },
    "p95": { ... },
    "p99": null
  },
  "slowest": { "jobId": "gt-xyz789", "totalMs": 588000, "fallback": true },
  "fallbackRate": 0.235
}
```

## Files to Change

| File | Change | Est. lines |
|---|---|---|
| `plugins/gemini/scripts/lib/gemini.mjs` | Instrument `callGeminiStreaming` only; return `timing`; parse `tool_use`/`tool_result`/non-fatal `error` events; read `per_model_usage` + real token fields; inject `GEMINI_TELEMETRY_ENABLED=1` and capture `startup_stats` | +90 |
| `plugins/gemini/scripts/lib/job-control.mjs` | Worker persists `timing` into per-job envelope; calls `appendTimingHistory()` | +25 |
| `plugins/gemini/scripts/lib/state.mjs` | `appendTimingHistory()`, `readTimingHistory()`, dedicated lock + trim + partial-line repair | +50 |
| `plugins/gemini/scripts/lib/render.mjs` | `/gemini:status` summary line; respects `timing === null` legacy path | +20 |
| `plugins/gemini/scripts/gemini-companion.mjs` | Route `timing` subcommand; reject combined flags | +30 |
| `plugins/gemini/scripts/lib/timing.mjs` | **new**: percentiles with small-n suppression, bar rendering, history filter/aggregate, fallback detection | +100 |
| `plugins/gemini/commands/timing.md` | **new**: frontmatter matching existing style (`disable-model-invocation: true`, `allowed-tools: Bash(node:*)`), usage | new file |
| `plugins/gemini/CHANGELOG.md` | 0.6.0 entry | — |
| `plugins/gemini/.claude-plugin/plugin.json` | 0.5.2 → 0.6.0 | 1 |
| Root `CHANGELOG.md` | Append 0.6.0 | — |

**Total**: ~315 lines. **(v1 was ~330 lines with Codex-compare; v2 trades codex-compare for `toolMs`/`retryMs`/`per_model_usage`/telemetry-phases logic — smaller and higher-signal.)**

## Implementation Phases

1. **Capture layer** — instrument `callGeminiStreaming`: timestamps, NDJSON dispatch for tool/retry/startup_stats events, token path with `per_model_usage`. Tests: happy path, timeout, cancelled (SIGINT), one-tool-call path, silent-fallback fixture, missing `stats` fixture. **Assert the segment-sum invariant.**
2. **Storage layer** — per-job envelope extension + global ndjson with dedicated lock, trim, partial-line repair. Tests: two concurrent appenders, trim on 10MB fixture, corrupted-last-line fixture, disk-full simulated via mock `fs.writeSync`.
3. **Render layer** — status summary + `/gemini:timing <id>` detail view. Tests: legacy job (timing absent), fallback warning rendering, null-segment omission.
4. **Aggregate layer** — `--history` + `--stats` with small-n suppression. Tests: n=5/n=19/n=20/n=99/n=100 boundaries; fallback rate math.

Each phase is independently testable; all merged together.

## Compatibility & Risk

- **Schema additivity**: `timing` is a new field; legacy jobs render `—`.
- **NDJSON schema drift (Gemini CLI)**: `tool_use`/`tool_result`/`error` event shapes aren't formally frozen. If a shape changes, segment accumulators stay at 0 and `streamMs` absorbs the time — degraded, not broken. Emit one debug log per unknown variant.
- **Invariant drift**: the `firstEventMs + ttftMs + streamMs + toolMs + retryMs + tailMs == totalMs` check runs only in tests (asserts with fixtures). At runtime, we record what we saw; a sum mismatch is logged but not fatal.
- **Token schema drift**: if `input_token_count` et al. vanish in a future CLI release, `tokensPerSec` becomes null. Never fabricate.
- **Lock contention across workspaces**: dedicated lock at global path. 10s acquire budget before dropping the record. Worker log shows drop reason.
- **Disk full**: ndjson append failure is caught; record is dropped with a log line; job still completes successfully.
- **`GEMINI_TELEMETRY_ENABLED=1`**: If the user has opted out via config, the env var is harmless (CLI ignores). If it enables telemetry beyond local stdout in some versions, verify during implementation and drop the env var if it causes network side-effects.
- **Privacy**: prompt/response content is NOT stored. Only byte size.
- **Performance**: 5 `Date.now()` calls + event dispatch + 1 ndjson append per job. < 2 ms overhead.

## Out of Scope (explicit, deferred to 0.6.1)

- Sync `callGemini` timing (wall-time only). Low traffic; adds noise to the v1 schema.
- Cross-plugin comparison `--compare codex`. Codex has no segment timing today; totals-only comparison was low-signal. Revisit after Codex plugin gains equivalent instrumentation.
- Live per-token rate during streaming.
- Historical backfill for pre-0.6.0 jobs.

## Success Criteria

After one week of real use, we should be able to answer:

1. For p50 and p95 `task` jobs, what is the share of cold / ttft / gen / tool / retry / tail?
2. How often (% of jobs) does silent Pro→Flash fallback occur? On which jobs (prompt size / duration buckets)?
3. What fraction of apparent latency is internal-retry delay masquerading as model slowness?
4. What fraction of apparent generation time is actually tool execution?
5. Do failed/timeout jobs cluster in a specific segment?
6. Is the cold-start breakdown (runtime / config / extensions) actionable — i.e., is one phase dominant and optimizable?

Only after these answers arrive do we design the optimization phase.

---

## Revision notes (v1 → v2)

**Blockers fixed**:
- Storage format realigned to `state.json + jobs/*.json` (Codex B1)
- Global ndjson now uses a dedicated lock, not state.mjs's bypass-prone one (Codex B2)
- Sync `callGemini` timing explicitly deferred to 0.6.1 — schema is streaming-only (Claude B2)
- `--compare codex` cut, `codex-compare.mjs` dropped (Claude B1 / Codex N6)
- Token field names corrected to `input_token_count` / `output_token_count` / `thoughts_token_count` (Gemini G4)
- Model attribution authoritative source is `result.per_model_usage`, not `init.model` (Gemini G3)

**Should-fix incorporated**:
- New `toolMs` segment — mid-stream tool execution no longer silently inflates `streamMs` (Gemini G1)
- New `retryMs` segment — internal 429/503/504 retries visible (Gemini G2)
- `tokensPerSec` includes `thoughts_token_count` (Gemini G6)
- `coldStartPhases[]` via `GEMINI_TELEMETRY_ENABLED=1` (Gemini G5, free value)
- Append-path partial-line repair before write (Claude S4)
- Percentile suppression at n<20 (p95) and n<100 (p99) (Claude S2)
- JSON shape examples for all modes (Claude S6)
- Cancel path timing semantics via `terminationReason` discriminator (Codex S4)

**Scope discipline**:
- ~330 → ~315 lines, but net signal density up (traded `codex-compare.mjs` for tool/retry/per_model accounting)
- 5 implementation phases → 4
