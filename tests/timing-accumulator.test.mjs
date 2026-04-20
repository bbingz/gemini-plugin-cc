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

test("onResult is idempotent — first call wins, second is ignored", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onFirstToken(200);
  acc.onLastToken(1200);
  acc.onResult({ stats: { input_token_count: 100, output_token_count: 200, thoughts_token_count: 0 } });
  acc.onResult({ stats: { input_token_count: 9999, output_token_count: 9999, thoughts_token_count: 9999 } });
  acc.onClose(1210, { exitCode: 0 });

  const t = acc.build();
  assert.equal(t.usage[0].input, 100);   // first call wins
  assert.equal(t.usage[0].output, 200);
});

test("invariantOk is null on timeout path (only meaningful on clean exit)", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onClose(60_000, { timedOut: true, exitCode: null });
  assert.equal(acc.build().invariantOk, null);
});

test("invariantOk is null on signal path", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onFirstToken(200);
  acc.onLastToken(300);
  acc.onClose(310, { signal: "SIGINT", exitCode: null });
  assert.equal(acc.build().invariantOk, null);
});

test("invariantOk is null on non-zero exit", () => {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  acc.onFirstEvent(100);
  acc.onClose(200, { exitCode: 1 });
  assert.equal(acc.build().invariantOk, null);
});
