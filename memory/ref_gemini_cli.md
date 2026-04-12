---
name: Gemini CLI Info
description: Gemini CLI v0.37.1 installation, flags, and headless invocation patterns
type: reference
---

Gemini CLI v0.37.1, installed at `/opt/homebrew/bin/gemini` (npm: `@google/gemini-cli`)

**Headless invocation:**
```bash
gemini -p "prompt" -o json -y
```

**Key flags:**
- `-p / --prompt` — non-interactive headless mode
- `-o / --output-format` — `text`, `json`, `stream-json`
- `-y / --yolo` — auto-approve all tool calls
- `-m / --model` — model selection (default: gemini-2.5-pro)
- `--include-directories` — expand workspace access
- `-r / --resume` — resume previous session
- `--approval-mode` — `default`, `auto_edit`, `yolo`, `plan`

**File references:** Use `@file` syntax in prompts to include file content.

**Stdin support:** Can pipe data via stdin, appended after `-p` prompt.
