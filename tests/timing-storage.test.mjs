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
