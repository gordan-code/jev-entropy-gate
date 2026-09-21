import type { Candidate } from "./types.ts";

/**
 * Local, zero-cost prefiltering. Before we spend a Jev call on a candidate,
 * drop sites that are clearly not real code: matches inside string literals
 * or comments. Jev is cheap but not free, and noise here would smear the
 * entropy statistics (decision point #3).
 *
 * This is intentionally heuristic and conservative: when in doubt we keep the
 * candidate. A false negative (dropping a real site) is worse than a false
 * positive (keeping a comment) because Jev itself would flag the obvious
 * cases anyway.
 */
export function shouldKeep(candidate: Candidate): boolean {
  return !isInsideStringOrComment(candidate.snippet, candidate.matched);
}

/**
 * Heuristic: look at the matched line within the snippet and decide whether
 * the match sits inside a string literal or a comment. We scan the line up to
 * the match column, tracking whether we are inside a string or comment.
 */
function isInsideStringOrComment(snippet: string, matched: string): boolean {
  // Find which line in the snippet contains the match. The snippet's first
  // line is the top context line, so we need the matched text's line.
  // Simpler: scan every line; if the matched text appears within guarded
  // syntax, treat it as not-code only when unambiguous.
  const lines = snippet.split("\n");
  for (const line of lines) {
    const idx = line.indexOf(matched);
    if (idx < 0) continue;
    if (isSpanGuarded(line, idx, matched.length)) return true;
  }
  return false;
}

/**
 * Returns true if the span [idx, idx+len) on `line` is inside a single-line
 * comment, a block comment, or a string literal.
 */
function isSpanGuarded(line: string, idx: number, len: number): boolean {
  return (
    insideSingleLineComment(line, idx) ||
    insideBlockComment(line, idx) ||
    insideStringLiteral(line, idx)
  );
}

function insideSingleLineComment(line: string, idx: number): boolean {
  const slash = line.lastIndexOf("//", idx);
  if (slash < 0) return false;
  // Ensure the "//" is not itself inside a string (rare; skip for v1).
  return true;
}

function insideBlockComment(line: string, idx: number): boolean {
  const open = line.lastIndexOf("/*", idx);
  const close = line.lastIndexOf("*/", idx);
  if (open < 0) return false;
  // We're inside a block comment if the nearest opener is after the nearest closer.
  return close < open;
}

function insideStringLiteral(line: string, idx: number): boolean {
  // Count unescaped quote characters before idx to determine whether we are
  // inside a string. Handles ', ", and ` (template literal) in a rough way.
  let inString = false;
  let quoteChar = "";
  for (let i = 0; i < idx; i++) {
    const c = line[i]!;
    if (!inString) {
      if (c === "'" || c === '"' || c === "`") {
        inString = true;
        quoteChar = c;
      }
    } else {
      if (c === "\\") {
        i++; // skip escaped char
        continue;
      }
      if (c === quoteChar) {
        inString = false;
        quoteChar = "";
      }
    }
  }
  return inString;
}