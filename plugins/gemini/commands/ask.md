---
description: Delegate a task or ask a question to Gemini
argument-hint: '[--model <model>] <prompt>'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" ask "$ARGUMENTS"
```

If the result is an error, present it to the user with guidance.

If the result is successful:
- Present Gemini's full response verbatim.
- After presenting, note any points where your own analysis differs from Gemini's.
  If there is a disagreement, flag it: "Note: Claude disagrees on X because Y."
- Do NOT auto-apply any suggestions. Ask the user which items to act on.
