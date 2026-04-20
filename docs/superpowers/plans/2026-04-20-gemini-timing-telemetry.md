# Gemini Timing Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument streaming `callGeminiStreaming` to attribute per-job wall time to 6 segments (cold / ttft / gen / tool / retry / tail), persist a global history, and surface via a new `/gemini:timing` command. Ship 0.6.0.

**Architecture:** A pure `TimingAccumulator` class converts NDJSON events into a timing object with an invariant sum check. `callGeminiStreaming` feeds it events as they arrive. A dedicated append-only NDJSON file (`timings.ndjson`) under a dedicated lock captures history globally. The new command reads the history and renders three views (single-job detail / history table / aggregate stats).

**Tech Stack:** Node.js ESM, zero external deps. Tests use built-in `node:test` + `node:assert/strict`. Run with `node --test tests/`.

**Spec:** `docs/superpowers/specs/2026-04-20-gemini-timing-telemetry-design.md`

---

## File Structure

### New files
- `tests/timing-accumulator.test.mjs` — unit tests for TimingAccumulator
- `tests/timing-storage.test.mjs` — unit tests for ndjson append/read/trim
- `tests/timing-render.test.mjs` — unit tests for bars / summary line
- `tests/timing-aggregate.test.mjs` — unit tests for percentiles / stats
- `plugins/gemini/scripts/lib/timing.mjs` — `TimingAccumulator` + render + aggregate pure functions
- `plugins/gemini/commands/timing.md` — slash command frontmatter

### Modified files
- `plugins/gemini/scripts/lib/gemini.mjs` — wire `TimingAccumulator` into `callGeminiStreaming`
- `plugins/gemini/scripts/lib/state.mjs` — `appendTimingHistory`, `readTimingHistory`, dedicated lock, trim, partial-line repair
- `plugins/gemini/scripts/lib/job-control.mjs` — worker persists timing + appends to history
- `plugins/gemini/scripts/lib/render.mjs` — status view timing summary line
- `plugins/gemini/scripts/gemini-companion.mjs` — route `timing` subcommand
- `plugins/gemini/CHANGELOG.md` — 0.6.0 entry
- `plugins/gemini/.claude-plugin/plugin.json` — 0.5.2 → 0.6.0
- `CHANGELOG.md` (root) — 0.6.0 entry

---

## Phase 0: Bootstrap Test Harness

### Task 0.1: Create tests/ directory with a smoke test

**Files:**
- Create: `tests/smoke.test.mjs`

- [ ] **Step 1: Write the smoke test**

```javascript
// tests/smoke.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

test("node:test runner is available", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 2: Run it**

Run: `node --test tests/smoke.test.mjs`
Expected: `# pass 1`

- [ ] **Step 3: Commit**

```bash
git add tests/smoke.test.mjs
git commit -m "test: bootstrap node:test harness"
```

---

## Phase 1: TimingAccumulator (pure class)

### Task 1.1: Stub TimingAccumulator + happy-path timing

**Files:**
- Create: `plugins/gemini/scripts/lib/timing.mjs`
- Create: `tests/timing-accumulator.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/timing-accumulator.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { TimingAccumulator } from "../plugins/gemini/scripts/lib/timing.mjs";

test("happy path — 5 boundaries produce correct segments", () => {
  const acc = new TimingAccumulator({ spawnedAt: 1000, prompt: "hello" });
  acc.onFirstEvent(1200);                  // cold = 200
  acc.onFirstToken(1500);                  // ttft = 300
  acc.onLastToken(2500);                   // stream = 1000
  acc.onClose(2510, { exitCode: 0 });      // tail = 10; total = 1510

  const t = acc.build();
  assert.equal(t.firstEventMs, 200);
  assert.equal(t.ttftMs, 300);
  assert.equal(t.streamMs, 1000);
  assert.equal(t.toolMs, 0);
  assert.equal(t.retryMs, 0);
  assert.equal(t.tailMs, 10);
  assert.equal(t.totalMs, 1510);
  assert.equal(t.exitCode, 0);
  assert.equal(t.timedOut, false);
  assert.equal(t.terminationReason, "exit");
  assert.equal(t.promptBytes, 5);  // "hello".length
  // Invariant
  assert.equal(
    t.firstEventMs + t.ttftMs + t.streamMs + t.toolMs + t.retryMs + t.tailMs,
    t.totalMs
  );
});
```

- [ ] **Step 2: Run — expect fail (module not found)**

Run: `node --test tests/timing-accumulator.test.mjs`
Expected: fail with `Cannot find module '.../timing.mjs'`

- [ ] **Step 3: Implement minimum**

```javascript
// plugins/gemini/scripts/lib/timing.mjs

export class TimingAccumulator {
  constructor({ spawnedAt = Date.now(), prompt = "" } = {}) {
    this._t = {
      spawned: spawnedAt,
      firstEvent: null,
      firstToken: null,
      lastToken: null,
      close: null,
    };
    this._toolMs = 0;
    this._retryMs = 0;
    this._promptBytes = Buffer.byteLength(prompt || "", "utf8");
    this._responseBytes = 0;
    this._termination = { reason: "exit", exitCode: 0, signal: null, timedOut: false };
  }

  onFirstEvent(t = Date.now()) {
    if (this._t.firstEvent == null) this._t.firstEvent = t;
  }

  onFirstToken(t = Date.now()) {
    if (this._t.firstToken == null) this._t.firstToken = t;
  }

  onLastToken(t = Date.now()) {
    this._t.lastToken = t;
  }

  onClose(t = Date.now(), { exitCode = 0, timedOut = false, signal = null } = {}) {
    this._t.close = t;
    this._termination = {
      reason: timedOut ? "timeout" : signal ? "signal" : exitCode !== 0 ? "error" : "exit",
      exitCode,
      signal,
      timedOut,
    };
  }

  recordResponseBytes(n) {
    this._responseBytes += n;
  }

  build() {
    const spawned = this._t.spawned;
    const close = this._t.close ?? Date.now();
    const firstEvent = this._t.firstEvent;
    const firstToken = this._t.firstToken;
    const lastToken = this._t.lastToken;

    const firstEventMs = firstEvent != null ? firstEvent - spawned : null;
    const ttftMs = firstToken != null && firstEvent != null ? firstToken - firstEvent : null;
    const rawStream = lastToken != null && firstToken != null ? lastToken - firstToken : 0;
    const streamMs = Math.max(0, rawStream - this._toolMs - this._retryMs);
    const tailMs = lastToken != null ? Math.max(0, close - lastToken) : null;
    const totalMs = close - spawned;

    return {
      spawnedAt: new Date(spawned).toISOString(),
      firstEventMs,
      ttftMs,
      streamMs,
      toolMs: this._toolMs,
      retryMs: this._retryMs,
      tailMs,
      totalMs,
      promptBytes: this._promptBytes,
      responseBytes: this._responseBytes,
      exitCode: this._termination.exitCode,
      terminationReason: this._termination.reason,
      timedOut: this._termination.timedOut,
      signal: this._termination.signal,
      // Filled by later tasks:
      requestedModel: null,
      usage: [],
      tokensPerSec: null,
      coldStartPhases: null,
    };
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `node --test tests/timing-accumulator.test.mjs`
Expected: `# pass 1`

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/timing.mjs tests/timing-accumulator.test.mjs
git commit -m "feat(timing): TimingAccumulator with 5-boundary happy path"
```

---

### Task 1.2: Tool time accumulation

**Files:**
- Modify: `plugins/gemini/scripts/lib/timing.mjs`
- Modify: `tests/timing-accumulator.test.mjs`

- [ ] **Step 1: Add failing test**

Append to `tests/timing-accumulator.test.mjs`:
```javascript
test("tool cycles accumulate into toolMs and subtract from streamMs", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onFirstToken(200);
  acc.onToolUseStart(300);
  acc.onToolResult(500);          // one tool cycle: 200ms
  acc.onToolUseStart(700);
  acc.onToolResult(800);          // another: 100ms
  acc.onLastToken(1200);          // (1200 - 200) = 1000 raw; minus 300 tool = 700 stream
  acc.onClose(1210, { exitCode: 0 });

  const t = acc.build();
  assert.equal(t.toolMs, 300);
  assert.equal(t.streamMs, 700);
  // Invariant
  assert.equal(
    t.firstEventMs + t.ttftMs + t.streamMs + t.toolMs + t.retryMs + t.tailMs,
    t.totalMs
  );
});
```

- [ ] **Step 2: Run — expect fail**

Run: `node --test tests/timing-accumulator.test.mjs`
Expected: `onToolUseStart is not a function`

- [ ] **Step 3: Implement**

Add to `TimingAccumulator`:
```javascript
  onToolUseStart(t = Date.now()) {
    this._toolStart = t;
  }

  onToolResult(t = Date.now()) {
    if (this._toolStart != null) {
      this._toolMs += t - this._toolStart;
      this._toolStart = null;
    }
  }
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/timing.mjs tests/timing-accumulator.test.mjs
git commit -m "feat(timing): toolMs accumulation via tool_use/tool_result cycles"
```

---

### Task 1.3: Retry delay accumulation

**Files:**
- Modify: `plugins/gemini/scripts/lib/timing.mjs`
- Modify: `tests/timing-accumulator.test.mjs`

- [ ] **Step 1: Add failing test**

```javascript
test("retry windows accumulate into retryMs and subtract from streamMs", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onFirstToken(200);
  acc.onRetryStart(400);
  acc.onRetryEnd(600);            // 200ms retry
  acc.onRetryStart(900);
  acc.onRetryEnd(950);            // 50ms retry
  acc.onLastToken(1200);          // 1000 raw; minus 250 retry = 750 stream
  acc.onClose(1210, { exitCode: 0 });

  const t = acc.build();
  assert.equal(t.retryMs, 250);
  assert.equal(t.streamMs, 750);
});

