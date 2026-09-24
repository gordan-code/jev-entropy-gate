#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validatorPath = join(rootDir, "scripts", "assert-package-files.mjs");
const npmCliFromEnvironment = process.env.npm_execpath;
const npmCliPath = npmCliFromEnvironment
  ? resolve(npmCliFromEnvironment)
  : join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
let packDirectory;
let temporaryPrefix;
let primaryError;
const cleanupErrors = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} 失败（${result.status}）：\n${output}`);
  }
  return result;
}

function runNpm(args, options = {}) {
  if (!existsSync(npmCliPath)) {
    throw new Error(`找不到 npm CLI entry：${npmCliPath}`);
  }
  return run(process.execPath, [npmCliPath, ...args], options);
}

function assertPackageListing(packOutput) {
  run(process.execPath, [validatorPath], { input: packOutput });
}

function assertUnderPrefix(path, prefix) {
  const resolvedPath = resolve(path);
  const resolvedPrefix = resolve(prefix);
  const comparisonPath = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  const comparisonPrefix = process.platform === "win32" ? resolvedPrefix.toLowerCase() : resolvedPrefix;
  const pathRelativeToPrefix = relative(comparisonPrefix, comparisonPath);
  if (pathRelativeToPrefix.startsWith(`..${sep}`) || pathRelativeToPrefix === ".." || isAbsolute(pathRelativeToPrefix)) {
    throw new Error(`解析到临时前缀之外的 jevg：${resolvedPath}`);
  }
  return resolvedPath;
}

function resolveExecutable(environment) {
  const resolver = process.platform === "win32" ? "where.exe" : "which";
  const result = run(resolver, ["jevg"], { env: environment });
  const resolved = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!resolved) throw new Error("无法从隔离 PATH 解析 jevg");
  return resolved;
}

function resolveTarball(packReport) {
  if (!packReport || typeof packReport.filename !== "string") {
    throw new Error("npm pack JSON 缺少 tarball filename");
  }

  const filename = packReport.filename;
  if (filename !== basename(filename) || filename.includes("/") || filename.includes("\\")) {
    throw new Error(`npm pack filename 不是安全 basename：${filename}`);
  }

  const candidate = resolve(packDirectory, filename);
  const candidateRelative = relative(packDirectory, candidate);
  if (!candidateRelative || candidateRelative.startsWith(`..${sep}`) || candidateRelative === ".." || isAbsolute(candidateRelative)) {
    throw new Error(`npm pack tarball 不在临时目录内：${candidate}`);
  }
  if (!existsSync(candidate)) throw new Error(`npm pack 未生成 tarball：${candidate}`);
  return candidate;
}

function cleanupTemporaryDirectory(label, path) {
  if (!path) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  runNpm(["run", "build"], { stdio: "inherit" });

  const dryRun = runNpm(["pack", "--dry-run", "--ignore-scripts", "--json"]);
  assertPackageListing(dryRun.stdout);

  packDirectory = mkdtempSync(join(tmpdir(), "jev-entropy-gate-pack-"));
  const packed = runNpm([
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    packDirectory
  ]);
  const reports = JSON.parse(packed.stdout);
  const report = Array.isArray(reports) ? reports[0] : reports;
  assertPackageListing(packed.stdout);
  const tarballPath = resolveTarball(report);

  temporaryPrefix = mkdtempSync(join(tmpdir(), "jev-entropy-gate-smoke-"));
  runNpm(["install", "--global", "--prefix", temporaryPrefix, tarballPath]);

  const globalBinDir = process.platform === "win32" ? temporaryPrefix : join(temporaryPrefix, "bin");
  const environment = {
    ...process.env,
    PATH: `${globalBinDir}${delimiter}${process.env.PATH ?? ""}`
  };
  const executable = resolveExecutable(environment);
  assertUnderPrefix(executable, temporaryPrefix);

  const help = process.platform === "win32"
    ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "jevg --help"], { env: environment })
    : run("jevg", ["--help"], { env: environment });
  if (!/^jev-entropy-gate$/m.test(help.stdout)) {
    throw new Error(`隔离安装的 jevg --help 输出异常：\n${help.stdout}`);
  }

  console.log(`tarball smoke test 通过：${executable}`);
} catch (error) {
  primaryError = error;
} finally {
  cleanupTemporaryDirectory("安装前缀", temporaryPrefix);
  cleanupTemporaryDirectory("打包临时目录", packDirectory);
}

if (primaryError) {
  console.error(`tarball smoke test 失败：${primaryError instanceof Error ? primaryError.message : String(primaryError)}`);
  if (cleanupErrors.length > 0) console.error(`清理也失败：${cleanupErrors.join("；")}`);
  process.exitCode = 1;
} else if (cleanupErrors.length > 0) {
  console.error(`tarball smoke test 清理失败：${cleanupErrors.join("；")}`);
  process.exitCode = 1;
}
