import { test } from "node:test";
import assert from "node:assert/strict";
import { planRewrites, applyToContent, type Rewrite } from "../src/apply.ts";
import { validateRewrites } from "../src/apply/validate.ts";
import { RegexMatcher } from "../src/matcher/regex.ts";
import { AstGrepMatcher } from "../src/matcher/astgrep.ts";
import type { SiteResult } from "../src/types.ts";
import { ruleSchema } from "../src/rules.ts";

/** 造一个 SiteResult，band 可以指定，方便测"只挑 auto"的逻辑。 */
function site(
  file: string,
  offset: number,
  matched: string,
  band: SiteResult["band"],
  sourceHash?: string
): SiteResult {
  return {
    candidate: { file, line: 1, column: 1, offset, snippet: "", matched, sourceHash },
    probabilities: { deterministic: 0.9, judgment: 0.05, manual: 0.05 },
    choice: "deterministic",
    entropy: 0.3,
    automateConfidence: 0.8,
    band,
    confidence: 0.9
  };
}

function autoSite(candidate: SiteResult["candidate"]): SiteResult {
  return {
    candidate,
    probabilities: { deterministic: 0.9, judgment: 0.05, manual: 0.05 },
    choice: "deterministic",
    entropy: 0.3,
    automateConfidence: 0.8,
    band: "auto",
    confidence: 0.9
  };
}

const rule = ruleSchema.parse({
  id: "console-to-logger",
  pattern: "console\\.(log|warn|error)\\(",
  replace: "logger.$1(",
  task: "迁移"
});

test("planRewrites 只挑 auto 点，忽略 assisted 和 manual", () => {
  const sites = [
    site("a.ts", 0, "console.warn(", "auto"),
    site("a.ts", 20, "console.error(", "assisted"),
    site("a.ts", 40, "console.log(", "manual")
  ];
  const rewrites = planRewrites(sites, rule);
  assert.equal(rewrites.length, 1);
  assert.equal(rewrites[0]!.after, "logger.warn(");
});

test("planRewrites 用 capture group 正确算出替换文本", () => {
  const sites = [
    site("a.ts", 0, "console.warn(", "auto"),
    site("a.ts", 20, "console.error(", "auto")
  ];
  const rewrites = planRewrites(sites, rule);
  assert.equal(rewrites[0]!.after, "logger.warn(");
  assert.equal(rewrites[1]!.after, "logger.error(");
});

test("planRewrites 透传 candidate 的 sourceHash", () => {
  const sourceHash = "a".repeat(64);
  const rewrites = planRewrites(
    [site("a.ts", 0, "console.warn(", "auto", sourceHash)],
    rule
  );
  assert.equal(rewrites[0]!.sourceHash, sourceHash);
});

test("regex 空字符串 replace 经 matcher 和 plan 后可删除原文", () => {
  const content = "console.log(msg)";
  const emptyReplaceRule = ruleSchema.parse({
    id: "remove-console",
    pattern: "console\\.log\\(msg\\)",
    replace: "",
    task: "删除"
  });
  const candidate = new RegexMatcher().findCandidates("a.ts", content, emptyReplaceRule)[0]!;
  const rewrites = planRewrites([autoSite(candidate)], emptyReplaceRule);

  assert.equal(rewrites[0]!.after, "");
  assert.equal(validateRewrites(content, rewrites), "");
});

test("ast-grep 空字符串 fix 经 matcher 和 plan 后可删除原文", () => {
  const content = "console.log(msg)";
  const emptyFixRule = ruleSchema.parse({
    id: "remove-console",
    engine: "ast-grep",
    language: "typescript",
    pattern: "console.log($ARG)",
    fix: "",
    task: "删除"
  });
  const candidate = new AstGrepMatcher().findCandidates("a.ts", content, emptyFixRule)[0]!;
  const rewrites = planRewrites([autoSite(candidate)], emptyFixRule);

  assert.equal(candidate.replacement, "");
  assert.equal(rewrites[0]!.after, "");
  assert.equal(validateRewrites(content, rewrites), "");
});

test("planRewrites 遇到没有 replace 字段的规则会抛错", () => {
  const noReplace = ruleSchema.parse({ id: "x", pattern: "a", task: "t" });
  assert.throws(() => planRewrites([site("a.ts", 0, "a", "auto")], noReplace), /replace/);
});

test("applyToContent 正确替换多处，且从后往前不串位", () => {
  const content = "console.warn('a')\nconsole.error('b')";
  const rewrites: Rewrite[] = [
    {
      file: "a.ts",
      offset: content.indexOf("console.warn("),
      before: "console.warn(",
      after: "logger.warn(",
      line: 1
    },
    {
      file: "a.ts",
      offset: content.indexOf("console.error("),
      before: "console.error(",
      after: "logger.error(",
      line: 2
    }
  ];
  const out = applyToContent(content, rewrites);
  assert.equal(out, "logger.warn('a')\nlogger.error('b')");
});

test("applyToContent 同一次替换里，前面的替换不影响后面 offset", () => {
  // 两个 auto 点，第二个的 offset 在第一个之后；从后往前替换，offset 不漂移。
  const content = "a b";
  const rewrites: Rewrite[] = [
    { file: "f", offset: 0, before: "a", after: "x", line: 1 },
    { file: "f", offset: 2, before: "b", after: "y", line: 1 }
  ];
  const out = applyToContent(content, rewrites);
  assert.equal(out, "x y");
});
