import type { Candidate, ScanResult, SiteResult, EntropyBand } from "./types.ts";
import type { Rule } from "./rules.ts";
import { locate } from "./locate.ts";
import { classifyCandidate } from "./classify.ts";
import { JevClient } from "./jev/client.ts";
import { computeRuleKey, loadCache, saveCache } from "./cache.ts";

export interface ScanOptions {
  rule: Rule;
  rootDir: string;
  apiKey: string;
  concurrency?: number;
  /** 缓存文件路径，指定后开启增量扫描。 */
  cachePath?: string;
  /** 测试用：注入一个 mock 的 Jev 客户端，不调真实 API。 */
  client?: Pick<JevClient, "evaluate">;
}

const BANDS: EntropyBand[] = ["auto", "assisted", "manual"];

/**
 * 跑完整管线：locate 圈点 -> 逐点问 Jev 判定 -> 汇总成 ScanResult。
 * 开了 cachePath 后，内容没变的文件直接复用上次判定，不重新问 Jev。
 */
export async function scan(options: ScanOptions): Promise<ScanResult> {
  const { rule, rootDir } = options;
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const client = options.client ?? new JevClient({ apiKey: options.apiKey });

  const { candidates, totalLocated, prefilteredOut } = await locate(rootDir, rule);

  // 增量缓存：规则 key 或文件哈希变了才重判，否则复用上次结果。
  const sites: SiteResult[] = [];
  let reusedSites = 0;
  let rejudgedSites = 0;
  const nextCache: {
    version: 2;
    ruleKey: string;
    files: Record<string, { hash: string; sites: SiteResult[] }>;
  } = {
    version: 2,
    ruleKey: computeRuleKey(rule),
    files: {}
  };

  if (options.cachePath) {
    const cache = await loadCache(options.cachePath);

    // 按文件分组，保持 locate 的遍历顺序。
    const byFile = groupByFile(candidates);
    for (const [file, fileCandidates] of byFile) {
      const hash = fileCandidates[0]?.sourceHash;
      if (!hash || fileCandidates.some((candidate) => candidate.sourceHash !== hash)) {
        throw new Error(`文件 ${file} 的候选点缺少一致的 sourceHash。`);
      }
      const cached = cache?.files[file];

      if (
        cache &&
        cache.ruleKey === nextCache.ruleKey &&
        cached &&
        cached.hash === hash &&
        sameCachedSites(cached.sites, fileCandidates)
      ) {
        // 文件没变、规则没变，复用上次判定。
        sites.push(...cached.sites);
        nextCache.files[file] = cached;
        reusedSites += cached.sites.length;
      } else {
        // 文件变了（或没有缓存），重新判定。
        const fileSites = await mapWithConcurrency(fileCandidates, concurrency, (c) =>
          classifyCandidate(c, rule, client)
        );
        sites.push(...fileSites);
        nextCache.files[file] = { hash, sites: fileSites };
        rejudgedSites += fileSites.length;
      }
    }

    await saveCache(options.cachePath, nextCache);
  } else {
    // 没开缓存，全量判定。
    const all = await mapWithConcurrency(candidates, concurrency, (c) =>
      classifyCandidate(c, rule, client)
    );
    sites.push(...all);
    rejudgedSites = all.length;
  }

  const summary = summarize(sites);
  const summaryPct = pctOf(summary, sites.length);

  const result: ScanResult = {
    ruleId: rule.id,
    ruleDescription: rule.description ?? rule.id,
    scannedAt: new Date().toISOString(),
    totalLocated,
    prefilteredOut,
    evaluated: sites.length,
    sites,
    summary,
    summaryPct
  };
  if (options.cachePath) {
    result.cacheStats = { reusedSites, rejudgedSites };
  }
  return result;
}

/** 缓存不仅要匹配文件哈希，还必须对应本次定位出的同一批候选点。 */
function sameCachedSites(cached: SiteResult[], current: Candidate[]): boolean {
  if (cached.length !== current.length) return false;
  return cached.every((site, index) => sameCandidate(site.candidate, current[index]!));
}

function sameCandidate(a: Candidate, b: Candidate): boolean {
  return (
    a.file === b.file &&
    a.sourceHash === b.sourceHash &&
    a.line === b.line &&
    a.column === b.column &&
    a.offset === b.offset &&
    a.snippet === b.snippet &&
    a.matched === b.matched &&
    a.replacement === b.replacement
  );
}

/** 把候选点按文件分组，保持文件首次出现的顺序。 */
function groupByFile(candidates: Candidate[]): Map<string, Candidate[]> {
  const map = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = map.get(c.file);
    if (list) list.push(c);
    else map.set(c.file, [c]);
  }
  return map;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function summarize(sites: SiteResult[]): Record<EntropyBand, number> {
  const summary: Record<EntropyBand, number> = { auto: 0, assisted: 0, manual: 0 };
  for (const site of sites) summary[site.band]++;
  return summary;
}

function pctOf(
  summary: Record<EntropyBand, number>,
  total: number
): Record<EntropyBand, number> {
  const pct: Record<EntropyBand, number> = { auto: 0, assisted: 0, manual: 0 };
  if (total === 0) return pct;
  for (const band of BANDS) {
    pct[band] = Math.round((summary[band] / total) * 100);
  }
  return pct;
}
