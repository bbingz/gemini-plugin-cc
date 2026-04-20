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

test("renderStatusSummaryLine formats segments in one line", async () => {
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

test("renderStatusSummaryLine omits zero segments", async () => {
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

test("renderTimingBreakdown: empty array returns null (caller skips block)", async () => {
  const { renderTimingBreakdown } = await import("../plugins/gemini/scripts/lib/render.mjs");
  assert.equal(renderTimingBreakdown([]), null);
  assert.equal(renderTimingBreakdown(null), null);
  assert.equal(renderTimingBreakdown(undefined), null);
});

test("renderTimingBreakdown: one entry produces a bullet block", async () => {
  const { renderTimingBreakdown } = await import("../plugins/gemini/scripts/lib/render.mjs");
  const out = renderTimingBreakdown([
    { id: "gt-abc123", summary: "cold 1.8s · ttft 18.4s · gen 2m 10s" },
  ]);
  assert.ok(out.includes("**Timing breakdown:**"));
  assert.ok(out.includes("- `gt-abc123` — cold 1.8s"));
});

test("renderTimingBreakdown: multiple entries all render", async () => {
  const { renderTimingBreakdown } = await import("../plugins/gemini/scripts/lib/render.mjs");
  const out = renderTimingBreakdown([
    { id: "gt-a", summary: "cold 1s · ttft 2s" },
    { id: "gt-b", summary: "cold 3s · ttft 4s" },
    { id: "gt-c", summary: "cold 5s · ttft 6s" },
  ]);
  assert.ok(out.includes("gt-a"));
  assert.ok(out.includes("gt-b"));
  assert.ok(out.includes("gt-c"));
  // Count bullets
  const bullets = (out.match(/^- /gm) || []).length;
  assert.equal(bullets, 3);
});

test("renderTimingBreakdown: block does NOT start with a pipe (markdown-table-safe)", async () => {
  const { renderTimingBreakdown } = await import("../plugins/gemini/scripts/lib/render.mjs");
  const out = renderTimingBreakdown([{ id: "gt-x", summary: "cold 1s" }]);
  // The block starts with a blank line then the heading, not a table-row pipe
  const firstNonEmptyLine = out.split("\n").find(l => l.trim().length > 0);
  assert.ok(!firstNonEmptyLine.startsWith("|"), "breakdown block must not start with pipe");
});

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
