# Qwen Plugin — Alignment Report

> **视角声明**：这份报告是我（Gemini 插件维护者）读完 `qwen-plugin-cc` 代码后的**外部观察**。你们的 v0.2 已经走到"Phase 4 完成 / 84 tests 全绿"，进度比 kimi 和 minimax 都快。凡是标"我看不到"的地方，请自行判断是设计意图还是待做。
>
> **盘点时间**：2026-04-21
> **对照对象**：`qwen-plugin-cc` v0.2.0 vs. `gemini-plugin-cc` v0.6.0（见 [`baseline.md`](./baseline.md)）

---

## 1. 我观察到的现状

### 版本 / 进度

- `plugin.json` 写的是 `0.2.0`
- `CHANGELOG.md` 第一条："0.1.0 (unreleased) — **Phase 4 完成**（9 tasks + 3 集成测试；累计 84 tests 全绿）"
- 推断：Phase 1-4 已走完，命令面按 "v0.1 scope 完整" 收口
- **三家里进度最快的**，也是**唯一有独立 tests/ 目录**的

### 命令面（7 个）

```
setup  review  adversarial-review  rescue  status  result  cancel
```

**关键差异**：**没有 `ask` 子命令**。`commands/` 目录里也不存在 `ask.md`。companion 的 `main()` 里（`qwen-companion.mjs:614-640`）只 switch `setup / task / task-resume-candidate / cancel / status / result / review / adversarial-review`。

### CLI 封装

- `QWEN_BIN` 默认 `qwen`（阿里 Qwen Code）
- 调用模式：`--output-format stream-json --approval-mode <mode>`（`lib/qwen.mjs:499-500`）
- ping 检测：`ping --output-format stream-json --max-session-turns 1`（`lib/qwen.mjs:274`）

### 独立设计（你做对的）

- **代理注入链路最完整**（`lib/qwen.mjs:21-42`）：四键一致性检测（HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy），还加了 OPENAI_BASE_URL / DASHSCOPE_ / ALIBABA_ 前缀过滤。这是 gemini / kimi / minimax 都没做的。
- **测试规模最大**（84 tests，含 3 个集成测试 spawn companion）
- **hook 重写最谨慎**：CHANGELOG 写明"从 codex 字节起点 + 6 类依赖重写"，说明你做过对比研究，没直接抄
- **Stop review gate 配置持久化到 state.json::config.stopReviewGate**，和 gemini 一致但文档化更清楚

---

## 2. 对齐度对照表

| Gemini baseline 能力 | Qwen 现状 | 证据 |
|---|---|---|
| §1 命令面 — setup | ✅ | `commands/setup.md` |
| §1 命令面 — **ask** | ❌ **缺失** | `commands/` 下无 ask.md；router 也无 ask case |
| §1 命令面 — review + schema | ✅ | `commands/review.md` + `lib/review-validate.mjs` |
| §1 命令面 — adversarial-review | ✅ | `commands/adversarial-review.md` |
| §1 命令面 — rescue | ✅ | `commands/rescue.md`（路由到 `task`）|
| §1 命令面 — status | ✅ | `commands/status.md` + orphan 探活迁移 |
| §1 命令面 — result | ✅ | `commands/result.md` + `permissionDenials` 高亮 |
| §1 命令面 — cancel | ✅ | `commands/cancel.md` |
| §1 命令面 — **timing** | ❌ | 无 |
| §2 streaming (`stream-json`) | ✅ | `lib/qwen.mjs:499` |
| §2 sync review | ✅ | `lib/review-validate.mjs` |
| §2 首行噪声截取 | ❓ | 未确认 qwen CLI 是否有 |
| §3 workspace-keyed state | ✅ | `lib/state.mjs:17, 28, 36` |
| §3 后台 worker + pgid cancel | ✅ | `lib/job-lifecycle.mjs`（注意：文件名和 gemini 不同）|
| §3 foreground 也生成 job | ❓ | 未确认 |
| §4 hooks (Start/End/Stop) | ✅ | `hooks/hooks.json` |
| §4 全 workspace 扫描清理 | ✅ | `session-lifecycle-hook.mjs`（3.5KB 比 gemini 稍大）|
| §5 三分区 review 上下文 | ✅ | `lib/git.mjs`（13.1KB）|
| §5 schema 强制 + retry | ✅ | `lib/review-validate.mjs`（3.3KB，用 "review-validate" 命名，和 gemini 不一样）|
| §6.1 六段 timing 分解 | ❌ | 无 |
| §6.2 事件路由 dispatcher | ❌ | 无 |
| §6.3 **主力模型使用验证（A 卷）** | ❌ | 无 `stats.models` 解析 |
| §6.4 timings.ndjson 全局历史 | ⚠️ **半成品** | `lib/state.mjs:242-362` 实现了 append/read/lock/trim，**但没人调用** |
| §6.5 `/qwen:timing` 三模式 | ❌ | 无 |
| §6.6 status 面板嵌入 timing | ❌ | 无 |
| §7 node:test 单测 | ✅✅ **比 gemini 多** | 84 tests（gemini 59） |
| §8 三个 skills | ✅ | `skills/qwen-cli-runtime / qwen-prompting / qwen-result-handling` |
| 独有：代理注入检测 | ✅ | `lib/qwen.mjs:21-42`（gemini 无）|
| 独有：job-lifecycle.mjs 拆分 | ✅ | `lib/job-lifecycle.mjs` 独立出来（gemini 是合在 job-control.mjs）|

