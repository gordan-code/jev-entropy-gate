import type { Candidate } from "../types.ts";
import { compilePattern, type Rule } from "../rules.ts";
import type { Matcher } from "./types.ts";

/**
 * Regex matcher. Cheap, universal, and good enough for v1. It locates every
 * line position where the pattern matches; the local prefilter and Jev then
 * decide which of those are real rewrite sites.
 */
export class RegexMatcher implements Matcher {
  readonly engine = "regex";

  findCandidates(filePath: string, content: string, rule: Rule): Candidate[] {
    const re = compilePattern(rule);
    const lines = content.split("\n");
    const candidates: Candidate[] = [];

    // Build line-start offsets once so we can map a match index -> line:col.
    const lineStarts: number[] = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === "\n") lineStarts.push(i + 1);
    }

    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const index = match.index;
      // Guard against zero-length matches to avoid an infinite loop.
      if (match[0].length === 0) re.lastIndex += 1;

      // Find the line containing the match start.
      const line = lineNumberAt(lineStarts, index);
      const col = index - lineStarts[line - 1]! + 1;

      const matched = match[0];
      const snippet = buildSnippet(lines, line, rule.context);

      candidates.push({
        file: normalizePath(filePath),
        line,
        column: col,
        snippet,
        matched
      });
    }

    return candidates;
  }
}

/** Map a character offset to a 1-based line number via binary search. */
function lineNumberAt(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Extract `context` lines before and after the given line (1-based). */
function buildSnippet(lines: string[], line: number, context: number): string {
  const start = Math.max(1, line - context);
  const end = Math.min(lines.length, line + context);
  return lines.slice(start - 1, end).join("\n");
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}