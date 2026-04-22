# Gemini Plugin — Feature Baseline (v0.6.0)

> **Purpose**: 这是我（Gemini 插件）在 2026-04-21 时的能力清单。它不是理想蓝图，而是**已经在代码里落地、在 `main` 分支上跑通**的东西。三家姐妹插件的对齐报告都以本文件为参照系。
>
> **Scope note**: 本清单只描述**我做了什么**和**我为什么这么做**，不对其他插件是否应该照抄做价值判断。是否抄、怎么抄、抄多少，由各家自行决定。

---

## 1. 命令面（9 个斜杠命令）

| 命令 | 模式 | 目的 | 关键实现 |
|---|---|---|---|
| `/gemini:setup` | 同步 | CLI 可用性检查 + stop-review-gate 开关持久化 | `commands/setup.md` → `companion.mjs:runSetup` |
| `/gemini:ask` | **streaming** | 一问一答，不持久化，前台阻塞 | `callGeminiStreaming` |
| `/gemini:review` | **sync + schema** | 基于 staged/unstaged/untracked 三分区的结构化代码审查 | `callGemini` + `schemas/review-output.schema.json` |
| `/gemini:adversarial-review` | sync | 对抗性审查（red/blue 两轮） | 同上，切换 stance |
| `/gemini:rescue` | streaming, 可后台 | 任务委派，支持 `--background` / `--wait` / `--resume-last` | `job-control.mjs` worker |
| `/gemini:status` | 同步，**可 --wait** | 后台任务状态，内嵌 timing 小结 | `render.mjs:renderStatus` |
| `/gemini:result` | 同步 | 拉取已完成任务的 stdout，含 timing | `resolveJobResult` |
| `/gemini:cancel` | 同步 | SIGINT 指定 job | `job-control.mjs:cancelJob` |
| `/gemini:timing` | 同步 | **6 段耗时观测面板**，支持 single / `--history` / `--stats` | `timing.mjs` + `render.mjs:renderTimingSingle / renderTimingHistory / renderTimingStats` |

**设计约束**：

- Review 类命令 frontmatter 必须带 `disable-model-invocation: true`，避免调用者 Claude 被诱导先自己审一遍
- ask / rescue 走 streaming；review 走 sync — 这是为了让 schema 强制能一次拿到完整 JSON
- 所有命令都支持 `--json` 扁平输出，便于 skill/agent 层消费

---

## 2. CLI 调用模式

### 2.1 Streaming（ask / rescue）

```bash
gemini -p "<prompt>" -o stream-json --approval-mode auto_edit [-m <model>]
```

- 输出 NDJSON 四种事件：`init` → `message(role=user)` → `message(role=assistant, delta)` → `result`
- **关键坑**：v0.37.1 的 stream-json 第一行有**噪声前缀**（可能是 telemetry 或 OSC 码），解析前需要找第一个 `{` 截取。`gemini.mjs:~210` 有实现。
- 首行噪声截取失败时，降级为整行 try/catch，避免单行脏数据导致整个流 abort

### 2.2 Sync（review / adversarial-review）

```bash
gemini -p "<prompt>" -o json --approval-mode plan [-m <model>]
```

- 单次返回完整 JSON，便于 schema 校验
- `plan` approval-mode 禁止副作用

### 2.3 参数约定

- `-m <model>` **显式传递**，不依赖 CLI 内部默认（v0.5.2 加的 "modelSteering guard"）— 原因是 Gemini CLI 在某些环境下会静默降级，显式传参至少让请求是确定性的
- 所有长 prompt 都走 stdin 而非 `-p ""` 参数以规避 shell 长度限制（`useStdin` 开关在 `gemini.mjs:94`）

---

## 3. 子进程与后台任务

### 3.1 Workspace-keyed 状态

- `stateRootDir()` = `~/.claude/plugins/data/gemini-gemini-plugin/`
- 每个 repo 对应 slug = `basename + sha256(workspaceRoot).slice(0,8)`（`state.mjs:17`）
- 好处：一台机器上多个 worktree / 仓库并存时任务不串门

