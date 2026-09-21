#!/usr/bin/env node
// jevg 命令入口。
// 项目源码是 TypeScript（import 用 .ts 后缀），用 Node 22.18+ 原生
// 的 --experimental-strip-types 直接跑，不打包不编译。
// 这里 spawn 一个子 Node 进程，把 --experimental-strip-types 传给真正的入口。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "index.ts");

const result = spawnSync(process.execPath, ["--experimental-strip-types", entry, ...process.argv.slice(2)], {
  stdio: "inherit"
});

if (result.error) {
  console.error(`jevg 运行失败：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 0);