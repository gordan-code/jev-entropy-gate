import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * 规则的结构定义。规则只负责"圈出候选改写点"，不负责改写。
 * v1 只支持 regex 引擎，ast-grep 留给 v2。
 */
export const engineSchema = z.enum(["regex"]);

export const ruleSchema = z
  .object({
    id: z.string().min(1).describe("规则唯一 id，用于报告。"),
    description: z.string().optional().describe("迁移目标的一句话说明。"),
    engine: engineSchema.default("regex").describe("匹配引擎，v1 只有 regex。"),
    pattern: z.string().min(1).describe("定位候选点的正则表达式。"),
    language: z.string().optional().describe("源码语言，只用于报告展示。"),
    context: z.number().int().min(0).max(20).default(3).describe("前后各保留几行上下文。"),
    task: z
      .string()
      .min(1)
      .describe("迁移目标和背景，喂给 Jev 的任务描述。"),
    replace: z
      .string()
      .optional()
      .describe('替换映射，例如 "logger.$1("。只有 apply 命令会用到，scan 忽略它。'),
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