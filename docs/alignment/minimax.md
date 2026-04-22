# MiniMax Plugin — Alignment Report

> **视角声明**：这份报告是我（Gemini 插件维护者）读完 `minimax-plugin-cc` 代码后的**外部观察**。你的架构最异类（走 Mini-Agent 包装器而非直接 CLI），对齐只能在"功能等价"维度看，不能按"代码相似"看。凡是标"我看不到"的地方请澄清。
>
> **盘点时间**：2026-04-21
> **对照对象**：`minimax-plugin-cc` v0.1.0 vs. `gemini-plugin-cc` v0.6.0（见 [`baseline.md`](./baseline.md)）

---

## 1. 我观察到的现状

### 版本 / 进度

- `plugin.json` 写的是 `0.1.0`
- `CHANGELOG.md` 首条："2026-04-21 — Phase 5"（adversarial-review 刚落）
- `PROGRESS.md` 体积 3.8KB——说明你有显式的过程文档化
- 推断：Phase 1-5 已过，核心命令齐全

### 命令面（9 个 — 三家里最多）

```
setup  ask  review  adversarial-review  rescue  status  result  cancel  task-resume-candidate
```

**独有命令**：`task-resume-candidate`（检查本 repo 是否有可恢复任务）。gemini 把这个逻辑藏在 `rescue --resume-last` 里，你显式暴露。

### 底层 runner — 最特殊的设计

```
MINI_AGENT_BIN = process.env.MINI_AGENT_BIN || "mini-agent"
```

- **不直接调 MiniMax API**（也不直接调 MiniMax 官方 CLI）
- 而是调 "Mini-Agent" 包装器（`~/.mini-agent/`）
- 访问模式：spawn `mini-agent` 一次性运行 + **回读日志文件**（`mini-agent log <file>`）作为 fallback 解析路径
- 参考：`lib/minimax.mjs:14, 442-500, 700-770`

这和 gemini/kimi/qwen 的 "streaming NDJSON 直出" 模式根本不同。

### 独立设计（你做对的）

- **硬超时 + 三层 fallback**：`spawnWithHardTimeout`（`lib/minimax.mjs:302-460`）做了超时杀子进程、stdout/stderr 截断、lineCarry 刷盘、spawn 错误统一 finalize
- **三层输出解析**（`lib/minimax.mjs:880`）：Layer 1 主解析 → Layer 2 快照 diff → Layer 3 stdout sentinel
- **单元测试直接放在 `lib/` 里（`lib/*.test.mjs`）**：7 个测试文件和实现文件并列。gemini 侧是独立 `tests/` 目录。两种风格都有人用。
- **spawn 错误和 timeout 分开处理**（`lib/minimax.mjs:821-823`）：`spawnError` 和 `timedOut` 是 finalize 的两个前置硬失败条件，不会和业务失败混淆
- **PROGRESS.md**：gemini 没做的过程文档化

---

## 2. 对齐度对照表

| Gemini baseline 能力 | MiniMax 现状 | 证据 |
|---|---|---|
| §1 命令面 — setup | ✅ | `commands/setup.md`（4.5KB，三家里最大——推断含 MINI_AGENT_BIN / .mini-agent 目录检查）|
| §1 命令面 — ask | ✅ | `commands/ask.md` |
| §1 命令面 — review + schema | ✅ | `commands/review.md` + `lib/minimax.mjs:953`（schema 引用）|
| §1 命令面 — adversarial-review | ✅ | `commands/adversarial-review.md` + `_callReviewLike` 抽象 |
| §1 命令面 — rescue | ✅ | `commands/rescue.md`（精简，23 行）|
| §1 命令面 — status | ✅ | `commands/status.md` |
| §1 命令面 — result | ✅ | `commands/result.md` |
| §1 命令面 — cancel | ✅ | `commands/cancel.md` |
| §1 命令面 — **timing** | ❌ | 无 |
| §1 命令面 — **task-resume-candidate** | ✅ 独有 | `commands/task-resume-candidate.md` |
| §2 streaming (NDJSON) | ⚠️ **不同架构** | Mini-Agent 不吐 stream-json，走 "spawn + log 文件回读" |
| §2 sync review | ✅ | `lib/minimax.mjs:callMiniAgentReview` |
| §2 首行噪声截取 | N/A | 架构不同，无对应问题 |
| §3 workspace-keyed state | ✅ | `lib/state.mjs:17, 28, 36`（和 gemini 一致）|
| §3 后台 worker | ❓ | `lib/job-control.mjs` 只有 8.1KB，gemini 是 20KB，推断功能简化 |
| §3 后台 pgid cancel | ❓ | 未确认是否用 pgid |
| §4 hooks (Start/End/Stop) | ⚠️ **极简** | `hooks.json` + `session-lifecycle-hook.mjs` (1.2KB) + `stop-review-gate-hook.mjs` (1.8KB)。gemini 侧 3.1KB/5.5KB，你是 1/3 大小 |
| §4 全 workspace 扫描清理 | ❓ | hook 才 1.2KB，不确定是否做了 |
| §5 三分区 review 上下文 | ✅ | `lib/git.mjs` 11.5KB |
| §5 schema 强制 | ✅ | `lib/minimax.mjs:953`（schema 引用，"review-output.schema.json"）|
| §6.1 六段 timing 分解 | ❌ | 无 |
| §6.2 事件路由 dispatcher | ❌ | 架构上也不适用（Mini-Agent 没有 streaming 事件）|
| §6.3 **主力模型使用验证（A 卷）** | ❌ | 无 |
| §6.4 timings.ndjson 全局历史 | ❌ | 无 `timing` / `TimingAccumulator` / `appendTiming` 任一关键字 |
| §6.5 `/minimax:timing` 三模式 | ❌ | 无 |
| §7 node:test 单测 | ✅ | 7 个测试文件，放在 `lib/` 内联。数量我没逐个 grep `test()` 行 |
| §8 三个 skills | ✅ | `skills/minimax-cli-runtime / minimax-prompting / minimax-result-handling` |
| 独有：硬超时框架 | ✅ | `spawnWithHardTimeout` |
| 独有：三层输出解析 | ✅ | Layer 1/2/3 fallback |
| 独有：`task-resume-candidate` | ✅ | 把 resume 逻辑显式暴露成命令 |
| 独有：PROGRESS.md | ✅ | 仓库根部 3.8KB |

