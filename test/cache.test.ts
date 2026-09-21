import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ruleSchema } from "../src/rules.ts";
import { scan } from "../src/scan.ts";
import { computeRuleKey, computeFileHash, loadCache, saveCache } from "../src/cache.ts";

const rule = ruleSchema.parse({
  id: "fetch",
  pattern: "fetch\\s*\\(",
  task: "迁移",
  engine: "regex"
});

/** 造一个 mock 的 Jev 客户端，统计 evaluate 调用次数，返回固定的判定。 */
function makeClient() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async evaluate() {
      calls++;
      return {
        model: "jev",
        answers: {
          rewrite_class: {
            type: "choice",
            choice: "deterministic",
            probabilities: { deterministic: 0.9, judgment: 0.05, manual: 0.05 },
            confidence: 0.9
          },
          can_safely_automate: { type: "noul", noul: 0.8 }
        },
        usage: { input_tokens: 1, output_tokens: 1 }
      };
    }
  };
}

test("computeRuleKey 随规则的 pattern 变化", () => {
  const r1 = ruleSchema.parse({ id: "a", pattern: "x", task: "t" });
  const r2 = ruleSchema.parse({ id: "a", pattern: "y", task: "t" });
  assert.notEqual(computeRuleKey(r1), computeRuleKey(r2));
});

test("computeFileHash 随内容变化，相同内容哈希相同", () => {
  assert.notEqual(computeFileHash("a"), computeFileHash("b"));
  assert.equal(computeFileHash("a"), computeFileHash("a"));
});

test("loadCache/saveCache 往返", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-cache-"));
  const path = join(dir, "cache.json");
  try {
    await saveCache(path, { ruleKey: "k", files: {} });
    const loaded = await loadCache(path);
    assert.equal(loaded!.ruleKey, "k");
    assert.deepEqual(loaded!.files, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadCache 对损坏的文件返回 undefined", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-cache-"));
  const path = join(dir, "cache.json");
  try {
    await writeFile(path, "not json {", "utf8");
    assert.equal(await loadCache(path), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("增量扫描：文件没变时复用缓存，文件变了才重判", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-scan-"));
  try {
    await writeFile(join(dir, "a.ts"), "fetch('/a')", "utf8");
    await writeFile(join(dir, "b.ts"), "fetch('/b')", "utf8");
    const cachePath = join(dir, ".cache.json");

    const client = makeClient();

    // 第一次扫描：两个点都重判。
    const r1 = await scan({ rule, rootDir: dir, apiKey: "k", cachePath, client: client as any });
    assert.equal(r1.evaluated, 2);
    assert.equal(r1.cacheStats!.reusedSites, 0);
    assert.equal(r1.cacheStats!.rejudgedSites, 2);
    assert.equal(client.calls, 2);

    // 第二次扫描（文件没变）：两个点都复用，不再调 Jev。
    const r2 = await scan({ rule, rootDir: dir, apiKey: "k", cachePath, client: client as any });
    assert.equal(r2.evaluated, 2);
    assert.equal(r2.cacheStats!.reusedSites, 2);
    assert.equal(r2.cacheStats!.rejudgedSites, 0);
    assert.equal(client.calls, 2); // 没新增调用

    // 改一个文件：只有它重判，另一个复用。
    await writeFile(join(dir, "a.ts"), "fetch('/changed')", "utf8");
    const r3 = await scan({ rule, rootDir: dir, apiKey: "k", cachePath, client: client as any });
    assert.equal(r3.evaluated, 2);
    assert.equal(r3.cacheStats!.reusedSites, 1);
    assert.equal(r3.cacheStats!.rejudgedSites, 1);
    assert.equal(client.calls, 3); // 只多一次调用
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("规则变了（pattern 改），缓存失效，全部重判", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-scan-"));
  try {
    await writeFile(join(dir, "a.ts"), "fetch('/a')", "utf8");
    const cachePath = join(dir, ".cache.json");

    const client = makeClient();
    await scan({ rule, rootDir: dir, apiKey: "k", cachePath, client: client as any });

    // 换个规则（pattern 不同），同一个文件也要重判。
    const rule2 = ruleSchema.parse({ id: "fetch", pattern: "fetch\\(('/[^']*')", task: "迁移", engine: "regex" });
    const r2 = await scan({ rule: rule2, rootDir: dir, apiKey: "k", cachePath, client: client as any });
    assert.equal(r2.cacheStats!.reusedSites, 0);
    assert.equal(r2.cacheStats!.rejudgedSites, 1);
    assert.equal(client.calls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
