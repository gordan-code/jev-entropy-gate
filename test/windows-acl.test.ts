import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { applyWindowsArtifactAcl, type WindowsAclRunner } from "../src/apply/windows-acl.ts";

interface FakeChild {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
  emit(event: string | symbol, ...args: unknown[]): boolean;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function successfulRunner(
  output: Buffer = Buffer.from("OK\r\n", "ascii"),
  errorOutput: Buffer = Buffer.alloc(0),
  code: number | null = 0
): { runner: WindowsAclRunner; child: FakeChild; call?: { command: string; args: readonly string[]; options: any } } {
  const child = fakeChild();
  let call: { command: string; args: readonly string[]; options: any } | undefined;
  const runner: WindowsAclRunner = (command, args, options) => {
    call = { command, args, options };
    queueMicrotask(() => {
      child.stdout.end(output);
      child.stderr.end(errorOutput);
      child.emit("close", code, null);
    });
    return child;
  };
  return { runner, child, get call() { return call; } } as unknown as {
    runner: WindowsAclRunner;
    child: FakeChild;
    call?: { command: string; args: readonly string[]; options: any };
  };
}

test("before-write starts powershell with a static encoded script and ACL environment", async () => {
  const harness = successfulRunner();
  await applyWindowsArtifactAcl("C:\\tmp\\artifact", "C:\\tmp\\target", "before-write", harness.runner);

  const call = harness.call!;
  assert.equal(call.command, "powershell.exe");
  assert.deepEqual(call.args.slice(0, 3), ["-NoLogo", "-NoProfile", "-NonInteractive"]);
  assert.equal(call.args[3], "-EncodedCommand");
  assert.match(call.args[4]!, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env.JEV_ACL_TARGET, "C:\\tmp\\target");
  assert.equal(call.options.env.JEV_ACL_ARTIFACT, "C:\\tmp\\artifact");
  assert.equal(call.options.env.JEV_ACL_PHASE, "before-write");
  assert.doesNotMatch(call.args.join("\0"), /C:\\tmp\\artifact|C:\\tmp\\target/);

  const script = Buffer.from(call.args[4]!, "base64").toString("utf16le");
  assert.match(script, /^\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(script, /Microsoft\.PowerShell\.Security\\Get-Acl/);
  assert.match(script, /Microsoft\.PowerShell\.Security\\Set-Acl/);
  assert.match(script, /GetSecurityDescriptorSddlForm/);
  assert.match(script, /JEV_ACL_PHASE/);
});

test("after-write succeeds with the same protocol and does not interpolate paths", async () => {
  const harness = successfulRunner(Buffer.from("OK\n", "ascii"));
  await applyWindowsArtifactAcl("C:\\path with spaces\\artifact", "C:\\path with spaces\\target", "after-write", harness.runner);
  assert.equal(harness.call!.options.env.JEV_ACL_PHASE, "after-write");
  assert.doesNotMatch(harness.call!.args.join("\0"), /path with spaces/);
});

test("rejects unknown phases before spawning", async () => {
  let calls = 0;
  const runner: WindowsAclRunner = () => {
    calls++;
    return fakeChild() as never;
  };
  await assert.rejects(
    applyWindowsArtifactAcl("artifact", "target", "unknown" as never, runner),
    /phase|阶段|unknown/i
  );
  assert.equal(calls, 0);
});

test("rejects nonzero exit and any stderr even with OK stdout", async () => {
  for (const [output, errorOutput, code] of [
    [Buffer.from("OK\r\n"), Buffer.alloc(0), 1],
    [Buffer.from("OK\r\n"), Buffer.from("warning\n"), 0]
  ] as const) {
    const harness = successfulRunner(output, errorOutput, code);
    await assert.rejects(
      applyWindowsArtifactAcl("artifact", "target", "after-write", harness.runner),
      /ACL|PowerShell|exit|stderr|失败|输出/i
    );
  }
});

test("accepts only exact OK line endings and rejects extra output", async () => {
  for (const output of [Buffer.from("OK\r\n"), Buffer.from("OK\n")]) {
    const harness = successfulRunner(output);
    await applyWindowsArtifactAcl("artifact", "target", "after-write", harness.runner);
  }
  for (const output of [Buffer.from("OK"), Buffer.from(" OK\r\n"), Buffer.from("OK\r\n\n"), Buffer.from([0xef, 0xbb, 0xbf, 0x4f, 0x4b, 0x0a])]) {
    const harness = successfulRunner(output);
    await assert.rejects(
      applyWindowsArtifactAcl("artifact", "target", "after-write", harness.runner),
      /ACL|PowerShell|输出|protocol|协议/i
    );
  }
});

test("rejects runner spawn errors including ENOENT", async () => {
  const runner: WindowsAclRunner = () => {
    const child = fakeChild();
    queueMicrotask(() => {
      const error = Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" });
      child.emit("error", error);
    });
    return child;
  };
  await assert.rejects(
    applyWindowsArtifactAcl("artifact", "target", "after-write", runner),
    /ENOENT|PowerShell|spawn|失败/i
  );
});

test("rejects and terminates a runner that exceeds the bounded timeout", async () => {
  const child = fakeChild();
  let killed = false;
  child.kill = () => {
    killed = true;
    return true;
  };
  const runner: WindowsAclRunner = () => child;
  await assert.rejects(
    applyWindowsArtifactAcl("artifact", "target", "after-write", runner),
    /timeout|超时|timed out/i
  );
  assert.equal(killed, true);
});

test("rejects output over the protocol collection limit", async () => {
  const child = fakeChild();
  const runner: WindowsAclRunner = () => {
    queueMicrotask(() => child.stdout.emit("data", Buffer.alloc(128 * 1024, 0x41)));
    return child;
  };
  await assert.rejects(
    applyWindowsArtifactAcl("artifact", "target", "after-write", runner),
    /output|输出|limit|限制/i
  );
});

test("real ACL copying and verification runs only on Windows", { skip: process.platform !== "win32" }, async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "jev-acl-"));
  const target = join(root, "target.txt");
  const artifact = join(root, "artifact.txt");
  try {
    await writeFile(target, "target\n", "utf8");
    await writeFile(artifact, Buffer.alloc(0));
    await applyWindowsArtifactAcl(artifact, target, "before-write");
    const targetSddl = await getOwnerAndAccessSddl(target);
    const artifactSddl = await getOwnerAndAccessSddl(artifact);
    assert.equal(artifactSddl, targetSddl);
    await writeFile(artifact, "artifact\n", "utf8");
    await applyWindowsArtifactAcl(artifact, target, "after-write");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function getOwnerAndAccessSddl(path: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$a=Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:P -ErrorAction Stop; $a.GetSecurityDescriptorSddlForm(([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access) )"],
      { windowsHide: true, env: windowsPowerShellTestEnv(path) },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}: ${stderr}`));
        else resolve(stdout.trim());
      }
    );
  });
}

function windowsPowerShellTestEnv(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, P: path };
  if (typeof env.PSModulePath === "string") {
    const compatible = env.PSModulePath.split(";").filter((entry) => !/powershell7/i.test(entry));
    if (compatible.length > 0) env.PSModulePath = compatible.join(";");
  }
  return env;
}
