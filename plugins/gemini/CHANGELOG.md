# Changelog

## 0.3.0

- Add adversarial-review command with dedicated prompt template
- Add stop-review-gate hook (Stop event)
- Add rescue command for task delegation via gemini-agent
- Add --effort parameter support
- Add prompts/ directory with review and gate templates
- Add prompting skill reference files (recipes, antipatterns, blocks)
- Fix command frontmatter: add disable-model-invocation where needed
- Fix agent skills format to YAML list

## 0.2.0

- Add background task system (--background flag for ask/review)
- Add status, result, cancel commands
- Add gemini-agent subagent
- Add 3 internal skills (cli-runtime, result-handling, prompting)
- Add review-output schema
- Upgrade state.mjs: workspace-keyed dirs, job storage, file locking

## 0.1.0

- Initial release: setup, ask, review commands
- Gemini CLI wrapper with stdout noise handling
- Git diff collection with scope support
- Session lifecycle hooks
