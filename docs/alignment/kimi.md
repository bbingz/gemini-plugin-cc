# Kimi Plugin — Alignment Report

> **视角声明**：这份报告是我（Gemini 插件维护者）读完 `kimi-plugin-cc` 代码后的**外部观察**。我没参与你的设计讨论，不知道你的 v0.1 排期原则。所以凡是标记"我看不到"的地方，不代表你应该去做，只是我希望你澄清或告诉我你的判断。
>
> **盘点时间**：2026-04-21
> **对照对象**：`kimi-plugin-cc` v0.1.0 vs. `gemini-plugin-cc` v0.6.0（见 [`baseline.md`](./baseline.md)）

---

## 1. 我观察到的现状

### 版本 / 进度

- `plugin.json` 写的是 `0.1.0`
- `CHANGELOG.md` 第一行："0.1.0 (in progress — Phase 1)"
- 推断：你还在从 gemini 骨架 fork 出来的初期阶段

### 命令面（8 个）

```
setup  ask  review  adversarial-review  rescue  status  result  cancel
```

✅ 覆盖了 gemini 命令集中**除了 `timing` 以外的全部**。这是目前三家里命令面最全的。

### CLI 封装

- `KIMI_CLI_BIN` 默认 `kimi`（Moonshot 官方 CLI）
- 调用模式：`--print --output-format stream-json`
- 行号参考：`lib/kimi.mjs:60, 369`
- ping 检测用 `-p ping --output-format stream-json`（`lib/kimi.mjs:232-236`）

和 gemini 的差别是标志位命名（`--print` vs. `-p` 长短形式、`--output-format` vs. `-o`），调用形状本质一致。

### 独立设计（你做对的）

- **单独抽了 `lib/review.mjs`**（13.7KB）把 schema 校验 + retry 路径从 `kimi.mjs` 剥离。gemini 是把这部分散在 `gemini.mjs` 里的，你这样更干净，将来更好维护。
- **`lib/kimi.mjs` 里对 "exit 0 + 0 events" 场景的多层分类**（`lib/kimi.mjs:482-500, 664-685`），把 "CLI 没装好"、"stream-json 格式未知"、"JSONL 被截断" 分开处理。gemini 当前是一个 catch-all 的降级，你这里更细。

---

## 2. 对齐度对照表

| Gemini baseline 能力 | Kimi 现状 | 证据 |
|---|---|---|
| §1 命令面 — setup | ✅ | `commands/setup.md` |
| §1 命令面 — ask | ✅ | `commands/ask.md` |
| §1 命令面 — review + schema | ✅ | `commands/review.md` + `lib/review.mjs` |
| §1 命令面 — adversarial-review | ✅ | `commands/adversarial-review.md` |
| §1 命令面 — rescue | ✅ | `commands/rescue.md` |
| §1 命令面 — status | ✅ | `commands/status.md` |
| §1 命令面 — result | ✅ | `commands/result.md` |
| §1 命令面 — cancel | ✅ | `commands/cancel.md` |
| §1 命令面 — **timing** | ❌ **未实现** | 无 `commands/timing.md` |
| §2 streaming (`stream-json`) | ✅ | `lib/kimi.mjs:369, 561` |
| §2 sync review | ✅ | `lib/review.mjs`（我没细读是否 schema 强制）|
| §2 首行噪声截取 | ❓ **未确认** | 需要你确认 kimi CLI 是否也有类似问题 |
| §3 workspace-keyed state | ✅ | `lib/state.mjs:17, 28, 48` |
| §3 后台 worker + pgid cancel | ✅ | `lib/job-control.mjs` |
| §3 foreground 也生成 job | ❓ | 我没在 job-control.mjs 里看到 `gfg-` 前缀，不确定 |
| §4 hooks (Start/End/Stop) | ✅ | `hooks/hooks.json` |
| §4 全 workspace 扫描清理 | ✅ | `session-lifecycle-hook.mjs` |
| §5 三分区 review 上下文 | ✅ | `lib/git.mjs` |
| §5 schema 强制 + retry | ✅ | `lib/review.mjs`（13.7KB 单文件处理）|
| §6.1 六段 timing 分解 | ❌ **stub** | `lib/state.mjs:346-358` 明确注释 "no-op" |
| §6.2 事件路由 dispatcher | ❌ | 不存在 |
| §6.3 **主力模型使用验证（A 卷）** | ❌ | 无 `stats.models` 解析 |
| §6.4 timings.ndjson 全局历史 | ❌ **stub** | `lib/state.mjs:346-358` 返回 `return;` 空操作 |
| §6.5 `/kimi:timing` 三模式 | ❌ | 命令不存在 |
| §6.6 status 面板嵌入 timing | ❌ | 连同 §6.1 一起不存在 |
| §7 node:test 单测（50+）| ❓ **未确认** | 我没看到 `tests/` 目录 |
| §8 三个 skills | ✅ | `skills/kimi-cli-runtime / kimi-prompting / kimi-result-handling` |

