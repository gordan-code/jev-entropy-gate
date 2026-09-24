import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  executeApply,
  prepareApply,
  type ApplyIO,
  type ExecuteResult,
  type PrepareResult
} from "../src/apply/transaction.ts";
import type { Rewrite } from "../src/apply.ts";
import { main } from "../src/index.ts";

function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function rewrite(file: string, source: Buffer | string, overrides: Partial<Rewrite> = {}): Rewrite {
  const text = Buffer.isBuffer(source) ? source.toString("utf8") : source;
  return {
    file,
    sourceHash: hash(source),
    offset: 0,
    before: text,
    after: text.toUpperCase(),
    line: 1,
    ...overrides
  };
}

function rejected(result: PrepareResult): Extract<PrepareResult, { ok: false }> {
  assert.equal(result.ok, false);
  return result as Extract<PrepareResult, { ok: false }>;
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "jev-apply-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("prepareApply returns all validated plans without creating staging files", async () => {
  await withTempRoot(async (root) => {
    const a = Buffer.from("alpha\n", "utf8");
    const b = Buffer.from("beta\n", "utf8");
    await writeFile(join(root, "a.txt"), a);
    await writeFile(join(root, "b.txt"), b);

    const result = await prepareApply(root, [rewrite("a.txt", a), rewrite("b.txt", b)]);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plans.length, 2);
    assert.deepEqual(result.plans.map((plan) => plan.file), ["a.txt", "b.txt"]);
    assert.deepEqual(result.plans[0]!.original, a);
    assert.deepEqual(result.plans[0]!.next, Buffer.from("ALPHA\n", "utf8"));
    assert.deepEqual(await readFile(join(root, "a.txt")), a);
    assert.deepEqual(await readFile(join(root, "b.txt")), b);
    assert.deepEqual(await readdir(root), ["a.txt", "b.txt"]);
  });
});

test("prepareApply rejects the whole batch when one unmatched file changed and leaves every file untouched", async () => {
  await withTempRoot(async (root) => {
    const a = Buffer.from("alpha\n", "utf8");
    const b = Buffer.from("beta\n", "utf8");
    await writeFile(join(root, "a.txt"), a);
    await writeFile(join(root, "b.txt"), b);

    const rewrites = [rewrite("a.txt", a), rewrite("b.txt", b)];
    await writeFile(join(root, "b.txt"), "beta changed\n", "utf8");
    const changed = await readFile(join(root, "b.txt"));

    const result = rejected(await prepareApply(root, rewrites));

    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.file, "b.txt");
    assert.match(result.errors[0]!.reason, /哈希|hash|变化|修改/i);
    assert.deepEqual(await readFile(join(root, "a.txt")), a);
    assert.deepEqual(await readFile(join(root, "b.txt")), changed);
  });
});

test("prepareApply aggregates independent errors from every affected file", async () => {
  await withTempRoot(async (root) => {
    const a = Buffer.from("alpha\n", "utf8");
    const b = Buffer.from("beta\n", "utf8");
    await writeFile(join(root, "a.txt"), a);
    await writeFile(join(root, "b.txt"), b);

    const result = rejected(
      await prepareApply(root, [
        rewrite("a.txt", a, { sourceHash: "0".repeat(64) }),
        rewrite("b.txt", b, { before: "zeta" })
      ])
    );

    assert.equal(result.errors.length, 2);
    assert.deepEqual(
      result.errors.map((error) => error.file).sort(),
      ["a.txt", "b.txt"]
    );
    assert.ok(result.errors.some((error) => /哈希|hash|变化|修改/i.test(error.reason)));
    assert.ok(result.errors.some((error) => /原文|before|不符|mismatch/i.test(error.reason)));
  });
});

test("prepareApply rejects a missing source hash", async () => {
  await withTempRoot(async (root) => {
    const source = Buffer.from("alpha\n", "utf8");
    await writeFile(join(root, "a.txt"), source);
    const candidate = rewrite("a.txt", source);
    delete candidate.sourceHash;

    const result = rejected(await prepareApply(root, [candidate]));

    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.file, "a.txt");
    assert.match(result.errors[0]!.reason, /sourceHash|哈希/i);
  });
});

test("prepareApply rejects inconsistent source hashes for candidates in one file", async () => {
  await withTempRoot(async (root) => {
    const source = Buffer.from("alpha beta\n", "utf8");
    await writeFile(join(root, "a.txt"), source);
    const first = rewrite("a.txt", source, { before: "alpha" });
    const second = rewrite("a.txt", source, {
      offset: source.toString("utf8").indexOf("beta"),
      before: "beta",
      sourceHash: "f".repeat(64)
    });

    const result = rejected(await prepareApply(root, [first, second]));

    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.file, "a.txt");
    assert.match(result.errors[0]!.reason, /sourceHash|哈希|一致/i);
  });
});

test("prepareApply rejects an invalid UTF-8 target without writing it", async () => {
  await withTempRoot(async (root) => {
    const source = Buffer.from([0x61, 0xff]);
    await writeFile(join(root, "bad.txt"), source);
    const result = rejected(
      await prepareApply(root, [rewrite("bad.txt", source, { before: "a�" })])
    );

    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.file, "bad.txt");
    assert.match(result.errors[0]!.reason, /UTF-8|utf-8|编码/i);
    assert.deepEqual(await readFile(join(root, "bad.txt")), source);
  });
});

