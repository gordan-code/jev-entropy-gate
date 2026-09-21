import { test } from "node:test";
import assert from "node:assert/strict";
import { RegexMatcher } from "../src/matcher/regex.ts";
import { ruleSchema } from "../src/rules.ts";

const rule = ruleSchema.parse({ id: "x", pattern: "fetch\\s*\\(", task: "t" });
const matcher = new RegexMatcher();

test("finds a real call site with correct line/col", () => {
  const content = "function a() {\n  return fetch('/x');\n}\n";
  const found = matcher.findCandidates("a.ts", content, rule);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.line, 2);
  assert.ok(found[0]!.column > 0);
});

test("finds multiple sites", () => {
  const content = "fetch('/a');\nfetch('/b');\n";
  const found = matcher.findCandidates("a.ts", content, rule);
  assert.equal(found.length, 2);
});

test("snippet includes surrounding context", () => {
  const content = "l1\nl2\nfetch('/x')\nl4\nl5";
  const found = matcher.findCandidates("a.ts", content, rule);
  assert.ok(found[0]!.snippet.includes("l1"));
  assert.ok(found[0]!.snippet.includes("l5"));
});