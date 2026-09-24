/**
 * Global shared types for jev-entropy-gate.
 */

/** The three automation bands derived from Jev's probability entropy. */
export type EntropyBand = "auto" | "assisted" | "manual";

/** 一个由 matcher 圈出的候选改写点，还没经过 Jev 判定。 */
export interface Candidate {
  /** 相对扫描根目录的文件路径，用正斜杠。 */
  file: string;
  /** 原始文件字节的完整 SHA-256，用于 apply 前确认源码未被修改。 */
  sourceHash?: string;
  /** 匹配开始的行号（从 1 数）。 */
  line: number;
  /** 匹配开始的列号（从 1 数）。 */
  column: number;
  /** 匹配文本在文件内容里的字符偏移（从 0 数），apply 命令用它精确定位要替换的位置。 */
  offset: number;
  /** 匹配行加上前后 context 行的原文。 */
  snippet: string;
  /** 匹配到的原文。 */
  matched: string;
  /**
   * 改写后的完整文本（可选）。ast-grep 引擎在圈点时就算好，因为它的改写
   * 依赖 AST 里的 metavariable，离开 parse 上下文就算不出来了。
   * regex 引擎不填这个字段，改写时用规则的 replace 字段现算。
   */
  replacement?: string;
}

/** The result of Jev classifying one candidate site. */
export interface SiteResult {
  candidate: Candidate;
  /** Raw probability distribution over rewrite_class choices. */
  probabilities: Record<string, number>;
  /** Top choice key. */
  choice: string;
  /** Normalized entropy in [0, 1] over the choice distribution. */
  entropy: number;
  /** Noul probability that the site can be safely automated (0..1). */
  automateConfidence: number;
  /** Final band after cross-checking entropy against automate confidence. */
  band: EntropyBand;
  /** Overall Jev confidence for the choice answer (0..1), when reported. */
  confidence: number;
}

/** Aggregated scan output. */
export interface ScanResult {
  ruleId: string;
  ruleDescription: string;
  scannedAt: string;
  /** Total sites located by the matcher, before local prefiltering. */
  totalLocated: number;
  /** Sites removed by local prefiltering (comments, strings, etc.). */
  prefilteredOut: number;
  /** Sites actually sent to Jev. */
  evaluated: number;
  sites: SiteResult[];
  /** Summary counts per band. */
  summary: Record<EntropyBand, number>;
  /** Summary percentages per band (0..100, rounded). */
  summaryPct: Record<EntropyBand, number>;
  /** 增量缓存的统计，没开缓存时是 undefined。 */
  cacheStats?: {
    /** 从缓存复用的判定数（没重新问 Jev）。 */
    reusedSites: number;
    /** 重新问 Jev 的判定数。 */
    rejudgedSites: number;
  };
}
