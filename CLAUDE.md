# Gemini Plugin for Claude Code

Claude Code 插件，将 Google Gemini CLI 集成为按需调用的子代理。~95% Codex 对齐。

## 项目状态

- **版本**: 0.6.0 (timing telemetry — 6-segment breakdown + `/gemini:timing` + global history)
- **GitHub**: https://github.com/bbingz/gemini-plugin-cc
- **安装**: `claude plugin marketplace add bbingz/gemini-plugin-cc && claude plugin install gemini`
- **Codex 对齐**: ~95% (实测 CLI 冷启动 p50 ≈ 8.7s，占总时长 41%，等 Google daemon mode PR)
- **可观测性**: 每次 streaming 调用 6 段耗时自动入 `timings.ndjson` 全局历史

## 目录结构

```
plugins/gemini/                    # 插件主体
  .claude-plugin/plugin.json       # 插件身份 + 版本
  agents/gemini-agent.md           # 子代理 (使用 task 命令)
  commands/                        # 用户命令
    setup.md                       # /gemini:setup — 安装检查 + review gate
    ask.md                         # /gemini:ask — 向 Gemini 提问 (streaming)
    review.md                      # /gemini:review — 代码审查 (sync, schema 强制)
    adversarial-review.md          # /gemini:adversarial-review — 对抗性审查
    rescue.md                      # /gemini:rescue — 任务委派 (支持 --resume-last)
    status.md                      # /gemini:status — 后台任务状态 (支持 --wait, 自带 timing summary)
    result.md                      # /gemini:result — 获取完成输出 (带 timing 字段)
    cancel.md                      # /gemini:cancel — 取消后台任务 (SIGINT)
    timing.md                      # /gemini:timing — 耗时细分 (single / --history / --stats)
  hooks/hooks.json                 # SessionStart / SessionEnd / Stop
  prompts/                         # Prompt 模板
  schemas/review-output.schema.json # Review 输出 JSON schema
  scripts/
    gemini-companion.mjs           # 主入口 (async, 所有命令路由)
    session-lifecycle-hook.mjs     # 会话生命周期 (全 workspace 扫描清理)
    stop-review-gate-hook.mjs      # Stop 审查门控
    lib/
      args.mjs                     # 参数解析
      gemini.mjs                   # callGemini (sync) + callGeminiStreaming (async, w/ TimingAccumulator 埋点)
      git.mjs                      # 结构化 review context + getDiff + scope
      job-control.mjs              # streaming worker + phases + wait + cancel + timing 持久化
      process.mjs                  # 子进程管理
      prompts.mjs                  # 模板加载
      render.mjs                   # 输出格式化 + follow-up hints + markdown-safe timing block
      state.mjs                    # 配置/状态持久化 (workspace-keyed + file locking + timings.ndjson)
      timing.mjs                   # TimingAccumulator 纯类 + dispatchTimingEvent + bar/percentile/aggregate render
  skills/
    gemini-cli-runtime/SKILL.md    # 运行时契约 (task 命令)
    gemini-result-handling/SKILL.md # 输出呈现规则
    gemini-prompting/              # Prompt 优化 + references
  CHANGELOG.md
  LICENSE

tests/                             # node:test, zero deps (since v0.6.0)
  smoke.test.mjs                   # 测试框架验证
  timing-accumulator.test.mjs      # TimingAccumulator 单测 (20)
  timing-dispatch.test.mjs         # 事件路由单测 (14)
  timing-render.test.mjs           # Bar/summary/single-job detail 单测 (9)
  timing-aggregate.test.mjs        # percentile/stats/history 单测 (11)
  timing-storage.test.mjs          # ndjson lock/trim/concurrent 单测 (5)
```

## 开发约定

### 语言与运行时
- Node.js ESM (`.mjs`)
- 无外部依赖 — 仅使用 Node.js 内置模块
- 与 Codex 插件保持风格一致

### Gemini CLI 调用模式

**Streaming (task/ask):**
```bash
gemini -p "prompt" -o stream-json --approval-mode auto_edit
```
- 输出 NDJSON: init → message(user) → message(assistant, delta) → result
- 第一行有噪声前缀，需要找 `{` 截取

**Sync (review):**
```bash
gemini -p "prompt" -o json --approval-mode plan
```
- 输出完整 JSON，用于 schema 强制

### 命令规范
- 命令文件为 `.md`，含 YAML frontmatter
- review 类命令需要 `disable-model-invocation: true`
- ask/task 使用 callGeminiStreaming (async)
- review 使用 callGemini (sync)
- 后台任务: streaming worker 直接调 API（不走 CLI re-entry）

### 参考实现
- Codex 插件: `~/.claude/plugins/cache/openai-codex/codex/1.0.0/`

## 常用开发命令

```bash
# 测试 companion 脚本
node plugins/gemini/scripts/gemini-companion.mjs setup --json
node plugins/gemini/scripts/gemini-companion.mjs ask "What is 2+2?" --json
node plugins/gemini/scripts/gemini-companion.mjs task "test" --json
node plugins/gemini/scripts/gemini-companion.mjs task --resume-last --json
node plugins/gemini/scripts/gemini-companion.mjs task-resume-candidate --json
node plugins/gemini/scripts/gemini-companion.mjs review --json
node plugins/gemini/scripts/gemini-companion.mjs adversarial-review --json

# 后台任务测试
node plugins/gemini/scripts/gemini-companion.mjs task --background "test" --json
node plugins/gemini/scripts/gemini-companion.mjs status --json
node plugins/gemini/scripts/gemini-companion.mjs status <job-id> --wait --json
node plugins/gemini/scripts/gemini-companion.mjs result --json

# Timing 观测 (v0.6.0)
node plugins/gemini/scripts/gemini-companion.mjs timing <job-id>          # 单任务 ASCII 细分
node plugins/gemini/scripts/gemini-companion.mjs timing --history --json  # 历史表
node plugins/gemini/scripts/gemini-companion.mjs timing --stats --json    # p50/p95/p99 聚合

# 单元测试
node --test 'tests/*.test.mjs'

# 更新已安装的插件
claude plugin marketplace update gemini-plugin
claude plugin update gemini@gemini-plugin
```

## 架构限制

### 当前 (~95% Codex 对齐)
- CLI stream-json 提供实时流式输出
- **实测冷启动 p50 = 8.7s**（非早期估计的 2-3s；n=10 baseline 见 `memory/data_timing_baseline.md`）
- 完整 6 段 timing 观测：cold / ttft / gen / tool / retry / tail

### 不可行 (需要 Google 支持)
- 零冷启动 — 等 Google daemon mode PR (#15338)
- 双向工具回调 — CLI 封闭循环
- 原生 review API — 只能 prompt engineering 模拟

### 已评估放弃的方案
- **v1internal 直调**: cloudcode-pa.googleapis.com 内部 API，违反 Google TOS
- **API Key 路线**: 免费额度太少 (250次/天 Flash)，Pro 已移出免费层