test("prepareApply rejects a path outside the root", async () => {
  await withTempRoot(async (root) => {
    const outside = resolve(root, "..", "jev-apply-outside.txt");
    const source = Buffer.from("outside\n", "utf8");
    await writeFile(outside, source);
    try {
      const result = rejected(
        await prepareApply(root, [rewrite("../jev-apply-outside.txt", source)])
      );
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0]!.file, "../jev-apply-outside.txt");
      assert.match(result.errors[0]!.reason, /根目录|越界|outside|outside the root/i);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("prepareApply rejects a non-regular target", async () => {
  await withTempRoot(async (root) => {
    await mkdir(join(root, "folder"));
    const result = rejected(
      await prepareApply(root, [
        rewrite("folder", "", { sourceHash: hash(""), before: "", after: "x" })
      ])
    );

    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.file, "folder");
    assert.match(result.errors[0]!.reason, /普通文件|regular|目录|directory/i);
  });
});

test("prepareApply rejects a symlink root when the platform permits symlink creation", async (t) => {
  await withTempRoot(async (parent) => {
    const realRoot = join(parent, "real");
    const linkRoot = join(parent, "link");
    await mkdir(realRoot);
    const source = Buffer.from("alpha\n", "utf8");
    await writeFile(join(realRoot, "a.txt"), source);
    try {
      await symlink(realRoot, linkRoot, "junction");
    } catch (error) {
      t.skip(`平台拒绝创建 junction/symlink: ${(error as Error).message}`);
      return;
    }

    const result = rejected(await prepareApply(linkRoot, [rewrite("a.txt", source)]));
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.file, "a.txt");
    assert.match(result.errors[0]!.reason, /符号链接|symlink|junction|链接/i);
  });
});

test("prepareApply rejects a symlink target when the platform permits symlink creation", async (t) => {
  await withTempRoot(async (root) => {
    const outside = join(root, "outside.txt");
    const target = join(root, "link.txt");
    const source = Buffer.from("alpha\n", "utf8");
    await writeFile(outside, source);
    try {
      await symlink(outside, target, "file");
    } catch (error) {
      t.skip(`平台拒绝创建文件 symlink: ${(error as Error).message}`);
      return;
    }

    const result = rejected(await prepareApply(root, [rewrite("link.txt", source)]));
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.file, "link.txt");
    assert.match(result.errors[0]!.reason, /符号链接|symlink|junction|链接/i);
  });
});

test("CLI --write permits an empty regex replacement and deletes the target", async () => {
  await withTempRoot(async (root) => {
    const source = Buffer.from("fetch('/a')\n", "utf8");
    const target = join(root, "a.ts");
    const rulePath = join(root, "rule.yaml");
    await writeFile(target, source);
    await writeFile(
      rulePath,
      [
        "id: fetch-to-client",
        "pattern: fetch\\s*\\(",
        "replace: ''",
        "task: 迁移 fetch",
        "engine: regex",
        ""
      ].join("\n"),
      "utf8"
    );

    const previousKey = process.env.JEV_API_KEY;
    const previousFetch = globalThis.fetch;
    const stderr: string[] = [];
    const previousStderrWrite = process.stderr.write;
    process.env.JEV_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          model: "jev",
          answers: {
            rewrite_class: {
              type: "choice",
              choice: "deterministic",
              probabilities: { deterministic: 0.95, judgment: 0.04, manual: 0.01 },
              confidence: 0.95
            },
            can_safely_automate: { type: "noul", noul: 0.95 }
          },
          usage: { input_tokens: 1, output_tokens: 1 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      const code = await main(["apply", "--rules", rulePath, "--dir", root, "--write"]);
      assert.equal(code, 0);
      assert.equal(stderr.join(""), "");
      assert.deepEqual(await readFile(target, "utf8"), "'/a')\n");
    } finally {
      process.stderr.write = previousStderrWrite;
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = previousKey;
    }
  });
});

test(
  "Windows default CLI writes through the existing inode when ACLs can be copied",
  { skip: process.platform !== "win32" },
  async (t) => {
    if (!(await windowsPowerShellIsAvailable())) {
      t.skip("powershell.exe is unavailable; Windows ACL success path is not runnable");
      return;
    }
    await withTempRoot(async (root) => {
      const source = Buffer.from("fetch('/a')\n", "utf8");
      const target = join(root, "a.ts");
      const rulePath = join(root, "rule.yaml");
      await writeFile(target, source);
      await writeFile(
        rulePath,
        [
          "id: fetch-to-client",
          "pattern: fetch\\s*\\(",
          "replace: logger(",
          "task: 迁移 fetch",
          "engine: regex",
          ""
        ].join("\n"),
        "utf8"
      );

      const beforeIdentity = await lstat(target, { bigint: true });
      const beforeAcl = await readWindowsOwnerAndAccessSddl(target);
      const previousKey = process.env.JEV_API_KEY;
      const previousFetch = globalThis.fetch;
      const previousStderrWrite = process.stderr.write;
      const stderr: string[] = [];
      process.env.JEV_API_KEY = "test-key";
      globalThis.fetch = deterministicAutoFetch;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      }) as typeof process.stderr.write;

      try {
        const code = await main(["apply", "--rules", rulePath, "--dir", root, "--write"]);
        assert.equal(code, 0);
        assert.equal(stderr.join(""), "");
        assert.deepEqual(await readFile(target, "utf8"), "logger('/a')\n");

        const afterIdentity = await lstat(target, { bigint: true });
        assert.equal(afterIdentity.dev.toString(), beforeIdentity.dev.toString());
        assert.equal(afterIdentity.ino.toString(), beforeIdentity.ino.toString());
        assert.equal(await readWindowsOwnerAndAccessSddl(target), beforeAcl);
        assert.deepEqual((await readdir(root)).sort(), ["a.ts", "rule.yaml"]);
      } finally {
        process.stderr.write = previousStderrWrite;
        globalThis.fetch = previousFetch;
        if (previousKey === undefined) delete process.env.JEV_API_KEY;
        else process.env.JEV_API_KEY = previousKey;
      }
    });
  }
);

