/**
 * Global shared types for jev-entropy-gate.
 */

/** The three automation bands derived from Jev's probability entropy. */
export type EntropyBand = "auto" | "assisted" | "manual";

/** A single candidate rewrite site located by a matcher, before Jev evaluates it. */
export interface Candidate {
  /** Path relative to the scanned root, using forward slashes. */
  file: string;
  /** 1-based line number where the match begins. */
  line: number;
  /** 1-based column (character) where the match begins. */
  column: number;
  /** The matched line(s) plus surrounding context, as raw text. */
  snippet: string;
  /** The raw matched text (single line or the matched portion). */
  matched: string;
}

/** The result of Jev classifying one candidate site. */
export interface SiteResult {
  candidate: Candidate;
  /** Raw probability distribution over rewrite_class choices. */
  probabilities: Record<string, number>;
  /** Top choice key. */
  choice: string;
  /** Normalized entropy in [0, 1] over the choice distribution. */
  entropy: number;
  /** Noul probability that the site can be safely automated (0..1). */
  automateConfidence: number;
  /** Final band after cross-checking entropy against automate confidence. */
  band: EntropyBand;
  /** Overall Jev confidence for the choice answer (0..1), when reported. */
  confidence: number;
}

/** Aggregated scan output. */
export interface ScanResult {
  ruleId: string;
  ruleDescription: string;
  scannedAt: string;
  /** Total sites located by the matcher, before local prefiltering. */
  totalLocated: number;
  /** Sites removed by local prefiltering (comments, strings, etc.). */
  prefilteredOut: number;
  /** Sites actually sent to Jev. */
  evaluated: number;
  sites: SiteResult[];
  /** Summary counts per band. */
  summary: Record<EntropyBand, number>;
  /** Summary percentages per band (0..100, rounded). */
  summaryPct: Record<EntropyBand, number>;
}