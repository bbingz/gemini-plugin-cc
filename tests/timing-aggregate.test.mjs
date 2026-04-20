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
