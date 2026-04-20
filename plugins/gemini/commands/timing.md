---
description: Show timing breakdown for Gemini jobs (cold / ttft / gen / tool / retry)
argument-hint: '[job-id] [--history] [--stats] [--kind task|ask] [--last N] [--since ISO] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" timing "$ARGUMENTS" --json
```

Render the timing output to the user as a human-readable view:
- If a single job was requested, show the detailed breakdown with bars.
- If `--history` was requested, show the tabular history.
- If `--stats` was requested, show the aggregate percentile table.
- If `fallback: true` is present, call out the silent model fallback prominently.
- If no timing data exists for the requested scope, say "No timing data yet — run a task first."
