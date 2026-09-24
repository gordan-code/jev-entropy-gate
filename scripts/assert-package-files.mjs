#!/usr/bin/env node

import { posix } from "node:path";

const ALLOWED_EXACT = new Set([
  "package.json",
  "README.md",
  "README.zh-CN.md",
  "LICENSE"
]);
const ALLOWED_PREFIXES = ["bin/", "dist/"];
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
  return posix.normalize(String(value).replaceAll("\\", "/"));
}

function isDenied(path) {
  return DENY_PATTERNS.some((pattern) => pattern.test(path));
}

function isAllowed(path) {
  return ALLOWED_EXACT.has(path) || ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
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

  const unexpected = files.filter((path) => !isAllowed(path));
  const denied = files.filter(isDenied);
  if (unexpected.length > 0 || denied.length > 0) {
    const details = [
      unexpected.length > 0 ? `未列入白名单：${unexpected.join(", ")}` : "",
      denied.length > 0 ? `命中拒绝规则：${denied.join(", ")}` : ""
    ].filter(Boolean).join("；");
    throw new Error(details);
  }

  console.log(`npm 包文件白名单校验通过（${files.length} 个文件）`);
} catch (error) {
  console.error(`npm 包文件白名单校验失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