async function plansFor(root: string, files: Array<[string, string]>): Promise<Extract<PrepareResult, { ok: true }>['plans']> {
  const rewrites = [] as Rewrite[];
  for (const [file, source] of files) {
    const bytes = Buffer.from(source, "utf8");
    await writeFile(join(root, file), bytes);
    rewrites.push(rewrite(file, bytes));
  }
  const result = await prepareApply(root, rewrites);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected plans");
  return result.plans;
}

function errorResult(result: ExecuteResult): Extract<ExecuteResult, { ok: false }> {
  assert.equal(result.ok, false);
  return result as Extract<ExecuteResult, { ok: false }>;
}

function failingIO(base: ApplyIO, predicate: (path: string, flags: string | number) => boolean): ApplyIO {
  return {
    ...base,
    open: async (path, flags, mode) => {
      if (predicate(path, flags)) throw new Error(`injected open failure: ${path}`);
      return base.open(path, flags, mode);
    }
  };
}

test("executeApply commits two files and cleans staging and backups", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"], ["b.txt", "beta\n"]]);
    const result = await executeApply(plans, defaultApplyIOForTest());

    assert.equal(result.ok, true);
    assert.equal(result.status, "committed");
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "ALPHA\n");
    assert.deepEqual(await readFile(join(root, "b.txt"), "utf8"), "BETA\n");
    assert.deepEqual((await readdir(root)).sort(), ["a.txt", "b.txt"]);
  });
});

test("executeApply verifies each artifact before writing and after closing it", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    const events: string[] = [];
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        const handle = await base.open(path, flags, mode);
        if (flags === "wx") {
          const kind = path.endsWith(".jev-staged") ? "staged" : "backup";
          const originalWrite = handle.write.bind(handle);
          handle.write = async (data) => {
            events.push(`write:${kind}`);
            return originalWrite(data);
          };
          const originalClose = handle.close.bind(handle);
          handle.close = async () => {
            events.push(`close:${kind}`);
            return originalClose();
          };
        }
        return handle;
      },
      verifyArtifactSecurity: async (artifactPath, _targetPath, _targetMode, _requestedMode, phase) => {
        const kind = artifactPath.endsWith(".jev-staged") ? "staged" : "backup";
        const length = (await readFile(artifactPath)).byteLength;
        events.push(`${phase}:${kind}:${length}`);
        if (phase === "before-write") assert.equal(length, 0);
        else assert.ok(length > 0);
        return true;
      }
    };

    const result = await executeApply(plans, io);

    assert.equal(result.ok, true);
    assert.deepEqual(events, [
      "before-write:staged:0",
      "write:staged",
      "close:staged",
      "after-write:staged:6",
      "before-write:backup:0",
      "write:backup",
      "close:backup",
      "after-write:backup:6"
    ]);
  });
});

test("executeApply rejects a before-write security failure while the artifact is empty", async () => {
  await withTempRoot(async (root) => {
    const original = Buffer.from("alpha\n", "utf8");
    const plans = await plansFor(root, [["a.txt", original.toString("utf8")]]);
    const base = defaultApplyIOForTest();
    let observedLength = -1;
    const phases: Array<string | undefined> = [];
    const io: ApplyIO = {
      ...base,
      verifyArtifactSecurity: async (artifactPath, _targetPath, _targetMode, _requestedMode, phase) => {
        phases.push(phase);
        if (phase === "before-write") {
          observedLength = (await readFile(artifactPath)).byteLength;
          return false;
        }
        return true;
      }
    };

    const result = errorResult(await executeApply(plans, io));

    assert.equal(result.status, "prepare-failed");
    assert.deepEqual(phases, ["before-write"]);
    assert.equal(observedLength, 0);
    assert.deepEqual(await readFile(join(root, "a.txt")), original);
    assert.deepEqual(await readdir(root), ["a.txt"]);

    if (process.platform === "win32") {
      let openCalls = 0;
      const noVerifierIO: ApplyIO = {
        ...base,
        verifyArtifactSecurity: undefined,
        open: async (path, flags, mode) => {
          openCalls++;
          return base.open(path, flags, mode);
        }
      };
      const noVerifierResult = errorResult(await executeApply(plans, noVerifierIO));
      assert.equal(noVerifierResult.status, "prepare-failed");
      assert.equal(openCalls, 0);
      assert.match(noVerifierResult.errors[0]!.reason, /Windows ACL|私有性|verifier/i);
      assert.deepEqual(await readdir(root), ["a.txt"]);
    }
  });
});

