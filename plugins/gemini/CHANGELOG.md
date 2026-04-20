# Changelog

## 0.6.0 — 2026-04-20

### Added
- **Timing telemetry**: `callGeminiStreaming` now emits a `timing` object per job with 6 segments (cold / ttft / gen / tool / retry / tail), authoritative per-model usage from `per_model_usage` (catches silent Pro→Flash fallbacks), and optional `coldStartPhases` breakdown from `GEMINI_TELEMETRY_ENABLED=1`.
- **`/gemini:timing` command**: single-job detail view with ASCII bars, `--history` table (newest-first), `--stats` aggregate with p50/p95/p99 (suppressed at n<20 / n<100 respectively), and `--json` on all modes.
- **Global history**: all streaming jobs (background workers AND foreground `ask`/`task`) appended to `~/.claude/plugins/gemini/timings.ndjson` under a dedicated lock; partial-line repair on crash recovery; trimmed to newest 50% at 10 MB.
- **Status view**: finished jobs in `/gemini:status` now show a one-line timing summary (`cold X · ttft Y · gen Z · ...`).
- **Silent-fallback detection**: when `per_model_usage` shows more than one model entry, the single-job view flags `⚠ silent fallback detected`.
- **`terminationReason` discriminator** (`exit` / `timeout` / `signal` / `error`) with signal name captured for SIGINT/SIGTERM cancels.

### Notes
- Synchronous `callGemini` (review / adversarial-review) is NOT yet instrumented — deferred to 0.6.1.
- Cross-plugin comparison against Codex (`--compare codex`) deferred to 0.6.1 — Codex lacks segment timing, totals-only comparison was low-signal.
- Jobs completed before 0.6.0 render their timing row as omitted (not `—`).
- `invariantOk` is reported only on clean-exit jobs; `null` on timeout/signal/error paths (the model has inherent null segments that can't sum to total).

## 0.5.2 (2026-04-20)

### Aligned with codex-plugin-cc v1.0.4 (PR #234/#235)
- `commands/rescue.md`: route through `Agent` tool explicitly instead of relying on subagent fork
  - Drop `context: fork` — fork doesn't expose the `Agent` tool
  - `allowed-tools` now includes `AskUserQuestion, Agent`
  - Explicit warning against `Skill(gemini:rescue)` recursion (skill and command share the name)

### Engram Integration
- Add Engram sidecar writer: `writeEngramSidecar()` writes `{sessionId}.engram.json` alongside Gemini session files
- Sidecar links Gemini CLI sessions back to parent Claude Code session via `GEMINI_COMPANION_SESSION_ID`
- Project directory resolved from `~/.gemini/projects.json` (longest prefix match)
- Integrated into both `callGemini()` (sync) and `callGeminiStreaming()` (async)
- Fail-open: sidecar write errors never affect main flow

### Fixes
- Prevent Gemini CLI `modelSteering` from silently swapping models: always pass `-m` explicitly, falling back to `~/.gemini/settings.json` default when caller omits it

## 0.5.1 (2026-04-18)

Aligned with codex-plugin-cc v1.0.3. Two security/scope fixes surfaced by reviewing
OpenAI's upstream patches against our parallel implementation.

### Security
- Quote `$ARGUMENTS` in all command `.md` shell invocations (ask/review/cancel/status/setup/result/adversarial-review). Unquoted `$ARGUMENTS` allowed shell-metacharacter injection via user input (e.g. `; rm -rf /`). Matches codex-plugin-cc PR #168.

### Job Session Scope
- `resolveCancelableJob` now scopes default (no job-id) target to the current Claude session via `CLAUDE_SESSION_ID`. Explicit `cancel <job-id>` still matches across sessions for precise targeting. Matches codex-plugin-cc PR #84.
- `resolveResumeCandidate` switched from soft-scope (fallback to any session) to hard-scope (current session only). Prevents implicit resume of another Claude session's Gemini thread after crash/restart. Matches codex-plugin-cc PR #83.

## 0.5.0

### Streaming (Path A)
- Add `callGeminiStreaming()` — async spawn with `-o stream-json`, NDJSON line parser
- Background worker uses streaming directly (no CLI re-entry for task/ask)
- Foreground ask/task use streaming for live progress
- UTF-8 safe chunk decoding via StringDecoder
- Review commands stay on sync `callGemini` for schema enforcement

### Task Runtime (P1)
- Add `task` subcommand: --write, --resume-last, --fresh, --prompt-file, stdin
- Add `task-resume-candidate` subcommand for thread discovery
- Thread resumption via Gemini CLI `--resume` + persisted session_id
- Default continue prompt for `--resume-last` without explicit prompt
- Rescue command upgraded from `ask` to `task` with resume detection

### Job System (P1)
- Job phases: queued → starting → running → done/failed/cancelled
- `status --wait` with configurable timeout (default 4min) and poll interval
- Graceful cancel: SIGINT (500ms grace) then SIGTERM
- Follow-up hints in status/result output
- Cancel-aware atomic state update (prevents race overwrite)
- Streaming worker writes assistant deltas to log for live progress preview

### Review System (P0)
- Structured review context: staged/unstaged/untracked separated sections
- Commit log + diffstat + merge-base for branch reviews
- Review schema (`review-output.schema.json`) embedded in prompts
- New scopes: `--scope staged` and `--scope unstaged`
- Per-file 24KB limit for untracked files, SVG kept as text

### Infrastructure (P0)
- SessionEnd cleanup: scans ALL workspace state directories
- `loadState()` retry with backoff for partial-write resilience
- `stateRootDir()` exported for cross-workspace scanning
- Resume candidate scoped to current Claude session

## 0.3.0

- Add adversarial-review command with dedicated prompt template
- Add stop-review-gate hook (Stop event)
- Add rescue command for task delegation via gemini-agent
- Add --effort parameter support
- Add prompts/ directory with review and gate templates
- Add prompting skill reference files (recipes, antipatterns, blocks)
- Fix command frontmatter: add disable-model-invocation where needed
- Fix agent skills format to YAML list

## 0.2.0

- Add background task system (--background flag for ask/review)
- Add status, result, cancel commands
- Add gemini-agent subagent
- Add 3 internal skills (cli-runtime, result-handling, prompting)
- Add review-output schema
- Upgrade state.mjs: workspace-keyed dirs, job storage, file locking

## 0.1.0

- Initial release: setup, ask, review commands
- Gemini CLI wrapper with stdout noise handling
- Git diff collection with scope support
- Session lifecycle hooks
