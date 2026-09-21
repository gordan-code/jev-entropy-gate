import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleSchema } from "../src/rules.ts";

test("valid rule parses with defaults", () => {
  const r = ruleSchema.parse({
    id: "x",
    pattern: "fetch\\(",
    task: "migrate"
  });
  assert.equal(r.engine, "regex");
  assert.equal(r.context, 3);
});

test("invalid engine rejected", () => {
  const res = ruleSchema.safeParse({ id: "x", pattern: "a", task: "t", engine: "ast-grep" });
  assert.equal(res.success, false);
});

test("missing task rejected", () => {
  const res = ruleSchema.safeParse({ id: "x", pattern: "a" });
  assert.equal(res.success, false);
});