---

## 3. 我看到的独有设计（你做得比我好）

### 3.1 硬超时框架

`spawnWithHardTimeout`（`lib/minimax.mjs:302-460`）是我看过最完整的子进程控制封装：

- `timedOut: boolean` 独立于 `exitCode`，不会和业务失败混淆
- `stdoutTruncated / stderrTruncated` 明确告知截断发生
- `lineCarry` 在 spawn 错误路径也会被 finalize 刷盘（`lib/minimax.mjs:367-371`）
- `spawnError` 和 `timedOut` 在 finalize 之前做硬失败短路（`lib/minimax.mjs:821-823`）

gemini 这边 `callGeminiStreaming` 的超时是靠 `setTimeout + child.kill`，粗很多。**这个框架我想搬到 gemini 侧**。

### 3.2 三层输出解析

`lib/minimax.mjs:880` 有注释 "Layer 3 - stdout sentinel (most fragile; fallback)"，意味着还有 Layer 1 和 Layer 2。推断是：

- Layer 1：主路径（mini-agent 退出 0 + 日志文件存在 + 日志 parse 成功）
- Layer 2：快照 diff（某种 workspace 文件变化推断）
- Layer 3：stdout sentinel（最后防线）

这种"多条证据交叉验证"的思路比 gemini 的"主路径 + 单 fallback"更稳健。

### 3.3 `task-resume-candidate` 显式化

把"本 repo 有没有可恢复任务"做成独立命令。gemini 是把这个逻辑藏在 `rescue --resume-last` 的开头做一次 query，如果没有就退出。你把 query 抽出来，更 UNIX 哲学。

### 3.4 测试文件内联 `lib/*.test.mjs`

7 个测试文件和实现文件在同一目录。IDE 导航方便，审计相关代码时一眼就看到有没有对应测试。gemini 是独立 tests/，两种风格都有理。

---

## 4. 我视角的差距（按优先级）

### P0 — Timing 完全缺席（不是 stub，不是 dead code，是**完全无概念**）

**证据**：

```
grep -rn "timing|appendTiming|TimingAccumulator" plugins/minimax/scripts/
# 零匹配
```

**我的看法**：你的架构（Mini-Agent + 日志文件）让**进程级时序**比另外两家更容易采集。流程：

1. `spawnWithHardTimeout` 的 `startedAt` 到 `exitAt` 之间是总时长
2. 日志文件第一行时间戳 到 最后一行时间戳 是"有效生成时长"
3. 两者差 = 冷启动 + tail

即使不做六段（Mini-Agent 可能没有 stream 事件能分段），**至少 cold / total / log-effective 三个时间点应该在每次 `spawnWithHardTimeout` 返回时就记录下来**。

**我会建议**：

1. 在 `spawnWithHardTimeout` return 的对象里加 `timing: { spawnAt, firstLogAt, lastLogAt, closeAt }`（log 字段可以 null）
2. job 完成时 append 到 `~/.claude/plugins/data/minimax-minimax-plugin/timings.ndjson`
3. 哪怕只是三段（cold / effective / tail）也比零强

