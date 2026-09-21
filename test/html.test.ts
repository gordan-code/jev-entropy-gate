import { test } from "node:test";
import assert from "node:assert/strict";
import { toHtml } from "../src/report/html.ts";
import type { ScanResult, SiteResult } from "../src/types.ts";

/** 造一个含两个点（一个 auto、一个 manual）的 ScanResult。 */
function scanResult(): ScanResult {
  const autoSite: SiteResult = {
    candidate: { file: "a<b>.ts", line: 1, column: 1, offset: 0, snippet: "", matched: "console.warn(" },
    probabilities: { deterministic: 0.9, judgment: 0.07, manual: 0.03 },
    choice: "deterministic",
    entropy: 0.33,
    automateConfidence: 0.8,
    band: "auto",
    confidence: 0.9
  };
  const manualSite: SiteResult = {
    candidate: { file: "b.ts", line: 2, column: 1, offset: 0, snippet: "", matched: "console.error(" },
    probabilities: { deterministic: 0.1, judgment: 0.2, manual: 0.7 },
    choice: "manual",
    entropy: 0.74,
    automateConfidence: 0.4,
    band: "manual",
    confidence: 0.5
  };
  return {
    ruleId: "console-to-logger",
    ruleDescription: "把裸 console 迁移到 logger",
    scannedAt: "2026-01-01T00:00:00Z",
    totalLocated: 2,
    prefilteredOut: 0,
    evaluated: 2,
    sites: [autoSite, manualSite],
    summary: { auto: 1, assisted: 0, manual: 1 },
    summaryPct: { auto: 50, assisted: 0, manual: 50 }
  };
}

test("toHtml 包含标题、档位标签和位置信息", () => {
  const html = toHtml(scanResult());
  assert.ok(html.includes("console-to-logger"));
  assert.ok(html.includes("可全自动"));
  assert.ok(html.includes("纯人工"));
  assert.ok(html.includes("a&lt;b&gt;.ts:1"));
});

test("toHtml 转义了文件名里的特殊字符", () => {
  const html = toHtml(scanResult());
  assert.ok(html.includes("a&lt;b&gt;.ts"));
  assert.ok(!html.includes("a<b>.ts"));
});

test("toHtml 是自包含的 HTML（有 DOCTYPE 和内联样式，不依赖外部资源）", () => {
  const html = toHtml(scanResult());
  assert.ok(html.trimStart().startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes("<style>"));
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("http"));
});
