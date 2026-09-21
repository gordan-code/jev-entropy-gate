export interface ParsedArgs {
  rules: string;
  dir: string;
  out?: string;
  concurrency?: number;
}

const HELP = `jev-entropy-gate scan
  用 Jev 的概率熵决定哪些迁移/重构点能安全自动化。

用法:
  jev-entropy-gate scan --rules <rule.yaml> --dir <dir> [--out <file>] [--concurrency N]

参数:
  --rules <path>       规则文件（YAML）
  --dir <path>         要扫描的仓库目录
  --out <path>         将结构化 JSON 报告写到该文件（可选）
  --concurrency <n>    并发调用 Jev 的数量（默认 8）
  --help               显示帮助
`;

export function parseArgs(argv: string[]): ParsedArgs {
  // argv[0] is the subcommand "scan" when invoked as `... scan ...`.
  const rest = argv[0] === "scan" ? argv.slice(1) : argv;

  if (rest.length === 0 || rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const get = (flag: string): string | undefined => {
    const i = rest.indexOf(flag);
    if (i < 0) return undefined;
    return rest[i + 1];
  };

  const rules = get("--rules");
  const dir = get("--dir");
  const out = get("--out");
  const concurrencyRaw = get("--concurrency");

  if (!rules) throw new Error("缺少 --rules <rule.yaml>");
  if (!dir) throw new Error("缺少 --dir <path>");

  const concurrency = concurrencyRaw ? Number(concurrencyRaw) : undefined;
  if (concurrency !== undefined && (!Number.isFinite(concurrency) || concurrency < 1)) {
    throw new Error("--concurrency 必须是正整数");
  }

  return { rules, dir, out, concurrency };
}