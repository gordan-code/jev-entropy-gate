import type { Candidate } from "../types.ts";
import { compilePattern, type Rule } from "../rules.ts";
import type { Matcher } from "./types.ts";

/**
 * 用正则圈候选点的匹配器。便宜、通用，v1 够用。
 * 它找出 pattern 匹配到的每个位置，交给后面的粗过滤和 Jev 判断。
 */
export class RegexMatcher implements Matcher {
  readonly engine = "regex";

  findCandidates(filePath: string, content: string, rule: Rule): Candidate[] {
    const re = compilePattern(rule);
    const lines = content.split("\n");
    const candidates: Candidate[] = [];

    // 先把每行开头的字符偏移算出来，方便把"字符偏移"换算成"行号:列号"。
    const lineStarts: number[] = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === "\n") lineStarts.push(i + 1);
    }

    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const index = match.index;
      // 防止零长度匹配导致死循环。
      if (match[0].length === 0) re.lastIndex += 1;

      // 算出匹配开始处在哪一行、哪一列。
      const line = lineNumberAt(lineStarts, index);
      const col = index - lineStarts[line - 1]! + 1;

      const matched = match[0];
      const snippet = buildSnippet(lines, line, rule.context);

      candidates.push({
        file: normalizePath(filePath),
        line,
        column: col,
        // 字符偏移直接交给 apply 命令，做替换时能精确定位。
        offset: index,
        snippet,
        matched
      });
    }

    return candidates;
  }
}

/** 用二分查找，把字符偏移换算成从 1 数起的行号。 */
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

/** 取给定行（从 1 数起）前后各 context 行的原文。 */
function buildSnippet(lines: string[], line: number, context: number): string {
  const start = Math.max(1, line - context);
  const end = Math.min(lines.length, line + context);
  return lines.slice(start - 1, end).join("\n");
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}