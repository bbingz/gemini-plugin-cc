---
name: gemini-result-handling
description: Internal guidance for presenting Gemini helper output back to the user
user-invocable: false
---

# Gemini Result Handling

Rules for presenting Gemini output back to the user.

## Structure preservation

- Preserve verdict, summary, findings, and next-steps structure
- For review output: present findings first, ordered by severity
- Use file paths and line numbers exactly as reported by Gemini
- Keep findings ordered by severity: critical → high → medium → low

## Evidence boundaries

- Mark what is fact vs. inference vs. follow-up question
- Keep residual-risk notes brief
- State explicitly if there are no findings
- State explicitly if Gemini made edits and list touched files

## CRITICAL: Do not auto-fix

After presenting review findings: **STOP.**

- Do NOT make code changes
- Do NOT fix issues automatically
- Explicitly ask the user which issues they want fixed
- Auto-applying fixes is strictly forbidden

This matches the Codex plugin's behavior — the user decides what to act on.

## Error handling

- If Gemini returns malformed output: include the most actionable stderr
  lines and stop. Do not guess.
- If Gemini is not set up: direct user to `/gemini:setup`.
  Do not improvise alternate flows.
- If a background job failed: report the failure and stop.
  Do NOT generate a substitute answer from Claude.

## Token stats

When displaying results, include the token stats footer:
`Model: <name> | Tokens: <total> (input: <input>, cached: <cached>) | Latency: <ms>ms`