test("executeApply cleans an artifact rejected by the after-write security phase", async () => {
  await withTempRoot(async (root) => {
    const original = Buffer.from("alpha\n", "utf8");
    const plans = await plansFor(root, [["a.txt", original.toString("utf8")]]);
    const base = defaultApplyIOForTest();
    const phases: Array<string | undefined> = [];
    const io: ApplyIO = {
      ...base,
      verifyArtifactSecurity: async (_artifactPath, _targetPath, _targetMode, _requestedMode, phase) => {
        phases.push(phase);
        return phase !== "after-write";
      }
    };

    const result = errorResult(await executeApply(plans, io));

    assert.equal(result.status, "prepare-failed");
    assert.deepEqual(phases, ["before-write", "after-write"]);
    assert.deepEqual(await readFile(join(root, "a.txt")), original);
    assert.deepEqual(await readdir(root), ["a.txt"]);
  });
});

test("executeApply marks an after-write residual as possibly containing source bytes", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    const io: ApplyIO = {
      ...base,
      verifyArtifactSecurity: async (_artifactPath, _targetPath, _targetMode, _requestedMode, phase) =>
        phase !== "after-write",
      unlink: async (path) => {
        throw new Error(`injected cleanup failure: ${path}`);
      }
    };

    const result = errorResult(await executeApply(plans, io));

    assert.equal(result.status, "prepare-failed");
    assert.ok(result.residuals.length > 0);
    assert.ok(result.residuals.every((residual) => /可能含源码/.test(residual.reason)));
    assert.ok(result.errors.some((error) => /可能含源码/.test(error.reason)));
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "alpha\n");
  });
});

test("executeApply refuses to write or delete an artifact whose path identity changed after before-write", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    let replaced = false;
    const phases: Array<string | undefined> = [];
    let stagedPath: string | undefined;
    const io: ApplyIO = {
      ...base,
      verifyArtifactSecurity: async (artifactPath, _targetPath, _targetMode, _requestedMode, phase) => {
        phases.push(phase);
        if (phase === "before-write" && !replaced) {
          replaced = true;
          stagedPath = artifactPath;
          await rm(artifactPath, { force: true });
          await writeFile(artifactPath, "external replacement\n", "utf8");
        }
        return true;
      }
    };

    const result = errorResult(await executeApply(plans, io));

    assert.equal(result.status, "prepare-failed");
    assert.deepEqual(phases, ["before-write"]);
    assert.ok(stagedPath);
    assert.ok(result.residuals.some((residual) => residual.stagedPath === stagedPath));
    assert.deepEqual(await readFile(stagedPath!, "utf8"), "external replacement\n");
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "alpha\n");
  });
});

test("executeApply staging failure leaves every target unchanged and cleans partial artifacts", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"], ["b.txt", "beta\n"]]);
    const before = await Promise.all(plans.map((plan) => readFile(plan.path)));
    const result = errorResult(
      await executeApply(plans, failingIO(defaultApplyIOForTest(), (path, flags) =>
        flags === "wx" && path.includes(`${join("", "b.txt")}.`) && path.endsWith(".jev-staged")
      ))
    );

    assert.equal(result.status, "prepare-failed");
    assert.deepEqual(await readFile(plans[0]!.path), before[0]);
    assert.deepEqual(await readFile(plans[1]!.path), before[1]);
    assert.deepEqual((await readdir(root)).sort(), ["a.txt", "b.txt"]);
  });
});

test("executeApply detects an external change before the second commit and restores only prior commits", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"], ["b.txt", "beta\n"]]);
    let openedTargets = 0;
    const base = defaultApplyIOForTest();
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        if (flags === "r+") {
          openedTargets++;
          if (openedTargets === 1) {
            await writeFile(join(root, "b.txt"), "externally changed\n", "utf8");
          }
        }
        return base.open(path, flags, mode);
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "commit-rolled-back");
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "alpha\n");
    assert.deepEqual(await readFile(join(root, "b.txt"), "utf8"), "externally changed\n");
    assert.deepEqual((await readdir(root)).sort(), ["a.txt", "b.txt"]);
  });
});

test("executeApply restores both files when the second write fails after truncation", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"], ["b.txt", "beta\n"]]);
    const base = defaultApplyIOForTest();
    let firstWrite = true;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        const handle = await base.open(path, flags, mode);
        if (flags === "r+" && path.endsWith("b.txt")) {
          const originalWrite = handle.write.bind(handle);
          handle.write = async (...args: Parameters<typeof handle.write>) => {
            const data = args[0];
            if (firstWrite && data instanceof Uint8Array) {
              const partial = data.subarray(0, Math.max(1, Math.floor(data.byteLength / 2)));
              await originalWrite(partial);
              firstWrite = false;
              throw new Error("injected partial write failure");
            }
            return originalWrite(...args);
          };
        }
        return handle;
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "commit-rolled-back");
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "alpha\n");
    assert.deepEqual(await readFile(join(root, "b.txt"), "utf8"), "beta\n");
    assert.deepEqual((await readdir(root)).sort(), ["a.txt", "b.txt"]);
  });
});

