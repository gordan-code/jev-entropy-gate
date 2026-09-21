import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Rule } from "./rules.ts";
import type { SiteResult } from "./types.ts";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./classify.ts";

/** 一个文件的缓存条目：内容哈希 + 该文件上次的判定结果。 */
interface FileCacheEntry {
  hash: string;
  sites: SiteResult[];
}

/** 一份扫描缓存：按规则 key 分组，再按文件存判定结果。 */
interface ScanCache {
  ruleKey: string;
  files: Record<string, FileCacheEntry>;
}

/**
 * 算出规则的缓存 key。规则里的关键字段或判定阈值变了，key 就变，
 * 旧缓存随之失效（因为判定依据变了，结果不能复用）。
 */
export function computeRuleKey(rule: Rule, thresholds: Thresholds = DEFAULT_THRESHOLDS): string {
  const key = JSON.stringify({
    id: rule.id,
    engine: rule.engine,
    pattern: rule.pattern,
    language: rule.language,
    context: rule.context,
    task: rule.task,
    replace: rule.replace,
    fix: rule.fix,
    include: rule.include,
    exclude: rule.exclude,
    thresholds
  });
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** 算出文件内容的哈希，用来判断文件有没有变。 */
export function computeFileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** 读缓存文件；不存在或损坏时返回 undefined（当作无缓存）。 */
export async function loadCache(path: string): Promise<ScanCache | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as ScanCache).ruleKey === "string" &&
      (parsed as ScanCache).files &&
      typeof (parsed as ScanCache).files === "object"
    ) {
      return parsed as ScanCache;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 写缓存文件，自动建父目录。 */
export async function saveCache(path: string, cache: ScanCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache), "utf8");
}

export type { ScanCache, FileCacheEntry };