### 3.2 后台 worker

- `/gemini:rescue --background` 不走 CLI re-entry（避免 CC 套娃）；直接在 `job-control.mjs` 里 spawn `callGeminiStreaming` 的 worker
- worker PID + pgid 写入 state，`cancel` 用 `kill -INT -<pgid>` 保证子孙进程都收到
- foreground 路径也会生成临时 job（`gfg-` 前缀），纯粹为了 timing 持久化走同一条路（见 §6）

### 3.3 Job 文件

- `<stateDir>/jobs/<jobId>.json`：`{id, kind, status, phase, result, timing, startedAt, completedAt, ...}`
- `phase` 粒度：`queued` → `starting` → `waiting_first_token` → `streaming` → `tool_loop` → `done | failed | cancelled`
- 原子写：tmp 文件 + rename

---

## 4. 会话生命周期（Hooks）

`hooks/hooks.json` 注册三个 hook：

| Hook | 脚本 | 作用 |
|---|---|---|
| `SessionStart` | `session-lifecycle-hook.mjs SessionStart` | **全 workspace 扫描**，清理 3 天前的 jobs + 孤儿 PID |
| `SessionEnd` | `session-lifecycle-hook.mjs SessionEnd` | 同上 + 刷新 timings.ndjson |
| `Stop` | `stop-review-gate-hook.mjs` | 可选：用户退出主循环时弹 review gate（只要 `state.config.stopReviewGate === true`）|

**为什么是"全 workspace 扫描"而非"仅当前 workspace"**：机器上可能有十几个关闭的 worktree 留下的 stale 状态，每次启动都顺手清一次比定期 cron 简单。

---

## 5. 结构化 Review

### 5.1 三分区上下文

`git.mjs:buildReviewContext` 把工作树状态拆成三段：

- **staged**：`git diff --cached --name-only`
- **unstaged**：`git diff --name-only`
- **untracked**：`git ls-files --others --exclude-standard`，每文件上限 24KB（`MAX_UNTRACKED_BYTES`）

Prompt 模板里这三块分别呈现给模型，避免模型把 untracked 当已提交。

### 5.2 Schema 强制

`schemas/review-output.schema.json` 定义 review 输出形状（issues[]、suggestions[]、scope、severity enum）。
sync 模式拿到完整 JSON 后本地校验 schema，失败时按 "schema_violation" 记账、重试 1 次。

---

## 6. Timing Telemetry（v0.6.0 核心）

### 6.1 六段分解

`TimingAccumulator`（`timing.mjs:~10-180`）把一次 streaming 调用分成：

| 段 | 含义 | 起点 | 终点 |
|---|---|---|---|
| **cold** | CLI 冷启动（从 spawn 到第一个 init 事件） | spawn | `init` 事件 |
| **ttft** | 首字延迟（init 到第一个 assistant delta） | `init` | 第一个 `message(assistant)` |
| **gen** | 纯生成时长（扣除 tool + retry） | 第一个 delta | `result` |
| **tool** | 工具调用累计 | `tool_use` / `tool_call` | `tool_result` / `tool_response` |
| **retry** | 可恢复错误期间的重试（`error` 且 `fatal=false`）| 第一个 error | 下一次 recovery |
| **tail** | 最后一个 token 到进程 close | last token | close |

**sum-invariant**：clean exit 时 6 段之和必须等于总时长，误差 > 50ms 会在 `finalize()` 里打 WARN。

### 6.2 事件路由

`dispatchTimingEvent(event, acc)`（`timing.mjs:348`）按事件类型分发：

```
init              → acc.onInit
message/assistant → acc.onAssistantDelta
tool_use / tool_call     → acc.onToolStart
tool_result / tool_response → acc.onToolEnd
error (fatal=false)       → acc.onRecoverableError
startup_stats / gemini_cli.startup_stats → acc.onColdStartPhases
result            → acc.onResult
```

抽这个 dispatcher 是为了让 job-control.mjs 保持"流过什么事件转发什么"的扁平写法，测试也好打桩。

### 6.3 主力模型使用验证（"A 卷"问题）

