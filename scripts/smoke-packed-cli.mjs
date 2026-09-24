#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const validatorPath = join(rootDir, "scripts", "assert-package-files.mjs");
let temporaryPrefix;
let tarballPath;

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

function assertPackageListing(packOutput) {
  run(process.execPath, [validatorPath], { input: packOutput });
}

function assertUnderPrefix(path, prefix) {
  const resolvedPath = resolve(path);
  const resolvedPrefix = resolve(prefix);
  const comparisonPath = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  const comparisonPrefix = process.platform === "win32" ? resolvedPrefix.toLowerCase() : resolvedPrefix;
  const pathRelativeToPrefix = relative(comparisonPrefix, comparisonPath);
  if (pathRelativeToPrefix.startsWith(`..${sep}`) || pathRelativeToPrefix === ".." || pathRelativeToPrefix.includes(`..${sep}`)) {
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

try {
  const npmOptions = { shell: process.platform === "win32" };
  run(npmCommand, ["run", "build"], { ...npmOptions, stdio: "inherit" });

  const packed = run(npmCommand, ["pack", "--ignore-scripts", "--json"], npmOptions);
  assertPackageListing(packed.stdout);
  const reports = JSON.parse(packed.stdout);
  const report = Array.isArray(reports) ? reports[0] : reports;
  if (!report || typeof report.filename !== "string") throw new Error("npm pack JSON 缺少 tarball filename");
  tarballPath = resolve(rootDir, report.filename);

  temporaryPrefix = mkdtempSync(join(tmpdir(), "jev-entropy-gate-smoke-"));
  run(npmCommand, ["install", "--global", "--prefix", temporaryPrefix, tarballPath], npmOptions);

  const globalBinDir = process.platform === "win32" ? temporaryPrefix : join(temporaryPrefix, "bin");
  const environment = {
    ...process.env,
    PATH: `${globalBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`
  };
  const executable = resolveExecutable(environment);
  const checkedExecutable = assertUnderPrefix(executable, temporaryPrefix);
  const expectedExecutable = process.platform === "win32"
    ? [
      join(temporaryPrefix, "jevg.cmd"),
      join(temporaryPrefix, "jevg.ps1"),
      join(temporaryPrefix, "jevg")
    ]
    : join(temporaryPrefix, "bin", "jevg");
  const expectedExecutables = Array.isArray(expectedExecutable) ? expectedExecutable : [expectedExecutable];
  const normalizedExecutable = resolve(checkedExecutable).toLowerCase();
  if (!expectedExecutables.some((candidate) => normalizedExecutable === resolve(candidate).toLowerCase())) {
    throw new Error(`jevg 解析路径不是隔离前缀入口：${checkedExecutable}`);
  }

  const help = run(checkedExecutable, ["--help"], {
    env: environment,
    shell: process.platform === "win32"
  });
  if (!/^jev-entropy-gate$/m.test(help.stdout)) {
    throw new Error(`隔离安装的 jevg --help 输出异常：\n${help.stdout}`);
  }

  console.log(`tarball smoke test 通过：${checkedExecutable}`);
} finally {
  if (tarballPath) rmSync(tarballPath, { force: true });
  if (temporaryPrefix) rmSync(temporaryPrefix, { recursive: true, force: true });
}