test("retry before first token is subtracted from ttftMs", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onRetryStart(150);
  acc.onRetryEnd(350);            // 200ms retry during ttft
  acc.onFirstToken(500);          // raw ttft = 400; net = 200
  acc.onLastToken(600);
  acc.onClose(610, { exitCode: 0 });

  const t = acc.build();
  assert.equal(t.retryMs, 200);
  assert.equal(t.ttftMs, 200);    // 400 - 200
});
```

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement**

Add to `TimingAccumulator`:
```javascript
  onRetryStart(t = Date.now()) {
    this._retryStart = t;
  }

  onRetryEnd(t = Date.now()) {
    if (this._retryStart != null) {
      const delta = t - this._retryStart;
      this._retryMs += delta;
      // Split bookkeeping: track retry time that occurred before firstToken
      if (this._t.firstToken == null) {
        this._retryMsBeforeFirstToken = (this._retryMsBeforeFirstToken || 0) + delta;
      }
      this._retryStart = null;
    }
  }
```

Modify `build()` to subtract `_retryMsBeforeFirstToken` from `ttftMs`:
```javascript
    const rawTtft = firstToken != null && firstEvent != null ? firstToken - firstEvent : null;
    const ttftMs = rawTtft != null
      ? Math.max(0, rawTtft - (this._retryMsBeforeFirstToken || 0))
      : null;
    const rawStream = lastToken != null && firstToken != null ? lastToken - firstToken : 0;
    const retryMsAfterFirstToken = this._retryMs - (this._retryMsBeforeFirstToken || 0);
    const streamMs = Math.max(0, rawStream - this._toolMs - retryMsAfterFirstToken);
```

- [ ] **Step 4: Run — expect pass** (including all prior tests)

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/timing.mjs tests/timing-accumulator.test.mjs
git commit -m "feat(timing): retryMs accumulation with ttft/stream attribution"
```

---

### Task 1.4: Per-model usage + token fields

**Files:**
- Modify: `plugins/gemini/scripts/lib/timing.mjs`
- Modify: `tests/timing-accumulator.test.mjs`

- [ ] **Step 1: Add failing test**

```javascript
test("per_model_usage populates usage[] and drives tokensPerSec", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.setRequestedModel("gemini-3-pro-preview");
  acc.onFirstEvent(100);
  acc.onFirstToken(200);
  acc.onLastToken(2200);          // streamMs = 2000 ms = 2s
  acc.onResult({
    stats: {
      per_model_usage: [
        { model: "gemini-3.1-pro-preview",   input_token_count: 100, output_token_count: 50,  thoughts_token_count: 20 },
        { model: "gemini-3-flash-preview",   input_token_count: 200, output_token_count: 150, thoughts_token_count: 30 },
      ],
    },
  });
  acc.onClose(2210, { exitCode: 0 });

  const t = acc.build();
  assert.equal(t.requestedModel, "gemini-3-pro-preview");
  assert.equal(t.usage.length, 2);
  assert.deepEqual(t.usage[0], { model: "gemini-3.1-pro-preview", input: 100, output: 50, thoughts: 20 });
  // tokensPerSec = (50+150+20+30) / 2.0 = 125
  assert.equal(t.tokensPerSec, 125);
});

test("flat stats fallback when no per_model_usage", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.setRequestedModel("gemini-3-flash-preview");
  acc.onFirstEvent(100);
  acc.onFirstToken(200);
  acc.onLastToken(1200);          // 1s stream
  acc.onResult({
    stats: { input_token_count: 100, output_token_count: 200, thoughts_token_count: 50 },
  });
  acc.onClose(1210, { exitCode: 0 });

  const t = acc.build();
  assert.equal(t.usage.length, 1);
  assert.equal(t.usage[0].model, "gemini-3-flash-preview");
  assert.equal(t.usage[0].output, 200);
  assert.equal(t.tokensPerSec, 250);   // (200+50) / 1
});

test("missing token fields leave tokensPerSec null", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onFirstToken(200);
  acc.onLastToken(1200);
  acc.onResult({ stats: {} });
  acc.onClose(1210, { exitCode: 0 });
  assert.equal(acc.build().tokensPerSec, null);
});
```

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement**

Add to `TimingAccumulator`:
```javascript
  setRequestedModel(m) {
    this._requestedModel = m || null;
  }

  onResult(resultEvent) {
    const stats = resultEvent?.stats || {};
    if (Array.isArray(stats.per_model_usage) && stats.per_model_usage.length > 0) {
      this._usage = stats.per_model_usage.map((u) => ({
        model: u.model ?? "unknown",
        input: u.input_token_count ?? 0,
        output: u.output_token_count ?? 0,
        thoughts: u.thoughts_token_count ?? 0,
      }));
    } else if (
      stats.input_token_count != null ||
      stats.output_token_count != null ||
      stats.thoughts_token_count != null
    ) {
      this._usage = [{
        model: this._requestedModel ?? "unknown",
        input: stats.input_token_count ?? 0,
        output: stats.output_token_count ?? 0,
        thoughts: stats.thoughts_token_count ?? 0,
      }];
    }
  }
```

Modify `build()` to set `requestedModel`, `usage`, `tokensPerSec`:
```javascript
    const usage = this._usage || [];
    const totalOutputAndThoughts = usage.reduce((s, u) => s + (u.output || 0) + (u.thoughts || 0), 0);
    const tokensPerSec = usage.length > 0 && streamMs > 0
      ? Math.round((totalOutputAndThoughts / (streamMs / 1000)) * 10) / 10
      : null;

    return {
      // ...existing fields,
      requestedModel: this._requestedModel || null,
      usage,
      tokensPerSec,
      // ...
    };
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/timing.mjs tests/timing-accumulator.test.mjs
git commit -m "feat(timing): per_model_usage parsing + tokensPerSec"
```

---

### Task 1.5: Cold-start phases breakdown

**Files:**
- Modify: `plugins/gemini/scripts/lib/timing.mjs`
- Modify: `tests/timing-accumulator.test.mjs`

- [ ] **Step 1: Add failing test**

```javascript
test("onStartupStats populates coldStartPhases verbatim", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onStartupStats({
    phases: [
      { phase: "runtime", ms: 420 },
      { phase: "config",  ms: 180 },
    ],
  });
  acc.onFirstEvent(700);
  acc.onFirstToken(900);
  acc.onLastToken(1000);
  acc.onClose(1010, { exitCode: 0 });

  const t = acc.build();
  assert.deepEqual(t.coldStartPhases, [
    { phase: "runtime", ms: 420 },
    { phase: "config", ms: 180 },
  ]);
});

test("no startup_stats event leaves coldStartPhases null", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onFirstToken(200);
  acc.onLastToken(300);
  acc.onClose(310, { exitCode: 0 });
  assert.equal(acc.build().coldStartPhases, null);
});
```

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement**

Add to `TimingAccumulator`:
```javascript
  onStartupStats(event) {
    if (event && Array.isArray(event.phases)) {
      this._coldStartPhases = event.phases.map((p) => ({
        phase: String(p.phase || "unknown"),
        ms: Number(p.ms) || 0,
      }));
    }
  }
```

Modify `build()` to return `coldStartPhases: this._coldStartPhases || null`.

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/timing.mjs tests/timing-accumulator.test.mjs
git commit -m "feat(timing): coldStartPhases from gemini_cli.startup_stats event"
```

---

### Task 1.6: Termination reason discriminator

**Files:**
- Modify: `tests/timing-accumulator.test.mjs`

- [ ] **Step 1: Add failing tests**

```javascript
test("timeout → terminationReason=timeout, timedOut=true", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onClose(60_000, { timedOut: true, exitCode: null });
  const t = acc.build();
  assert.equal(t.terminationReason, "timeout");
  assert.equal(t.timedOut, true);
  assert.equal(t.ttftMs, null);
  assert.equal(t.streamMs, 0);     // no stream reached
});

