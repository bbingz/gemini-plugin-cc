---
description: Run a Gemini code review on the current diff
argument-hint: '[--wait|--background] [--base <ref>] [--scope <auto|working-tree|staged|unstaged|branch>] [--model <model>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review --json "$ARGUMENTS"
```

Present the review output to the user.

If the diff was truncated, warn the user that some changes were not covered.

If no changes were found, tell the user there is nothing to review.

If the review found issues:
- Present all findings verbatim, ordered by severity.
- Do NOT auto-fix any issues. Ask the user which issues they want to address.

If `/review` (Claude's own review) was already run earlier in this conversation,
compare the two sets of findings:
- Both found: findings that overlap
- Only Gemini found: unique to Gemini
- Only Claude found: unique to Claude's review
