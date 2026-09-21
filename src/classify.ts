import type { Candidate, SiteResult, EntropyBand } from "./types.ts";
import type { Rule } from "./rules.ts";
import { JevClient, type JevApiError } from "./jev/client.ts";
import type { JevChoiceAnswer, JevNoulAnswer, JevResponse } from "./jev/schema.ts";
import { normalizedEntropy } from "./entropy.ts";

/** The three rewrite_class choices (anchored on judgment, not correctness). */
export const REWRITE_CLASSES = {
  deterministic: "纯机械替换（改名/签名/导入路径变化），无需理解业务意图",
  judgment: "必须理解这段代码的意图或上下文才能改对",
  manual: "有歧义/副作用/错误处理或并发，机器改写不安全，必须人看"
} as const;

/**
 * Build the Jev state + questions for a single candidate site.
 * State = focused code snippet + task description (decision point #2).
 */
export function buildState(candidate: Candidate, rule: Rule): unknown {
  return {
    file: candidate.file,
    line: candidate.line,
    snippet: candidate.snippet,
    matched: candidate.matched,
    task: rule.task
  };
}

export function buildQuestions() {
  return {
    rewrite_class: {
      type: "choice",
      instructions: "按给定迁移任务改写这段代码，需要多少判断力？",
      criteria: REWRITE_CLASSES
    },
    can_safely_automate: {
      type: "noul",
      instructions: "这段代码按任务自动改写后，不需要人工复核的概率？"
    }
  };
}

/** Classify a single candidate into a SiteResult via one Jev call. */
export async function classifyCandidate(
  candidate: Candidate,
  rule: Rule,
  client: Pick<JevClient, "evaluate">
): Promise<SiteResult> {
  const response = await client.evaluate(buildState(candidate, rule), buildQuestions());
  return toSiteResult(candidate, response);
}

/** Pure transformation from a raw Jev response to a SiteResult (testable). */
export function toSiteResult(candidate: Candidate, response: JevResponse): SiteResult {
  const choice = response.answers["rewrite_class"];
  const noul = response.answers["can_safely_automate"];

  if (!choice || choice.type !== "choice") {
    throw new Error(`Jev omitted rewrite_class for ${candidate.file}:${candidate.line}.`);
  }
  if (!noul || noul.type !== "noul") {
    throw new Error(`Jev omitted can_safely_automate for ${candidate.file}:${candidate.line}.`);
  }

  const choiceAnswer = choice as JevChoiceAnswer;
  const noulAnswer = noul as JevNoulAnswer;

  const normEntropy = normalizedEntropy(choiceAnswer.probabilities);
  const automateConfidence = noulAnswer.noul;

  const band = resolveBand(choiceAnswer.choice, normEntropy, automateConfidence);

  return {
    candidate,
    probabilities: choiceAnswer.probabilities,
    choice: choiceAnswer.choice,
    entropy: round(normEntropy, 3),
    automateConfidence: round(automateConfidence, 3),
    band,
    confidence: round(choiceAnswer.confidence, 3)
  };
}

/** Baseline band for each rewrite_class choice. */
const CHOICE_BASELINE: Record<string, EntropyBand> = {
  deterministic: "auto",
  judgment: "assisted",
  manual: "manual"
};

/** Tunable thresholds used to synthesize the final band. */
export interface Thresholds {
  /** Entropy at or above this demotes the baseline one notch toward conservative. */
  highEntropy: number;
  /** Noul at or below this vetoes an `auto` (the safety fuse). */
  automateVeto: number;
}

/**
 * Default thresholds, chosen from the real-run entropy ladder: a confident
 * pick sits ~0.35, a hesitant pick ~0.71, a near-flat one ~0.92, so 0.65
 * cleanly separates "sure" from "unsure". These are starting points; the
 * `calibrate` command re-fits them from labeled flip feedback.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  highEntropy: 0.65,
  automateVeto: 0.3
};

/**
 * Final band synthesis. The signals play distinct roles:
 *
 *   1. `choice` (what Jev picked) sets the BASELINE:
 *        deterministic -> auto, judgment -> assisted, manual -> manual.
 *   2. `normalizedEntropy` CORRECTS: if Jev is itself unsure (high entropy),
 *      demote one notch toward conservative. Entropy tells us how much to
 *      TRUST the choice, not what the choice is.
 *   3. `automateConfidence` (the Noul) is a final SAFETY FUSE: only a very low
 *      value vetoes `auto`.
 *
 * Rationale (from real Jev runs): entropy alone loses the "which option won"
 * information. A flat-ish distribution whose winner is `manual` must still be
 * `manual`; a sharp distribution whose winner is `deterministic` should be
 * `auto`. Leading with `choice` and using entropy as a trust adjustment fixes
 * that, matching the observed 0.35/0.71/0.92 entropy ladder.
 */
export function resolveBand(
  choice: string,
  normalizedEntropy: number,
  automateConfidence: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS
): EntropyBand {
  // 1. Baseline from what Jev actually picked.
  let band: EntropyBand = CHOICE_BASELINE[choice] ?? "manual";

  // 2. Entropy correction: unsure Jev demotes one notch (never promotes).
  if (normalizedEntropy >= thresholds.highEntropy && band !== "manual") {
    band = demote(band);
  }

  // 3. Noul safety fuse: very low automate-confidence vetoes `auto`.
  if (band === "auto" && automateConfidence <= thresholds.automateVeto) {
    band = "assisted";
  }

  return band;
}

/** One notch toward conservative: auto -> assisted -> manual. */
function demote(band: EntropyBand): EntropyBand {
  return band === "auto" ? "assisted" : "manual";
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function isJevApiError(error: unknown): error is JevApiError {
  return error instanceof Error && error.name === "JevApiError";
}