test("signal → terminationReason=signal, signal name recorded", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onFirstToken(200);
  acc.onLastToken(300);
  acc.onClose(310, { signal: "SIGINT", exitCode: null });
  const t = acc.build();
  assert.equal(t.terminationReason, "signal");
  assert.equal(t.signal, "SIGINT");
});

test("non-zero exit → terminationReason=error", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onClose(200, { exitCode: 1 });
  const t = acc.build();
  assert.equal(t.terminationReason, "error");
  assert.equal(t.exitCode, 1);
});
```

- [ ] **Step 2: Run — these should already pass from Task 1.1's `onClose` logic**

Run: `node --test tests/timing-accumulator.test.mjs`
Expected: all pass. If any fail, fix `onClose` to correctly dispatch between the 4 reasons. The implementation from Task 1.1 handles this; tests here pin it down.

- [ ] **Step 3: Commit**

```bash
git add tests/timing-accumulator.test.mjs
git commit -m "test(timing): pin terminationReason for timeout/signal/error paths"
```

---

### Task 1.7: Invariant sum assertion

**Files:**
- Modify: `plugins/gemini/scripts/lib/timing.mjs`
- Modify: `tests/timing-accumulator.test.mjs`

- [ ] **Step 1: Add failing test**

```javascript
test("build() result satisfies segment-sum invariant on happy path", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onFirstToken(200);
  acc.onToolUseStart(300);
  acc.onToolResult(450);
  acc.onRetryStart(500);
  acc.onRetryEnd(550);
  acc.onLastToken(900);
  acc.onClose(910, { exitCode: 0 });

  const t = acc.build();
  const sum = t.firstEventMs + t.ttftMs + t.streamMs + t.toolMs + t.retryMs + t.tailMs;
  assert.equal(sum, t.totalMs, `invariant broken: ${sum} !== ${t.totalMs}`);
});

test("build() exposes invariant via explicit property for runtime assertions", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onFirstToken(200);
  acc.onLastToken(300);
  acc.onClose(310, { exitCode: 0 });
  assert.equal(acc.build().invariantOk, true);
});
```

- [ ] **Step 2: Run — expect fail (invariantOk missing)**

- [ ] **Step 3: Implement**

In `build()` right before return, compute:
```javascript
    const sum = (firstEventMs || 0) + (ttftMs || 0) + streamMs + this._toolMs + this._retryMs + (tailMs || 0);
    const invariantOk = sum === totalMs;
```

Add `invariantOk` to the returned object.

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/timing.mjs tests/timing-accumulator.test.mjs
git commit -m "feat(timing): invariantOk flag validates segment sum equals total"
```

---

## Phase 2: Integrate with callGeminiStreaming

### Task 2.1: Wire TimingAccumulator into streaming flow

**Files:**
- Modify: `plugins/gemini/scripts/lib/gemini.mjs:209-335`

- [ ] **Step 1: Read context**

Read `plugins/gemini/scripts/lib/gemini.mjs` lines 209-335 to understand the current streaming function.

- [ ] **Step 2: Import TimingAccumulator and instantiate**

At top of `gemini.mjs`, add:
```javascript
import { TimingAccumulator } from "./timing.mjs";
```

Inside `callGeminiStreaming`, immediately before `return new Promise((resolve) => {`:
```javascript
  const timing = new TimingAccumulator({ spawnedAt: Date.now(), prompt });
  if (model || getSettingsModel()) timing.setRequestedModel(model || getSettingsModel());
```

Inject `GEMINI_TELEMETRY_ENABLED=1` in child env:
```javascript
    const child = spawn("gemini", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GEMINI_TELEMETRY_ENABLED: "1" },
    });
```

- [ ] **Step 3: Hook timing into processLine**

Modify `processLine(raw)` — after successful `JSON.parse(raw.slice(jsonStart))`, add as the FIRST action after parse:
```javascript
      timing.onFirstEvent();
```

Inside the existing `if (event.type === "init")` branch, add:
```javascript
        if (event.model) timing.setRequestedModel(event.model);
```

Inside the `else if (event.type === "message" && event.role === "assistant")` branch, add:
```javascript
        if (event.content != null && event.content.length > 0) {
          timing.onFirstToken();
          timing.onLastToken();
          timing.recordResponseBytes(Buffer.byteLength(event.content, "utf8"));
        }
```

Add new branches for tool/retry/startup/result:
```javascript
      } else if (event.type === "tool_use") {
        timing.onToolUseStart();
      } else if (event.type === "tool_result") {
        timing.onToolResult();
      } else if (event.type === "error" && !event.fatal) {
        // Non-fatal error = retry window start
        timing.onRetryStart();
      } else if (timing._retryStart != null && event.type !== "error") {
        // Any non-error event after a retry start closes the window
        timing.onRetryEnd();
      } else if (event.type === "gemini_cli.startup_stats") {
        timing.onStartupStats(event);
      } else if (event.type === "result") {
        timing.onResult(event);
        stats = event.stats || null;
      }
```

- [ ] **Step 4: Hook timing into close handler**

Modify the `child.on("close", (exitCode) => {` handler:
- At the very top of the handler, immediately after `clearTimeout(timer);`, capture close time:
```javascript
      timing.onClose(Date.now(), {
        exitCode,
        timedOut,
        signal: child.signalCode || null,
      });
```

- At the end of each `resolve({ ... })` call in the handler, add `timing: timing.build(),` to the object.

- [ ] **Step 5: Sanity check compile**

Run: `node -e "import('./plugins/gemini/scripts/lib/gemini.mjs').then(m => console.log(typeof m.callGeminiStreaming))"`
Expected: `function`

- [ ] **Step 6: Commit**

```bash
git add plugins/gemini/scripts/lib/gemini.mjs
git commit -m "feat(gemini): instrument callGeminiStreaming with TimingAccumulator"
```

---

### Task 2.2: Integration smoke — run a real task and verify timing

**Files:**
- No source changes

- [ ] **Step 1: Run a small real task**

Run:
```bash
node plugins/gemini/scripts/gemini-companion.mjs ask "What is 2+2? Answer in one word." --json 2>/dev/null | tail -c 4000
```

- [ ] **Step 2: Verify `timing` is present and invariant holds**

Inspect the JSON output. It must contain a `timing` object with:
- `firstEventMs` > 0
- `ttftMs` ≥ 0 (may be 0 on ultra-fast responses)
- `streamMs` ≥ 0
- `totalMs` > 0
- `invariantOk: true`
- `terminationReason: "exit"`
- `usage` array (possibly with 1 entry)

If `invariantOk` is false, there is an edge case in the accumulator — fix before proceeding.

- [ ] **Step 3: Commit any fixes discovered**

If no fixes needed, skip commit. If fixes made:
```bash
git add plugins/gemini/scripts/lib/timing.mjs plugins/gemini/scripts/lib/gemini.mjs
git commit -m "fix(timing): handle <specific edge case> found in smoke test"
```

---

## Phase 3: Storage Layer — global ndjson

### Task 3.1: Dedicated lock + basic append

**Files:**
- Modify: `plugins/gemini/scripts/lib/state.mjs`
- Create: `tests/timing-storage.test.mjs`

- [ ] **Step 1: Write failing test**

```javascript
// tests/timing-storage.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendTimingHistory,
  readTimingHistory,
  resolveTimingHistoryFile,
} from "../plugins/gemini/scripts/lib/state.mjs";

// Redirect plugin data to a temp dir for this test file
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-timing-test-"));
process.env.CLAUDE_PLUGIN_DATA = tmpRoot;

test("appendTimingHistory writes one line and readTimingHistory returns it", () => {
  const record = { jobId: "gt-abc", kind: "task", timing: { totalMs: 100 } };
  const ok = appendTimingHistory(record);
  assert.equal(ok, true);

  const rows = readTimingHistory();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobId, "gt-abc");
  assert.equal(rows[0].timing.totalMs, 100);
});

test("two appends produce two lines", () => {
  appendTimingHistory({ jobId: "gt-a" });
  appendTimingHistory({ jobId: "gt-b" });
  const rows = readTimingHistory();
  // previous test already wrote 1 record; expect >=3
  assert.ok(rows.length >= 3);
});
```

- [ ] **Step 2: Run — expect fail (functions not exported)**

Run: `node --test tests/timing-storage.test.mjs`

- [ ] **Step 3: Implement in state.mjs**

