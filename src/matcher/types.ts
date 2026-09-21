import type { Candidate } from "../types.ts";
import type { Rule } from "../rules.ts";

/**
 * A Matcher locates candidate rewrite sites for a given file.
 * This is the extension point that lets us add an `ast-grep` engine later
 * without changing the scan pipeline (decision point #1, option C).
 */
export interface Matcher {
  /** Engine name this matcher is registered under. */
  readonly engine: string;
  /**
   * Return all candidate sites in `content` for the given `filePath`.
   * Implementations must return line/column positions and enough matched text
   * for the prefilter and the Jev state builder.
   */
  findCandidates(filePath: string, content: string, rule: Rule): Candidate[];
}