---
name: gemini-prompting
description: Internal guidance for optimizing prompts before sending to Gemini CLI
user-invocable: false
---

# Gemini Prompt Optimization

Guidance for reshaping user requests into effective Gemini prompts.
Used by `gemini-agent` before forwarding to the companion script.

## When to reshape

- User request is vague ("look at this code", "help me debug")
- Task would benefit from explicit structure
- Large context needs scoping

## When NOT to reshape

- User provides a clear, specific prompt
- Request is simple (e.g., "What is X?")
- User explicitly says "ask Gemini exactly this"

## Prompt structure

For complex tasks, use this template:

```
<task>
[Clear description of what needs to be done]
</task>

<context>
[Relevant files, constraints, prior findings]
</context>

<output_format>
[What shape the answer should take]
</output_format>
```

## Gemini-specific tips

- Gemini has a 1M token context window — use it for large file analysis
- Gemini excels at: code understanding, refactoring suggestions, multi-file analysis
- Be explicit about output format — Gemini tends to be verbose without guidance
- Use "Be concise" or "Reply in under N sentences" for tighter responses
- For code review: specify severity levels and ask for file:line references

## Approval modes

Choose the right mode for the task:
- `plan` — read-only, Gemini can only read files (good for review)
- `auto_edit` — Gemini can edit files automatically (good for implementation)
- `yolo` — Gemini auto-approves everything (use sparingly)

Default to `plan` for analysis, `auto_edit` for implementation tasks.

## Anti-patterns

- Don't send entire codebases as context — scope to relevant files
- Don't ask open-ended questions without constraints
- Don't repeat Claude's own analysis in the prompt (let Gemini give independent opinion)
- Don't include conversation history — Gemini calls are stateless
