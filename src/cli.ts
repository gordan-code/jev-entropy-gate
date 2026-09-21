export type Command =
  | { kind: "scan"; rules: string; dir: string; out?: string; concurrency?: number }
  | {
      kind: "apply";
      rules: string;
      dir: string;
      write: boolean;
      concurrency?: number;
    }
  | {
      kind: "record";
      data: string;
      choice: string;
      entropy: number;
      confidence: number;
      outcome: "ok" | "flipped";
    }
  | { kind: "calibrate"; data: string };

const HELP = `jev-entropy-gate
  用 Jev 的概率熵决定哪些迁移/重构点能安全自动化。

子命令:
  scan       扫描仓库，逐点判熵并分档
  apply      对判为 auto 的点执行改写（默认只预览，加 --write 才写回）
  record     追加一条带人工反馈的判定记录（用于自校准）
  calibrate  从反馈记录里重新拟合最优阈值

scan 用法:
  jev-entropy-gate scan --rules <rule.yaml> --dir <dir> [--out <file>] [--concurrency N]
    --rules <path>       规则文件（YAML）
    --dir <path>         要扫描的仓库目录
    --out <path>         将结构化 JSON 报告写到该文件（可选）
    --concurrency <n>    并发调用 Jev 的数量（默认 8）

apply 用法:
  jev-entropy-gate apply --rules <rule.yaml> --dir <dir> [--write] [--concurrency N]
    --rules <path>       规则文件（YAML，必须含 replace 字段）
    --dir <path>         要改写的仓库目录
    --write              真正写回文件；不加则只预览改动

record 用法:
  jev-entropy-gate record --data <verdicts.jsonl> --choice <c> --entropy <0-1> --confidence <0-1> --outcome <ok|flipped>
    --choice              Jev 选了什么（deterministic / judgment / manual）
    --entropy             归一化熵（0-1）
    --confidence          Noul 概率（0-1）
    --outcome             人工反馈：ok=没翻车，flipped=自动改错了

calibrate 用法:
  jev-entropy-gate calibrate --data <verdicts.jsonl>
    --data                判定反馈文件（JSONL，每行一条）
`;

export function parseArgs(argv: string[]): Command {
  const sub = argv[0];

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const args = argv.slice(1);
  if (sub === "scan") return parseScan(args);
  if (sub === "apply") return parseApply(args);
  if (sub === "record") return parseRecord(args);
  if (sub === "calibrate") return parseCalibrate(args);

  throw new Error(`未知子命令 "${sub}"（支持 scan / apply / record / calibrate）`);
}

function get(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}

function parseScan(args: string[]): Command {
  const rules = get(args, "--rules");
  const dir = get(args, "--dir");
  const out = get(args, "--out");
  const concurrencyRaw = get(args, "--concurrency");

  if (!rules) throw new Error("缺少 --rules <rule.yaml>");
  if (!dir) throw new Error("缺少 --dir <path>");

  const concurrency = parseConcurrency(concurrencyRaw);
  return { kind: "scan", rules, dir, out, concurrency };
}

function parseApply(args: string[]): Command {
  const rules = get(args, "--rules");
  const dir = get(args, "--dir");
  const write = args.includes("--write");
  const concurrencyRaw = get(args, "--concurrency");

  if (!rules) throw new Error("缺少 --rules <rule.yaml>");
  if (!dir) throw new Error("缺少 --dir <path>");

  const concurrency = parseConcurrency(concurrencyRaw);
  return { kind: "apply", rules, dir, write, concurrency };
}

function parseRecord(args: string[]): Command {
  const data = get(args, "--data");
  const choice = get(args, "--choice");
  const entropyRaw = get(args, "--entropy");
  const confidenceRaw = get(args, "--confidence");
  const outcome = get(args, "--outcome");

  if (!data) throw new Error("缺少 --data <verdicts.jsonl>");
  if (!choice) throw new Error("缺少 --choice <deterministic|judgment|manual>");
  if (entropyRaw === undefined) throw new Error("缺少 --entropy <0-1>");
  if (confidenceRaw === undefined) throw new Error("缺少 --confidence <0-1>");
  if (outcome !== "ok" && outcome !== "flipped") {
    throw new Error("--outcome 必须是 ok 或 flipped");
  }

  const entropy = Number(entropyRaw);
  const confidence = Number(confidenceRaw);
  if (!Number.isFinite(entropy) || entropy < 0 || entropy > 1) {
    throw new Error("--entropy 必须是 0-1 之间的数字");
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("--confidence 必须是 0-1 之间的数字");
  }

  return { kind: "record", data, choice, entropy, confidence, outcome };
}

function parseCalibrate(args: string[]): Command {
  const data = get(args, "--data");
  if (!data) throw new Error("缺少 --data <verdicts.jsonl>");
  return { kind: "calibrate", data };
}

function parseConcurrency(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("--concurrency 必须是正整数");
  }
  return n;
}
