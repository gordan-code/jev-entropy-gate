import type { SiteResult } from "./types.ts";
import type { Rule } from "./rules.ts";

/** 一次具体要执行的替换。 */
export interface Rewrite {
  /** 文件路径（相对根目录）。 */
  file: string;
  /** 定位时文件原始字节的完整 SHA-256。 */
  sourceHash?: string;
  /** 匹配文本在文件里的字符偏移（从 0 数）。 */
  offset: number;
  /** 替换前的文本。 */
  before: string;
  /** 替换后的文本。 */
  after: string;
  /** 匹配开始的行号（从 1 数），只用于展示。 */
  line: number;
}

/**
 * 从 scan 结果里挑出 auto 点，算出每个点替换前后的文本。
 * 只有 auto 点会被改写；assisted 和 manual 点原样不动。
 *
 * 改写文本有两个来源：
 *   - ast-grep 引擎：圈点时已经把替换结果算好，存在 candidate.replacement 里；
 *   - regex 引擎：这里用 replace 字段对匹配文本做正则替换。
 */
export function planRewrites(sites: SiteResult[], rule: Rule): Rewrite[] {
  // regex 引擎需要 replace 字段；ast-grep 引擎需要 fix 字段（圈点时已用掉）。
  const regex = rule.engine === "regex" ? new RegExp(rule.pattern) : null;

  const rewrites: Rewrite[] = [];
  for (const site of sites) {
    if (site.band !== "auto") continue;

    let after: string;
    if (site.candidate.replacement !== undefined) {
      // ast-grep 引擎预填的结果。
      after = site.candidate.replacement;
    } else {
      if (rule.replace === undefined || !regex) {
        throw new Error(
          `规则 "${rule.id}" 没有 replace 字段（regex 引擎），无法执行 apply`
        );
      }
      after = site.candidate.matched.replace(regex, rule.replace);
    }

    rewrites.push({
      file: site.candidate.file,
      sourceHash: site.candidate.sourceHash,
      offset: site.candidate.offset,
      before: site.candidate.matched,
      after,
      line: site.candidate.line
    });
  }
  return rewrites;
}

/**
 * 对一段文件内容执行一批替换。
 * 按 offset 从后往前做，这样前面的替换不会让后面的偏移错位。
 */
export function applyToContent(content: string, rewrites: Rewrite[]): string {
  const sorted = [...rewrites].sort((a, b) => b.offset - a.offset);
  let out = content;
  for (const r of sorted) {
    out = out.slice(0, r.offset) + r.after + out.slice(r.offset + r.before.length);
  }
  return out;
}
