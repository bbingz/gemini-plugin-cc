# Changelog

## 0.5.0

### Streaming (Path A)
- Add `callGeminiStreaming()` — async spawn with `-o stream-json`, NDJSON line parser
- Background worker uses streaming directly (no CLI re-entry for task/ask)
- Foreground ask/task use streaming for live progress
- UTF-8 safe chunk decoding via StringDecoder
- Review commands stay on sync `callGemini` for schema enforcement

### Task Runtime (P1)
- Add `task` subcommand: --write, --resume-last, --fresh, --prompt-file, stdin
- Add `task-resume-candidate` subcommand for thread discovery
- Thread resumption via Gemini CLI `--resume` + persisted session_id
- Default continue prompt for `--resume-last` without explicit prompt
- Rescue command upgraded from `ask` to `task` with resume detection

### Job System (P1)
- Job phases: queued → starting → running → done/failed/cancelled
- `status --wait` with configurable timeout (default 4min) and poll interval
- Graceful cancel: SIGINT (500ms grace) then SIGTERM
- Follow-up hints in status/result output
- Cancel-aware atomic state update (prevents race overwrite)
- Streaming worker writes assistant deltas to log for live progress preview

### Review System (P0)
- Structured review context: staged/unstaged/untracked separated sections
- Commit log + diffstat + merge-base for branch reviews
- Review schema (`review-output.schema.json`) embedded in prompts
- New scopes: `--scope staged` and `--scope unstaged`
- Per-file 24KB limit for untracked files, SVG kept as text

### Infrastructure (P0)
- SessionEnd cleanup: scans ALL workspace state directories
- `loadState()` retry with backoff for partial-write resilience
- `stateRootDir()` exported for cross-workspace scanning
- Resume candidate scoped to current Claude session

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
