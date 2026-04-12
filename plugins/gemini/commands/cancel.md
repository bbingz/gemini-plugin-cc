---
description: Cancel an active Gemini background job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" cancel $ARGUMENTS --json
```

Report whether the job was successfully cancelled.
If no active job was found, tell the user.
