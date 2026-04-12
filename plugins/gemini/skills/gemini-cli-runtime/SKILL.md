---
name: gemini-cli-runtime
description: Internal helper contract for calling the gemini-companion runtime from Claude Code
user-invocable: false
---

# Gemini CLI Runtime Contract

This skill defines how `gemini-agent` (the subagent) interacts with the
Gemini companion script. Only invoked from within `gemini-agent`.

## Primary helper

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task "<prompt>" --json
```

## Commands available to the agent

Only `task` should be used from the agent. Other commands are user-facing:

| Command | Used by agent? | Purpose |
|---------|---------------|---------|
| `task` | Yes | Delegate work with full runtime support |
| `ask` | Fallback | Simple question (no thread tracking) |
| `task-resume-candidate` | Yes | Check if resumable thread exists |
| `setup` | No | User checks installation |
| `review` | No | User triggers code review |
| `status` | No | User checks job status |
| `result` | No | User fetches completed output |
| `cancel` | No | User cancels background job |

## Routing controls

These are CLI flags, not task text:

- `--background` — run async, return job ID immediately
- `--write` — allow Gemini to modify files (maps to `--approval-mode auto_edit`)
- `--resume-last` — continue previous Gemini thread
- `--fresh` — start new thread (ignore previous)
- `--model <model>` — override the default model
- `--effort <low|medium|high>` — reasoning effort level
- `--prompt-file <path>` — read prompt from file instead of positional args
- `--json` — always use this for machine-readable output

## Safety rules

- **Preserve task text as-is.** Only reshape via `gemini-prompting` skill.
- **Never inspect the repo** from the agent. Claude does that.
- **Return stdout exactly.** No independent analysis.
- **Return nothing** if invocation fails (let Claude handle the error).