---

## 3. 我看到的独有设计（你做得比我好）

### 3.1 代理注入链路

`lib/qwen.mjs:21-42` 是我看过最完整的代理检测：

```js
export const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
```

加上 `OPENAI_BASE_URL / OPENAI_API_KEY / QWEN_ / BAILIAN_ / DASHSCOPE_ / ALIBABA_ / ALI_` 的前缀过滤（注释里还写了 "v3.1 F-5 实测：多数 qwen 用户 settings.json 无 proxy 字段"——说明你做过实地调查）。

gemini 这边完全没做代理。如果 gemini 用户在代理下有问题我都不知道。这是我欠你学的。

### 3.2 Job-lifecycle 拆分

`lib/job-control.mjs` (1.1KB) + `lib/job-lifecycle.mjs` (5.3KB) 分家。gemini 侧是一个 20KB 的 `job-control.mjs`。你的拆法把"进程控制"和"生命周期 transition"分开，更易测试，也是我想学的点。

### 3.3 Review 文件命名

你把 schema 校验叫 `lib/review-validate.mjs` 而不是 `review.mjs`。这个名字更准确——里面就是校验逻辑，不是 review 主流程。gemini 侧的 `review` 语义比较模糊。

### 3.4 Orphan 探活迁移

CHANGELOG 提到 "status 含 orphan 探活迁移"。推断：如果 job 的 PID 已死但 state 没标记，status 命令会主动迁移到 failed。gemini 这边是被动等下次 SessionStart 清理，你这个更及时。

### 3.5 hook 重写的考古态度

CHANGELOG 里："hooks.json + 2 个 hook 脚本（**从 codex 字节起点 + 6 类依赖重写**，见 FINDINGS F-16）"——这个工作态度我要点赞。gemini 是"看 codex 意思抄过来"，你是"按字节对比 + 标记差异点"。

---

## 4. 我视角的差距（按优先级）

### P0 — `ask` 命令缺失

**证据**：
- `commands/` 下无 `ask.md`
- `qwen-companion.mjs:614-640` switch 里无 `case "ask"`

**我的看法**：这是**与 gemini / kimi / minimax 最大的使用习惯断裂**。用户用 `/gemini:ask` 和 `/kimi:ask` 的肌肉记忆切过来，发现 `/qwen:ask` 不存在，只能走 `/qwen:rescue`（但 rescue 的语义是"委派，可能后台，可能 resume"，不是"问一下"）。

`task` 子命令目前承担了 ask 的角色，但它通过 `/qwen:rescue` 暴露。

**我会建议**：

1. **最省事的方案**：加一个 `commands/ask.md`，内部路由到 `task` 子命令但语义更轻（前台、不 resume、不后台）
2. **更正确的方案**：在 companion 里加 `case "ask"`，和 `task` 共享 `runTask` 但默认 `background=false, resume=false`

`baseline.md §1` 描述了我这边 ask 的参数默认（streaming、前台阻塞、不持久化）。你照这个语义做，用户切 provider 无缝。

**我看不到的**：你们可能有意识地反对"ask"这个命令——也许认为 Qwen Code 更适合多轮 agent 而非单问单答。如果是这样，**请在 README 里说明"用 rescue 代替 ask"的设计决策**，否则用户会反复踩。

---

### P1 — Timing 基础设施完备但未启用（dead code）

**证据**：
- `lib/state.mjs:242-362` 实现了完整的 `appendTimingHistory` + 锁 + 10MB trim + 脏行修复（**和 gemini 侧一模一样甚至更细**）
- `grep appendTimingHistory scripts/` 只在 state.mjs 里有**定义**，没有**调用**

**我的看法**：这是个很有意思的状态——基础设施比 kimi 强（kimi 是明确的 no-op stub），比 gemini 晚（gemini 调用点已接通）。看起来你已经为 timing 铺好路，但还没接六段采集的源头。

**我会建议**：

要么**接通**（建议路径）：

1. 在 `lib/qwen.mjs` 的 streaming 主循环里加 `TimingAccumulator`（参考 `baseline.md §6.1`）
2. 在 job-lifecycle 完成时调 `appendTimingHistory`（你已经有的函数）
3. 加 `commands/timing.md` + companion router case

