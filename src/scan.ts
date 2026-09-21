import type { Candidate, ScanResult, SiteResult, EntropyBand } from "./types.ts";
import type { Rule } from "./rules.ts";
import { locate } from "./locate.ts";
import { classifyCandidate } from "./classify.ts";
import { JevClient } from "./jev/client.ts";

export interface ScanOptions {
  rule: Rule;
  rootDir: string;
  apiKey: string;
  concurrency?: number;
}

const BANDS: EntropyBand[] = ["auto", "assisted", "manual"];

/**
 * Run the full pipeline: locate candidates -> classify in a bounded concurrency
 * pool -> aggregate a ScanResult.
 */
export async function scan(options: ScanOptions): Promise<ScanResult> {
  const { rule, rootDir } = options;
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const client = new JevClient({ apiKey: options.apiKey });

  const { candidates, totalLocated, prefilteredOut } = await locate(rootDir, rule);

  const sites = await mapWithConcurrency(candidates, concurrency, (c) =>
    classifyCandidate(c, rule, client)
  );

  const summary = summarize(sites);
  const summaryPct = pctOf(summary, sites.length);

  return {
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