`onResult(resultEvent)` 读取 `stats.models` 对象（`timing.mjs:70-95`）：

```js
if (stats.models && typeof stats.models === "object" && !Array.isArray(stats.models)) {
  this._usage = Object.entries(stats.models).map(([modelName, m]) => ({
    model: modelName,
    input: m?.input_tokens ?? 0,
    output: m?.output_tokens ?? 0,
    thoughts: m?.thoughts_token_count ?? 0,
  }));
}
```

**这一段为什么重要**：Gemini CLI 存在"请求 Pro，实际服务 Flash"的静默降级场景（尤其是免费用户到额度边界）。`stats.models` 的键是**实际被计费的模型**，对比 `setRequestedModel` 记下的 requested model，就能发现降级。

fallback 路径（旧版 CLI 只吐平铺 `stats.input_tokens`）被保留，回填 `model = requestedModel ?? "unknown"`。

**前置条件（sibling 注意）**：这一检测路径 **要求 CLI 在 result 事件里吐 per-model usage 映射**（Gemini CLI 的 `stats.models`）。并非所有 sibling CLI 都具备这个能力——kimi-cli 1.x 未暴露（2026-04-22），Mini-Agent 0.1.0 日志 RESPONSE block 只有 `finish_reason`。如果上游 CLI 无此字段，本节的"A 卷"取证**无法照搬**，需要先做 CLI probe 确认能否观测到"请求的模型 ≠ 实际计费的模型"这一数据源。这是架构受限，不是插件可自行补齐的差距。

### 6.4 全局历史（timings.ndjson）

- 路径：`~/.claude/plugins/data/gemini-gemini-plugin/timings.ndjson`（**跨 workspace 共享**）
- 每次 job 完成（前台 + 后台）都 append 一行 JSON
- 独立锁文件 `timings.ndjson.lock`（flock 风格，10s 超时放弃）
- 10MB 触发 trim，保留尾部
- 脏行（程序崩溃写了一半）启动时自动修复，最多跳过 N 行并打 WARN，**不清空整文件**

### 6.5 `/gemini:timing` 三模式

| 模式 | 用途 | 渲染 |
|---|---|---|
| 单任务 `<job-id>` | 一次调用的详细 ASCII 条图 | `renderTimingSingle` |
| `--history` | 近 N 次的表格 | `renderTimingHistory` |
| `--stats` | p50/p95/p99 聚合（n < 5 时 suppress 百分位） | `renderTimingStats` |

三模式都支持 `--json`。

### 6.6 Status 面板嵌入

`/gemini:status` 输出下方会接一个 **markdown-safe 的 timing breakdown block**（backtick-safe，不破坏 fence）。这是 post-review 修的一个 bug：之前直接塞 "```" 会把主渲染的 fence 闭合掉。

---

## 7. 测试（node:test，零依赖）

位置：`tests/*.test.mjs`，共 **59 个测试**（v0.6.0 全绿）：

| 文件 | 覆盖 | 数量 |
|---|---|---|
| `smoke.test.mjs` | 框架自检 | 1 |
| `timing-accumulator.test.mjs` | TimingAccumulator 单测 | 20 |
| `timing-dispatch.test.mjs` | 事件路由 | 14 |
| `timing-render.test.mjs` | ASCII bar / single-job / summary | 9 |
| `timing-aggregate.test.mjs` | percentile / stats / history | 9 |
| `timing-storage.test.mjs` | ndjson lock / trim / concurrent | 6 |

**原则**：只依赖 `node:test` + `node:assert`，不引 vitest/jest。目的是插件仓库本身保持零 npm 依赖。

---

## 8. Skills 契约（三个）

| Skill | 作用 | 面向 |
|---|---|---|
| `gemini-cli-runtime` | 运行时契约：`task` 命令语义、job-id 生命周期、session-id 透传 | 父 agent（Claude Code） |
| `gemini-prompting` | Prompt 模板和 references（适合 Gemini 的指令风格） | 写 prompt 的开发者 |
| `gemini-result-handling` | 输出呈现规则：何时截断、何时展开、timing block 放哪 | 父 agent 的渲染层 |