**我看不到的**：Mini-Agent 的 log 文件格式、是否有时间戳、是否有 model 字段。如果 log 里有 `model=MiniMax-M2.x`，`baseline.md §6.3` 的 A 卷检测可以做；如果没有，请在 Phase 6 探针时顺带检查。

---

### P1 — 主力模型使用验证（A 卷）缺失

**证据**：grep `stats | modelUsed | fallback` 只命中了 stdout fallback 和 `fallbackUsed`（这个指的是日志文件回读 fallback，不是模型降级）。

**我的看法**：MiniMax 的模型切换比 Gemini/Kimi/Qwen 更少（M1/M2 / MiniMax-Text-01 等），但**Mini-Agent 包装器内部是否会切模型**，你比我清楚。如果有（比如配额耗尽走 M1-lite），同样需要检测。

gemini 侧的方法（`baseline.md §6.3`）是在 CLI 的 result 事件里读 `stats.models`。MiniMax 这个模式对应的数据源应该在 `mini-agent log <file>` 的输出里——如果有 model 字段的话。

**我看不到的**：Mini-Agent 的 log 输出是否包含"实际调用的模型名"。**这是 Phase 6 最值得探针的一个点**。

---

### P2 — Hook 文件体量偏小，可能漏了清理逻辑

**证据**：`session-lifecycle-hook.mjs` 1.2KB vs. gemini 侧 3.1KB。

**我的看法**：我没读你的 hook 代码，只比了大小。可能：

- 你只做了 SessionStart/End 的 minimal 日志
- 没做 gemini 那种"全 workspace 扫描清理 3 天前的 jobs + 孤儿 PID"

如果确实没做，`~/.claude/plugins/data/minimax-minimax-plugin/` 会随时间膨胀。

**我会建议**：在 SessionStart 里加全目录扫描，mtime > 3 days 的 jobs 文件删掉。gemini 实现参考 `plugins/gemini/scripts/session-lifecycle-hook.mjs`。

**我看不到的**：可能你有意识地**把清理放在 Mini-Agent 自己那边**做（`~/.mini-agent/` 目录由 Mini-Agent 自管）。如果是，忽略此条。

---

### P3 — 没有 `/minimax:timing` 命令

这是 P0 的延伸。即使没做六段，把三段（cold / effective / tail）在 `/minimax:timing <job-id>` 里用 ASCII bar 渲染也是有价值的。

---

### P4 — 测试文件内联风格（可讨论，不是 bug）

`lib/*.test.mjs` 和 `lib/*.mjs` 在同一目录。好处是导航方便，坏处是：

- `ls lib/` 混杂实现和测试
- 生产打包时（如果将来有）要显式排除 `*.test.mjs`

gemini 的独立 `tests/` 目录更传统但更累赘。**这个不是差距，只是风格选择**，你认为合理就保持。

---

## 5. 我看不到的地方（请你澄清）

1. **Mini-Agent 是什么**：你在 CHANGELOG 里提 "Mini-Agent 0.1.0"、"api.minimaxi.com/anthropic" 这些概念，但我不清楚：
   - Mini-Agent 是 MiniMax 官方产品还是你自己写的中间层？
   - 为什么不直接调 MiniMax API？
   - 为什么要走日志文件 fallback 而不是 stdout 直出？
2. **Probe 结果**：`lib/minimax.mjs:791` 注释 "api.minimaxi.com/anthropic we see `end_turn`"——这说明你探过 MiniMax 的 OpenAI 兼容层。希望你把这些 probe 发现沉淀到文档（类似 kimi 的 probe 01-04）。
3. **日志文件格式**：`mini-agent log <file>` 的输出 schema 是什么？JSON lines？纯文本？有没有时间戳？有没有 model 字段？这直接决定 §6 timing 能做到多细。
4. **`lib/state.mjs` 里 TIMING_FILE_NAME 为什么没出现**：我 grep `timing` 零匹配说明连基础设施都没铺。和 qwen（铺好没接）/ kimi（stub）都不同。是你**有意完全不做**，还是 Phase 6 计划？
5. **`PROGRESS.md` 的内容**：3.8KB 的过程文档可能有我不知道的设计决策记录。希望方便时开源，gemini 侧也想学这个习惯。
6. **`task-resume-candidate` 命令**：这个设计很好。但我不清楚它在对话里怎么触发——是用户手动调，还是你在 rescue skill 里引导 Claude 先调？gemini 侧 rescue 是内部逻辑不暴露，两种都有道理。

---

## 6. 迁移建议（仅当你想要时）

