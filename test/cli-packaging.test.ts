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
) as {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  repository?: { type?: string; url?: string };
  files?: string[];
  scripts?: {
    pretest?: string;
    test?: string;
    prepack?: string;
    "package:smoke"?: string;
  };
};

const packageRoot = join(testDir, "..");
const packageValidatorPath = join(packageRoot, "scripts", "assert-package-files.mjs");
const packageLock = readFileSync(join(packageRoot, "package-lock.json"), "utf8");

function runCli(...argv: string[]) {
  return spawnSync(process.execPath, [wrapperPath, ...argv], {
    encoding: "utf8",
    timeout: 10_000
  });
}

test("npm test builds the distribution before running subprocess checks", () => {
  assert.equal(packageJson.scripts?.pretest, "npm run build");
  assert.match(packageJson.scripts?.test ?? "", /^node --test /);
  assert.doesNotMatch(packageJson.scripts?.test ?? "", /&&/);
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

test("package metadata is publishable and keeps native runtime dependency exact", () => {
  assert.notEqual(packageJson.private, true);
  assert.equal(packageJson.name, "jev-entropy-gate");
  assert.equal(packageJson.version, "0.1.0");
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.engines?.node, ">=22.18.0");
  assert.equal(packageJson.dependencies?.["@ast-grep/napi"], "0.45.3");
  assert.equal(packageJson.dependencies?.yaml, undefined);
  assert.equal(packageJson.dependencies?.zod, undefined);
  assert.equal(packageJson.devDependencies?.yaml, "2.8.2");
  assert.equal(packageJson.devDependencies?.zod, "4.6.5");
  assert.equal(packageJson.repository?.type, "git");
  assert.match(packageJson.repository?.url ?? "", /github\.com\/gordan-code\/jev-entropy-gate/);
  assert.doesNotMatch(packageLock, /registry\.npmmirror\.com/);
  assert.match(packageLock, /https:\/\/registry\.npmjs\.org/);
});

test("package files field is an explicit publish allowlist", () => {
  assert.deepEqual(packageJson.files, [
    "bin/",
    "dist/",
    "README.md",
    "README.zh-CN.md",
    "LICENSE"
  ]);
  assert.equal(packageJson.scripts?.prepack, "npm run build");
  assert.equal(packageJson.scripts?.["package:smoke"], "node scripts/smoke-packed-cli.mjs");
});

function runPackageValidator(input: unknown) {
  return spawnSync(process.execPath, [packageValidatorPath], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 10_000
  });
}

test("package validator accepts only the intended npm entries", () => {
  const validListing = [
    {
      files: [
        { path: "package.json" },
        { path: "bin/jevg.mjs" },
        { path: "dist/index.js" },
        { path: "README.md" },
        { path: "README.zh-CN.md" },
        { path: "LICENSE" }
      ]
    }
  ];
  const accepted = runPackageValidator(validListing);

  assert.equal(accepted.error, undefined, accepted.error?.message);
  assert.equal(accepted.status, 0, accepted.stderr);

  const deniedPaths = [
    ".env",
    ".env.example",
    "helloagents/plan/task.md",
    "src/index.ts",
    "test/cli-packaging.test.ts",
    "reports/result.json",
    "tsconfig.json",
    "dist/index.js.map"
  ];
  for (const path of deniedPaths) {
    const rejected = runPackageValidator([
      { files: [{ path: "package.json" }, { path }] }
    ]);
    assert.notEqual(rejected.status, 0, `validator accepted ${path}`);
  }
});

test("package validation scripts exist and package smoke uses isolated installation", () => {
  const validator = readFileSync(packageValidatorPath, "utf8");
  const smokeScript = readFileSync(join(packageRoot, "scripts", "smoke-packed-cli.mjs"), "utf8");

  assert.match(validator, /process\.stdin/);
  assert.match(validator, /bin\//);
  assert.match(validator, /dist\//);
  assert.match(smokeScript, /finally/);
  assert.match(smokeScript, /--global/);
  assert.match(smokeScript, /--prefix/);
  assert.match(smokeScript, /--help/);
});
