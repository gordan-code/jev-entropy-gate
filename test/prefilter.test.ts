import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldKeep } from "../src/prefilter.ts";

function cand(matched: string, snippet: string) {
  return { file: "a.ts", line: 1, column: 1, offset: 0, matched, snippet };
}

test("keeps a real code site", () => {
  assert.equal(shouldKeep(cand("fetch(", "fetch('/x')")), true);
});

test("drops a match inside a string literal", () => {
  assert.equal(shouldKeep(cand("fetch(", 'const s = "fetch( is a string"')), false);
});

test("drops a match inside a comment", () => {
  assert.equal(shouldKeep(cand("fetch(", "// fetch( is commented")), false);
});