Add to `state.mjs`:
```javascript
// ── Timing history (global) ──────────────────────────────

const TIMING_FILE_NAME = "timings.ndjson";
const TIMING_LOCK_NAME = "timings.ndjson.lock";
const TIMING_LOCK_ACQUIRE_MS = 10_000;

export function resolveTimingHistoryFile() {
  return path.join(stateRootDir(), "..", TIMING_FILE_NAME);
}

function resolveTimingLockFile() {
  return path.join(stateRootDir(), "..", TIMING_LOCK_NAME);
}

function acquireTimingLock() {
  const lockFile = resolveTimingLockFile();
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + TIMING_LOCK_ACQUIRE_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.closeSync(fd);
      return lockFile;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Sleep spin
      const until = Date.now() + 25;
      while (Date.now() < until) { /* spin */ }
      // Clean stale lock (>30s old)
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > 30_000) removeFileIfExists(lockFile);
      } catch { /* gone */ }
    }
  }
  return null;
}

function releaseTimingLock() {
  removeFileIfExists(resolveTimingLockFile());
}

export function appendTimingHistory(record) {
  const file = resolveTimingHistoryFile();
  const lock = acquireTimingLock();
  if (!lock) {
    try { process.stderr.write(`[timing] lock acquire timeout; dropping record ${record?.jobId || "?"}\n`); } catch { /* ignore */ }
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify(record) + "\n";
    fs.appendFileSync(file, line);
    return true;
  } catch (e) {
    try { process.stderr.write(`[timing] append failed: ${e.message}\n`); } catch { /* ignore */ }
    return false;
  } finally {
    releaseTimingLock();
  }
}

export function readTimingHistory() {
  const file = resolveTimingHistoryFile();
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip corrupted line
    }
  }
  return out;
}
```

- [ ] **Step 4: Run — expect pass**

Run: `node --test tests/timing-storage.test.mjs`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/state.mjs tests/timing-storage.test.mjs
git commit -m "feat(state): appendTimingHistory + readTimingHistory with dedicated lock"
```

---

### Task 3.2: Partial-line repair before append

**Files:**
- Modify: `plugins/gemini/scripts/lib/state.mjs`
- Modify: `tests/timing-storage.test.mjs`

- [ ] **Step 1: Add failing test**

```javascript
test("append after a partial-line file prepends newline to recover", () => {
  const file = resolveTimingHistoryFile();
  // Force-write a partial line (no trailing \n)
  fs.writeFileSync(file, '{"jobId":"gt-part');
  appendTimingHistory({ jobId: "gt-after" });

  const rows = readTimingHistory();
  // The partial line is corrupt and skipped; new line is recoverable
  assert.ok(rows.some((r) => r.jobId === "gt-after"));
});
```

- [ ] **Step 2: Run — expect fail** (raw append concatenates into the partial line, corrupting both)

- [ ] **Step 3: Implement**

In `appendTimingHistory`, inside the lock's try block, before `fs.appendFileSync`:
```javascript
    // Repair: if file ends without \n (prior crash), prepend one
    let needsLeadingNewline = false;
    try {
      const st = fs.statSync(file);
      if (st.size > 0) {
        const buf = Buffer.alloc(1);
        const fd = fs.openSync(file, "r");
        try {
          fs.readSync(fd, buf, 0, 1, st.size - 1);
        } finally {
          fs.closeSync(fd);
        }
        if (buf[0] !== 0x0A /* \n */) needsLeadingNewline = true;
      }
    } catch { /* new file */ }

    const line = (needsLeadingNewline ? "\n" : "") + JSON.stringify(record) + "\n";
    fs.appendFileSync(file, line);
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/state.mjs tests/timing-storage.test.mjs
git commit -m "feat(state): repair partial last line before appending to timings.ndjson"
```

---

### Task 3.3: Trim on 10MB threshold

**Files:**
- Modify: `plugins/gemini/scripts/lib/state.mjs`
- Modify: `tests/timing-storage.test.mjs`

- [ ] **Step 1: Add failing test**

```javascript
test("file exceeding 10MB is trimmed to newest 50%", () => {
  const file = resolveTimingHistoryFile();
  fs.writeFileSync(file, "");  // reset

  // Write ~11MB of 300-byte records (~36k records)
  const chunk = JSON.stringify({ jobId: "g-x".padEnd(280, "x") }) + "\n";
  const fd = fs.openSync(file, "a");
  try {
    const target = 11 * 1024 * 1024;
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    const count = Math.ceil(target / chunkBytes);
    for (let i = 0; i < count; i++) fs.writeSync(fd, chunk);
  } finally {
    fs.closeSync(fd);
  }

  const beforeSize = fs.statSync(file).size;
  assert.ok(beforeSize > 10 * 1024 * 1024);

  // This append triggers trim
  appendTimingHistory({ jobId: "gt-trigger-trim" });

  const afterSize = fs.statSync(file).size;
  assert.ok(afterSize < beforeSize, `expected trim, got ${afterSize} vs ${beforeSize}`);
  assert.ok(afterSize < 10 * 1024 * 1024 * 0.7, "trimmed file should be under 70% of threshold");

  const rows = readTimingHistory();
  assert.ok(rows.some((r) => r.jobId === "gt-trigger-trim"), "new record survives trim");
});
```

- [ ] **Step 2: Run — expect fail** (current implementation just grows unbounded)

- [ ] **Step 3: Implement**

Add constant to `state.mjs`:
```javascript
const TIMING_MAX_BYTES = 10 * 1024 * 1024;
```

In `appendTimingHistory`, AFTER the successful `fs.appendFileSync`, still inside the lock's try block, add:
```javascript
    try {
      const st = fs.statSync(file);
      if (st.size > TIMING_MAX_BYTES) {
        const raw = fs.readFileSync(file, "utf8");
        const lines = raw.split("\n").filter(Boolean);
        // Keep only valid JSON lines
        const valid = [];
        for (const l of lines) {
          try { JSON.parse(l); valid.push(l); } catch { /* drop */ }
        }
        const keep = valid.slice(Math.floor(valid.length / 2));
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, keep.join("\n") + "\n");
        fs.renameSync(tmp, file);
      }
    } catch (e) {
      try { process.stderr.write(`[timing] trim failed: ${e.message}\n`); } catch { /* ignore */ }
    }
```

- [ ] **Step 4: Run — expect pass**

Run: `node --test tests/timing-storage.test.mjs` (may take a few seconds due to 11MB write).

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/state.mjs tests/timing-storage.test.mjs
git commit -m "feat(state): trim timings.ndjson to newest 50% when it exceeds 10MB"
```

---

### Task 3.4: Concurrent append safety

**Files:**
- Modify: `tests/timing-storage.test.mjs`

- [ ] **Step 1: Write failing test**

```javascript
test("two concurrent appendTimingHistory calls both land", async () => {
  // Reset file
  try { fs.unlinkSync(resolveTimingHistoryFile()); } catch { /* gone */ }

  const child = await import("node:child_process");
  const script = `
    import { appendTimingHistory } from "${path.resolve("plugins/gemini/scripts/lib/state.mjs")}";
    process.env.CLAUDE_PLUGIN_DATA = "${tmpRoot}";
    for (let i = 0; i < 20; i++) appendTimingHistory({ jobId: "gt-p" + process.pid + "-" + i });
  `;
  await Promise.all([
    new Promise((r) => {
      const p = child.spawn(process.execPath, ["--input-type=module", "-e", script], { env: process.env });
      p.on("close", r);
    }),
    new Promise((r) => {
      const p = child.spawn(process.execPath, ["--input-type=module", "-e", script], { env: process.env });
      p.on("close", r);
    }),
  ]);

  const rows = readTimingHistory();
  assert.equal(rows.length, 40, `expected 40 rows, got ${rows.length}`);
});
```

- [ ] **Step 2: Run — expect pass** (dedicated lock already prevents interleaving; if it fails, bug in lock logic)

- [ ] **Step 3: Commit**

```bash
git add tests/timing-storage.test.mjs
git commit -m "test(state): verify concurrent appends from two processes all land"
```

---

## Phase 4: Worker Integration

### Task 4.1: Worker persists timing to per-job envelope

**Files:**
- Modify: `plugins/gemini/scripts/lib/job-control.mjs:178-239`

- [ ] **Step 1: Read context**

Read `runStreamingWorker` in `job-control.mjs` lines 178-239.

- [ ] **Step 2: Extend `writeJobFile` payload to include timing**

Modify `runStreamingWorker` in `job-control.mjs`. After computing `status`, `phase`, `geminiSessionId`:
```javascript
  const timing = result.timing || null;
```

Change the `writeJobFile` call:
```javascript
  writeJobFile(workspaceRoot, jobId, {
    id: jobId,
    status,
    result,
    timing,
    completedAt: now,
  });
```

- [ ] **Step 3: Import appendTimingHistory and call it**

At top of `job-control.mjs` imports, add `appendTimingHistory`:
```javascript
import {
  ensureStateDir,
  generateJobId,
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  updateState,
  upsertJob,
  writeJobFile,
  appendTimingHistory,   // NEW
} from "./state.mjs";
```

After the `writeJobFile` call, append to history:
```javascript
  if (timing) {
    appendTimingHistory({
      ts: now,
      jobId,
      kind: (listJobs(workspaceRoot).find((j) => j.id === jobId))?.kind || "task",
      workspace: workspaceRoot,
      sessionId: process.env[SESSION_ID_ENV] || null,
      timing,
    });
  }
```

- [ ] **Step 4: Smoke test — run a real task**

Run:
```bash
node plugins/gemini/scripts/gemini-companion.mjs ask --background "What is 2+2?" --json
# Wait a few seconds, then:
node plugins/gemini/scripts/gemini-companion.mjs status --json | tail -c 2000
```