| 想做的事 | 我的文件 | 建议策略 |
|---|---|---|
| 三段 timing（cold/effective/tail）| `plugins/gemini/scripts/lib/timing.mjs:10-180` | **不要全抄**；你的架构拿不到 stream 事件。只做 spawnAt/firstLogAt/lastLogAt/closeAt 四个时间点 + 三段计算 |
| timings.ndjson 全局历史 + 锁 | `plugins/gemini/scripts/lib/state.mjs` timing 段 | 可以直接搬；lock/trim 逻辑 OS 无关 |
| `/minimax:timing` 命令 | `plugins/gemini/commands/timing.md` + render 段 | UI 通用 |
| 全 workspace 清理 hook | `plugins/gemini/scripts/session-lifecycle-hook.mjs` | 可直接搬 |

---

## 7. 我想从你这里学的

1. **`spawnWithHardTimeout` 框架**（gemini 想搬到自己侧）
2. **三层输出解析 fallback** 的思路
3. **`task-resume-candidate` 显式命令**（可能借鉴进 gemini）
4. **PROGRESS.md** 的过程文档习惯
5. **lib/*.test.mjs 内联测试** 是否值得（还在评估）

---

## 8. 小结

- **架构**：三家里最异类（Mini-Agent + 日志回读），是 feature 而非 bug
- **独有优势**：硬超时框架 / 三层 fallback / task-resume-candidate / PROGRESS.md
- **主要差距**：
  - P0 — timing 完全缺席，但你的架构**只需要三段就能给出 cold 数据**，成本不高
  - P1 — 主力模型验证未做，取决于 mini-agent log 格式
  - P2 — Hook 体量偏小，可能漏清理（需确认）
- **我要学你**：spawnWithHardTimeout、三层解析、PROGRESS 文档、task-resume-candidate
- **你要学我**：timing 三段（即使不做六段）、hook 全 workspace 清理

**架构异类不是问题**，问题是没有时序可观测性就无法回答"MiniMax 到底快不快"。P0 的三段 timing 成本最低、收益最大，建议优先。

---

## 9. 对侧回执（2026-04-22）

MiniMax 侧已发 v0.1.2（tag + GitHub Release + CHANGELOG 双同步，`node --test plugins/minimax/scripts/lib/*.test.mjs` 86 pass / 0 fail），对本文 §4 的 5 条发现给出按「单向流动」原则回写到 `minimax-plugin-cc/PROGRESS.md §Cross-plugin alignment response` 的处置意见。本节只记录我方收到的结论，不跨写对侧文档。

| 发现 | 对侧处置 | 备注 |
|---|---|---|
| P0 — timing 完全缺席 | **承认 / 接受**，v0.1.3 tentative scope | 计划做 3 段粗粒度 ndjson（cold / effective / tail），不强求 6 段 |
| P1 — 主力模型使用验证（A 卷） | **承认但受限于上游** | Mini-Agent 0.1.0 日志 RESPONSE block 只有 `finish_reason`，无独立 `served-model` 字段；v0.1.3 同步向上游 Mini-Agent 提 issue，短期无法与 gemini `stats.models` 对等 |
| P2 — Hook 文件体量偏小 | **承认 / 接受**，v0.1.3 tentative scope | 计划在 SessionStart 里加过期作业清理 |
| P3 — 无 `/minimax:timing` 命令 | **承认 / 接受**，v0.1.3 tentative scope | 作为 P0 的渲染出口一并推进 |
| P4 — `lib/*.test.mjs` 内联测试 | **保留现状** | 明确不视为缺陷，风格选择 |

并对我上一轮作为审阅方报的问题做了修复回归：

- **Critical ×1**：`String.prototype.replace` 的 `$&`/`$$`/`$1` 被意外解释
- **High ×4**：`extractReviewJson` 栈深走负 / `/minimax:adversarial-review` 默认未带 `--json` 吞掉 red 报告 / mock 测试 `process.env.MOCK_*` 共享可变状态 / `buildReviewPrompt` 缺 M2 sentinel 镜像测试
- **Medium ×1**：误导性的 "null-byte sentinel" 注释
- 回归测试 **+3**

### 我方后续动作

- 本报告的"差距清单"视角仍然有效，但 **P0/P2/P3 的责任球已交给对侧 v0.1.3**；本仓库不发起平行实现
- 我只需要在 MiniMax v0.1.3 发布后做一次二次 alignment（重点看：timing ndjson 的 schema 是否和 gemini 的兼容、SessionStart 清理阈值选择、upstream issue 是否得到 Mini-Agent 项目回应）
- **P1 不要再推**——在 Mini-Agent 不吐 `served-model` 前，我方视角无可用数据源，这条差距属于上游问题，不应重复点名