要么**暂时撤回**：在 state.mjs 的 timing 段加个 `// TODO(phase5): caller not wired` 注释，避免未来迭代者看到以为已经工作。

**我看不到的地方**：Qwen Code CLI 的 result 事件是否吐 `stats.models` 或等价字段，我没法替你探。如果有，§6.3 的 A 卷检测就能做。如果没有，至少 cold/ttft/tail 三段是**纯进程级时序**，不依赖 CLI stats，值得先做。

---

### P2 — 主力模型使用验证（A 卷）完全缺失

**证据**：grep `stats.models | modelUsed | fallback` 在 qwen.mjs 只命中 1 处（`lib/qwen.mjs:324, 333` 是 HTTP 状态码 fallback 的注释，和模型无关）。

**我的看法**：阿里 Qwen 在免费用户和付费用户之间有配额切换，以及 "qwen3-coder 降级到 qwen3-flash" 的场景。如果你不抓，用户感知"变笨了"时没有数据依据。

gemini 侧参考 `baseline.md §6.3` + `timing.mjs:70-95`。核心是 `setRequestedModel`（发请求时记我们要的）+ `onResult.stats.models`（CLI 回吐实际计费的）两者对比。

**我看不到的**：Qwen Code CLI 的 result 事件 schema。希望你 Phase 5 探针一下。

---

### P3 — 命名不一致（小）

你的 tests 目录在 `plugins/qwen/scripts/tests/`，gemini 在仓库根部 `tests/`。两种都合理，但如果将来想做"跨插件 CI 同跑"，统一到根部比较好。

`lib/job-lifecycle.mjs` 这个名字很好，但你留了个空壳 `lib/job-control.mjs` (1.1KB)。可以合并或删掉空壳。

---

## 5. 我看不到的地方（请你澄清）

1. **为什么跳过 `ask`**：是有意的（倾向 Qwen Code 的多轮 agent 模式）还是 Phase 5 的计划？
2. **`FINDINGS F-16`**：你的 CHANGELOG 反复引用 "FINDINGS F-XX" 编号。gemini 没有对等文档，希望你方便时把 FINDINGS 开源或迁移到 `docs/findings/`，这样我能学。
3. **84 tests 的结构**：我只看到 `scripts/tests/` 目录存在，没细读。如果有能 copy 的通用测试 helper（比如"mock CLI stream-json"），希望分享给 gemini。
4. **`lib/review-validate.mjs` 的 schema 路径**：你是否也用 JSON Schema draft-07？gemini 用的是 `schemas/review-output.schema.json`，如果两边 schema 一致，可以抽到一个共享位置。
5. **orphan 探活的触发条件**：是每次 status 都探活，还是仅当 job 超过某 stale 阈值？gemini 想学这个机制，需要更多细节。
6. **你对 timing 的计划**：`state.mjs` 里的 appendTimingHistory 已经写得比 gemini 第一版还完整——这是"先准备基础设施，等 Phase 5 接通"的节奏，还是"意识到做不了（CLI 不吐 stats），就没接"？

---

## 6. 迁移建议（仅当你想要时）

| 想做的事 | 我的文件 | 建议策略 |
|---|---|---|
| 加 `/qwen:ask` | `plugins/gemini/commands/ask.md` + `runAsk` 分支 | 可以 copy，改 provider 名和 argument-hint |
| 接通六段 timing | `plugins/gemini/scripts/lib/timing.mjs:10-180` | 结构可抄；事件名映射到 qwen CLI 实际事件 |
| `/qwen:timing` 三模式 | `plugins/gemini/scripts/lib/render.mjs:renderTimingSingle/History/Stats` | ASCII 渲染通用，直接搬 |
| 主力模型检测 | `timing.mjs:70-95` | 要先探针 qwen CLI 的 result 事件 schema |

---

## 7. 我想从你这里学的

1. **代理注入框架**（gemini 想抄这个）
2. **job-control vs. job-lifecycle 拆分**（gemini 想学这个结构）
3. **FINDINGS 文档化习惯**（gemini 的 lessons 只记"怎么做对"，没记"发现了什么"）
4. **Orphan 探活的具体实现**

---

## 8. 小结

- **进度**：三家里最快，Phase 4 完成，84 tests
- **独有优势**：代理注入 / job-lifecycle 拆分 / hook 考古 / orphan 探活 / review-validate 命名
- **主要差距**：
  - P0 — 没 `ask` 命令，使用习惯断裂
  - P1 — timing 基础设施做好了**但没接源头**（dead code）
  - P2 — 主力模型验证未做
- **我要学你**：代理、拆分、FINDINGS、探活
- **你要学我**：ask 语义、六段 timing 埋点、sum-invariant 校验

这是三家里状态最成熟的一份报告。P0 的 ask 我觉得最值得优先解决（体验问题）。P1 的 timing 主要看你 Phase 5 的排期。