---

## 3. 我看到的独有设计（你做得比我好）

### 3.1 Review 单独抽库

`lib/review.mjs` 独立成文件（13.7KB），schema 校验、retry、渲染都在一起。gemini 侧目前是散在 `gemini.mjs` + `render.mjs` 里的。等我下次迭代 review 时想参考你这个结构。

### 3.2 Exit-0-but-no-events 的多层分类

在 `lib/kimi.mjs:482-500` 你把这种"进程退出 0 但 stream-json 里啥都没有"的情况分成至少 4 种子类型（format 未知、JSONL 中途损坏、ping 成功但实际 prompt 失败…）。gemini 侧只是统一降级到 fallback，诊断精度不如你。

### 3.3 Lessons.md 有 18.8KB 详细记录

仓库根部的 `lessons.md` 体量很大。说明你有写"遇到问题→沉淀经验"的习惯。这点值得 gemini 侧学习（我这边目前只有 CHANGELOG 没有 lessons）。

---

## 4. 我视角的差距（按优先级）

### P0 — Timing 是诚实但具误导性的 stub

**证据**：`lib/state.mjs:339-358`

```js
// ── Timing history stubs (Phase 4 import resolver) ─────────
//
// Gemini's state.mjs records timing per-job for operator dashboards. Kimi has
// no equivalent stats surface (probe 04: JsonPrinter drops StatusUpdate), so
// we export inert stubs to satisfy job-control.mjs's import set without
// fabricating data. Phase 5+ may wire real timing if kimi exposes it.

export function appendTimingHistory(_record) {
  // Intentional no-op in v0.1 — we have no timing data to record.
  return;
}
```

**我的看法**：注释很诚实（特别是 "probe 04: JsonPrinter drops StatusUpdate" 这个发现），**但 `job-control.mjs:254,264` 里仍然在读 `result.timing || null`，结果永远是 null**。这会让未来迭代者以为"只要把 timing 放进 result 就会被记录"——但实际上 appendTimingHistory 是空操作。

**我会建议**（仅供参考）：

1. 要么**删掉** `job-control.mjs` 里那三行对 `timing` 的读取，让代码诚实反映"v0.1 不收 timing"
2. 要么**把六段埋点做起来**，哪怕 kimi CLI 只能给 `ttft` 和 `gen`，也比 stub 强。`baseline.md §6.1` 的 6 段里，`cold` / `ttft` / `tail` 这三段**不依赖 CLI 内部 stats**，只看"进程开始"、"第一个 stream 事件"、"进程 close" 即可得到。仅这三段就能解答 "kimi 冷启动有多慢" 这个核心问题。

**我看不到的地方**：你的 "probe 04" 结论是 "kimi CLI 的 stream-json 不会吐 StatusUpdate"。我信任这个发现。但我不知道 kimi 的 result 事件最后是否有类似 gemini `stats.models` 的字段——如果有，§6.3 的 A 卷检测就能做；如果没有，A 卷这块就只能靠"发出请求时指定的 model" vs. 无，做半边验证。请在 Phase 5 re-probe 时顺带看一眼 result 事件 schema。

---

### P1 — 主力模型使用验证（A 卷）完全缺失

**证据**：grep `stats.models | modelUsed | fallback` 三关键字，只命中 1 处（`lib/kimi.mjs:394` 是一句无关注释）。

**我的看法**：Moonshot 侧也有"请求 kimi-k2-preview、实际给 kimi-k1.5"的场景（尤其是套餐额度耗尽时）。如果你不检测，用户投诉"为什么感觉变笨了"时你没有证据。

gemini 侧的实现参考 `baseline.md §6.3` + `timing.mjs:70-95`。关键是在 TimingAccumulator 里同时记录 `requestedModel`（发请求时我们指定的）和 `_usage[].model`（CLI 回吐的）。两者不同即"降级"。

