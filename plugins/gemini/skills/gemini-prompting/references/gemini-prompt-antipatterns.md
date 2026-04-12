# Gemini Prompt Anti-Patterns

Avoid these when prompting Gemini.

## Vague task framing

Bad:

```text
Take a look at this and let me know what you think.
```

Better:

```xml
<task>
Review this change for material correctness and regression risks.
</task>
```

## Missing output contract

Bad:

```text
Investigate and report back.
```

Better:

```xml
<structured_output_contract>
Return:
1. root cause
2. evidence
3. smallest safe next step
</structured_output_contract>
```

## No follow-through default

Bad:

```text
Debug this failure.
```

Better:

```xml
<default_follow_through_policy>
Keep going until you have enough evidence to identify the root cause confidently.
</default_follow_through_policy>
```

## Mixing unrelated jobs into one run

Bad:

```text
Review this diff, fix the bug you find, update the docs, and suggest a roadmap.
```

Better: Run review first. Run a separate fix prompt if needed. Use a third run for docs.

## Unsupported certainty

Bad:

```text
Tell me exactly why production failed.
```

Better:

```xml
<grounding_rules>
Ground every claim in the provided context or tool outputs.
If a point is an inference, label it clearly.
</grounding_rules>
```

## Gemini-specific: not scoping the context

Bad: Sending the entire repo contents as a single prompt.

Better: Scope to the relevant files and directories. Even with 1M tokens, focused context produces better results.

## Gemini-specific: expecting tool use in plan mode

Bad: Asking Gemini to run tests or edit files when `--approval-mode plan` is set.

Better: Use `--approval-mode auto_edit` for tasks that require tool use, `plan` for read-only analysis.
