# Changelog

## docs(alignment/kimi) — 2026-04-22

Record kimi alignment loop-close in `docs/alignment/kimi.md` §8. Kimi merged `kimi-plugin-cc@8e18587` (10 files, +617/−46): applied P0 (dead timing read path removed) + P3 (command contract normalization) + §5.2/§5.3/§5.5 clarifications (auth boundary, Phase-5 timing gate, prompts.mjs rationale); deferred P1 (blocked on kimi-cli 1.37 per-model re-probe) + P2 (pairs with v0.2 timing path); intentionally skipped `gfg-` foreground-job prefix. Also captured two factual corrections to our 2026-04-21 report (§2 首行噪声截取 N/A for kimi — gemini-CLI-only quirk; "Phase 1 in progress" was stale sub-CHANGELOG drift) and logged three inputs for next baseline.md iteration.

## docs — 2026-04-22

Record minimax v0.1.2 alignment loop-close in `docs/alignment/minimax.md` §9. MiniMax side accepted P0 (timing) / P2 (hook cleanup) / P3 (`/minimax:timing`) as v0.1.3 tentative scope, flagged P1 (served-model attestation) as upstream-limited until Mini-Agent exposes the field, kept P4 (inline test style) as-is. Also fixed 1 Critical + 4 High + 1 Medium from our review round with +3 regression tests (86 pass / 0 fail).

## 0.6.0 — 2026-04-20

Add timing telemetry for streaming Gemini calls. Each job now emits a 6-segment breakdown (cold-start / ttft / generation / tool-exec / retry / tail), with authoritative per-model usage (catches silent Pro→Flash fallbacks) and optional cold-start phase decomposition from `GEMINI_TELEMETRY_ENABLED=1`. New `/gemini:timing` command with single-job / history / stats modes and `--json` on all. Global append-only history at `~/.claude/plugins/gemini/timings.ndjson` (both background worker and foreground ask/task). Sync `callGemini` (review) timing and cross-plugin Codex comparison deferred to 0.6.1.
