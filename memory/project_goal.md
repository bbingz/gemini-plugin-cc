---
name: Project Goal
description: Gemini CLI plugin for Claude Code — goals, scope, and key design decisions
type: project
---

Building a Claude Code plugin that integrates Google Gemini CLI as an on-demand subagent.

**Why:** User wants to call Gemini for code review, task delegation, and second opinions without Gemini running as a persistent MCP server (which would waste context).

**How to apply:**
- Plugin architecture follows Codex plugin conventions (companion script + commands + agents + skills)
- Core difference: Gemini CLI is stateless (`gemini -p ... -o json`), no JSON-RPC/app-server needed
- ~500 lines expected vs Codex's ~2000 — keep it simple
- Four commands: setup, ask, review, status
- One subagent: gemini-agent (like codex:codex-rescue)
- Gemini's 1M token window is a key differentiator for large file analysis
