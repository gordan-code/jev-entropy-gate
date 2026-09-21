import type { Rule } from "../rules.ts";
import type { Matcher } from "./types.ts";
import { RegexMatcher } from "./regex.ts";

const matchers: Matcher[] = [new RegexMatcher()];

/**
 * Resolve the matcher for a rule. v1 only has `regex`; `ast-grep` will be
 * added here in v2 without touching the rest of the pipeline.
 */
export function matcherFor(rule: Rule): Matcher {
  const matcher = matchers.find((m) => m.engine === rule.engine);
  if (!matcher) {
    throw new Error(
      `No matcher registered for engine "${rule.engine}" (supported: ${matchers
        .map((m) => m.engine)
        .join(", ")})`
    );
  }
  return matcher;
}