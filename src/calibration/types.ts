import type { Thresholds } from "../classify.ts";

/**
 * One labeled decision record. The `outcome` field is a HUMAN-provided
 * ground-truth label: did this site end up needing rework?
 */
export interface Verdict {
  /** The Jev choice (deterministic / judgment / manual). */
  choice: string;
  /** Normalized entropy in [0,1]. */
  entropy: number;
  /** Noul "automation is safe" probability in [0,1]. */
  automateConfidence: number;
  /**
   * Ground-truth label:
   *   - "ok"      : the decision held up (auto stayed fine, manual was needed).
   *   - "flipped" : the decision backfired — we auto'd it and it needed rework.
   */
  outcome: "ok" | "flipped";
  /** Optional provenance, for human audit. */
  file?: string;
  line?: number;
}

/** Result of re-fitting thresholds from labeled verdicts. */
export interface CalibrationResult {
  /** The fitted thresholds. */
  thresholds: Thresholds;
  /** How many `auto` decisions ended up flipping (the cost we minimize). */
  autoFlips: number;
  /** How many `auto` decisions held up. */
  autoOk: number;
  /** Total verdicts evaluated. */
  total: number;
  /** Whether the fitted thresholds beat the current defaults. */
  improved: boolean;
}
