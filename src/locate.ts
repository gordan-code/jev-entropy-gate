import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Candidate } from "./types.ts";
import type { Rule } from "./rules.ts";
import { matcherFor } from "./matcher/index.ts";
import { shouldKeep } from "./prefilter.ts";
import { matchesAny } from "./glob.ts";
import { computeFileHash } from "./cache.ts";

/** Directories always skipped when walking the tree. */
const ALWAYS_EXCLUDED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target", // Maven/Gradle build output (contains .class/.jar binaries)
  ".next",
  ".turbo",
  "coverage",
  ".jev-gate",
  ".cache",
  ".vite"
]);

/** Binary / non-source extensions we never scan. */
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".mp4", ".mp3", ".wav", ".zip", ".gz", ".tar", ".pdf",
  ".woff", ".woff2", ".ttf", ".lock",
  ".class", ".jar", ".map", ".pyc", ".exe", ".dll", ".so", ".dylib", ".bin"
]);

/** Dot-directories that MAY hold source code; all other dot-dirs are skipped. */
const DOT_DIR_ALLOWED = new Set([".github"]);

export interface LocateResult {
  candidates: Candidate[];
  totalLocated: number;
  prefilteredOut: number;
}

/**
 * Walk `rootDir`, apply the rule's matcher to each source file, and drop
 * candidate sites that fail the local prefilter. Returns the surviving
 * candidates plus counts for reporting.
 */
export async function locate(rootDir: string, rule: Rule): Promise<LocateResult> {
  const matcher = matcherFor(rule);
  const files = await collectFiles(rootDir);
  let totalLocated = 0;
  let prefilteredOut = 0;
  const candidates: Candidate[] = [];

  for (const file of files) {
    const rel = relative(resolve(rootDir), file).replace(/\\/g, "/");

    // include/exclude filtering happens here, where we know the relative path.
    if (rule.include && !matchesAny(rel, rule.include)) continue;
    if (matchesAny(rel, rule.exclude)) continue;

    const bytes = await readFile(file);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      // Binary or otherwise invalid UTF-8 files are not source files we can safely scan.
      continue;
    }
    const sourceHash = computeFileHash(bytes);
    const found = matcher.findCandidates(rel, content, rule);
    totalLocated += found.length;
    for (const c of found) {
      if (shouldKeep(c)) candidates.push({ ...c, sourceHash });
      else prefilteredOut++;
    }
  }

  return { candidates, totalLocated, prefilteredOut };
}

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ALWAYS_EXCLUDED.has(entry.name)) continue;
      if (entry.name.startsWith(".") && !DOT_DIR_ALLOWED.has(entry.name)) continue;
      out.push(...(await collectFiles(full)));
    } else if (entry.isFile()) {
      if (SKIP_EXTENSIONS.has(ext(entry.name))) continue;
      const st = await stat(full);
      if (st.size > 2 * 1024 * 1024) continue; // skip files > 2MB
      out.push(full);
    }
  }
  return out;
}

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i) : "";
}
