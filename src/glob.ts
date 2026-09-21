// Minimal glob matching for `include` / `exclude` rule fields.
// Supports "**" (any depth), "*" (single path segment), "?" (single char).
// Enough for common cases like "src/**", "**/*.vue", "**/target/**".
// No external dependency.
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // "**" crosses directory boundaries.
        re += ".*";
        i += 2;
        // Collapse a following "/" so "**/foo" matches "foo" too.
        if (pattern[i] === "/") i += 1;
        continue;
      }
      re += "[^/]*";
      i += 1;
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += escapeRegexChar(c);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True if `path` matches any of the glob `patterns`. Empty list => no match. */
export function matchesAny(path: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => globToRegExp(p).test(path));
}

function escapeRegexChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}