# Gemini Plugin for Claude Code

## Context

将 Google Gemini CLI 集成为 Claude Code 的插件（类似 Codex 插件），按需调用 Gemini 进行代码审查、任务委派等。

**设计原则：**
- 对照 Codex 插件架构，但不盲目 1:1 复制
- 先跑通最小路径，再逐步扩展
- 每一步基于实测验证，不做未验证的假设

## Gemini CLI 实测结果 (v0.37.1)

### JSON 输出格式 (`-o json`)

**成功时 stdout:**
```
MCP issues detected. Run /mcp list for status.{
  "session_id": "uuid",
  "response": "actual response text",
  "stats": {
    "models": {
      "gemini-3.1-pro-preview": {
        "api": { "totalRequests": 1, "totalErrors": 0, "totalLatencyMs": 8020 },
        "tokens": { "input": 17433, "prompt": 17433, "candidates": 1, "total": 17523, "cached": 0, "thoughts": 89, "tool": 0 }
      }
    },
    "tools": { "totalCalls": 0, "totalSuccess": 0, "totalFail": 0 },
    "files": { "totalLinesAdded": 0, "totalLinesRemoved": 0 }
  }
}
```

**⚠️ stdout 有噪声前缀**（"MCP issues detected..."），必须找到第一个 `{` 位置截取 JSON。

**错误时:**
- stdout: 仅噪声，无 JSON
- stderr: stack trace + JSON 错误对象
```json
{ "session_id": "uuid", "error": { "type": "Error", "message": "Requested entity was not found.", "code": 1 } }
```
- 退出码: 0=成功, 1=失败

### Stream-JSON 格式 (`-o stream-json`)
```jsonl
{"type":"init","timestamp":"...","session_id":"uuid","model":"gemini-3.1-pro-preview"}
{"type":"message","timestamp":"...","role":"user","content":"..."}
{"type":"message","timestamp":"...","role":"assistant","content":"...","delta":true}
{"type":"result","timestamp":"...","status":"success","stats":{...}}
```

### 默认模型
`gemini-3.1-pro-preview`（非 2.5-pro）

### 认证
- OAuth 凭据: `~/.gemini/oauth_creds.json`
- 可通过文件存在性 + 短超时测试调用检测

### Approval Mode
- `-y / --yolo`: 自动审批所有工具调用（**不应作为默认值**）
- `--approval-mode plan`: 只读模式，适合 review（用户 settings.json 已设为 plan）
- `--approval-mode auto_edit`: 自动审批编辑类工具
- 建议: review 用 `plan`，ask 用 `auto_edit` 或让用户配置

### Stderr 内容
- "YOLO mode is enabled" 警告
- "Skill conflict detected" 警告
- 错误时: stack trace + JSON error 对象

## 目录结构

### v1 (最小可用)
```
gemini-plugin-cc/
├── plugins/
│   └── gemini/
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── commands/
│       │   ├── setup.md              # /gemini:setup
│       │   ├── ask.md                # /gemini:ask
│       │   └── review.md             # /gemini:review
│       ├── hooks/
│       │   └── hooks.json            # SessionStart / SessionEnd
│       └── scripts/
│           ├── gemini-companion.mjs  # 主入口
│           ├── session-lifecycle-hook.mjs
│           └── lib/
│               ├── args.mjs          # 参数解析
│               ├── gemini.mjs        # CLI 调用 + JSON 解析
│               ├── git.mjs           # git diff/log
│               ├── process.mjs       # 子进程 + 二进制检查
│               ├── render.mjs        # 输出格式化
│               └── state.mjs         # 配置持久化
├── doc/
│   └── PLAN.md
├── LICENSE
└── README.md
```

