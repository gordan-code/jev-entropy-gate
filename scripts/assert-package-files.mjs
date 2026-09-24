#!/usr/bin/env node

import { posix } from "node:path";

const EXPECTED_FILES = [
  "package.json",
  "bin/jevg.mjs",
  "dist/index.js",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md"
];
const EXPECTED_FILE_SET = new Set(EXPECTED_FILES);
const DENY_PATTERNS = [
  /(^|\/)\.env(?:$|\.)/i,
  /(^|\/)helloagents(?:\/|$)/i,
  /(^|\/)tests?(?:\/|$)/i,
  /(^|\/)reports?(?:\/|$)/i,
  /(^|\/)src(?:\/|$)/i,
  /\.tsx?$/i,
  /\.map$/i,
  /(^|\/)(?:tsconfig|package-lock|\.npmrc|\.eslintrc|vitest\.config|jest\.config|config|configuration)(?:\.|\/|$)/i
];

function normalizePath(value) {
  const raw = String(value);
  const slashPath = raw.replaceAll("\\", "/");
  return {
    raw,
    path: posix.normalize(slashPath),
    canonical: raw === slashPath && slashPath === posix.normalize(slashPath) && !slashPath.startsWith("/") && !slashPath.includes("\0")
  };
}

function isDenied(path) {
  return DENY_PATTERNS.some((pattern) => pattern.test(path));
}

function extractFiles(payload) {
  const records = Array.isArray(payload) ? payload : [payload];
  return records.flatMap((record) => {
    if (!record || typeof record !== "object" || !Array.isArray(record.files)) {
      throw new Error("npm pack JSON must contain a files array");
    }
    return record.files.map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && typeof entry.path === "string") return entry.path;
      throw new Error("npm pack JSON contains a file entry without a path");
    });
  });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

let payload;
try {
  payload = JSON.parse(await readStdin());
} catch (error) {
  console.error(`无法解析 npm pack JSON：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

try {
  const files = extractFiles(payload).map(normalizePath);
  if (files.length === 0) throw new Error("npm pack JSON contains no files");

  const paths = files.map(({ path }) => path);
  const actualFileSet = new Set(paths);
  const unexpected = files.filter(({ path, canonical }) => !canonical || !EXPECTED_FILE_SET.has(path));
  const missing = EXPECTED_FILES.filter((path) => !actualFileSet.has(path));
  const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index);
  const denied = files.filter(({ path }) => isDenied(path));
  if (unexpected.length > 0 || missing.length > 0 || duplicates.length > 0 || denied.length > 0) {
    const details = [
      unexpected.length > 0 ? `未列入精确清单：${unexpected.map(({ raw }) => raw).join(", ")}` : "",
      missing.length > 0 ? `缺少清单文件：${missing.join(", ")}` : "",
      duplicates.length > 0 ? `重复清单文件：${duplicates.join(", ")}` : "",
      denied.length > 0 ? `命中拒绝规则：${denied.map(({ raw }) => raw).join(", ")}` : ""
    ].filter(Boolean).join("；");
    throw new Error(details);
  }

  console.log(`npm 包文件精确清单校验通过（${files.length} 个文件）`);
} catch (error) {
  console.error(`npm 包文件白名单校验失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
