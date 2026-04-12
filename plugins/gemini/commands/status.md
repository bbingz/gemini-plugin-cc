---
description: Show active and recent Gemini background jobs
argument-hint: '[job-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" status $ARGUMENTS --json
```

Present the status output to the user as a formatted table.

If a specific job ID is provided, show detailed status for that job.
If no jobs exist, tell the user there are no Gemini jobs.
If a job is running, show the progress preview.
