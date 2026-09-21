import { parseArgs } from "./cli.ts";
import { loadRule } from "./rules.ts";
import { scan } from "./scan.ts";
import { getJevApiKey } from "./config.ts";
import { renderTable } from "./report/table.ts";
import { toJson } from "./report/json.ts";
import { writeFile } from "node:fs/promises";

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const rule = await loadRule(args.rules);
    const apiKey = getJevApiKey();

    const result = await scan({
      rule,
      rootDir: args.dir,
      apiKey,
      concurrency: args.concurrency
    });

    process.stdout.write(renderTable(result) + "\n");

    if (args.out) {
      await writeFile(args.out, toJson(result), "utf8");
      process.stdout.write(`\n报告已写入 ${args.out}\n`);
    }

    return result.evaluated === 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(`错误：${(error as Error).message}\n`);
    return 1;
  }
}

// Only run main when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}