import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * 规则的结构定义。规则负责"圈出候选改写点"和"定义怎么替换"。
 * 两个引擎：regex（文本匹配）和 ast-grep（语法感知匹配）。
 */
export const engineSchema = z.enum(["regex", "ast-grep"]);

export const ruleSchema = z
  .object({
    id: z.string().min(1).describe("规则唯一 id，用于报告。"),
    description: z.string().optional().describe("迁移目标的一句话说明。"),
    engine: engineSchema.default("regex").describe("匹配引擎：regex 或 ast-grep。"),
    pattern: z.string().min(1).describe("定位候选点的模式（regex 是正则，ast-grep 是 AST 模式）。"),
    language: z.string().optional().describe("源码语言，ast-grep 引擎用它选解析器（typescript/javascript 等）。"),
    context: z.number().int().min(0).max(20).default(3).describe("前后各保留几行上下文。"),
    task: z
      .string()
      .min(1)
      .describe("迁移目标和背景，喂给 Jev 的任务描述。"),
    replace: z
      .string()
      .optional()
      .describe('regex 引擎的替换映射，例如 "logger.$1("。只有 apply 命令会用到，scan 忽略它。'),
    fix: z
      .string()
      .optional()
      .describe('ast-grep 引擎的改写模板，例如 "apiClient($$$ARGS)"。metavariable 会被替换成匹配到的内容。'),
    include: z.array(z.string()).optional().describe("只扫描匹配这些 glob 的文件。"),
    exclude: z
      .array(z.string())
      .optional()
      .describe("跳过匹配这些 glob 的文件（比如 node_modules、dist）。")
  })
  .strict();

export type Rule = z.infer<typeof ruleSchema>;

export type RuleInput = z.input<typeof ruleSchema>;

/** 把规则里的 pattern 编译成正则（带全局标志），pattern 写错时抛出清晰的中文错误。 */
export function compilePattern(rule: Rule): RegExp {
  try {
    return new RegExp(rule.pattern, "g");
  } catch (error) {
    throw new Error(
      `规则 "${rule.id}" 的正则写错了：${(error as Error).message}`
    );
  }
}

/** 从 YAML（或 JSON）文件加载并校验规则。 */
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