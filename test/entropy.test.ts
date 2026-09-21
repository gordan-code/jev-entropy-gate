import { test } from "node:test";
import assert from "node:assert/strict";
import { entropy, normalizedEntropy } from "../src/entropy.ts";

test("entropy of a degenerate distribution is 0", () => {
  assert.equal(entropy({ a: 1, b: 0, c: 0 }), 0);
});

test("normalized entropy is 1 for a flat distribution", () => {
  assert.equal(normalizedEntropy({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }), 1);
});

test("normalized entropy of a sharp distribution is much smaller than a flat one", () => {
  const sharp = normalizedEntropy({ a: 0.98, b: 0.01, c: 0.01 });
  const flat = normalizedEntropy({ a: 1 / 3, b: 1 / 3, c: 1 / 3 });
  assert.ok(sharp < 0.2, `expected sharp entropy < 0.2, got ${sharp}`);
  assert.ok(sharp < flat);
});