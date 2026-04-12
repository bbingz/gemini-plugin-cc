---
name: Gemini CLI Info
description: Gemini CLI v0.37.1 — verified output formats, auth detection, approval modes, and gotchas
type: reference
---

Gemini CLI v0.37.1, installed at `/opt/homebrew/bin/gemini` (npm: `@google/gemini-cli`)

**Default model:** `gemini-3.1-pro-preview` (NOT 2.5-pro)

**Headless invocation:**
```bash
gemini -p "prompt" -o json --approval-mode plan
```

**Key flags:**
- `-p / --prompt` — non-interactive headless mode
- `-o / --output-format` — `text`, `json`, `stream-json`
- `-y / --yolo` — auto-approve all tool calls (**don't use as default**)
- `--approval-mode` — `default`, `auto_edit`, `yolo`, `plan` (prefer `plan` for review)
- `-m / --model` — model selection
- `--include-directories` — expand workspace access
- `-r / --resume` — resume previous session

**JSON output (verified):**
- Success stdout: noise prefix + `{ session_id, response, stats }` — must find first `{` to parse
- Error stderr: stack trace + `{ session_id, error: { type, message, code } }`
- Exit codes: 0=success, 1=error

**stream-json output (verified):**
- JSONL: `{type:"init"}`, `{type:"message",role:"user"}`, `{type:"message",role:"assistant",delta:true}`, `{type:"result",status:"success",stats:{...}}`

**stdout noise:** "MCP issues detected..." printed before JSON — must strip.
**stderr noise:** "YOLO mode enabled", "Skill conflict detected" — informational, ignore.

**Auth:** OAuth creds at `~/.gemini/oauth_creds.json`. Check file existence + test call for detection.
**Config:** `~/.gemini/settings.json` — user has `defaultApprovalMode: "plan"`.
