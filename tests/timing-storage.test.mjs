// tests/timing-storage.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Redirect plugin data to a temp dir for this test file
// MUST be set BEFORE importing state.mjs
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-timing-test-"));
process.env.CLAUDE_PLUGIN_DATA = tmpRoot;

import {
  appendTimingHistory,
  readTimingHistory,
  resolveTimingHistoryFile,
} from "../plugins/gemini/scripts/lib/state.mjs";

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

test("append after a partial-line file prepends newline to recover", () => {
  const file = resolveTimingHistoryFile();
  // Force-write a partial line (no trailing \n)
  fs.writeFileSync(file, '{"jobId":"gt-part');
  appendTimingHistory({ jobId: "gt-after" });

  const rows = readTimingHistory();
  // The partial line is corrupt and skipped; new line is recoverable
  assert.ok(rows.some((r) => r.jobId === "gt-after"));
});

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

test("resolveTimingHistoryFile falls back under tmpdir/gemini-companion when CLAUDE_PLUGIN_DATA absent", async () => {
  // Capture current env, temporarily unset
  const saved = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    // Re-import to pick up fresh env — note: ESM caches, so we can't truly re-evaluate,
    // but the resolve* functions read env at call time, not module load time.
    const mod = await import("../plugins/gemini/scripts/lib/state.mjs");
    const p = mod.resolveTimingHistoryFile();
    const os = await import("node:os");
    const path = await import("node:path");
    assert.ok(
      p.startsWith(path.join(os.tmpdir(), "gemini-companion")),
      `fallback path ${p} should be under ${os.tmpdir()}/gemini-companion`
    );
  } finally {
    if (saved !== undefined) process.env.CLAUDE_PLUGIN_DATA = saved;
  }
});

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
