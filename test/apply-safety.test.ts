import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { validateRewrites } from "../src/apply/validate.ts";
import type { Rewrite } from "../src/apply.ts";

function rewrite(overrides: Partial<Rewrite>): Rewrite {
  return {
    file: "a.ts",
    offset: 0,
    before: "",
    after: "",
    line: 1,
    ...overrides
  };
}

test("validateRewrites rejects a rewrite whose original text differs", () => {
  assert.throws(
    () => validateRewrites("abc", [rewrite({ offset: 1, before: "x", after: "y" })]),
    /原文|before|mismatch/i
  );
});

test("validateRewrites rejects negative and out-of-bounds offsets", () => {
  assert.throws(
    () => validateRewrites("abc", [rewrite({ offset: -1 })]),
    /偏移|offset/i
  );
  assert.throws(
    () => validateRewrites("abc", [rewrite({ offset: 4 })]),
    /偏移|offset/i
  );
});

test("validateRewrites rejects offsets that are not safe integers", () => {
  assert.throws(
    () => validateRewrites("abc", [rewrite({ offset: 1.5 })]),
    /偏移|offset/i
  );
  assert.throws(
    () => validateRewrites("abc", [rewrite({ offset: Number.MAX_SAFE_INTEGER + 1 })]),
    /偏移|offset/i
  );
  assert.throws(
    () => validateRewrites("abc", [rewrite({ offset: Number.NaN })]),
    /偏移|offset/i
  );
  assert.throws(
    () => validateRewrites("abc", [rewrite({ offset: Number.POSITIVE_INFINITY })]),
    /偏移|offset/i
  );
});

test("validateRewrites rejects overlapping non-empty rewrite ranges", () => {
  assert.throws(
    () =>
      validateRewrites("abcd", [
        rewrite({ offset: 0, before: "ab", after: "x" }),
        rewrite({ offset: 1, before: "bc", after: "y" })
      ]),
    /重叠|overlap/i
  );
});

test("validateRewrites rejects two insertions at the same offset", () => {
  assert.throws(
    () =>
      validateRewrites("ab", [
        rewrite({ offset: 1, before: "", after: "X" }),
        rewrite({ offset: 1, before: "", after: "Y" })
      ]),
    /插入|overlap|同一偏移/i
  );
});

test("validateRewrites rejects an insertion at either boundary of a non-empty range", () => {
  assert.throws(
    () =>
      validateRewrites("abcd", [
        rewrite({ offset: 1, before: "bc", after: "X" }),
        rewrite({ offset: 1, before: "", after: "Y" })
      ]),
    /插入|重叠|overlap/i
  );
  assert.throws(
    () =>
      validateRewrites("abcd", [
        rewrite({ offset: 1, before: "bc", after: "X" }),
        rewrite({ offset: 3, before: "", after: "Y" })
      ]),
    /插入|重叠|overlap/i
  );
});

test("validateRewrites rejects an insertion inside a non-empty range", () => {
  assert.throws(
    () =>
      validateRewrites("abcd", [
        rewrite({ offset: 1, before: "bc", after: "X" }),
        rewrite({ offset: 2, before: "", after: "Y" })
      ]),
    /插入|重叠|overlap/i
  );
});

test("validateRewrites allows separate zero-width insertions, including EOF", () => {
  assert.equal(
    validateRewrites("ab", [rewrite({ offset: 1, after: "X" })]),
    "aXb"
  );
  assert.equal(
    validateRewrites("ab", [rewrite({ offset: 2, after: "Y" })]),
    "abY"
  );
});

test("validateRewrites applies multiple zero-width insertions in reverse input order", () => {
  assert.equal(
    validateRewrites("abcd", [
      rewrite({ offset: 4, after: "E" }),
      rewrite({ offset: 2, after: "C" }),
      rewrite({ offset: 0, after: "A" })
    ]),
    "AabCcdE"
  );
});

test("validateRewrites scales to many non-conflicting insertions", () => {
  const count = 30_000;
  const content = "a".repeat(count);
  const rewrites = Array.from({ length: count }, (_, index) =>
    rewrite({ offset: count - index, after: "x" })
  );
  const started = performance.now();
  const output = validateRewrites(content, rewrites);
  const elapsed = performance.now() - started;

  assert.equal(output.length, content.length + count);
  assert.ok(elapsed < 500, `validation took ${elapsed.toFixed(1)}ms`);
});

test("validateRewrites allows adjacent non-empty ranges", () => {
  assert.equal(
    validateRewrites("abcd", [
      rewrite({ offset: 0, before: "ab", after: "AB" }),
      rewrite({ offset: 2, before: "cd", after: "CD" })
    ]),
    "ABCD"
  );
});

test("validateRewrites allows deleting matched text with an empty after", () => {
  assert.equal(
    validateRewrites("abc", [rewrite({ offset: 1, before: "b", after: "" })]),
    "ac"
  );
});
