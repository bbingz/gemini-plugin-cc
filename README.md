# Gemini Plugin for Claude Code

A Claude Code plugin that integrates Google Gemini CLI for code review and task delegation.

## Prerequisites

- [Claude Code](https://claude.ai/code)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`npm install -g @google/gemini-cli`)
- Authenticated Gemini CLI (run `gemini` interactively once to log in)

## Install

```bash
# From this repository
claude plugins add ./plugins/gemini
```

## Commands

### `/gemini:setup`

Check Gemini CLI installation and authentication status.

```
/gemini:setup
```

### `/gemini:ask`

Delegate a task or ask a question to Gemini.

```
/gemini:ask What does the function foo() in src/bar.ts do?
/gemini:ask --model gemini-2.5-flash Summarize this codebase
```

### `/gemini:review`

Run a Gemini code review on the current diff.

```
/gemini:review
/gemini:review --scope branch
/gemini:review --base main focus on security
```

**Options:**
- `--base <ref>` — Base branch for diff (default: auto-detected)
- `--scope <auto|working-tree|branch>` — What to review (default: auto)
- `--model <model>` — Gemini model to use

## How It Works

The plugin calls Gemini CLI in headless mode (`gemini -p "..." -o json`) and presents the structured response. No persistent processes, no MCP server — each call is independent.

**Review flow:**
1. Collects `git diff` based on scope
2. Sends diff to Gemini with review instructions
3. Presents findings ordered by severity
4. Does NOT auto-fix — asks which issues to address

## Architecture

```
plugins/gemini/
├── .claude-plugin/plugin.json     # Plugin identity
├── commands/                       # Slash command definitions
│   ├── setup.md                   # /gemini:setup
│   ├── ask.md                     # /gemini:ask
│   └── review.md                  # /gemini:review
├── hooks/hooks.json               # Session lifecycle hooks
└── scripts/
    ├── gemini-companion.mjs       # Main entry point
    ├── session-lifecycle-hook.mjs # Session management
    └── lib/
        ├── args.mjs               # Argument parsing
        ├── gemini.mjs             # Gemini CLI wrapper
        ├── git.mjs                # Git diff collection
        ├── process.mjs            # Process management
        ├── render.mjs             # Output formatting
        └── state.mjs              # Configuration persistence
```

## License

MIT
