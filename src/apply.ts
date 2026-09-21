import type { SiteResult } from "./types.ts";
import type { Rule } from "./rules.ts";

/** 一次具体要执行的替换。 */
export interface Rewrite {
  /** 文件路径（相对根目录）。 */
  file: string;
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
 */
export function planRewrites(sites: SiteResult[], rule: Rule): Rewrite[] {
  if (!rule.replace) {
    throw new Error(`规则 "${rule.id}" 没有 replace 字段，无法执行 apply`);
  }
  // 用非全局的正则，对"匹配到的文本"做替换，得到替换后的文本。
  // 比如 pattern 是 console\.(log|warn|error)\( ，replace 是 logger.$1( ，
  // 那么 console.warn( 会变成 logger.warn( 。
  const regex = new RegExp(rule.pattern);

  const rewrites: Rewrite[] = [];
  for (const site of sites) {
    if (site.band !== "auto") continue;
    const after = site.candidate.matched.replace(regex, rule.replace);
    rewrites.push({
      file: site.candidate.file,
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
