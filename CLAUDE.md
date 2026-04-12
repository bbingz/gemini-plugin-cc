# Gemini Plugin for Claude Code

Claude Code 插件，将 Google Gemini CLI 集成为按需调用的子代理。对标 Codex 插件架构，89% 对齐 (33/37 文件，差 4 个是 Codex JSON-RPC 专用)。

## 项目状态

- **版本**: 0.3.0 (v3 — full Codex alignment)
- **GitHub**: https://github.com/bbingz/gemini-plugin-cc
- **安装**: `claude plugin marketplace add bbingz/gemini-plugin-cc && claude plugin install gemini`

## 目录结构

```
plugins/gemini/                    # 插件主体 (33 文件)
  .claude-plugin/plugin.json       # 插件身份 + 版本
  agents/gemini-agent.md           # 子代理 (对标 codex-rescue)
  commands/                        # 8 个用户命令
    setup.md                       # /gemini:setup — 安装检查 + review gate
    ask.md                         # /gemini:ask — 向 Gemini 提问
    review.md                      # /gemini:review — 代码审查
    adversarial-review.md          # /gemini:adversarial-review — 对抗性审查
    rescue.md                      # /gemini:rescue — 任务委派
    status.md                      # /gemini:status — 后台任务状态
    result.md                      # /gemini:result — 获取完成输出
    cancel.md                      # /gemini:cancel — 取消后台任务
  hooks/hooks.json                 # SessionStart / SessionEnd / Stop
  prompts/                         # Prompt 模板
    adversarial-review.md          # 对抗性审查 prompt
    stop-review-gate.md            # Stop 时自动审查 prompt
  schemas/review-output.schema.json
  scripts/
    gemini-companion.mjs           # 主入口 (所有命令路由)
    session-lifecycle-hook.mjs     # 会话生命周期
    stop-review-gate-hook.mjs      # Stop 审查门控
    lib/
      args.mjs                     # 参数解析
      gemini.mjs                   # Gemini CLI 调用 + JSON 解析
      git.mjs                      # git diff/log + scope
      job-control.mjs              # 后台任务管理
      process.mjs                  # 子进程管理
      prompts.mjs                  # 模板加载
      render.mjs                   # 输出格式化
      state.mjs                    # 配置/状态持久化 (workspace-keyed + file locking)
  skills/
    gemini-cli-runtime/SKILL.md    # 运行时契约
    gemini-result-handling/SKILL.md # 输出呈现规则
    gemini-prompting/              # Prompt 优化
      SKILL.md
      references/                  # 3 个参考文件
        gemini-prompt-recipes.md
        gemini-prompt-antipatterns.md
        prompt-blocks.md
  CHANGELOG.md
  LICENSE
```

## 开发约定

### 语言与运行时
- Node.js ESM (`.mjs`)
- 无外部依赖 — 仅使用 Node.js 内置模块
- 与 Codex 插件保持风格一致

### Gemini CLI 调用模式
```bash
gemini -p "prompt" -o json --approval-mode plan
```
- `-p` headless 模式，`-o json` 结构化输出
- `--approval-mode plan` 只读 (review)，`auto_edit` (ask)
- 默认模型: `gemini-3.1-pro-preview`
- stdout 有噪声前缀，必须找第一个 `{` 截取 JSON

### 命令规范
- 命令文件为 `.md`，含 YAML frontmatter
- review 类命令需要 `disable-model-invocation: true`
- 所有命令最终通过 `gemini-companion.mjs` 执行
- 后台任务: `--background` flag → spawn worker → job file

### 参考实现
- Codex 插件: `~/.claude/plugins/cache/openai-codex/codex/1.0.0/`

## 常用开发命令

```bash
# 测试 companion 脚本
node plugins/gemini/scripts/gemini-companion.mjs setup --json
node plugins/gemini/scripts/gemini-companion.mjs ask "What is 2+2?" --json
node plugins/gemini/scripts/gemini-companion.mjs review --json
node plugins/gemini/scripts/gemini-companion.mjs adversarial-review --json

# 后台任务测试
node plugins/gemini/scripts/gemini-companion.mjs ask --background "test" --json
node plugins/gemini/scripts/gemini-companion.mjs status --json
node plugins/gemini/scripts/gemini-companion.mjs result --json

# 更新已安装的插件
claude plugin marketplace update gemini-plugin
claude plugin update gemini@gemini-plugin
```

## 已知问题 (TODOs)

- 大 repo 中 diff 收集阶段需要早期截断 (untracked files 太多导致溢出)
- 详见 `doc/PLAN.md` 的 v2 TODO 部分
