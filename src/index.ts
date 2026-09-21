import { parseArgs, type Command } from "./cli.ts";
import { loadRule } from "./rules.ts";
import { scan } from "./scan.ts";
import { getJevApiKey } from "./config.ts";
import { renderTable } from "./report/table.ts";
import { toJson } from "./report/json.ts";
import { writeFile } from "node:fs/promises";
import { appendVerdict, loadVerdicts } from "./calibration/record.ts";
import { calibrate } from "./calibration/calibrate.ts";

export async function main(argv: string[]): Promise<number> {
  try {
    const cmd = parseArgs(argv);
    switch (cmd.kind) {
      case "scan":
        return await runScan(cmd);
      case "record":
        return await runRecord(cmd);
      case "calibrate":
        return await runCalibrate(cmd);
    }
  } catch (error) {
    process.stderr.write(`错误：${(error as Error).message}\n`);
    return 1;
  }
}

async function runScan(cmd: Extract<Command, { kind: "scan" }>): Promise<number> {
  const rule = await loadRule(cmd.rules);
  const apiKey = getJevApiKey();

  const result = await scan({
    rule,
    rootDir: cmd.dir,
    apiKey,
    concurrency: cmd.concurrency
  });

  process.stdout.write(renderTable(result) + "\n");

  if (cmd.out) {
    await writeFile(cmd.out, toJson(result), "utf8");
    process.stdout.write(`\n报告已写入 ${cmd.out}\n`);
  }

  return result.evaluated === 0 ? 1 : 0;
}

async function runRecord(cmd: Extract<Command, { kind: "record" }>): Promise<number> {
  await appendVerdict(cmd.data, {
    choice: cmd.choice,
    entropy: cmd.entropy,
    automateConfidence: cmd.confidence,
    outcome: cmd.outcome
  });
  process.stdout.write(
    `已记录：choice=${cmd.choice} entropy=${cmd.entropy} confidence=${cmd.confidence} outcome=${cmd.outcome}\n`
  );
  return 0;
}

async function runCalibrate(cmd: Extract<Command, { kind: "calibrate" }>): Promise<number> {
  const verdicts = await loadVerdicts(cmd.data);
  if (verdicts.length === 0) {
    process.stdout.write(`没有读到判定记录（${cmd.data} 为空或不存在）\n`);
    return 1;
  }

  const result = calibrate(verdicts);

  process.stdout.write(
    `共 ${result.total} 条记录，拟合最优阈值：\n` +
      `  highEntropy   = ${result.thresholds.highEntropy}\n` +
      `  automateVeto  = ${result.thresholds.automateVeto}\n` +
      `  auto 翻车数   = ${result.autoFlips}\n` +
      `  auto 成功数   = ${result.autoOk}\n` +
      (result.improved
        ? `  结论：优于当前默认阈值，建议更新 classify.ts 的 DEFAULT_THRESHOLDS\n`
        : `  结论：当前默认阈值已是最优\n`)
  );
  return 0;
}

// Only run main when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
