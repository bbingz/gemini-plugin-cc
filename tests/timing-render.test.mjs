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
