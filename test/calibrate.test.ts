import { test } from "node:test";
import assert from "node:assert/strict";
import { calibrate } from "../src/calibration/calibrate.ts";
import { appendVerdict, loadVerdicts } from "../src/calibration/record.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function v(choice: string, entropy: number, confidence: number, outcome: "ok" | "flipped") {
  return { choice, entropy, automateConfidence: confidence, outcome };
}

test("calibrate separates flipped (high entropy) from ok (low entropy)", () => {
  const verdicts = [
    v("deterministic", 0.35, 0.8, "ok"),
    v("deterministic", 0.40, 0.8, "ok"),
    v("deterministic", 0.45, 0.8, "ok"),
    v("deterministic", 0.70, 0.8, "flipped"),
    v("deterministic", 0.75, 0.8, "flipped")
  ];

  const r = calibrate(verdicts);

  // The fitted highEntropy must exclude the 0.70+ flipped sites from auto,
  // while keeping the <=0.45 ok sites auto.
  assert.equal(r.autoFlips, 0);
  assert.equal(r.autoOk, 3);
  assert.ok(r.thresholds.highEntropy > 0.45, `highEntropy=${r.thresholds.highEntropy}`);
  assert.ok(r.thresholds.highEntropy <= 0.70, `highEntropy=${r.thresholds.highEntropy}`);
});

test("empty verdicts return defaults and not improved", () => {
  const r = calibrate([]);
  assert.equal(r.total, 0);
  assert.equal(r.improved, false);
});

test("all-ok verdicts drive the most permissive (automate-maximizing) thresholds", () => {
  const verdicts = [
    v("deterministic", 0.8, 0.1, "ok"),
    v("deterministic", 0.9, 0.2, "ok")
  ];
  const r = calibrate(verdicts);
  assert.equal(r.autoFlips, 0);
  assert.equal(r.autoOk, 2);
});

test("a low-confidence auto flip pushes automateVeto up to catch it", () => {
  const verdicts = [
    v("deterministic", 0.3, 0.9, "ok"),
    // this site looks auto but flips; its automateConfidence is very low (0.1)
    v("deterministic", 0.3, 0.1, "flipped")
  ];
  const r = calibrate(verdicts);
  assert.equal(r.autoFlips, 0);
  assert.ok(r.thresholds.automateVeto >= 0.1, `automateVeto=${r.thresholds.automateVeto}`);
});

test("record round-trips through JSONL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-gate-"));
  const file = join(dir, "verdicts.jsonl");
  try {
    await appendVerdict(file, v("deterministic", 0.3, 0.8, "ok"));
    await appendVerdict(file, v("manual", 0.9, 0.4, "flipped"));

    const loaded = await loadVerdicts(file);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0]!.choice, "deterministic");
    assert.equal(loaded[1]!.outcome, "flipped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
