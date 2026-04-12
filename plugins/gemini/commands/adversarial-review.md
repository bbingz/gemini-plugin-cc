---
description: Run a Gemini review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Gemini review through the shared plugin runtime.
This challenges the chosen implementation, design choices, tradeoffs, and assumptions.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Gemini's output verbatim.

Execution mode rules:
- If the raw arguments include `--wait`, run in the foreground.
- If the raw arguments include `--background`, run in a Claude background task.
- Otherwise, estimate the review size:
  - For working-tree review: `git status --short --untracked-files=all`
  - For base-branch review: `git diff --shortstat <base>...HEAD`
  - Recommend background for anything beyond 1-2 files.
- Then use `AskUserQuestion` exactly once with two options:
  - `Wait for results (Recommended)` or `Run in background (Recommended)` based on size estimate
  - The non-recommended option second

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" adversarial-review $ARGUMENTS --json
```
Return the output verbatim. Do not fix any issues.

Background flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" adversarial-review --background $ARGUMENTS --json
```
After launching: "Gemini adversarial review started in the background. Check `/gemini:status` for progress."
