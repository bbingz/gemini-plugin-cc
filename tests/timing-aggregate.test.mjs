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