test("executeApply retains a backup and reports rollback-incomplete when recovery fails", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"], ["b.txt", "beta\n"]]);
    const base = defaultApplyIOForTest();
    let rollbackOpen = false;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        if (flags === "r+" && path.endsWith("b.txt")) {
          if (rollbackOpen) throw new Error("injected rollback failure");
          const handle = await base.open(path, flags, mode);
          const originalWrite = handle.write.bind(handle);
          handle.write = async (...args: Parameters<typeof handle.write>) => {
            const data = args[0];
            if (data instanceof Uint8Array) await originalWrite(data);
            throw new Error("injected commit failure");
          };
          rollbackOpen = true;
          return handle;
        }
        return base.open(path, flags, mode);
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "rollback-incomplete");
    assert.ok(result.residuals.some((residual) => residual.file === "b.txt"));
    const bResidual = result.residuals.find((residual) => residual.file === "b.txt")!;
    assert.ok(bResidual.backupPath);
    assert.ok(await readFile(bResidual.backupPath));
  });
});

test("executeApply reports a hash mismatch after recovery and preserves the backup", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"], ["b.txt", "beta\n"]]);
    const base = defaultApplyIOForTest();
    let firstSync = true;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        if (flags === "r+" && path.endsWith("b.txt")) {
          const handle = await base.open(path, flags, mode);
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            if (!firstSync) {
              await originalSync();
              await writeFile(path, "tampered during recovery\n", "utf8");
              return;
            }
            firstSync = false;
            throw new Error("injected commit failure");
          };
          return handle;
        }
        return base.open(path, flags, mode);
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "rollback-incomplete");
    assert.ok(result.residuals.some((residual) => residual.file === "b.txt"));
    const bResidual = result.residuals.find((residual) => residual.file === "b.txt")!;
    assert.ok(bResidual.backupPath);
    assert.ok(await readFile(bResidual.backupPath));
  });
});

