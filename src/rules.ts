import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * The rule schema. A rule LOCATES candidate rewrite sites; it never rewrites.
 * v1 only supports the `regex` engine. `ast-grep` is a reserved v2 engine.
 */
export const engineSchema = z.enum(["regex"]);

export const ruleSchema = z
  .object({
    id: z.string().min(1).describe("Unique rule id, used in reports."),
    description: z.string().optional().describe("Human summary of the migration."),
    engine: engineSchema.default("regex").describe("Matching engine. v1: regex only."),
    pattern: z.string().min(1).describe("Regex pattern that locates candidate sites."),
    language: z.string().optional().describe("Source language, used only in reports."),
    context: z.number().int().min(0).max(20).default(3).describe("Lines of context on each side."),
    task: z
      .string()
      .min(1)
      .describe("Migration goal and background, fed to Jev as the task description."),
    include: z.array(z.string()).optional().describe("Glob patterns of files to scan."),
    exclude: z
      .array(z.string())
      .optional()
      .describe("Glob patterns of files to skip (notably node_modules, dist).")
  })
  .strict();

export type Rule = z.infer<typeof ruleSchema>;

export type RuleInput = z.input<typeof ruleSchema>;

/** Compile the regex once from a rule, throwing on an invalid pattern. */
export function compilePattern(rule: Rule): RegExp {
  try {
    return new RegExp(rule.pattern, "g");
  } catch (error) {
    throw new Error(
      `Rule "${rule.id}" has an invalid regex pattern: ${(error as Error).message}`
    );
  }
}

/** Load and validate a rule from a YAML (or JSON) file. */
export async function loadRule(path: string): Promise<Rule> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw) as unknown;
  const result = ruleSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`规则文件校验失败:\n${details}`);
  }
  return result.data;
}