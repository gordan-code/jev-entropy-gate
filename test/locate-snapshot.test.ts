import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ruleSchema } from "../src/rules.ts";
import { locate } from "../src/locate.ts";

const rule = ruleSchema.parse({
  id: "fetch",
  pattern: "fetch\\s*\\(",
  task: "迁移",
  engine: "regex"
});

test("locate 为候选点记录原始字节快照哈希，并跳过无效 UTF-8 文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-locate-"));
  try {
    const source = Buffer.from("fetch('/a')\nfetch('/b')\n", "utf8");
    await writeFile(join(dir, "good.ts"), source);
    await writeFile(join(dir, "bad.ts"), Buffer.from([0x66, 0x65, 0x74, 0x63, 0x68, 0x28, 0xff]));

    const result = await locate(dir, rule);
    const expectedHash = createHash("sha256").update(source).digest("hex");

    assert.equal(result.candidates.length, 2);
    assert.equal(expectedHash.length, 64);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.sourceHash),
      [expectedHash, expectedHash]
    );
    assert.equal(result.candidates.some((candidate) => candidate.file === "bad.ts"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("locate 保留 UTF-8 BOM，使候选 offset 与原始文本一致", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-locate-"));
  try {
    const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("fetch('/a')", "utf8")]);
    await writeFile(join(dir, "bom.ts"), source);

    const result = await locate(dir, rule);

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.offset, 1);
    assert.equal(result.candidates[0]!.column, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
