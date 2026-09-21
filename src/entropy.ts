import type { EntropyBand } from "./types.ts";

/** Natural-log Shannon entropy of a probability distribution. */
export function entropy(probs: Record<string, number>): number {
  let h = 0;
  for (const p of Object.values(probs)) {
    if (p > 0) h -= p * Math.log(p);
  }
  return h;
}

/**
 * Normalized entropy in [0,1]. A flat distribution over N choices -> 1;
 * a degenerate distribution (one option at 1.0) -> 0.
 */
export function normalizedEntropy(probs: Record<string, number>): number {
  const keys = Object.keys(probs);
  if (keys.length <= 1) return 0;
  const maxH = Math.log(keys.length);
  if (maxH <= 0) return 0;
  const h = entropy(probs);
  const n = h / maxH;
  // Guard against tiny floating-point overshoots.
  return Math.min(1, Math.max(0, n));
}

export const BAND_LABELS: Record<EntropyBand, string> = {
  auto: "可全自动",
  assisted: "AI改+人复核",
  manual: "纯人工"
};