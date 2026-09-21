import { parseArgs, type Command } from "./cli.ts";
import { loadRule } from "./rules.ts";
import { scan } from "./scan.ts";
import { getJevApiKey } from "./config.ts";
import { renderTable } from "./report/table.ts";
import { toJson } from "./report/json.ts";
import { toHtml } from "./report/html.ts";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { appendVerdict, loadVerdicts } from "./calibration/record.ts";
import { calibrate } from "./calibration/calibrate.ts";
import { planRewrites, applyToContent } from "./apply.ts";

export async function main(argv: string[]): Promise<number> {
  try {
    const cmd = parseArgs(argv);
    switch (cmd.kind) {
      case "scan":
        return await runScan(cmd);
      case "apply":
        return await runApply(cmd);
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
    // 按扩展名决定输出格式：.html 出可视化报告，其余出 JSON。
    const isHtml = cmd.out.endsWith(".html") || cmd.out.endsWith(".htm");
    const content = isHtml ? toHtml(result) : toJson(result);
    await writeFile(cmd.out, content, "utf8");
    process.stdout.write(`\n报告已写入 ${cmd.out}\n`);
  }

  return result.evaluated === 0 ? 1 : 0;
}

async function runApply(cmd: Extract<Command, { kind: "apply" }>): Promise<number> {
  const rule = await loadRule(cmd.rules);
  if (!rule.replace) {
    process.stderr.write(`错误：规则 "${rule.id}" 没有 replace 字段，无法执行 apply\n`);
    return 1;
  }

  const apiKey = getJevApiKey();
  const result = await scan({
    rule,
    rootDir: cmd.dir,
    apiKey,
    concurrency: cmd.concurrency
  });

  // 只挑 auto 点，算出每个点的替换前后文本。
  const rewrites = planRewrites(result.sites, rule);
  if (rewrites.length === 0) {
    process.stdout.write(`没有 auto 点需要改写（共 ${result.evaluated} 个候选点）\n`);
    return 0;
  }

  // 按文件分组，方便一次读一个文件、统一替换。
  const byFile = new Map<string, typeof rewrites>();
  for (const r of rewrites) {
    const list = byFile.get(r.file) ?? [];
    list.push(r);
    byFile.set(r.file, list);
  }

  const root = resolve(cmd.dir);
  process.stdout.write(`apply · ${rule.id}\n将改写 ${rewrites.length} 处（涉及 ${byFile.size} 个文件）：\n\n`);

  for (const [file, fileRewrites] of byFile) {
    const abs = join(root, file);
    const content = await readFile(abs, "utf8");
    const newContent = applyToContent(content, fileRewrites);

    // 打印每一处改动，供人工核对。
    const sorted = [...fileRewrites].sort((a, b) => a.line - b.line);
    for (const r of sorted) {
      process.stdout.write(`  ${file}:${r.line}  ${r.before}  →  ${r.after}\n`);
    }

    if (cmd.write) {
      await writeFile(abs, newContent, "utf8");
    }
  }

  process.stdout.write(
    cmd.write
      ? `\n已写回 ${byFile.size} 个文件\n`
      : `\n预览模式，未写回文件；加 --write 才会真正修改\n`
  );
  return 0;
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
