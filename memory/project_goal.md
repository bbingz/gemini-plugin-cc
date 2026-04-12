---
name: Project Goal
description: Gemini CLI plugin for Claude Code — goals, scope, v1/v2 split after Codex review
type: project
---

Building a Claude Code plugin that integrates Google Gemini CLI as an on-demand subagent.

**Why:** User wants to call Gemini for code review, task delegation, and second opinions without Gemini running as a persistent MCP server (which would waste context).

**How to apply:**
- Plugin architecture informed by Codex plugin, but not blind 1:1 copy
- v1 scope (after Codex review): foreground-only `setup/ask/review` — 3 commands
- v2 scope: background tasks (status/result/cancel), agents, skills, adversarial review
- Key simplification: Gemini CLI is direct `spawnSync`, no JSON-RPC/app-server needed
- Implementation sequence: prove minimal command path first, then layer on complexity
- Codex reviewed the plan (2026-04-12) — key feedback: reduce scope, verify CLI assumptions, fix error handling gaps. All addressed in revised plan.
