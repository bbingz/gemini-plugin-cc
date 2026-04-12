---
name: Project Goal
description: Gemini CLI plugin for Claude Code — v1 shipped and verified working
type: project
---

Claude Code plugin integrating Google Gemini CLI as an on-demand subagent. **v1 shipped 2026-04-12.**

**Status:** v1 complete, installed, and verified in live Claude Code session.
- `/gemini:setup` — Ready (gemini-3.1-pro-preview, auth OK)
- `/gemini:ask` — working (tested "What is 2+2?")
- `/gemini:review` — working (tested on real git diffs)

**Installation:** Local marketplace at `/Users/bing/-Code-/gemini-plugin-cc/`, installed via `claude plugin marketplace add` + `claude plugin install gemini`.

**Architecture:** Companion script pattern (like Codex plugin). 1051 lines across 15 files. No external deps.

**Reviews completed:**
- Gemini self-review: 6 findings, 4 fixed (parseCommandInput, E2BIG, stderr parsing, auth detection)
- Codex review: 3 findings, 3 fixed (auto scope misses working tree, silent main fallback, untracked files invisible)

**Next:** v2 features — background tasks (status/result/cancel), agents, skills, adversarial review. See doc/PLAN.md "v2 TODO" section.