Verify the completed job in state has `timing` in its envelope. Check the global ndjson file exists.

Run:
```bash
cat "${CLAUDE_PLUGIN_DATA:-/tmp/gemini-companion}/timings.ndjson" 2>/dev/null || \
  find "${CLAUDE_PLUGIN_DATA:-/tmp/gemini-companion}/.." -name "timings.ndjson" 2>/dev/null
```

Verify the file exists and contains ≥1 record.

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/job-control.mjs
git commit -m "feat(job-control): persist timing to job envelope and append to history"
```

---

### Task 4.2: Surface timing in `/gemini:result --json`

**Files:**
- Modify: `plugins/gemini/scripts/gemini-companion.mjs` (result handler)

- [ ] **Step 1: Locate the result handler**

Run: `grep -n 'result' plugins/gemini/scripts/gemini-companion.mjs | head -20`
Find where `result` subcommand returns the JSON envelope.

- [ ] **Step 2: Include `timing` in output**

Locate the block that returns `{ job, result }`. Change to `{ job, result, timing }`, reading `timing` from the same job envelope file (`readJobFile`). If `timing` is absent (legacy job), pass through as `null`.

Exact edit: after retrieving the envelope via `readJobFile`, ensure the returned JSON includes a top-level `timing` key equal to `envelope.timing ?? null`.

- [ ] **Step 3: Verify**

Run:
```bash
node plugins/gemini/scripts/gemini-companion.mjs result --json | tail -c 2000
```

The JSON should have `timing` at top level (null for legacy jobs, object for new).

- [ ] **Step 4: Commit**

```bash
git add plugins/gemini/scripts/gemini-companion.mjs
git commit -m "feat(result): include timing object in /gemini:result --json output"
```

---

## Phase 5: Render helpers

### Task 5.1: renderBar() — proportional ASCII bars

**Files:**
- Modify: `plugins/gemini/scripts/lib/timing.mjs`
- Create: `tests/timing-render.test.mjs`

- [ ] **Step 1: Write failing test**

```javascript
// tests/timing-render.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { renderBar } from "../plugins/gemini/scripts/lib/timing.mjs";

test("renderBar produces a bar proportional to value/max, width 20", () => {
  assert.equal(renderBar(50, 100, 20), "██████████          ");   // 50% = 10 chars
  assert.equal(renderBar(0, 100, 20).trim(), "");                    // empty
  assert.equal(renderBar(100, 100, 20), "████████████████████");    // full
});

