// tests/timing-dispatch.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { TimingAccumulator, dispatchTimingEvent } from "../plugins/gemini/scripts/lib/timing.mjs";

function fresh() {
  const acc = new TimingAccumulator({ spawnedAt: 0 });
  return acc;
}

test("dispatch: init event with model sets requestedModel (first-wins)", () => {
  const acc = fresh();
  dispatchTimingEvent({ type: "init", model: "gemini-3-pro-preview" }, acc);
  assert.equal(acc.build().requestedModel, "gemini-3-pro-preview");
});

test("dispatch: init without model does not clobber", () => {
  const acc = fresh();
  acc.setRequestedModel("seeded-model");
  dispatchTimingEvent({ type: "init" }, acc);  // no model field
  assert.equal(acc.build().requestedModel, "seeded-model");
});

test("dispatch: assistant message with content triggers firstToken/lastToken/responseBytes", () => {
  const acc = fresh();
  dispatchTimingEvent({ type: "message", role: "assistant", content: "hello" }, acc);
  // firstToken + lastToken are both set, so streamMs at close will be > 0 only if we see a later event
  acc.onClose(1000, { exitCode: 0 });
  const t = acc.build();
  assert.equal(t.responseBytes, 5);
  // firstToken was set; ttftMs is null because no firstEvent separate from message dispatch
  // but the content bytes did record
});

test("dispatch: empty-content assistant message does not trigger token times", () => {
  const acc = fresh();
  dispatchTimingEvent({ type: "message", role: "assistant", content: "" }, acc);
  acc.onClose(1000, { exitCode: 0 });
  const t = acc.build();
  assert.equal(t.responseBytes, 0);
});

test("dispatch: tool_use alias triggers onToolUseStart", () => {
  const acc = fresh();
  dispatchTimingEvent({ type: "message", role: "assistant", content: "x" }, acc);  // set firstToken=0
  dispatchTimingEvent({ type: "tool_use" }, acc);   // toolStart at now (roughly 0)
  // simulate small delay
  acc._toolStart = 100;  // force deterministic start
  dispatchTimingEvent({ type: "tool_result" }, acc);
  acc.onClose(500, { exitCode: 0 });
  assert.ok(acc.build().toolMs > 0, "toolMs should be positive");
});

test("dispatch: tool_call is accepted as alias for tool_use", () => {
  const acc = fresh();
  dispatchTimingEvent({ type: "message", role: "assistant", content: "x" }, acc);
  dispatchTimingEvent({ type: "tool_call" }, acc);
  acc._toolStart = 100;
  dispatchTimingEvent({ type: "tool_response" }, acc);
  acc.onClose(500, { exitCode: 0 });
  assert.ok(acc.build().toolMs > 0, "tool_call/tool_response alias path should accumulate toolMs");
});

test("dispatch: error with fatal:false opens retry window", () => {
  const acc = fresh();
  dispatchTimingEvent({ type: "message", role: "assistant", content: "x" }, acc);
  dispatchTimingEvent({ type: "error", fatal: false }, acc);
  assert.ok(acc._retryStart != null, "retry window should be open");
});

test("dispatch: error with missing fatal field does NOT open retry (default terminal)", () => {
  const acc = fresh();
  dispatchTimingEvent({ type: "message", role: "assistant", content: "x" }, acc);
  dispatchTimingEvent({ type: "error" /* no fatal */ }, acc);
  assert.equal(acc._retryStart, undefined, "retry should NOT be opened when fatal is missing");
});

test("dispatch: error with fatal:true does NOT open retry", () => {
  const acc = fresh();
  dispatchTimingEvent({ type: "message", role: "assistant", content: "x" }, acc);
  dispatchTimingEvent({ type: "error", fatal: true }, acc);
  assert.equal(acc._retryStart, undefined);
});

test("dispatch: non-error event after retry closes the window", () => {
  const acc = fresh();
  dispatchTimingEvent({ type: "message", role: "assistant", content: "x" }, acc);
  dispatchTimingEvent({ type: "error", fatal: false }, acc);  // opens retry
  acc._retryStart = 100;  // deterministic
  dispatchTimingEvent({ type: "message", role: "assistant", content: "y" }, acc);  // closes retry
  acc.onClose(500, { exitCode: 0 });
  assert.ok(acc.build().retryMs > 0);
});

test("dispatch: gemini_cli.startup_stats populates coldStartPhases", () => {
  const acc = fresh();
  dispatchTimingEvent({ type: "gemini_cli.startup_stats", phases: [{ phase: "boot", ms: 420 }] }, acc);
  acc.onClose(1000, { exitCode: 0 });
  assert.deepEqual(acc.build().coldStartPhases, [{ phase: "boot", ms: 420 }]);
});

test("dispatch: startup_stats (no prefix) also works", () => {
  const acc = fresh();
  dispatchTimingEvent({ type: "startup_stats", phases: [{ phase: "boot", ms: 200 }] }, acc);
  acc.onClose(1000, { exitCode: 0 });
  assert.deepEqual(acc.build().coldStartPhases, [{ phase: "boot", ms: 200 }]);
});

test("dispatch: result event populates usage from stats.models", () => {
  const acc = fresh();
  dispatchTimingEvent({
    type: "result",
    stats: {
      models: {
        "gemini-3.1-pro-preview": { input_tokens: 100, output_tokens: 50 },
      },
    },
  }, acc);
  acc.onClose(1000, { exitCode: 0 });
  const t = acc.build();
  assert.equal(t.usage.length, 1);
  assert.equal(t.usage[0].model, "gemini-3.1-pro-preview");
  assert.equal(t.usage[0].input, 100);
});

test("dispatch: unknown event type is a no-op (forward-compat)", () => {
  const acc = fresh();
  dispatchTimingEvent({ type: "some_future_event", foo: "bar" }, acc);
  acc.onClose(1000, { exitCode: 0 });
  // firstEvent was registered, nothing else
  const t = acc.build();
  assert.ok(t.firstEventMs != null);
  assert.equal(t.usage.length, 0);
});
