import type { Rule } from "../rules.ts";
import type { Matcher } from "./types.ts";
import { RegexMatcher } from "./regex.ts";
import { AstGrepMatcher } from "./astgrep.ts";

const matchers: Matcher[] = [new RegexMatcher(), new AstGrepMatcher()];

/** 按规则的 engine 字段找对应的匹配器。 */
export function matcherFor(rule: Rule): Matcher {
  const matcher = matchers.find((m) => m.engine === rule.engine);
  if (!matcher) {
    throw new Error(
      `没有注册 engine "${rule.engine}" 的匹配器（支持 ${matchers
        .map((m) => m.engine)
        .join("、")}）`
    );
  }
  return matcher;
}