三个 skill 的 frontmatter 都用 `description:` 写明"何时应该激活"，避免过度触发。

---

## 9. 架构限制（诚实声明）

当前真实数据（v0.6.0，n=10 baseline，见 `memory/data_timing_baseline.md`）：

- **冷启动 p50 = 8.7s**（占总时长 41%）— 不是早期估计的 2-3s
- **TTFT p50 = 12.2s**
- **总时长 p50 = 21s**
- **10% fallback 率**（降级到平铺 stats）

**不做的事**：

- ❌ **v1internal 直调** (`cloudcode-pa.googleapis.com` 内部 API)：违反 Google TOS
- ❌ **API Key 免费额度路线**：Flash 250次/天、Pro 已不在免费层
- ❌ **零冷启动**：等 Google daemon mode PR (#20700 / #21307, issue #15338)

**正在观察的事**：

- Daemon mode landed 后，冷启动期望 < 1s
- 届时再做一次 n=50 的 baseline 更新

---

## 10. 设计原则（以供参考，不是强制）

这几条是我六轮 review + 三方（Codex + Gemini + Claude）对抗性 review 后沉淀的：

1. **实测胜过估计**：v0.5 之前对冷启动的口头估计是 "2-3s"，0.6.0 埋点后实测 8.7s。差距大到需要重写 roadmap。
2. **fallback 路径也要埋点**：10% 走降级路径也是真实用户体验的一部分。如果只记主路径，统计会偏乐观。
3. **诚实宣告限制**：README 和 CLAUDE.md 里明说"不做 v1internal"、"不做 API Key"、"等 daemon mode"。让用户知道边界比假装全能有用。
4. **workspace 隔离是底线**：多 worktree 开发是常态，state 必须 keyed by workspace，否则任务会串。
5. **sum-invariant 自检**：6 段相加必须等于总时长。这种代数不变量比任何单测都更能发现 dispatch 漏事件。
6. **markdown-safe 输出**：Claude Code 会把插件输出直接塞进对话流。fence / backtick / 表格对齐都得考虑。
7. **CHANGELOG 权威性排序**（跨插件审计注意）：仓库根 `CHANGELOG.md` + `plugins/*/plugin.json` version 字段是**权威**；`plugins/*/CHANGELOG.md` 子 changelog 可能滞后。**审计 sibling 状态时以 repo-root 和 plugin.json 为准**，不要从子 changelog 推断"Phase N in progress"，否则会踩 stale-drift 坑（2026-04-21 我读 kimi `plugins/kimi/CHANGELOG.md` 时就中过一次）。

---

## 11. 路线图之外的观察

几件我自己还没做但标记了的事：

- **Engram sidecar 深度集成**：目前只做到了 "deterministic Claude Code parent link"，没把 timing 写进 engram 的 `save_insight`
- **跨插件 timing 可对比**：如果三家都采纳 timings.ndjson 同 schema，可以做一个上层 dashboard 比较 cold/ttft 分布
- **A/B 模型切换**：当下只有"记录降级"，没"触发切换"（比如检测到 Pro→Flash 时自动提示用户调档）
- **Review 从 `gemini.mjs` 抽出**：当前 sync review 和 streaming ask/task 在同一文件，耦合偏重。未来抽取时可参考 kimi 插件的"薄 CLI-specific adapter（`callKimiReview` / `callKimiAdversarialReview`）→ 厚共享 pipeline（`scripts/lib/review.mjs` 里的 `runReviewPipeline`）"形状，schema 校验 + retry + fallback 全部下沉到 pipeline，adapter 只负责 CLI 特异性。

这些不在 0.6.0 范围，写在这里只是让你们知道我在想什么。

---

**更新节奏**：每次 `plugins/gemini/plugin.json` version bump 时，这份 baseline 也要相应更新。当前锚点：**v0.6.0 / 2026-04-21**（2026-04-22 annotations: kimi §8.3 反馈——§6.3 per-model prerequisite / §10 原则 #7 CHANGELOG 权威性 / §11 review 抽取参考）。
