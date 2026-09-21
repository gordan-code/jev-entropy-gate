import { test } from "node:test";
import assert from "node:assert/strict";
import { toSiteResult, resolveBand } from "../src/classify.ts";

const candidate = { file: "a.ts", line: 1, column: 1, offset: 0, snippet: "x", matched: "x" };

function response(
  choice: string,
  probs: Record<string, number>,
  noul: number,
  confidence = 0.9
) {
  return {
    model: "jev",
    answers: {
      rewrite_class: { type: "choice", choice, probabilities: probs, confidence },
      can_safely_automate: { type: "noul", noul }
    },
    usage: { input_tokens: 1, output_tokens: 1 }
  } as any;
}

// ---- toSiteResult end-to-end, using the three real demo data points ----

test("mechanical fetch (deterministic, low entropy) => auto", () => {
  const r = toSiteResult(
    candidate,
    response("deterministic", { deterministic: 0.89, judgment: 0.1, manual: 0.01 }, 0.77)
  );
  assert.equal(r.band, "auto");
});

test("contextual fetch (manual choice, medium entropy) => manual", () => {
  const r = toSiteResult(
    candidate,
    response("manual", { manual: 0.7, judgment: 0.22, deterministic: 0.08 }, 0.44)
  );
  assert.equal(r.band, "manual");
});

test("retry fetch (manual choice, high entropy) => manual", () => {
  const r = toSiteResult(
    candidate,
    response("manual", { manual: 0.52, judgment: 0.29, deterministic: 0.19 }, 0.57)
  );
  assert.equal(r.band, "manual");
});

// ---- resolveBand unit tests (choice-led synthesis) ----

test("choice sets the baseline", () => {
  // low entropy, no veto -> baseline holds for every choice
  assert.equal(resolveBand("deterministic", 0.3, 0.9), "auto");
  assert.equal(resolveBand("judgment", 0.3, 0.9), "assisted");
  assert.equal(resolveBand("manual", 0.3, 0.9), "manual");
});

test("high entropy demotes deterministic -> assisted", () => {
  assert.equal(resolveBand("deterministic", 0.7, 0.9), "assisted");
});

test("high entropy demotes judgment -> manual", () => {
  assert.equal(resolveBand("judgment", 0.7, 0.9), "manual");
});

test("high entropy cannot demote manual further", () => {
  assert.equal(resolveBand("manual", 0.95, 0.9), "manual");
});

test("noul safety fuse vetoes auto when very low", () => {
  assert.equal(resolveBand("deterministic", 0.3, 0.2), "assisted");
  assert.equal(resolveBand("deterministic", 0.3, 0.31), "auto");
});

test("unknown choice is treated conservatively as manual", () => {
  assert.equal(resolveBand("some_unexpected_value", 0.1, 0.9), "manual");
});
