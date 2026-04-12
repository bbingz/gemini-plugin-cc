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
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" ask "<prompt>" --json
```

## Commands available to the agent

Only `ask` should be used from the agent. Other commands are user-facing:

| Command | Used by agent? | Purpose |
|---------|---------------|---------|
| `ask` | Yes | Delegate task, ask question |
| `setup` | No | User checks installation |
| `review` | No | User triggers code review |
| `status` | No | User checks job status |
| `result` | No | User fetches completed output |
| `cancel` | No | User cancels background job |

## Routing controls

These are CLI flags, not task text:

- `--background` — run async, return job ID immediately
- `--model <model>` — override the default model
- `--approval-mode <mode>` — `plan` (read-only), `auto_edit`, `yolo`
- `--json` — always use this for machine-readable output

## Safety rules

- **Preserve task text as-is.** Only reshape via `gemini-prompting` skill.
- **Never inspect the repo** from the agent. Claude does that.
- **Return stdout exactly.** No independent analysis.
- **Return nothing** if invocation fails (let Claude handle the error).
