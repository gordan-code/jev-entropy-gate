import { resolveBand, DEFAULT_THRESHOLDS, type Thresholds } from "../classify.ts";
import type { CalibrationResult, Verdict } from "./types.ts";

/**
 * Re-fit the two thresholds from labeled flip feedback via grid search.
 *
 * Objective, in priority order:
 *   1. Minimize `autoFlips` — the number of sites we auto'd that later needed
 *      rework. A wrong auto is the expensive failure, so safety comes first.
 *   2. Maximize `autoOk` — among equally-safe thresholds, prefer the one that
 *      automates the most (fewer wasted human reviews).
 *
 * Both thresholds are swept on a coarse grid; the result is a good starting
 * point, not a proof that the model is calibrated.
 */
export function calibrate(verdicts: Verdict[]): CalibrationResult {
  if (verdicts.length === 0) {
    return {
      thresholds: { ...DEFAULT_THRESHOLDS },
      autoFlips: 0,
      autoOk: 0,
      total: 0,
      improved: false
    };
  }

  const highEntropyOptions = grid(0.3, 0.95, 0.05);
  const automateVetoOptions = grid(0.05, 0.7, 0.05);

  let best: CalibrationResult | null = null;

  for (const highEntropy of highEntropyOptions) {
    for (const automateVeto of automateVetoOptions) {
      const thresholds: Thresholds = { highEntropy, automateVeto };
      let autoFlips = 0;
      let autoOk = 0;

      for (const v of verdicts) {
        const band = resolveBand(v.choice, v.entropy, v.automateConfidence, thresholds);
        if (band === "auto") {
          if (v.outcome === "flipped") autoFlips++;
          else autoOk++;
        }
      }

      const candidate: CalibrationResult = {
        thresholds,
        autoFlips,
        autoOk,
        total: verdicts.length,
        improved: false
      };

      if (betterThan(candidate, best)) best = candidate;
    }
  }

  const result = best!;
  result.improved = betterThan(result, evaluateAt(DEFAULT_THRESHOLDS, verdicts));
  return result;
}

/** Evaluate a fixed threshold set against the verdicts. */
function evaluateAt(thresholds: Thresholds, verdicts: Verdict[]): CalibrationResult {
  let autoFlips = 0;
  let autoOk = 0;
  for (const v of verdicts) {
    const band = resolveBand(v.choice, v.entropy, v.automateConfidence, thresholds);
    if (band === "auto") {
      if (v.outcome === "flipped") autoFlips++;
      else autoOk++;
    }
  }
  return { thresholds: { ...thresholds }, autoFlips, autoOk, total: verdicts.length, improved: false };
}

/**
 * Ordering: fewer autoFlips wins; ties broken by more autoOk.
 * `null` is treated as "no candidate yet".
 */
function betterThan(a: CalibrationResult, b: CalibrationResult | null): boolean {
  if (b === null) return true;
  if (a.autoFlips !== b.autoFlips) return a.autoFlips < b.autoFlips;
  return a.autoOk > b.autoOk;
}

function grid(start: number, end: number, step: number): number[] {
  const out: number[] = [];
  for (let v = start; v <= end + 1e-9; v += step) {
    out.push(round(v, 2));
  }
  return out;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
