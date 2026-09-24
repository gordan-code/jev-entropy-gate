import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
    await saveCache(path, { version: 2, ruleKey: "k", files: {} });
    const loaded = await loadCache(path);
    assert.equal(loaded!.version, 2);
    assert.equal(loaded!.ruleKey, "k");
    assert.deepEqual(loaded!.files, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadCache 拒绝没有版本号的旧缓存", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-cache-"));
  const path = join(dir, "cache.json");
  try {
    await writeFile(path, JSON.stringify({ ruleKey: "k", files: {} }), "utf8");
    assert.equal(await loadCache(path), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadCache 拒绝缺少 sourceHash 的缓存站点", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-cache-"));
  const path = join(dir, "cache.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        ruleKey: "k",
        files: {
          "a.ts": {
            hash: "file-hash",
            sites: [{ candidate: { file: "a.ts" } }]
          }
        }
      }),
      "utf8"
    );
    assert.equal(await loadCache(path), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadCache 拒绝结构损坏或哈希不一致的 v2 缓存", async () => {
  const validHash = "a".repeat(64);
  const invalidCases = [
    {
      name: "files 为数组",
      value: { version: 2, ruleKey: "k", files: [] }
    },
    {
      name: "文件哈希不是 64 位 hex",
      value: { version: 2, ruleKey: "k", files: { "a.ts": { hash: "not-a-hash", sites: [] } } }
    },
    {
      name: "站点 sourceHash 不是 64 位 hex",
      value: {
        version: 2,
        ruleKey: "k",
        files: {
          "a.ts": {
            hash: validHash,
            sites: [{ candidate: { sourceHash: "z".repeat(64) } }]
          }
        }
      }
    },
    {
      name: "站点缺少完整 SiteResult 字段",
      value: {
        version: 2,
        ruleKey: "k",
        files: {
          "a.ts": { hash: validHash, sites: [{ candidate: { sourceHash: validHash } }] }
        }
      }
    },
    {
      name: "站点 sourceHash 与文件哈希不同",
      value: {
        version: 2,
        ruleKey: "k",
        files: {
          "a.ts": {
            hash: validHash,
            sites: [{ candidate: { sourceHash: "b".repeat(64) } }]
          }
        }
      }
    }
  ];

  for (const invalidCase of invalidCases) {
    const dir = await mkdtemp(join(tmpdir(), "jev-cache-"));
    const path = join(dir, "cache.json");
    try {
      await writeFile(path, JSON.stringify(invalidCase.value), "utf8");
      assert.equal(await loadCache(path), undefined, invalidCase.name);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("loadCache 拒绝超出 [0,1] 的概率和判定值", async () => {
  const validHash = "a".repeat(64);
  const candidate = {
    file: "a.ts",
    sourceHash: validHash,
    line: 1,
    column: 1,
    offset: 0,
    snippet: "fetch('/a')",
    matched: "fetch("
  };
  const baseSite = {
    candidate,
    probabilities: { deterministic: 0.9, judgment: 0.05, manual: 0.05 },
    choice: "deterministic",
    entropy: 0.2,
    automateConfidence: 0.8,
    band: "auto",
    confidence: 0.9
  };
  const invalidCases = [
    ["概率大于 1", { ...baseSite, probabilities: { ...baseSite.probabilities, deterministic: 1.1 } }],
    ["entropy 大于 1", { ...baseSite, entropy: 1.1 }],
    ["automateConfidence 小于 0", { ...baseSite, automateConfidence: -0.1 }],
    ["confidence 大于 1", { ...baseSite, confidence: 1.1 }]
  ] as const;

  for (const [name, site] of invalidCases) {
    const dir = await mkdtemp(join(tmpdir(), "jev-cache-"));
    const path = join(dir, "cache.json");
    try {
      await writeFile(
        path,
        JSON.stringify({ version: 2, ruleKey: "k", files: { "a.ts": { hash: validHash, sites: [site] } } }),
        "utf8"
      );
      assert.equal(await loadCache(path), undefined, name);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    assert.equal(r1.sites.every((site) => site.candidate.sourceHash?.length === 64), true);
    const saved = JSON.parse(await readFile(cachePath, "utf8")) as any;
    const aSite = r1.sites.find((site) => site.candidate.file === "a.ts");
    assert.equal(saved.files["a.ts"].hash, aSite?.candidate.sourceHash);

    // 第二次扫描（文件没变）：两个点都复用，不再调 Jev。
    const r2 = await scan({ rule, rootDir: dir, apiKey: "k", cachePath, client: client as any });
    assert.equal(r2.evaluated, 2);
    assert.equal(r2.cacheStats!.reusedSites, 2);
    assert.equal(r2.cacheStats!.rejudgedSites, 0);
    assert.equal(client.calls, 2); // 没新增调用
    assert.equal(r2.sites.every((site) => site.candidate.sourceHash?.length === 64), true);
    assert.deepEqual(
      r2.sites.map((site) => site.candidate.sourceHash),
      r1.sites.map((site) => site.candidate.sourceHash)
    );

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

test("缓存站点身份变化时不复用旧判定", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-scan-"));
  try {
    await writeFile(join(dir, "a.ts"), "fetch('/a')", "utf8");
    const cachePath = join(dir, ".cache.json");
    const client = makeClient();

    await scan({ rule, rootDir: dir, apiKey: "k", cachePath, client: client as any });
    const saved = JSON.parse(await readFile(cachePath, "utf8")) as any;
    saved.files["a.ts"].sites[0].candidate.offset += 1;
    await writeFile(cachePath, JSON.stringify(saved), "utf8");

    const result = await scan({ rule, rootDir: dir, apiKey: "k", cachePath, client: client as any });
    assert.equal(result.cacheStats!.reusedSites, 0);
    assert.equal(result.cacheStats!.rejudgedSites, 1);
    assert.equal(client.calls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("身份匹配但判定值越界的缓存不复用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-scan-"));
  try {
    await writeFile(join(dir, "a.ts"), "fetch('/a')", "utf8");
    const cachePath = join(dir, ".cache.json");
    const client = makeClient();

    await scan({ rule, rootDir: dir, apiKey: "k", cachePath, client: client as any });
    const saved = JSON.parse(await readFile(cachePath, "utf8")) as any;
    const site = saved.files["a.ts"].sites[0];
    site.band = "auto";
    site.entropy = 99;
    site.automateConfidence = -1;
    await writeFile(cachePath, JSON.stringify(saved), "utf8");

    const result = await scan({ rule, rootDir: dir, apiKey: "k", cachePath, client: client as any });
    assert.equal(result.cacheStats!.reusedSites, 0);
    assert.equal(result.cacheStats!.rejudgedSites, 1);
    assert.equal(client.calls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("无缓存扫描也为站点保留 sourceHash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-scan-"));
  try {
    const source = Buffer.from("fetch('/a')", "utf8");
    await writeFile(join(dir, "a.ts"), source);
    const result = await scan({ rule, rootDir: dir, apiKey: "k", client: makeClient() as any });
    assert.equal(result.sites.length, 1);
    assert.equal(result.sites[0]!.candidate.sourceHash, computeFileHash(source));
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
