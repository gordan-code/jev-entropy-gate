import { test } from "node:test";
import assert from "node:assert/strict";
import { AstGrepMatcher } from "../src/matcher/astgrep.ts";
import { ruleSchema } from "../src/rules.ts";

/** 造一个 ast-grep 引擎的规则。 */
function rule(pattern: string, fix?: string) {
  return ruleSchema.parse({
    id: "x",
    pattern,
    task: "t",
    engine: "ast-grep",
    language: "typescript",
    ...(fix ? { fix } : {})
  });
}

const matcher = new AstGrepMatcher();

test("用 AST pattern 圈点，不会匹配字符串和注释里的假点", () => {
  const code = [
    'const a = fetch("/real")', // 真调用
    'const s = "fetch( 是字符串"', // 字符串里，regex 会误报
    "// fetch( 是注释" // 注释里，regex 会误报
  ].join("\n");

  const found = matcher.findCandidates("a.ts", code, rule("fetch($$$ARGS)"));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.matched, 'fetch("/real")');
});

test("正确计算 line/column/offset", () => {
  const code = "const x = 1\nconst y = fetch('/a')";
  const found = matcher.findCandidates("a.ts", code, rule("fetch($$$ARGS)"));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.line, 2);
  assert.equal(found[0]!.column, 11);
  assert.equal(found[0]!.offset, code.indexOf("fetch"));
});

test("fix 模板的多节点 metavariable（$$$ARGS）被正确替换", () => {
  const code = "fetch('/a', { method: 'POST' })";
  const found = matcher.findCandidates(
    "a.ts",
    code,
    rule("fetch($$$ARGS)", "apiClient($$$ARGS)")
  );
  assert.equal(found[0]!.replacement, "apiClient('/a', { method: 'POST' })");
});

test("单节点 metavariable（$NAME）被正确替换", () => {
  const code = "console.log(msg)";
  const found = matcher.findCandidates(
    "a.ts",
    code,
    rule("console.$METHOD($ARG)", "logger.$METHOD($ARG)")
  );
  assert.equal(found[0]!.replacement, "logger.log(msg)");
});

test("语法错误的代码返回空数组，不抛错", () => {
  const code = "const = = broken syntax";
  const found = matcher.findCandidates("a.ts", code, rule("fetch($$$ARGS)"));
  assert.equal(found.length, 0);
});

test("不支持的 language 抛错", () => {
  const badRule = ruleSchema.parse({
    id: "x",
    pattern: "fetch($$$ARGS)",
    task: "t",
    engine: "ast-grep",
    language: "python"
  });
  assert.throws(() => matcher.findCandidates("a.ts", "fetch('/a')", badRule), /不支持语言/);
});
