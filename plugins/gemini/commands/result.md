---
description: Retrieve the full output of a completed Gemini job
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" result $ARGUMENTS --json
```

Present the full result verbatim. Preserve the original structure:
- verdict/summary/findings/next-steps if it's a review
- full response text if it's an ask

If the job has findings, present them ordered by severity.
Do NOT auto-fix any issues. Ask the user which issues to address.
