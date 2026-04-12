---
description: Delegate investigation, an explicit fix request, or follow-up work to the Gemini rescue subagent
argument-hint: "[--background|--wait] [--resume-last|--fresh] [--write] [--model <model>] [--effort <low|medium|high>] [what Gemini should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*)
---

Route this request to the `gemini:gemini-agent` subagent.
The final user-visible response must be Gemini's output verbatim.

Raw user request:
$ARGUMENTS

Resume detection:
- Before dispatching, check if there is a resumable Gemini session:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task-resume-candidate --json
  ```
- If `available: true` and the user did NOT pass `--fresh`:
  Ask the user whether to continue the previous thread or start fresh.
  Prepend `--resume-last` or `--fresh` based on their choice.
- If the user already passed `--resume-last` or `--fresh`, skip this step.

Execution mode:
- If the request includes `--background`, run the subagent in the background.
- If the request includes `--wait`, run the subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags. Do not forward them to `task`.
- `--model`, `--effort`, `--write`, `--resume-last`, `--fresh` are runtime flags. Preserve them.

Operating rules:
- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Gemini companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary.
- Do not ask the subagent to inspect files, monitor progress, poll status, or do follow-up work.
- If the user did not supply a request AND `--resume-last` is present, proceed with the default continue prompt (the task runtime handles this).
- If the user did not supply a request AND no `--resume-last`, ask what Gemini should investigate or fix.