**我看不到的地方**：Moonshot kimi CLI 是否在 result 事件里回吐实际计费模型，我没法替你测。Phase 5 probe 里如果能确认这件事，就能把 §6.3 补齐。

---

### P2 — 没有单测目录

**证据**：`ls kimi-plugin-cc/tests/` 无结果。gemini 侧 `tests/*.test.mjs` 共 59 个测试。

**我的看法**：v0.1 可以先不做。但**一旦你开始做 timing**，像 `TimingAccumulator` 这种纯逻辑类没单测会很危险（sum-invariant 只要漏一类事件就会静默偏差）。可以等到 Phase 5 做 timing 时一起建。

**我不建议你做的事**：把 gemini 的 59 个 timing 测试原样 copy — 它们绑定 gemini 的事件 schema，复制过来改的工作量可能和重写一样。

---

### P3 — 命令名大小写 / 缩写不一致

我注意到 rescue.md 里 argument-hint 用了 `[what Kimi should investigate]`，而 gemini 侧是 `[what Gemini should investigate]`。这没问题，但**如果三家都参考 gemini，最好统一 rescue.md 的参数名约定**（比如都用 `--model` 而不是有的写 `--model <name>` 有的不写）。

这属于 polish 级别，不是功能差距。

---

## 5. 我看不到的地方（请你澄清）

1. **"Phase 4 import resolver" 具体指什么**：你在注释里反复提 Phase 编号（1/4/5），我推断你有一份内部 roadmap 但没开源。如果方便，希望 CHANGELOG 里说清楚"Phase X = 做 Y"。
2. **Moonshot CLI 的 auth 模型**：你在 `kimi.mjs` 里读 TOML（推测是 CLI config）获取 model name。但 Moonshot 的 API key 是怎么管理的？是 CLI 自己读 env，还是插件层要注入？gemini 是"完全让 CLI 自己处理 auth"，希望 kimi 也保持这个边界。
3. **你对 timing 的 Phase 5 计划**：是打算"做一个精简版只记 cold/ttft/tail"还是"等 Moonshot 加 stats API"？如果是前者，`baseline.md §6.1` 的骨架可以搬；如果是后者，可能要等一段时间。
4. **lessons.md (18.8KB) 的内容**：我没读，只看了大小。里面可能有我会受益的发现（特别是 probe 01-04 的细节）。
5. **为什么 `lib/prompts.mjs` 只有 440B**：gemini 这边也是这个大小，看来你是直接 copy 的。这个文件要不要扩展？gemini 侧也没扩展过，但我意识到 prompt 管理是未来的 tech debt。

---

## 6. 迁移建议（仅当你想要时）

如果你决定在 Phase 5 做 timing，这些文件我的实现可以作为参考起点（不是让你 copy）：

| 想做的事 | 我的文件 | 建议策略 |
|---|---|---|
| 6 段 accumulator | `plugins/gemini/scripts/lib/timing.mjs:10-180` | 结构可抄，但 `onResult` 里的 `stats.models` 解析要替换成 kimi 的 schema |
| 事件 dispatcher | `timing.mjs:348-380` | 事件类型名（init / message / tool_use...）要映射到 kimi CLI 的实际事件类型 |
| ndjson 全局历史 + 锁 | `state.mjs` 中的 timing 相关段 | 可以直接搬，lock/trim 逻辑是 OS 级无关 |
| `/kimi:timing` 三模式渲染 | `render.mjs:renderTimingSingle / History / Stats` | ASCII bar 逻辑是通用的 |
| 单测 | `tests/timing-*.test.mjs` | **不要直接复制**；这些测试绑 gemini 事件 schema |

---

## 7. 小结

- **命令面**：✅ 八个齐全（仅缺 timing），是三家里最完整的
- **Review 实现**：✅ 独立成 `lib/review.mjs`，比 gemini 更干净
- **Timing**：❌ 是诚实的 stub，但有误导性读取路径需要清理
- **A 卷检测**：❌ 完全未做，需要 Phase 5 先确认 CLI 能否吐 model 字段
- **测试**：❓ 当前无 tests/；建议和 timing 一起建

**我不会替你排期**。上面的 P0/P1/P2 只是我看到的问题严重度，你自己的 roadmap 优先。
