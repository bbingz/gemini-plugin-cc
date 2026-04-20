# Changelog

## 0.6.0 — 2026-04-20

Add timing telemetry for streaming Gemini calls. Each job now emits a 6-segment breakdown (cold-start / ttft / generation / tool-exec / retry / tail), with authoritative per-model usage (catches silent Pro→Flash fallbacks) and optional cold-start phase decomposition from `GEMINI_TELEMETRY_ENABLED=1`. New `/gemini:timing` command with single-job / history / stats modes and `--json` on all. Global append-only history at `~/.claude/plugins/gemini/timings.ndjson` (both background worker and foreground ask/task). Sync `callGemini` (review) timing and cross-plugin Codex comparison deferred to 0.6.1.
