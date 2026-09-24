import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));
const wrapperPath = join(testDir, "..", "bin", "jevg.mjs");
const packageJson = JSON.parse(
  readFileSync(join(testDir, "..", "package.json"), "utf8")
) as { scripts?: { test?: string } };

function runCli(...argv: string[]) {
  return spawnSync(process.execPath, [wrapperPath, ...argv], {
    encoding: "utf8"
  });
}

test("npm test builds the distribution before running subprocess checks", () => {
  assert.match(packageJson.scripts?.test ?? "", /^npm run build &&/);
});

test("CLI wrapper imports the built ESM entry and forwards its exit code", () => {
  const wrapper = readFileSync(wrapperPath, "utf8");

  assert.match(wrapper, /import\s*\{\s*main\s*\}\s*from\s*["']\.\.\/dist\/index\.js["']/);
  assert.match(wrapper, /main\(process\.argv\.slice\(2\)\)/);
  assert.match(wrapper, /process\.exitCode\s*=\s*code/);
  assert.doesNotMatch(wrapper, /src\/index\.ts/);
  assert.doesNotMatch(wrapper, /--experimental-strip-types/);
});

test("built CLI --help exits successfully and runs main only once", () => {
  const result = runCli("--help");

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /^jev-entropy-gate$/m);
  assert.equal((result.stdout.match(/^jev-entropy-gate$/gm) ?? []).length, 1);
  assert.equal(result.stderr, "");
});

test("built CLI forwards invalid-command failures and does not execute main twice", () => {
  const result = runCli("__invalid_command__");

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal((result.stderr.match(/错误：未知子命令/g) ?? []).length, 1);
});