test("renderBar uses sub-character fractional precision", () => {
  // 5% of 20 columns = 1 char; 5/100 * 20 = 1.0 → full char
  // 2.5% → 0.5 char → half char
  const bar = renderBar(2.5, 100, 20);
  // First character is a partial block
  assert.ok(bar.length === 20);
  assert.ok(bar[0] !== " ");
});
```

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement**

Add to `timing.mjs`:
```javascript
const BAR_FRAC = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export function renderBar(value, max, width) {
  if (!max || max <= 0 || value <= 0) return " ".repeat(width);
  const filled = Math.max(0, Math.min(width, (value / max) * width));
  const whole = Math.floor(filled);
  const frac = filled - whole;
  const fracChar = BAR_FRAC[Math.round(frac * 8)] || "";
  const usedWidth = whole + (fracChar ? 1 : 0);
  return "█".repeat(whole) + fracChar + " ".repeat(Math.max(0, width - usedWidth));
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/timing.mjs tests/timing-render.test.mjs
git commit -m "feat(timing): renderBar() with fractional-character precision"
```

---

### Task 5.2: renderStatusSummaryLine()

**Files:**
- Modify: `plugins/gemini/scripts/lib/timing.mjs`
- Modify: `tests/timing-render.test.mjs`

- [ ] **Step 1: Add failing test**

```javascript
test("renderStatusSummaryLine formats segments in one line", () => {
  const { renderStatusSummaryLine } = await import("../plugins/gemini/scripts/lib/timing.mjs");
  const line = renderStatusSummaryLine({
    firstEventMs: 1800,
    ttftMs: 18400,
    streamMs: 220000,
    toolMs: 180000,
    retryMs: 32000,
    tailMs: 200,
    totalMs: 452400,
    tokensPerSec: 16.3,
  });
  assert.ok(line.includes("cold 1.8s"));
  assert.ok(line.includes("ttft 18.4s"));
  assert.ok(line.includes("gen 3m 40s"));
  assert.ok(line.includes("tool 3m 0s"));
  assert.ok(line.includes("retry 32.0s"));
  assert.ok(line.includes("16.3 tok/s"));
});

test("renderStatusSummaryLine omits zero segments", () => {
  const { renderStatusSummaryLine } = await import("../plugins/gemini/scripts/lib/timing.mjs");
  const line = renderStatusSummaryLine({
    firstEventMs: 1800,
    ttftMs: 18400,
    streamMs: 100000,
    toolMs: 0,
    retryMs: 0,
    tailMs: 0,
    totalMs: 120200,
    tokensPerSec: 20.0,
  });
  assert.ok(!line.includes("tool"));
  assert.ok(!line.includes("retry"));
});
```

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement**

Add to `timing.mjs`:
```javascript
export function formatMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

export function renderStatusSummaryLine(timing) {
  if (!timing) return "—";
  const parts = [];
  if (timing.firstEventMs != null) parts.push(`cold ${formatMs(timing.firstEventMs)}`);
  if (timing.ttftMs != null)       parts.push(`ttft ${formatMs(timing.ttftMs)}`);
  if (timing.streamMs != null)     parts.push(`gen ${formatMs(timing.streamMs)}`);
  if (timing.toolMs > 0)           parts.push(`tool ${formatMs(timing.toolMs)}`);
  if (timing.retryMs > 0)          parts.push(`retry ${formatMs(timing.retryMs)}`);
  if (timing.tokensPerSec != null) parts.push(`${timing.tokensPerSec} tok/s`);
  return parts.join(" · ");
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/timing.mjs tests/timing-render.test.mjs
git commit -m "feat(timing): renderStatusSummaryLine + formatMs"
```

---

### Task 5.3: renderSingleJobDetail()

**Files:**
- Modify: `plugins/gemini/scripts/lib/timing.mjs`
- Modify: `tests/timing-render.test.mjs`

- [ ] **Step 1: Add failing test**

```javascript
test("renderSingleJobDetail shows bars, segments, and fallback warning", async () => {
  const { renderSingleJobDetail } = await import("../plugins/gemini/scripts/lib/timing.mjs");
  const output = renderSingleJobDetail({
    job: { id: "gt-abc", kind: "task", status: "done" },
    timing: {
      firstEventMs: 1800,
      ttftMs: 18400,
      streamMs: 220000,
      toolMs: 180000,
      retryMs: 32000,
      tailMs: 200,
      totalMs: 452400,
      tokensPerSec: 16.3,
      requestedModel: "gemini-3-pro-preview",
      usage: [
        { model: "gemini-3.1-pro-preview", input: 12400, output: 3200, thoughts: 900 },
        { model: "gemini-3-flash-preview", input: 48000, output: 7040, thoughts: 0 },
      ],
      promptBytes: 12034,
      responseBytes: 28516,
      coldStartPhases: [{ phase: "runtime", ms: 420 }, { phase: "config", ms: 180 }],
    },
  });
  assert.ok(output.includes("gt-abc"));
  assert.ok(output.includes("cold"));
  assert.ok(output.includes("ttft"));
  assert.ok(output.includes("gen"));
  assert.ok(output.includes("silent fallback"));   // warning when usage.length > 1
  assert.ok(output.includes("Cold-start breakdown"));
});
```

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement**

Add to `timing.mjs`:
```javascript
function formatBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function renderSingleJobDetail({ job, timing }) {
  if (!timing) {
    return `Job ${job?.id || "?"} has no timing data.`;
  }
  const lines = [];
  lines.push(`Job ${job?.id || "?"} · ${job?.kind || "?"} · ${job?.status || "?"}`);
  lines.push(`  Prompt      ${formatBytes(timing.promptBytes)}`);
  lines.push(`  Response    ${formatBytes(timing.responseBytes)}`);
  lines.push(`  Requested   ${timing.requestedModel || "—"}`);
  if (timing.usage && timing.usage.length > 0) {
    for (const u of timing.usage) {
      const toks = (u.output + u.thoughts) / 1000;
      lines.push(`  Actual      ${u.model}  (${toks.toFixed(0)}K tok)`);
    }
    if (timing.usage.length > 1) {
      lines.push(`              ⚠ silent fallback detected`);
    }
  }
  lines.push("");

  const segs = [
    ["cold",  timing.firstEventMs],
    ["ttft",  timing.ttftMs],
    ["gen",   timing.streamMs],
    ["tool",  timing.toolMs],
    ["retry", timing.retryMs],
    ["tail",  timing.tailMs],
  ].filter(([, v]) => v != null && v >= 0);
  const total = timing.totalMs || 0;

  for (const [name, ms] of segs) {
    const bar = renderBar(ms, total, 20);
    const pct = total > 0 ? ((ms / total) * 100).toFixed(1) : "0.0";
    lines.push(`  ${name.padEnd(6)} ${bar}  ${formatMs(ms).padStart(8)}  (${pct.padStart(4)}%)`);
  }
  lines.push("  " + "─".repeat(36));
  lines.push(`  total  ${" ".repeat(20)}  ${formatMs(total).padStart(8)}   100%`);
  lines.push("");
  if (timing.tokensPerSec != null) {
    lines.push(`  Throughput: ${timing.tokensPerSec} tok/s  (includes thoughts)`);
  }
  if (timing.coldStartPhases && timing.coldStartPhases.length > 0) {
    const parts = timing.coldStartPhases.map((p) => `${p.phase} ${formatMs(p.ms)}`).join(" · ");
    lines.push(`  Cold-start breakdown: ${parts}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/timing.mjs tests/timing-render.test.mjs
git commit -m "feat(timing): renderSingleJobDetail with bars and fallback warning"
```

---

## Phase 6: Aggregate helpers

### Task 6.1: percentile() with nearest-rank

**Files:**
- Modify: `plugins/gemini/scripts/lib/timing.mjs`
- Create: `tests/timing-aggregate.test.mjs`

- [ ] **Step 1: Write failing test**

```javascript
// tests/timing-aggregate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { percentile } from "../plugins/gemini/scripts/lib/timing.mjs";

test("percentile — nearest-rank method", () => {
  const data = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(data, 0.5), 50);
  assert.equal(percentile(data, 0.95), 100);
  assert.equal(percentile(data, 0.9), 90);
});

test("percentile ignores null values", () => {
  const data = [10, null, 20, null, 30];
  assert.equal(percentile(data, 0.5), 20);
});

test("percentile of empty returns null", () => {
  assert.equal(percentile([], 0.5), null);
});
```

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement**

Add to `timing.mjs`:
```javascript
export function percentile(values, p) {
  const filtered = values.filter((v) => v != null && typeof v === "number");
  if (filtered.length === 0) return null;
  const sorted = filtered.slice().sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[idx];
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/timing.mjs tests/timing-aggregate.test.mjs
git commit -m "feat(timing): percentile() via nearest-rank, skips nulls"
```

---

### Task 6.2: computeAggregateStats() with small-n suppression

**Files:**
- Modify: `plugins/gemini/scripts/lib/timing.mjs`
- Modify: `tests/timing-aggregate.test.mjs`

- [ ] **Step 1: Add failing test**

```javascript
test("computeAggregateStats: n<20 suppresses p95, n<100 suppresses p99", async () => {
  const { computeAggregateStats } = await import("../plugins/gemini/scripts/lib/timing.mjs");

  const records = Array.from({ length: 15 }, (_, i) => ({
    timing: { totalMs: (i + 1) * 1000, firstEventMs: 100, ttftMs: 200, streamMs: 500, toolMs: 0, retryMs: 0 },
  }));
  const stats = computeAggregateStats(records);
  assert.ok(stats.percentiles.p50 !== null);
  assert.equal(stats.percentiles.p95, null);   // n<20
  assert.equal(stats.percentiles.p99, null);
  assert.equal(stats.n, 15);
});

test("computeAggregateStats: fallback rate from usage.length>1", async () => {
  const { computeAggregateStats } = await import("../plugins/gemini/scripts/lib/timing.mjs");

  const records = [
    { jobId: "a", timing: { totalMs: 100, usage: [{}, {}] } },  // fallback
    { jobId: "b", timing: { totalMs: 200, usage: [{}] } },
    { jobId: "c", timing: { totalMs: 300, usage: [{}, {}] } },  // fallback
    { jobId: "d", timing: { totalMs: 400, usage: [] } },
  ];
  const stats = computeAggregateStats(records);
  assert.equal(stats.fallbackRate, 0.5);    // 2/4
});

test("computeAggregateStats identifies slowest job", async () => {
  const { computeAggregateStats } = await import("../plugins/gemini/scripts/lib/timing.mjs");
  const records = [
    { jobId: "a", timing: { totalMs: 100 } },
    { jobId: "b", timing: { totalMs: 500 } },
    { jobId: "c", timing: { totalMs: 300 } },
  ];
  const stats = computeAggregateStats(records);
  assert.equal(stats.slowest.jobId, "b");
  assert.equal(stats.slowest.totalMs, 500);
});
```

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement**

Add to `timing.mjs`:
```javascript
const PERCENTILE_CUTOFFS = {
  p50: 1,
  p95: 20,
  p99: 100,
};

export function computeAggregateStats(records) {
  const n = records.length;
  const pick = (key) => records.map((r) => r.timing?.[key]);
  const allPercentiles = ["p50", "p95", "p99"];
  const metrics = ["firstEventMs", "ttftMs", "streamMs", "toolMs", "retryMs", "totalMs"];

  const percentiles = {};
  for (const p of allPercentiles) {
    if (n < PERCENTILE_CUTOFFS[p]) {
      percentiles[p] = null;
      continue;
    }
    const row = {};
    for (const m of metrics) {
      row[m] = percentile(pick(m), Number(p.slice(1)) / 100);
    }
    percentiles[p] = row;
  }

  // Slowest
  let slowest = null;
  for (const r of records) {
    const total = r.timing?.totalMs || 0;
    if (!slowest || total > slowest.totalMs) {
      slowest = {
        jobId: r.jobId || r.job?.id,
        totalMs: total,
        fallback: Array.isArray(r.timing?.usage) && r.timing.usage.length > 1,
      };
    }
  }

  // Fallback rate
  let fallbackCount = 0;
  for (const r of records) {
    if (Array.isArray(r.timing?.usage) && r.timing.usage.length > 1) fallbackCount++;
  }
  const fallbackRate = n > 0 ? Math.round((fallbackCount / n) * 1000) / 1000 : 0;

  return { n, percentiles, slowest, fallbackRate };
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/timing.mjs tests/timing-aggregate.test.mjs
git commit -m "feat(timing): computeAggregateStats with small-n suppression"
```

---

### Task 6.3: renderAggregateTable()

**Files:**
- Modify: `plugins/gemini/scripts/lib/timing.mjs`
- Modify: `tests/timing-aggregate.test.mjs`

- [ ] **Step 1: Add failing test**

```javascript
test("renderAggregateTable includes header, percentile rows, fallback rate", async () => {
  const { renderAggregateTable } = await import("../plugins/gemini/scripts/lib/timing.mjs");
  const stats = {
    n: 34,
    percentiles: {
      p50: { firstEventMs: 1900, ttftMs: 19200, streamMs: 130000, toolMs: 0, retryMs: 0, totalMs: 155000 },
      p95: { firstEventMs: 3100, ttftMs: 42000, streamMs: 495000, toolMs: 240000, retryMs: 80000, totalMs: 543000 },
      p99: null,
    },
    slowest: { jobId: "gt-xyz", totalMs: 588000, fallback: true },
    fallbackRate: 0.235,
  };
  const output = renderAggregateTable(stats, { kind: "task" });
  assert.ok(output.includes("task"));
  assert.ok(output.includes("n=34"));
  assert.ok(output.includes("p50"));
  assert.ok(output.includes("p95"));
  assert.ok(output.includes("p99"));
  assert.ok(output.includes("—"));               // p99 suppressed
  assert.ok(output.includes("gt-xyz"));
  assert.ok(output.includes("23.5%"));
});
```

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement**

Add to `timing.mjs`:
```javascript
export function renderAggregateTable(stats, { kind = "all" } = {}) {
  const lines = [];
  lines.push(`${kind} (n=${stats.n})`);
  lines.push(`                   cold        ttft        gen         tool        retry       total`);
  for (const p of ["p50", "p95", "p99"]) {
    const row = stats.percentiles[p];
    if (!row) {
      lines.push(`  ${p.padEnd(14)}  —           —           —           —           —           —`);
      continue;
    }
    const cells = ["firstEventMs", "ttftMs", "streamMs", "toolMs", "retryMs", "totalMs"]
      .map((m) => formatMs(row[m]).padEnd(12))
      .join("");
    lines.push(`  ${p.padEnd(14)}  ${cells}`);
  }
  if (stats.slowest) {
    const fb = stats.slowest.fallback ? " · fallback" : "";
    lines.push(`  slowest         ${stats.slowest.jobId} · ${formatMs(stats.slowest.totalMs)}${fb}`);
  }
  lines.push(`  fallback rate   ${(stats.fallbackRate * 100).toFixed(1)}%`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/timing.mjs tests/timing-aggregate.test.mjs
git commit -m "feat(timing): renderAggregateTable with p50/p95/p99 row suppression"
```

---

### Task 6.4: filterHistory() + renderHistoryTable()

**Files:**
- Modify: `plugins/gemini/scripts/lib/timing.mjs`
- Modify: `tests/timing-aggregate.test.mjs`

- [ ] **Step 1: Add failing test**

```javascript
test("filterHistory applies kind + last + since", async () => {
  const { filterHistory } = await import("../plugins/gemini/scripts/lib/timing.mjs");
  const records = [
    { ts: "2026-04-01T00:00:00Z", kind: "task", jobId: "a" },
    { ts: "2026-04-15T00:00:00Z", kind: "ask",  jobId: "b" },
    { ts: "2026-04-20T00:00:00Z", kind: "task", jobId: "c" },
    { ts: "2026-04-20T01:00:00Z", kind: "task", jobId: "d" },
  ];
  // kind filter
  assert.equal(filterHistory(records, { kind: "task" }).length, 3);
  // since filter
  assert.equal(filterHistory(records, { since: "2026-04-16T00:00:00Z" }).length, 2);
  // last N (newest first)
  const last2 = filterHistory(records, { last: 2 });
  assert.equal(last2.length, 2);
  assert.equal(last2[0].jobId, "d");    // newest first
});

test("renderHistoryTable lists rows with segment columns", async () => {
  const { renderHistoryTable } = await import("../plugins/gemini/scripts/lib/timing.mjs");
  const rows = [{
    jobId: "gt-abc", kind: "task", ts: "2026-04-20T00:00:00Z",
    timing: {
      firstEventMs: 1800, ttftMs: 18400, streamMs: 100000, toolMs: 0, retryMs: 0,
      totalMs: 120200, tokensPerSec: 16.3, usage: [{}],
    },
  }];
  const output = renderHistoryTable(rows);
  assert.ok(output.includes("gt-abc"));
  assert.ok(output.includes("task"));
  assert.ok(output.includes("2026-04-20"));
});
```

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement**

Add to `timing.mjs`:
```javascript
export function filterHistory(records, { kind, last, since } = {}) {
  let out = records.slice();
  if (kind) out = out.filter((r) => r.kind === kind);
  if (since) out = out.filter((r) => r.ts && r.ts >= since);
  // Newest first
  out.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  if (last) out = out.slice(0, last);
  return out;
}

export function renderHistoryTable(rows) {
  const lines = [];
  lines.push("id              kind    total      cold    ttft    gen     tool    retry   tok/s   fb   completedAt");
  for (const r of rows) {
    const t = r.timing || {};
    const fb = (t.usage?.length || 0) > 1 ? "!" : " ";
    lines.push([
      (r.jobId || "?").padEnd(16),
      (r.kind || "?").padEnd(8),
      formatMs(t.totalMs).padEnd(10),
      formatMs(t.firstEventMs).padEnd(8),
      formatMs(t.ttftMs).padEnd(8),
      formatMs(t.streamMs).padEnd(8),
      formatMs(t.toolMs).padEnd(8),
      formatMs(t.retryMs).padEnd(8),
      (t.tokensPerSec != null ? `${t.tokensPerSec}` : "—").padEnd(8),
      fb,
      "  ",
      (r.ts || "—").slice(0, 19),
    ].join(""));
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/timing.mjs tests/timing-aggregate.test.mjs
git commit -m "feat(timing): filterHistory + renderHistoryTable"
```

---

## Phase 7: Command routing

### Task 7.1: `/gemini:timing` subcommand dispatcher

**Files:**
- Modify: `plugins/gemini/scripts/gemini-companion.mjs`

- [ ] **Step 1: Locate the subcommand router**

Run: `grep -n 'switch.*command\|case "' plugins/gemini/scripts/gemini-companion.mjs | head -20`

Find where other subcommands like `status`, `result`, `cancel` are registered.

- [ ] **Step 2: Implement the `timing` route**

In `gemini-companion.mjs`, add a new handler for `command === "timing"`. The handler must:

1. Parse args: `[job-id?]`, `--history`, `--stats`, `--since`, `--kind`, `--last`, `--json`
2. Enforce mutual exclusion: `<job-id>` vs `--history` vs `--stats` — exactly one. Combining returns a usage error.
3. Dispatch by mode:

```javascript
  if (command === "timing") {
    const options = parseArgs(rest, {
      booleans: ["history", "stats", "json"],
      valueOptions: ["since", "kind", "last"],
    });
    const positional = rest.filter((a) => !a.startsWith("--"));
    const jobId = positional[0] || null;

    const modes = [!!jobId, !!options.history, !!options.stats].filter(Boolean).length;
    if (modes > 1) {
      return emit({ ok: false, error: "--history / --stats / <job-id> are mutually exclusive" }, options.json);
    }

    // Load history
    const allRecords = readTimingHistory();

    if (jobId) {
      // Single-job mode — try envelope first, then history
      const envelope = readJobFile(resolveJobFile(workspaceRoot, jobId));
      const timing = envelope?.timing || allRecords.find((r) => r.jobId === jobId)?.timing || null;
      const job = envelope?.id ? envelope : (listJobs(workspaceRoot).find((j) => j.id === jobId) || { id: jobId });
      if (options.json) {
        return emit({
          job: { id: job.id, kind: job.kind, status: job.status },
          timing,
          fallback: Array.isArray(timing?.usage) && timing.usage.length > 1,
        }, true);
      }
      return emit(renderSingleJobDetail({ job, timing }));
    }

    if (options.stats) {
      const rows = filterHistory(allRecords, {
        kind: options.kind,
        since: options.since,
      });
      const stats = computeAggregateStats(rows);
      if (options.json) {
        return emit({ kind: options.kind || "all", ...stats, since: options.since || null }, true);
      }
      return emit(renderAggregateTable(stats, { kind: options.kind || "all" }));
    }

    // --history
    const rows = filterHistory(allRecords, {
      kind: options.kind,
      since: options.since,
      last: options.last ? parseInt(options.last, 10) : 20,
    });
    if (options.json) {
      return emit({ rows, count: rows.length }, true);
    }
    return emit(renderHistoryTable(rows));
  }
```

At top of file, add imports:
```javascript
import {
  renderSingleJobDetail,
  renderAggregateTable,
  renderHistoryTable,
  computeAggregateStats,
  filterHistory,
} from "./lib/timing.mjs";
import { readTimingHistory } from "./lib/state.mjs";
```

(`parseArgs` is already imported per `plugins/gemini/scripts/lib/args.mjs`.)

- [ ] **Step 3: Smoke test**

Run:
```bash
node plugins/gemini/scripts/gemini-companion.mjs timing --history --json
node plugins/gemini/scripts/gemini-companion.mjs timing --stats --json
```

Both should emit valid JSON (empty arrays/objects if no history).

- [ ] **Step 4: Mutual-exclusion test**

Run:
```bash
node plugins/gemini/scripts/gemini-companion.mjs timing gt-xyz --stats --json
```
Expected: JSON error `--history / --stats / <job-id> are mutually exclusive`.

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/gemini-companion.mjs
git commit -m "feat(cmd): /gemini:timing with single-job, --history, --stats modes"
```

---

### Task 7.2: Create `commands/timing.md` slash command

**Files:**
- Create: `plugins/gemini/commands/timing.md`

- [ ] **Step 1: Write file**

```markdown
---
description: Show timing breakdown for Gemini jobs (cold / ttft / gen / tool / retry)
argument-hint: '[job-id] [--history] [--stats] [--kind task|ask] [--last N] [--since ISO] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" timing "$ARGUMENTS" --json
```

Render the timing output to the user as a human-readable view:
- If a single job was requested, show the detailed breakdown with bars.
- If `--history` was requested, show the tabular history.
- If `--stats` was requested, show the aggregate percentile table.
- If `fallback: true` is present, call out the silent model fallback prominently.
- If no timing data exists for the requested scope, say "No timing data yet — run a task first."
```

- [ ] **Step 2: Verify slash command discovery**

The command file exists under `plugins/gemini/commands/timing.md`. The plugin's manifest will auto-discover it on next session start.

- [ ] **Step 3: Commit**

```bash
git add plugins/gemini/commands/timing.md
git commit -m "feat(cmd): add /gemini:timing slash command"
```

---

## Phase 8: Status integration

### Task 8.1: Status view shows timing summary line per job

**Files:**
- Modify: `plugins/gemini/scripts/lib/render.mjs`

- [ ] **Step 1: Read render.mjs to find job row rendering**

Run: `grep -n 'renderJob\|status' plugins/gemini/scripts/lib/render.mjs | head -20`

Identify the function that renders a single job row in the status view.

- [ ] **Step 2: Import renderStatusSummaryLine**

At top of `render.mjs`:
```javascript
import { renderStatusSummaryLine } from "./timing.mjs";
import { readJobFile, resolveJobFile } from "./state.mjs";
```

- [ ] **Step 3: Append summary line to rendered job**

In the function that renders a job row for terminal status, after the existing row text, look up the job envelope and append `renderStatusSummaryLine(timing)` indented 2 spaces.

Because the status handler already has `workspaceRoot` in scope, read the envelope: `const env = readJobFile(resolveJobFile(workspaceRoot, job.id));` then `const timing = env?.timing ?? null;`. If `timing` is non-null, emit one extra line `  ${renderStatusSummaryLine(timing)}` below the main row. Skip entirely if `timing` is null (legacy jobs render as before — no `—` pollution).

- [ ] **Step 4: Smoke test**

Run a task in the background, wait for it to finish, then:
```bash
node plugins/gemini/scripts/gemini-companion.mjs status
```

A finished job should show the extra summary line beneath its row.

- [ ] **Step 5: Commit**

```bash
git add plugins/gemini/scripts/lib/render.mjs
git commit -m "feat(status): show timing summary line under each finished job"
```

---

## Phase 9: End-to-End Verification

### Task 9.1: Full smoke — real task → all three surfaces

**Files:**
- No source changes

- [ ] **Step 1: Run a real task**

```bash
node plugins/gemini/scripts/gemini-companion.mjs task --background "Write a 50-word haiku about timeouts." --json
```

Note the job-id returned.

- [ ] **Step 2: Wait for completion**

```bash
node plugins/gemini/scripts/gemini-companion.mjs status <job-id> --wait --json
```

- [ ] **Step 3: Verify all four surfaces**

```bash
# Surface 1: status (human)
node plugins/gemini/scripts/gemini-companion.mjs status
# Expect: completed job has a "cold X · ttft Y · gen Z ..." summary line

# Surface 2: result JSON
node plugins/gemini/scripts/gemini-companion.mjs result --json | head -c 500
# Expect: top-level "timing": {...} object with invariantOk: true

# Surface 3: /gemini:timing single-job
node plugins/gemini/scripts/gemini-companion.mjs timing <job-id>
# Expect: bar chart with cold / ttft / gen segments

# Surface 4: /gemini:timing --stats
node plugins/gemini/scripts/gemini-companion.mjs timing --stats --kind task
# Expect: p50 row populated; p95/p99 likely suppressed (small n)
```

- [ ] **Step 4: If any surface fails**

Diagnose and fix. Do not proceed until all four surfaces work on fresh data.

- [ ] **Step 5: Commit any diagnostic fixes**

```bash
git add <affected>
git commit -m "fix(timing): <specific e2e bug>"
```

---

### Task 9.2: Ensure full test suite passes

**Files:**
- No source changes

- [ ] **Step 1: Run full suite**

Run: `node --test tests/`
Expected: all tests pass, 0 failures.

- [ ] **Step 2: If any fail**

Fix before proceeding. Do not commit a ship with failing tests.

---

## Phase 10: Version Bump & Docs

### Task 10.1: Bump version to 0.6.0

**Files:**
- Modify: `plugins/gemini/.claude-plugin/plugin.json`

- [ ] **Step 1: Read current plugin.json**

Run: `cat plugins/gemini/.claude-plugin/plugin.json`

- [ ] **Step 2: Update version**

Change the `"version"` field from `"0.5.2"` to `"0.6.0"`.

- [ ] **Step 3: Commit**

```bash
git add plugins/gemini/.claude-plugin/plugin.json
git commit -m "chore: bump version to 0.6.0"
```

---

### Task 10.2: Plugin CHANGELOG entry

**Files:**
- Modify: `plugins/gemini/CHANGELOG.md`

- [ ] **Step 1: Add top entry**

Prepend to `plugins/gemini/CHANGELOG.md`:

```markdown
## 0.6.0 — 2026-04-20

### Added
- **Timing telemetry**: `callGeminiStreaming` now emits a `timing` object per job with 6 segments (cold / ttft / gen / tool / retry / tail), authoritative per-model usage from `per_model_usage`, and optional `coldStartPhases` from `GEMINI_TELEMETRY_ENABLED=1`.
- **`/gemini:timing` command**: single-job detail view with bars, `--history` table, `--stats` aggregate with p50/p95/p99 (suppressed at small n), and `--json` on all modes.
- **Global history**: all streaming jobs appended to `~/.claude/plugins/gemini/timings.ndjson` under a dedicated lock; trimmed to newest 50% at 10 MB.
- **Status view**: finished jobs in `/gemini:status` now show a one-line timing summary (cold / ttft / gen / tool / retry / tok/s).
- **Silent-fallback detection**: when `per_model_usage` shows >1 model, the single-job view flags the silent Pro→Flash downgrade.

### Notes
- Synchronous `callGemini` (review / adversarial-review) is NOT yet instrumented — deferred to 0.6.1.
- Cross-plugin comparison against Codex (`--compare codex`) deferred to 0.6.1.
- Jobs completed before 0.6.0 render their timing row as `—`.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/gemini/CHANGELOG.md
git commit -m "docs(changelog): 0.6.0 timing telemetry entry"
```

---

### Task 10.3: Root CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md` (root)

- [ ] **Step 1: Add entry**

Prepend to root `CHANGELOG.md`, mirroring the plugin CHANGELOG entry but more concise (one-paragraph summary suitable for cross-AI collaboration per the global rule).

```markdown
## 0.6.0 — 2026-04-20

Add timing telemetry for streaming Gemini calls. Each job now emits a 6-segment breakdown (cold-start / ttft / generation / tool / retry / tail), with authoritative per-model usage (catches silent Pro→Flash fallbacks) and optional cold-start phase decomposition from `GEMINI_TELEMETRY_ENABLED=1`. New `/gemini:timing` command with single-job / history / stats modes. Global append-only history at `~/.claude/plugins/gemini/timings.ndjson`. Sync `callGemini` (review) timing deferred to 0.6.1.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): root entry for 0.6.0"
```

---

### Task 10.4: Final verification pass

**Files:**
- No source changes

- [ ] **Step 1: Run tests one more time**

Run: `node --test tests/`
Expected: all pass.

- [ ] **Step 2: Run `git log --oneline -30`**

Inspect commits. Each phase should have a clear trail.

- [ ] **Step 3: Run `git status`**

Expected: clean working tree.

- [ ] **Step 4: Notify user**

Tell the user: "Phase 10 complete. Tests green. Ready for `claude plugin marketplace update gemini-plugin && claude plugin update gemini@gemini-plugin`."

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| 5 timestamp boundaries + segment schema | 1.1 |
| `toolMs` via `tool_use`/`tool_result` | 1.2, 2.1 |
| `retryMs` via non-fatal error events | 1.3, 2.1 |
| `per_model_usage` authoritative model attribution | 1.4 |
| Token fields (`input_token_count` etc.) + `thoughts_token_count` in tok/s | 1.4 |
| `coldStartPhases` via `GEMINI_TELEMETRY_ENABLED=1` | 1.5, 2.1 |
| `terminationReason` discriminator (exit/timeout/signal/error) | 1.6 |
| Invariant sum assertion | 1.7 |
| `callGeminiStreaming` integration | 2.1 |
| `appendTimingHistory` + dedicated lock | 3.1 |
| Partial-line repair before append | 3.2 |
| Trim at 10 MB | 3.3 |
| Concurrent append safety | 3.4 |
| Worker persists timing to job envelope | 4.1 |
| Worker appends to global history | 4.1 |
| `/gemini:result --json` includes timing | 4.2 |
| Bar rendering + status summary line | 5.1, 5.2 |
| Single-job detail view with fallback warning | 5.3 |
| Percentile with nearest-rank + null skip | 6.1 |
| Aggregate stats with small-n suppression | 6.2 |
| `renderAggregateTable` / `renderHistoryTable` | 6.3, 6.4 |
| `/gemini:timing` command + mutex guard | 7.1 |
| `commands/timing.md` | 7.2 |
| Status view timing summary line | 8.1 |
| End-to-end smoke | 9.1, 9.2 |
| Version bump + CHANGELOGs | 10.1–10.3 |

All spec sections have a task. No gaps.

### Placeholder scan

Searched plan for: TBD, TODO, "fill in later", "implement later", "similar to", "add appropriate error handling". None found.

### Type/name consistency

- `TimingAccumulator` class name consistent across Phase 1, Phase 2, and test files.
- `appendTimingHistory` / `readTimingHistory` signatures match across state.mjs definition (Phase 3) and consumers in job-control.mjs (Phase 4.1) and gemini-companion.mjs (Phase 7.1).
- `renderStatusSummaryLine` / `renderSingleJobDetail` / `renderAggregateTable` / `renderHistoryTable` exported names match between timing.mjs tasks and gemini-companion.mjs / render.mjs imports.
- Field names (`firstEventMs`, `ttftMs`, `streamMs`, `toolMs`, `retryMs`, `tailMs`, `totalMs`, `usage`, `tokensPerSec`, `requestedModel`, `coldStartPhases`, `terminationReason`, `exitCode`, `timedOut`, `signal`, `invariantOk`, `promptBytes`, `responseBytes`) are used identically across schema, tests, and render helpers.

No inconsistencies.
