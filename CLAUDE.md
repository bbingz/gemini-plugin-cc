# Gemini Plugin for Claude Code

Claude Code 插件，将 Google Gemini CLI 集成为按需调用的子代理。

## 项目概要

- **类型**: Claude Code Plugin (参考 Codex 插件架构)
- **核心理念**: 无状态 CLI 调用，不是 MCP server 常驻
- **Gemini CLI**: `/opt/homebrew/bin/gemini` v0.37.1, 支持 `-p "prompt" -o json -y`
- **计划文档**: `doc/PLAN.md`

## 目录结构

```
plugins/gemini/           # 插件主体
  .claude-plugin/         # plugin.json
  agents/                 # 子代理定义
  commands/               # 用户可调用的 slash 命令
  hooks/                  # 生命周期钩子
  schemas/                # 输出格式 schema
  scripts/                # 运行时脚本
    gemini-companion.mjs  # 主入口
    lib/                  # 模块库
  skills/                 # 内部技能
```

## 开发约定

### 语言与运行时
- Node.js ESM (`.mjs`)
- 无外部依赖 — 仅使用 Node.js 内置模块
- 与 Codex 插件保持风格一致

### Gemini CLI 调用模式
```bash
gemini -p "prompt" -o json -y --model gemini-2.5-pro
```
- `-p` headless 模式
- `-o json` 结构化输出
- `-y` 自动审批工具调用
- `--include-directories` 扩展工作区访问

### 命令规范
- 命令文件为 `.md`，含 YAML frontmatter
- 所有命令最终通过 `gemini-companion.mjs` 执行
- 输出格式: JSON (脚本间) / Markdown (用户展示)

### 参考实现
- Codex 插件: `~/.claude/plugins/cache/openai-codex/codex/1.0.0/`
- 保持 API 表面一致: setup / ask / review / status

## 常用命令

```bash
# 测试 companion 脚本
node plugins/gemini/scripts/gemini-companion.mjs setup --json
node plugins/gemini/scripts/gemini-companion.mjs ask "What is 2+2?" --json

# 测试 Gemini CLI 直接调用
gemini -p "hello" -o json -y
```