test("CLI preview performs no writes and --write commits the same prepared changes", async () => {
  await withTempRoot(async (root) => {
    const source = Buffer.from("fetch('/a')\n", "utf8");
    const target = join(root, "a.ts");
    const rulePath = join(root, "rule.yaml");
    await writeFile(target, source);
    await writeFile(
      rulePath,
      [
        "id: fetch-to-client",
        "pattern: fetch\\s*\\(",
        "replace: logger(",
        "task: 迁移 fetch",
        "engine: regex",
        ""
      ].join("\n"),
      "utf8"
    );

    const previousKey = process.env.JEV_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.JEV_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          model: "jev",
          answers: {
            rewrite_class: {
              type: "choice",
              choice: "deterministic",
              probabilities: { deterministic: 0.95, judgment: 0.04, manual: 0.01 },
              confidence: 0.95
            },
            can_safely_automate: { type: "noul", noul: 0.95 }
          },
          usage: { input_tokens: 1, output_tokens: 1 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch;

    try {
      assert.equal(await main(["apply", "--rules", rulePath, "--dir", root]), 0);
      assert.deepEqual(await readFile(target), source);
      const writeCode = await main(["apply", "--rules", rulePath, "--dir", root, "--write"]);
      assert.equal(writeCode, 0);
      assert.deepEqual(await readFile(target, "utf8"), "logger('/a')\n");
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = previousKey;
    }
  });
});

test("CLI --write reports a per-file preflight failure and exits nonzero", async () => {
  await withTempRoot(async (root) => {
    const target = join(root, "a.ts");
    const rulePath = join(root, "rule.yaml");
    await writeFile(target, "fetch('/a')\n", "utf8");
    await writeFile(
      rulePath,
      [
        "id: fetch-to-client",
        "pattern: fetch\\s*\\(",
        "replace: logger(",
        "task: 迁移 fetch",
        "engine: regex",
        ""
      ].join("\n"),
      "utf8"
    );

    const previousKey = process.env.JEV_API_KEY;
    const previousFetch = globalThis.fetch;
    const previousStderrWrite = process.stderr.write;
    const stderr: string[] = [];
    process.env.JEV_API_KEY = "test-key";
    globalThis.fetch = (async () => {
      await writeFile(target, "externally changed\n", "utf8");
      return new Response(
        JSON.stringify({
          model: "jev",
          answers: {
            rewrite_class: {
              type: "choice",
              choice: "deterministic",
              probabilities: { deterministic: 0.95, judgment: 0.04, manual: 0.01 },
              confidence: 0.95
            },
            can_safely_automate: { type: "noul", noul: 0.95 }
          },
          usage: { input_tokens: 1, output_tokens: 1 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      const code = await main(["apply", "--rules", rulePath, "--dir", root, "--write"]);
      assert.equal(code, 1);
      assert.match(stderr.join(""), /a\.ts/);
      assert.match(stderr.join(""), /哈希|变化|修改/i);
      assert.deepEqual(await readFile(target, "utf8"), "externally changed\n");
    } finally {
      process.stderr.write = previousStderrWrite;
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = previousKey;
    }
  });
});

test("staged-byte precommit failure does not restore the current target over an external change", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"], ["b.txt", "beta\n"]]);
    const base = defaultApplyIOForTest();
    let bStagedReads = 0;
    const io: ApplyIO = {
      ...base,
      readFile: async (path) => {
        if (path.includes(".b.txt.") && path.endsWith(".jev-staged")) {
          bStagedReads++;
          if (bStagedReads === 2) {
            await writeFile(join(root, "b.txt"), "external change\n", "utf8");
            throw new Error("injected staged read failure");
          }
        }
        return base.readFile(path);
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "commit-rolled-back");
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "alpha\n");
    assert.deepEqual(await readFile(join(root, "b.txt"), "utf8"), "external change\n");
  });
});

test("executeApply rejects a symlinked ancestor before staging", async () => {
  await withTempRoot(async (root) => {
    const nested = join(root, "nested");
    await mkdir(nested);
    const plans = await plansFor(root, [["nested/a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    const io: ApplyIO = {
      ...base,
      lstat: async (path) => {
        const stats = await base.lstat(path);
        if (path === nested) {
          stats.isSymbolicLink = () => true;
        }
        return stats;
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "prepare-failed");
    assert.match(result.errors[0]!.reason, /符号链接|symlink|junction|链接/i);
    assert.deepEqual(await readFile(join(nested, "a.txt"), "utf8"), "alpha\n");
  });
});

test("executeApply rechecks every ancestor before each commit", async () => {
  await withTempRoot(async (root) => {
    const nested = join(root, "nested");
    await mkdir(nested);
    const plans = await plansFor(root, [["nested/a.txt", "alpha\n"], ["nested/b.txt", "beta\n"]]);
    const base = defaultApplyIOForTest();
    let ancestorChanged = false;
    let rejectNextAncestorCheck = true;
    const io: ApplyIO = {
      ...base,
      lstat: async (path) => {
        const stats = await base.lstat(path);
        if (path === nested && ancestorChanged && rejectNextAncestorCheck) {
          rejectNextAncestorCheck = false;
          stats.isSymbolicLink = () => true;
        }
        return stats;
      },
      open: async (path, flags, mode) => {
        const handle = await base.open(path, flags, mode);
        if (flags === "r+" && path.endsWith("a.txt")) ancestorChanged = true;
        return handle;
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "commit-rolled-back");
    assert.match(result.errors[0]!.reason, /符号链接|symlink|junction|链接/i);
    assert.deepEqual(await readFile(join(nested, "a.txt"), "utf8"), "alpha\n");
    assert.deepEqual(await readFile(join(nested, "b.txt"), "utf8"), "beta\n");
  });
});

test("executeApply rejects staged or backup permissions wider than the target", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    let io: ApplyIO;
    io = {
      ...base,
      verifyArtifactSecurity: async (artifactPath, _targetPath, targetMode, requestedMode) => {
        // Read through the injected IO so this test exercises the same
        // permission observation path as production, rather than bypassing
        // the fake widened mode below with base.lstat().
        const artifactStat = await io.lstat(artifactPath);
        const actual = Number(artifactStat.mode) & 0o777;
        const target = targetMode & 0o777;
        const requested = requestedMode & 0o777;
        return (actual & ~target) === 0 && (actual & ~requested) === 0;
      },
      lstat: async (path) => {
        const stats = await base.lstat(path);
        if (path.includes(".a.txt.") && (path.endsWith(".jev-staged") || path.endsWith(".jev-backup"))) {
          const originalMode = Number(stats.mode);
          Object.defineProperty(stats, "mode", {
            configurable: true,
            value: BigInt(originalMode | 0o077)
          });
        }
        return stats;
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "prepare-failed");
    assert.match(result.errors[0]!.reason, /权限|permission|私有|mode/i);
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "alpha\n");
  });
});

test("executeApply reports an uncertain artifact when wx open creates then throws", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    let createdPath: string | undefined;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        if (flags === "wx" && createdPath === undefined) {
          const handle = await base.open(path, flags, mode);
          createdPath = path;
          await handle.close();
          throw new Error("injected wx failure after create");
        }
        return base.open(path, flags, mode);
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "prepare-failed");
    assert.ok(createdPath);
    assert.ok(result.residuals.some((residual) => residual.stagedPath === createdPath));
    assert.deepEqual(await readFile(createdPath!), Buffer.alloc(0));
  });
});

test("executeApply preserves a replacement after wx open creates then throws", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    let createdPath: string | undefined;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        if (flags === "wx" && createdPath === undefined) {
          const handle = await base.open(path, flags, mode);
          createdPath = path;
          await handle.close();
          await rm(path, { force: true });
          await writeFile(path, "external after wx failure\n", "utf8");
          throw new Error("injected wx failure after external replacement");
        }
        return base.open(path, flags, mode);
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "prepare-failed");
    assert.ok(createdPath);
    assert.ok(result.residuals.some((residual) => residual.stagedPath === createdPath));
    assert.deepEqual(await readFile(createdPath!, "utf8"), "external after wx failure\n");
  });
});

