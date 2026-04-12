# Gemini Plugin for Claude Code

## Context

用户希望将 Google Gemini CLI 集成为 Claude Code 的插件（类似 Codex 插件），以便按需调用 Gemini 进行代码审查、任务委派等，而不是作为 MCP server 常驻占用上下文。

**关键发现：**
- Gemini CLI v0.37.1 已安装在 `/opt/homebrew/bin/gemini`
- 支持 headless 模式：`gemini -p "prompt" -o json` 
- 支持 `@file` 引用、stdin 管道、`--yolo` 自动审批
- Codex 插件结构清晰，可直接复刻其目录结构

## 目录结构

```
gemini-plugin-cc/
├── .claude-plugin/
│   └── marketplace.json              # Marketplace 注册
├── plugins/
│   └── gemini/
│       ├── .claude-plugin/
│       │   └── plugin.json           # 插件身份
│       ├── agents/
│       │   └── gemini-agent.md       # 子代理定义（委派任务给 Gemini）
│       ├── commands/
│       │   ├── ask.md                # /gemini:ask — 向 Gemini 提问
│       │   ├── review.md             # /gemini:review — Gemini 代码审查
│       │   ├── setup.md              # /gemini:setup — 检查安装和认证
│       │   └── status.md             # /gemini:status — 查看后台任务状态
│       ├── hooks/
│       │   └── hooks.json            # 生命周期钩子（轻量）
│       ├── schemas/
│       │   └── review-output.schema.json  # 审查输出格式
│       ├── scripts/
│       │   ├── gemini-companion.mjs  # 核心运行时入口
│       │   └── lib/
│       │       ├── gemini.mjs        # Gemini CLI 调用封装
│       │       ├── process.mjs       # 子进程管理
│       │       ├── git.mjs           # Git 上下文收集
│       │       ├── render.mjs        # 输出格式化
│       │       └── state.mjs         # 任务状态持久化
│       └── skills/
│           ├── gemini-cli-runtime/
│           │   └── SKILL.md          # 内部技能：调用 Gemini 的契约
│           └── gemini-prompting/
│               └── SKILL.md          # 内部技能：为 Gemini 优化 prompt
├── doc/
│   └── PLAN.md                       # 本文件
├── LICENSE
└── README.md
```

## 核心设计

### 1. gemini-companion.mjs — 入口脚本

所有命令最终都调用此脚本，子命令：
- `setup` — 检查 `gemini` 是否可用 + 认证状态
- `ask` — 单次问答，传 prompt 给 Gemini CLI
- `review` — 收集 git diff，让 Gemini 做代码审查
- `status` — 查询后台任务状态
- `cancel` — 中断后台任务

### 2. Gemini CLI 调用模式

比 Codex 简单得多——不需要 JSON-RPC/app-server，直接：

```javascript
// 核心调用
const result = spawnSync("gemini", [
  "--prompt", prompt,
  "--output-format", "json",
  "--model", model || "gemini-2.5-pro",
  "--yolo",                    // 自动审批工具调用
  "--include-directories", cwd // 允许访问项目文件
], { cwd, encoding: "utf8", timeout: 300000 });

const parsed = JSON.parse(result.stdout);
return parsed.response;
```

### 3. 四个命令

| 命令 | 用途 | 调用方式 |
|------|------|----------|
| `/gemini:setup` | 检查安装 + 认证 | `gemini --version` + 测试调用 |
| `/gemini:ask` | 委派任务/提问 | `gemini -p "..." -o json` |
| `/gemini:review` | 代码审查 | `git diff \| gemini -p "review" -o json` |
| `/gemini:status` | 后台任务状态 | 读取本地 job 文件 |

### 4. 子代理 (gemini-agent)

类似 codex:codex-rescue，作为 Claude 可以主动使用的子代理：
- 当需要第二意见、大文件分析（利用 Gemini 1M token 窗口）、或 Claude 自身不确定时触发
- 只使用 Bash 工具调用 companion script
- 返回 Gemini 输出原文

## 实现步骤

### Step 1: 脚手架
- 创建完整目录结构
- 写 `marketplace.json` 和 `plugin.json`

### Step 2: 核心运行时
- `scripts/lib/process.mjs` — spawnSync 封装
- `scripts/lib/gemini.mjs` — Gemini CLI 调用、输出解析
- `scripts/lib/git.mjs` — git diff/log 收集
- `scripts/lib/state.mjs` — 任务状态管理
- `scripts/lib/render.mjs` — 输出格式化
- `scripts/gemini-companion.mjs` — 主入口

### Step 3: 命令定义
- `commands/setup.md`
- `commands/ask.md`
- `commands/review.md`
- `commands/status.md`

### Step 4: 子代理 + 技能
- `agents/gemini-agent.md`
- `skills/gemini-cli-runtime/SKILL.md`
- `skills/gemini-prompting/SKILL.md`

### Step 5: 钩子 + Schema
- `hooks/hooks.json`（轻量，只需 session 生命周期）
- `schemas/review-output.schema.json`

### Step 6: 文档
- `README.md` — 安装和使用说明

## 与 Codex 插件的差异

| 方面 | Codex | Gemini |
|------|-------|--------|
| CLI 调用 | JSON-RPC app-server | 直接 `gemini -p ... -o json` |
| 复杂度 | ~2000 行 JS | 预计 ~500 行 |
| 线程管理 | 内置 thread/turn 机制 | 无状态，每次独立调用 |
| 特色功能 | review gate, adversarial | 1M token 大文件分析 |

## 参考资料

### Codex 插件（参考实现）
- 源码：`~/.claude/plugins/cache/openai-codex/codex/1.0.0/`
- GitHub：https://github.com/openai/codex-plugin-cc (⭐ 13.6k, Apache-2.0)

### Gemini CLI
- 安装位置：`/opt/homebrew/bin/gemini`
- npm 包：`@google/gemini-cli`
- headless 调用：`gemini -p "prompt" -o json -y`
- `@file` 语法引用文件，`--include-directories` 扩展工作区

## 验证计划

1. `node plugins/gemini/scripts/gemini-companion.mjs setup --json`
2. `node plugins/gemini/scripts/gemini-companion.mjs ask "What is 2+2?" --json`
3. 在 Claude Code 中安装插件，测试 `/gemini:setup` 和 `/gemini:ask hello`
4. 测试 `/gemini:review` 对某个 git repo 的 diff 输出
