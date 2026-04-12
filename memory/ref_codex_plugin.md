---
name: Codex Plugin Reference
description: Structure and patterns from the Codex plugin at ~/.claude/plugins/cache/openai-codex/codex/1.0.0/
type: reference
---

Codex plugin location: `~/.claude/plugins/cache/openai-codex/codex/1.0.0/`

**Key structure to replicate:**
- `.claude-plugin/plugin.json` — `{ name, description, author }`, minimal
- `commands/*.md` — YAML frontmatter with description, argument-hint, allowed-tools, disable-model-invocation
- `agents/*.md` — subagent definitions, tools list, skills list
- `skills/*/SKILL.md` — internal (non-user-invocable) skills
- `hooks/hooks.json` — SessionStart, SessionEnd, Stop hooks
- `schemas/review-output.schema.json` — structured output contract
- `scripts/codex-companion.mjs` — main entry, all commands delegate here

**Codex commands:** setup, review, adversarial-review, rescue, cancel, status, result (7 total)
**Gemini commands (planned):** setup, ask, review, status (4 total — simpler scope)

**Key pattern:** Commands are `.md` files that tell Claude to invoke the companion script via Bash. The companion script does the actual work (CLI calls, output parsing, job management).