test("executeApply does not claim a replacement made after artifact close", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    let stagedPath: string | undefined;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        const handle = await base.open(path, flags, mode);
        if (flags === "wx" && stagedPath === undefined) {
          stagedPath = path;
          const originalClose = handle.close.bind(handle);
          handle.close = async () => {
            const result = await originalClose();
            await rm(path, { force: true });
            await writeFile(path, "replacement after close\n", "utf8");
            return result;
          };
        }
        return handle;
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "prepare-failed");
    assert.ok(stagedPath);
    assert.ok(result.residuals.some((residual) => residual.stagedPath === stagedPath));
    assert.deepEqual(await readFile(stagedPath!, "utf8"), "replacement after close\n");
  });
});

test("executeApply does not claim a backup replacement made after artifact close", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    let backupPath: string | undefined;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        const handle = await base.open(path, flags, mode);
        if (flags === "wx" && path.endsWith(".jev-backup")) {
          backupPath = path;
          const originalClose = handle.close.bind(handle);
          handle.close = async () => {
            const result = await originalClose();
            await rm(path, { force: true });
            await writeFile(path, "replacement backup after close\n", "utf8");
            return result;
          };
        }
        return handle;
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "prepare-failed");
    assert.ok(backupPath);
    assert.ok(result.residuals.some((residual) => residual.backupPath === backupPath));
    assert.deepEqual(await readFile(backupPath!, "utf8"), "replacement backup after close\n");
  });
});

test("executeApply does not delete an existing file when wx reports EEXIST", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    let collisionPath: string | undefined;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        if (flags === "wx" && collisionPath === undefined) {
          collisionPath = path;
          await writeFile(path, "someone else's artifact\n", "utf8");
          const error = new Error("injected EEXIST") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        }
        return base.open(path, flags, mode);
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "prepare-failed");
    assert.ok(collisionPath);
    assert.deepEqual(await readFile(collisionPath!, "utf8"), "someone else's artifact\n");
  });
});

test("executeApply refuses to truncate a replacement inode after opening r+", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"], ["b.txt", "beta\n"]]);
    const base = defaultApplyIOForTest();
    let replaced = false;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        if (flags === "r+" && path.endsWith("b.txt") && !replaced) {
          replaced = true;
          await rm(path, { force: true });
          await writeFile(path, "replacement\n", "utf8");
        }
        return base.open(path, flags, mode);
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "rollback-incomplete");
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "alpha\n");
    assert.deepEqual(await readFile(join(root, "b.txt"), "utf8"), "replacement\n");
    const bResidual = result.residuals.find((residual) => residual.file === "b.txt");
    assert.ok(bResidual);
    assert.ok(await readFile(bResidual!.backupPath));
  });
});

test("executeApply rejects a fake successful write with no bytesWritten", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    let injected = false;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        const handle = await base.open(path, flags, mode);
        if (flags === "wx" && !injected) {
          injected = true;
          const originalWrite = handle.write.bind(handle);
          handle.write = async (data) => {
            await originalWrite(data);
            return undefined;
          };
        }
        return handle;
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "prepare-failed");
    assert.match(result.errors[0]!.reason, /bytesWritten|写入返回|写入/i);
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "alpha\n");
  });
});

test("executeApply rejects a write reporting more bytes than requested", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    let injected = false;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        const handle = await base.open(path, flags, mode);
        if (flags === "wx" && !injected) {
          injected = true;
          const originalWrite = handle.write.bind(handle);
          handle.write = async (data) => {
            const result = await originalWrite(data);
            return {
              ...(result as { buffer: Uint8Array }),
              bytesWritten: data.byteLength + 1
            };
          };
        }
        return handle;
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "prepare-failed");
    assert.match(result.errors[0]!.reason, /bytesWritten|写入返回|写入/i);
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "alpha\n");
  });
});

test("executeApply rejects an empty write that reports zero bytes", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    let injected = false;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        const handle = await base.open(path, flags, mode);
        if (flags === "wx" && !injected) {
          injected = true;
          handle.write = async (data) => ({ bytesWritten: 0, buffer: data });
        }
        return handle;
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "prepare-failed");
    assert.match(result.errors[0]!.reason, /bytesWritten|写入返回|写入/i);
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "alpha\n");
  });
});

test("executeApply completes a staged write reported in valid short chunks", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    let injected = false;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        const handle = await base.open(path, flags, mode);
        if (flags === "wx" && !injected) {
          injected = true;
          const originalWrite = handle.write.bind(handle);
          handle.write = async (data) => {
            const chunk = data.subarray(0, Math.max(1, Math.floor(data.byteLength / 2)));
            const result = await originalWrite(chunk);
            return { ...(result as { buffer: Uint8Array }), bytesWritten: chunk.byteLength };
          };
        }
        return handle;
      }
    };

    const result = await executeApply(plans, io);
    assert.equal(result.ok, true);
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "ALPHA\n");
  });
});

