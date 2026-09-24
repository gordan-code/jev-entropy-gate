import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Rule } from "./rules.ts";
import type { SiteResult } from "./types.ts";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./classify.ts";

const CACHE_VERSION = 2;
const SHA256_HEX = /^[a-f0-9]{64}$/i;

/** 一个文件的缓存条目：内容哈希 + 该文件上次的判定结果。 */
interface FileCacheEntry {
  hash: string;
  sites: SiteResult[];
}

/** 一份扫描缓存：按规则 key 分组，再按文件存判定结果。 */
interface ScanCache {
  version: 2;
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

/** 算出文件原始内容的完整哈希，用来判断文件有没有变。 */
export function computeFileHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 读缓存文件；不存在或损坏时返回 undefined（当作无缓存）。 */
export async function loadCache(path: string): Promise<ScanCache | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (parsed.version !== CACHE_VERSION || typeof parsed.ruleKey !== "string") return undefined;
    if (!isRecord(parsed.files)) return undefined;

    for (const entry of Object.values(parsed.files)) {
      if (!isFileCacheEntry(entry)) return undefined;
    }
    return parsed as unknown as ScanCache;
  } catch {
    return undefined;
  }
}

function isFileCacheEntry(value: unknown): value is FileCacheEntry {
  if (!isRecord(value) || !isSha256(value.hash) || !Array.isArray(value.sites)) return false;
  return value.sites.every(
    (site) => isSiteResult(site) && site.candidate.sourceHash === value.hash
  );
}

function isSiteResult(value: unknown): value is SiteResult {
  if (!isRecord(value)) return false;
  if (!isCandidate(value.candidate)) return false;
  if (!isRecord(value.probabilities)) return false;
  if (!Object.values(value.probabilities).every(isUnitInterval)) return false;
  return (
    typeof value.choice === "string" &&
    isUnitInterval(value.entropy) &&
    isUnitInterval(value.automateConfidence) &&
    (value.band === "auto" || value.band === "assisted" || value.band === "manual") &&
    isUnitInterval(value.confidence)
  );
}

function isCandidate(value: unknown): value is SiteResult["candidate"] {
  if (!isRecord(value) || !isSha256(value.sourceHash)) return false;
  return (
    typeof value.file === "string" &&
    typeof value.line === "number" &&
    Number.isFinite(value.line) &&
    typeof value.column === "number" &&
    Number.isFinite(value.column) &&
    typeof value.offset === "number" &&
    Number.isFinite(value.offset) &&
    typeof value.snippet === "string" &&
    typeof value.matched === "string" &&
    (value.replacement === undefined || typeof value.replacement === "string")
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 写缓存文件，自动建父目录。 */
export async function saveCache(path: string, cache: ScanCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ...cache, version: CACHE_VERSION }), "utf8");
}

export type { ScanCache, FileCacheEntry };
