import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, "..");
const workflowPath = join(packageRoot, ".github", "workflows", "ci.yml");
const dependabotPath = join(packageRoot, ".github", "dependabot.yml");
const smokeScriptPath = join(packageRoot, "scripts", "smoke-packed-cli.mjs");

test("CI runs only on push and pull_request with read-only contents permission", () => {
  const workflowText = readFileSync(workflowPath, "utf8");
  const workflow = parse(workflowText) as {
    on?: Record<string, unknown>;
    permissions?: { contents?: string };
  };

  assert.deepEqual(Object.keys(workflow.on ?? {}).sort(), ["pull_request", "push"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
});

test("CI covers the six supported runner labels at the minimum Node version", () => {
  const workflow = parse(readFileSync(workflowPath, "utf8")) as {
    jobs?: Record<string, {
      strategy?: { "fail-fast"?: boolean; matrix?: { os?: string[] } };
      "runs-on"?: string;
      "timeout-minutes"?: number;
      steps?: Array<{ uses?: string; with?: Record<string, unknown>; run?: string }>;
    }>;
  };
  const jobs = Object.values(workflow.jobs ?? {});
  assert.equal(jobs.length, 1);

  const [job] = jobs;
  assert.ok(job);
  assert.equal(job["runs-on"], "${{ matrix.os }}");
  assert.equal(job["timeout-minutes"], 30);
  assert.equal(job.strategy?.["fail-fast"], false);
  assert.deepEqual(job.strategy?.matrix?.os, [
    "windows-2025",
    "windows-11-arm",
    "ubuntu-24.04",
    "ubuntu-24.04-arm",
    "macos-15-intel",
    "macos-14"
  ]);

  const checkout = job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.ok(checkout, "CI must check out the repository");
  const setupNode = job.steps?.find((step) => step.uses?.startsWith("actions/setup-node@"));
  assert.ok(setupNode, "CI must configure Node.js");
  assert.equal(setupNode.with?.["node-version"], "22.18.0");
  assert.equal(setupNode.with?.cache, "npm");
});

test("CI pins every Action to the verified release SHA and disables checkout credentials", () => {
  const workflowText = readFileSync(workflowPath, "utf8");
  const actionReferences = [...workflowText.matchAll(/^\s+uses:\s*(\S+)(?:\s+#\s*(v\d+\.\d+\.\d+))?\s*$/gmi)]
    .map((match) => ({ reference: match[1], version: match[2] }));

  assert.deepEqual(
    actionReferences.map(({ reference }) => reference?.split("@")[0]),
    ["actions/checkout", "actions/setup-node"]
  );
  for (const { reference, version } of actionReferences) {
    assert.match(reference ?? "", /^actions\/(?:checkout|setup-node)@[0-9a-f]{40}$/i);
    assert.match(version ?? "", /^v\d+\.\d+\.\d+$/);
  }

  const workflow = parse(workflowText) as {
    jobs?: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
  };
  const checkout = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.ok(checkout, "CI must check out the repository");
  assert.equal(checkout.with?.["persist-credentials"], false);
});

test("Dependabot checks pinned GitHub Actions weekly", () => {
  const dependabot = parse(readFileSync(dependabotPath, "utf8")) as {
    version?: number;
    updates?: Array<{
      "package-ecosystem"?: string;
      directory?: string;
      schedule?: { interval?: string };
    }>;
  };

  assert.equal(dependabot.version, 2);
  assert.deepEqual(dependabot.updates, [{
    "package-ecosystem": "github-actions",
    directory: "/",
    schedule: { interval: "weekly" }
  }]);
});

test("CI steps stay in install, check, build, and smoke order", () => {
  const workflow = parse(readFileSync(workflowPath, "utf8")) as {
    jobs?: Record<string, { steps?: Array<{ uses?: string; run?: string }> }>;
  };
  const steps = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.uses ?? step.run ?? "");

  assert.equal(steps.length, 7);
  assert.match(steps[0] ?? "", /^actions\/checkout@[0-9a-f]{40}$/i);
  assert.match(steps[1] ?? "", /^actions\/setup-node@[0-9a-f]{40}$/i);
  assert.deepEqual(steps.slice(2), [
    "npm ci",
    "npm run typecheck",
    "npm test",
    "npm run build",
    "npm run package:smoke"
  ]);
});

test("CI installs, checks, builds, and package-smoke-tests without publishing", () => {
  const workflowText = readFileSync(workflowPath, "utf8");
  const workflow = parse(workflowText) as {
    jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
  };
  const runCommands = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run ?? "")
    .join("\n");

  for (const command of [
    "npm ci",
    "npm run typecheck",
    "npm test",
    "npm run build",
    "npm run package:smoke"
  ]) {
    assert.match(runCommands, new RegExp(`(?:^|\\n)\\s*${command.replaceAll(" ", "\\s+")}(?:\\s|$)`, "m"));
  }

  assert.doesNotMatch(workflowText, /\bnpm\s+publish\b/i);
  assert.doesNotMatch(workflowText, /(?:NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.)/i);
  assert.doesNotMatch(workflowText, /\brelease\b/i);
});

test("package smoke validates dry-run and actual tarball manifests", () => {
  const smokeScript = readFileSync(smokeScriptPath, "utf8");
  assert.match(smokeScript, /["']--dry-run["']/);
  assert.match(smokeScript, /["']--ignore-scripts["']/);
  assert.match(smokeScript, /["']--json["']/);
  assert.match(smokeScript, /assertPackageListing\(dryRun/);
  assert.match(smokeScript, /assertPackageListing\(packed/);
  assert.match(smokeScript, /--pack-destination/);
});