test("executeApply verifies target bytes after commit and rolls back a mismatched write", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"], ["b.txt", "beta\n"]]);
    const base = defaultApplyIOForTest();
    let injected = false;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        const handle = await base.open(path, flags, mode);
        if (flags === "r+" && path.endsWith("b.txt") && !injected) {
          injected = true;
          const originalWrite = handle.write.bind(handle);
          handle.write = async (data) => {
            await originalWrite(Buffer.from("XXXXX", "utf8"));
            return { bytesWritten: data.byteLength, buffer: data };
          };
        }
        return handle;
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "commit-rolled-back");
    assert.deepEqual(result.committedFiles, ["a.txt"]);
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "alpha\n");
    assert.deepEqual(await readFile(join(root, "b.txt"), "utf8"), "beta\n");
  });
});

test("cleanup refuses to unlink a staged artifact whose inode was replaced", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    let stagedPath: string | undefined;
    let replaced = false;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        const handle = await base.open(path, flags, mode);
        if (flags === "wx" && stagedPath === undefined) stagedPath = path;
        if (flags === "r+") {
          const originalClose = handle.close.bind(handle);
          handle.close = async () => {
            const result = await originalClose();
            if (!replaced && stagedPath) {
              replaced = true;
              await rm(stagedPath, { force: true });
              await writeFile(stagedPath, "replacement artifact\n", "utf8");
            }
            return result;
          };
        }
        return handle;
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "cleanup-incomplete");
    assert.ok(stagedPath);
    assert.ok(result.residuals.some((residual) => residual.stagedPath === stagedPath));
    assert.deepEqual(await readFile(stagedPath!, "utf8"), "replacement artifact\n");
  });
});

test("cleanup refuses to unlink a backup artifact whose inode was replaced", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const base = defaultApplyIOForTest();
    let backupPath: string | undefined;
    let replaced = false;
    const io: ApplyIO = {
      ...base,
      open: async (path, flags, mode) => {
        if (flags === "wx" && path.endsWith(".jev-backup")) backupPath = path;
        const handle = await base.open(path, flags, mode);
        if (flags === "r+") {
          const originalClose = handle.close.bind(handle);
          handle.close = async () => {
            const result = await originalClose();
            if (!replaced && backupPath) {
              replaced = true;
              await rm(backupPath, { force: true });
              await writeFile(backupPath, "replacement backup\n", "utf8");
            }
            return result;
          };
        }
        return handle;
      }
    };

    const result = errorResult(await executeApply(plans, io));
    assert.equal(result.status, "cleanup-incomplete");
    assert.ok(backupPath);
    assert.ok(result.residuals.some((residual) => residual.backupPath === backupPath));
    assert.deepEqual(await readFile(backupPath!, "utf8"), "replacement backup\n");
  });
});

test("executeApply rejects a directly constructed plan without rootDir", async () => {
  await withTempRoot(async (root) => {
    const plans = await plansFor(root, [["a.txt", "alpha\n"]]);
    const directPlan = { ...plans[0]! };
    const result = errorResult(await executeApply([directPlan], defaultApplyIOForTest()));

    assert.equal(result.status, "prepare-failed");
    assert.match(result.errors[0]!.reason, /rootDir|根目录|边界/i);
    assert.deepEqual(await readFile(join(root, "a.txt"), "utf8"), "alpha\n");
    assert.deepEqual(await readdir(root), ["a.txt"]);
  });
});

function defaultApplyIOForTest(): ApplyIO {
  return {
    readFile: async (path) => readFile(path),
    lstat: async (path) => (await import("node:fs/promises")).lstat(path, { bigint: true }),
    open: async (path, flags, mode) => {
      const handle = await (await import("node:fs/promises")).open(path, flags, mode);
      return {
        write: (data: Uint8Array) => handle.write(data),
        truncate: (length?: number) => handle.truncate(length),
        sync: () => handle.sync(),
        stat: () => handle.stat({ bigint: true }),
        close: () => handle.close()
      };
    },
    unlink: async (path) => (await import("node:fs/promises")).unlink(path),
    verifyArtifactSecurity: async () => true
  };
}

function deterministicAutoFetch(): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        model: "jev",
        answers: {
          rewrite_class: {
            type: "choice",
            choice: "deterministic",
            probabilities: { deterministic: 0.95, judgment: 0.04, manual: 0.01 },
            confidence: 0.95
          },
          can_safely_automate: { type: "noul", noul: 0.95 }
        },
        usage: { input_tokens: 1, output_tokens: 1 }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
}

async function readWindowsOwnerAndAccessSddl(path: string): Promise<string> {
  const command =
    "$a=Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:JEV_TEST_ACL_PATH -ErrorAction Stop; " +
    "$sections=[System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access; " +
    "[Console]::Out.Write($a.GetSecurityDescriptorSddlForm($sections))";
  const env: NodeJS.ProcessEnv = { ...process.env, JEV_TEST_ACL_PATH: path };
  if (typeof env.PSModulePath === "string") {
    const compatible = env.PSModulePath.split(";").filter((entry) => !/powershell7/i.test(entry));
    if (compatible.length > 0) env.PSModulePath = compatible.join(";");
  }
  return await new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, env },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`读取 Windows ACL 失败: ${error.message}: ${stderr}`));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function windowsPowerShellIsAvailable(): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
      { windowsHide: true },
      (error) => {
        if (error === null) {
          resolve(true);
          return;
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve(false);
          return;
        }
        reject(error);
      }
    );
  });
}