### v2 追加
```
│       ├── agents/
│       │   └── gemini-agent.md
│       ├── commands/
│       │   ├── status.md
│       │   ├── result.md
│       │   └── cancel.md
│       ├── schemas/
│       │   └── review-output.schema.json
│       └── scripts/
│           └── lib/
│               └── job-control.mjs
│       └── skills/
│           ├── gemini-cli-runtime/SKILL.md
│           ├── gemini-result-handling/SKILL.md
│           └── gemini-prompting/SKILL.md
```

## 核心设计

### 1. gemini-companion.mjs — 主入口

v1 子命令:
- `setup` — 检查 gemini 二进制 + 认证
- `ask` — 向 Gemini 提问/委派任务
- `review` — 收集 git diff 让 Gemini 做代码审查

### 2. Gemini CLI 调用 (lib/gemini.mjs)

```javascript
import { spawnSync } from "node:child_process";

function callGemini({ prompt, model, approvalMode = "plan", cwd, timeout = 300000 }) {
  const args = ["-p", prompt, "-o", "json"];
  if (model) args.push("-m", model);
  args.push("--approval-mode", approvalMode);

  const result = spawnSync("gemini", args, {
    cwd,
    encoding: "utf8",
    timeout,
    env: { ...process.env },
  });

  if (result.error) {
    // timeout or spawn error
    return { ok: false, error: result.error.message };
  }

  // stdout 有噪声前缀，找第一个 { 截取 JSON
  const stdout = result.stdout || "";
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) {
    // 没有 JSON — 检查 stderr 的 JSON error
    return parseStderrError(result.stderr, result.status);
  }

  try {
    const parsed = JSON.parse(stdout.slice(jsonStart));
    if (parsed.error) {
      return { ok: false, error: parsed.error.message, code: parsed.error.code };
    }
    return {
      ok: true,
      response: parsed.response,
      sessionId: parsed.session_id,
      stats: parsed.stats,
    };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e.message}` };
  }
}

