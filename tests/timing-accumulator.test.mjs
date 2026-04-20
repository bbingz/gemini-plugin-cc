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