function parseStderrError(stderr, exitCode) {
  // stderr 可能包含 JSON error 对象
  const idx = (stderr || "").lastIndexOf("{");
  if (idx >= 0) {
    try {
      const errObj = JSON.parse(stderr.slice(idx));
      if (errObj.error) {
        return { ok: false, error: errObj.error.message, code: errObj.error.code };
      }
    } catch {}
  }
  return { ok: false, error: `gemini exited with code ${exitCode}`, stderr };
}
```

### 3. Setup 检测逻辑

```javascript
async function setup() {
  // 1. 检查二进制
  const version = checkBinary("gemini");  // spawnSync("gemini", ["-v"])
  if (!version) return { status: "missing", message: "Install: npm i -g @google/gemini-cli" };

  // 2. 检查认证文件
  const oauthFile = path.join(os.homedir(), ".gemini", "oauth_creds.json");
  if (!fs.existsSync(oauthFile)) {
    return { status: "unauthenticated", message: "Run: gemini (interactive) to login" };
  }

  // 3. 短超时测试调用 (验证凭据是否有效)
  const test = callGemini({ prompt: "ping", timeout: 15000, approvalMode: "plan" });
  if (!test.ok) {
    return { status: "auth_expired", message: test.error };
  }

  return {
    status: "ready",
    version,
    model: Object.keys(test.stats?.models || {})[0] || "unknown",
  };
}
```

### 4. Review 流程

```javascript
async function review({ base, scope, cwd }) {
  // 1. 收集 diff
  const diff = getDiff({ base, scope, cwd });  // git diff 封装
  if (!diff.trim()) return { verdict: "no_changes", summary: "No changes to review." };

  // 2. 截断策略 — 防止超过合理 prompt 大小
  const maxDiffLen = 200_000;  // ~50K tokens
  let truncated = false;
  let diffText = diff;
  if (diff.length > maxDiffLen) {
    diffText = diff.slice(0, maxDiffLen) + "\n\n... [TRUNCATED — diff too large] ...";
    truncated = true;
  }

  // 3. 构造 prompt
  const prompt = `Review the following git diff. For each issue found, provide:
- severity: critical / high / medium / low
- file and line range
- description and recommendation

Be thorough but concise. Focus on bugs, security issues, and logic errors.
Do not comment on style unless it causes bugs.

\`\`\`diff
${diffText}
\`\`\``;

  // 4. 调用 Gemini (review 用 plan 模式 — 只读)
  const result = callGemini({
    prompt,
    approvalMode: "plan",
    cwd,
    timeout: 300000,
  });

  return result;
}
```

### 5. Diff 收集策略 (lib/git.mjs)

```javascript
function getDiff({ base, scope, cwd }) {
  // scope 解析 (对标 Codex)
  // "auto" — 有 staged 就用 staged，否则用 working-tree vs base
  // "working-tree" — 未提交的变更
  // "branch" — 当前分支 vs base

  if (scope === "working-tree") {
    return exec("git diff", cwd);
  }
  if (scope === "branch") {
    return exec(`git diff ${base}...HEAD`, cwd);
  }
  // auto: 优先 staged，fallback to branch diff
  const staged = exec("git diff --cached", cwd);
  if (staged.trim()) return staged;
  const branch = exec(`git diff ${base}...HEAD`, cwd);
  if (branch.trim()) return branch;
  return exec("git diff", cwd);  // working tree
}
```

### 6. 错误处理矩阵

| 场景 | 检测方式 | 用户提示 |
|------|---------|---------|
| 二进制不存在 | `which gemini` 失败 | "Install: npm i -g @google/gemini-cli" |
| 未认证 | `oauth_creds.json` 不存在 | "Run: gemini (interactive) to login" |
| 凭据过期 | 测试调用返回 auth error | "Run: gemini (interactive) to re-login" |
| 模型无效 | exit code 1 + ModelNotFoundError | "Invalid model. Available: gemini-3.1-pro-preview" |
| 超时 | spawnSync ETIMEDOUT | "Timed out after Ns. Try a smaller scope" |
| JSON 解析失败 | stdout 无 `{` 或 parse error | "Unexpected output format. Run with --debug" |
| 非 git 目录 | `git rev-parse` 失败 | "Not a git repository" |
| 无 diff | diff 为空 | "No changes to review" |
| Diff 过大 | 超过 200K 字符 | 截断 + 警告 |
| stderr 噪声 | 正常，忽略 | — |

## 实现步骤 (修订后)

### Step 1: 最小命令验证
**目标: 证明一个命令 markdown → companion script → Claude Code 可以跑通**

- [ ] 创建目录结构 (v1 部分)
- [ ] 写 `plugin.json`
- [ ] 写最简 `gemini-companion.mjs` (只支持 `setup`)
- [ ] 写 `lib/process.mjs` (二进制检查)
- [ ] 写 `commands/setup.md`
- [ ] **验证**: 在 Claude Code 中安装插件，运行 `/gemini:setup`

### Step 2: 核心调用
**目标: 证明 Gemini CLI 调用 + JSON 解析可靠**

- [ ] 写 `lib/gemini.mjs` (CLI 调用封装，含 stdout 噪声处理)
- [ ] 写 `lib/args.mjs` (参数解析)
- [ ] 写 `lib/render.mjs` (输出格式化)
- [ ] 扩展 `gemini-companion.mjs` 支持 `ask`
- [ ] 写 `commands/ask.md`
- [ ] **验证**: `/gemini:ask "What is 2+2?"` 返回正确结果

### Step 3: Review 命令
**目标: 证明 git diff + Gemini review 端到端可用**

- [ ] 写 `lib/git.mjs` (diff 收集 + scope 解析)
- [ ] 扩展 `gemini-companion.mjs` 支持 `review`
- [ ] 写 `commands/review.md`
- [ ] 写 `lib/state.mjs` (配置持久化 — 如 default model)
- [ ] **验证**: 在真实 git repo 上跑 `/gemini:review`

### Step 4: Hooks + 生命周期
- [ ] 写 `hooks/hooks.json` (SessionStart / SessionEnd)
- [ ] 写 `session-lifecycle-hook.mjs`
- [ ] **验证**: 钩子正确触发

### Step 5: 文档
- [ ] `README.md`
- [ ] `LICENSE`

## v2 TODO

以下功能在 v1 验证通过后再加:

### 后台任务系统
- [ ] `lib/job-control.mjs` — spawn + detach + PID 管理 + stale cleanup
- [ ] `commands/status.md` — 查看后台任务
- [ ] `commands/result.md` — 获取完成输出
- [ ] `commands/cancel.md` — 取消后台任务 (进程组 kill)
- [ ] `ask --background` / `review --background` 支持

### 子代理 + 技能
- [ ] `agents/gemini-agent.md` — Claude 主动调用的子代理
- [ ] `skills/gemini-cli-runtime/SKILL.md`
- [ ] `skills/gemini-result-handling/SKILL.md`
- [ ] `skills/gemini-prompting/SKILL.md`

### Bug 修复
- [ ] **diff 收集阶段早期截断** — 大 repo 中 untracked files 太多导致 Node.js 字符串溢出。需要在 `getUntrackedFilesDiff` 和 `getLocalModifications` 中加入文件数/总大小限制，而不只是在发送给 Gemini 时截断。(v1 实测发现：DrCom repo review 失败)

### 高级功能
- [ ] `schemas/review-output.schema.json` — 结构化审查输出
- [ ] **adversarial-review 命令** — 对抗性安全审查
- [ ] **stop-review-gate 钩子** — Stop 时自动审查
- [ ] **session resume** — 利用 `-r/--resume` 保持上下文
- [ ] **prompts/ 目录** — 可复用的 prompt 模板
- [ ] **stream-json 支持** — 后台任务进度追踪
- [ ] **大 diff 分块** — 超过截断阈值时分段 review
- [ ] **`@file` 引用** — prompt 中引用项目文件

## Codex 对照 (仅供参考)

| Codex 模块 | Gemini 对应 | v1/v2 |
|------------|------------|-------|
| `codex-companion.mjs` | `gemini-companion.mjs` | v1 |
| `lib/codex.mjs` | `lib/gemini.mjs` | v1 |
| `lib/process.mjs` | `lib/process.mjs` | v1 |
| `lib/git.mjs` | `lib/git.mjs` | v1 |
| `lib/render.mjs` | `lib/render.mjs` | v1 |
| `lib/state.mjs` | `lib/state.mjs` | v1 |
| `lib/args.mjs` | `lib/args.mjs` | v1 |
| `lib/job-control.mjs` | `lib/job-control.mjs` | v2 |
| `lib/tracked-jobs.mjs` | *(并入 job-control)* | v2 |
| `codex-rescue.md` agent | `gemini-agent.md` | v2 |
| 3 个 skills | 3 个 skills | v2 |
| `app-server*.mjs` | *(不需要)* | — |
| `broker-*.mjs` | *(不需要)* | — |

## 参考资料

### Codex 插件
- 本地: `~/.claude/plugins/cache/openai-codex/codex/1.0.0/`
- GitHub: https://github.com/openai/codex-plugin-cc

### Gemini CLI
- 安装: `/opt/homebrew/bin/gemini` (npm: `@google/gemini-cli`)
- 认证: `~/.gemini/oauth_creds.json`
- 配置: `~/.gemini/settings.json`
- 默认模型: `gemini-3.1-pro-preview`

## 验证计划

1. `node plugins/gemini/scripts/gemini-companion.mjs setup --json`
2. `/gemini:setup` — 在 Claude Code 内测试
3. `node plugins/gemini/scripts/gemini-companion.mjs ask "What is 2+2?" --json`
4. `/gemini:ask hello` — 在 Claude Code 内测试
5. `/gemini:review` — 在有 diff 的真实 git repo 测试
