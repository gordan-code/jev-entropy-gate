# jev-entropy-gate

[English](./README.md) | 中文

用 Jev 的概率熵，判断一批代码迁移/重构点里，哪些可以放心自动改，哪些要人来判断。

## 它解决什么问题

做大规模代码迁移（比如把 `fetch` 全换成 `apiClient`、把 `console.error` 换成统一的 `logger`）时，候选改动点通常分三类：

- 大部分是机械替换，闭着眼睛改都不会错；
- 少部分需要理解上下文才能改对；
- 极少数改错了会出事（错误处理、并发和边界情况）。

用 LLM 去逐个判断太慢太贵，用正则脚本一把梭又容易在"需要理解"的那部分翻车。

这个工具的做法，把每个候选点丢给 Jev，让它回答"改这里需要多少判断力"，再用概率分布的**熵**（有多确定）把候选点分成三档：

| 概率分布 | 熵 | 结果 |
|---|---|---|
| `{0.98, 0.01, 0.01}` | 低，很确定 | auto，自动改 |
| `{0.60, 0.30, 0.10}` | 中，有倾向但犹豫 | assisted，AI 改 + 人复核 |
| `{0.34, 0.33, 0.33}` | 高，拿不准 | manual，人来改 |

## 它是什么、不是什么

`jev-entropy-gate` 是一个命令行工具，四个子命令：

- `scan`：扫描仓库，逐点问 Jev，输出分档结果；
- `apply`：对 auto 点执行改写；
- `record` / `calibrate`：记录翻车反馈，回头校准判定阈值。

先说清楚它不做什么。

- **它不调 coding agent，也不调 LLM 来改写代码。** 唯一一次模型调用是 `scan` 里的 Jev，而且 Jev 只做判断，不产代码。`apply` 的改写就是规则里写好的替换（`console.warn(` 换成 `logger.warn(`），纯字符串或 AST 操作，没有模型参与。
- **它不是质量打分器。** 它问的是"改这里要不要人判断"，不是"这段代码好不好"。
- **regex 引擎做不了结构化改写。** 正则只能做文本替换；要 AST 级别的改写（比如保持嵌套参数不变），用 ast-grep 引擎。

## 安装和快速开始

需要 Node.js 22.18.0 以上（公开发布的 CLI 运行已构建的 JavaScript 产物）。

可以从 npm 安装全局命令 `jevg`，开发时也可以直接跑源码脚本。

### 装成命令行（推荐）

从 npm 安装公开发布的包：

```bash
npm install --global jev-entropy-gate
```

先确认命令可用，再从任意目录执行：

```bash
jevg --help
```

如果是在源码仓库中本地开发，可以安装当前目录：

```bash
npm install -g .
# 或者开发时用软链接，改代码即时生效：
# npm link
```

之后任何目录都能用 `jevg`：

```bash
export JEV_API_KEY="..."   # 从 https://console.typesafe.ai/ 获取

jevg scan --rules rules.yaml --dir /path/to/repo --out report.json
jevg apply --rules rules.yaml --dir /path/to/repo --write
jevg record --data verdicts.jsonl --choice deterministic --entropy 0.7 --confidence 0.8 --outcome flipped
jevg calibrate --data verdicts.jsonl
```

### 直接跑源码脚本

不装全局也行，用 Node 原生 TS 支持直接跑：

```bash
export JEV_API_KEY="..."

npm install
node --experimental-strip-types src/index.ts scan \
  --rules examples/migrate.fetch-to-apiclient.yaml \
  --dir examples/demo-project \
  --out report.json
```

`--out` 的扩展名决定输出格式：`.html` 出可视化报告（自包含单文件，浏览器打开），`.json` 出结构化数据。

终端输出长这样：

```
fetch-to-apiclient · 把原生 fetch 升级到 apiClient 封装
找到 6 个候选点，粗过滤后 4 个（丢弃 2 个）

┌──────────────────────────────┬────────┬──────────┬──────────────┐
│ location                     │ 档位   │ 置信度    │ 处置          │
├──────────────────────────────┼────────┼──────────┼──────────────┤
│ src/users.ts:9               │ auto   │ 0.95     │ 可全自动      │
│ src/users.ts:16              │ assisted│ 0.71    │ AI改+人复核   │
│ src/users.ts:24              │ manual │ 0.55     │ 纯人工        │
└──────────────────────────────┴────────┴──────────┴──────────────┘

汇总：可全自动 40% · AI改+人复核 40% · 纯人工 20%
```

## 规则文件格式

规则负责圈出候选点（`pattern`），以及定义怎么替换。两个引擎：

**regex 引擎**（默认），用正则圈点 + 正则替换：

```yaml
id: fetch-to-apiclient
description: 把原生 fetch 升级到 apiClient 封装
engine: regex
pattern: "fetch\\s*\\("
replace: "apiClient("         # 可选，apply 用它做替换
context: 3                    # 匹配点前后各保留几行，喂给 Jev
task: |                       # 迁移目标，喂给 Jev
  把所有原生 fetch(...) 升级到团队的 apiClient 封装，语义保持不变。
```

`replace` 支持正则的 capture group。比如 `pattern: "console\\.(log|warn|error)\\("` 配 `replace: "logger.$1("`，会把 `console.warn(` 变成 `logger.warn(`。

**ast-grep 引擎**，用 AST 模式圈点 + metavariable 改写。AST 模式是语法感知的，不会匹配到字符串或注释里的假点：

```yaml
id: fetch-to-apiclient-ast
description: 用 ast-grep 把原生 fetch 升级到 apiClient 封装
engine: ast-grep
language: typescript            # 支持 typescript/javascript/tsx/jsx/css/html
pattern: "fetch($$$ARGS)"       # AST 模式，$$$ARGS 是"零或多个节点"的 metavariable
fix: "apiClient($$$ARGS)"       # 结构化改写，metavariable 会被替换成匹配到的内容
context: 3
task: |
  把所有原生 fetch(...) 升级到团队的 apiClient 封装，语义保持不变。
```

ast-grep 的 `$NAME` 匹配单个节点，`$$$NAME` 匹配零或多个节点。`fix` 里的 metavariable 会被替换成匹配到的原文，所以 `fetch("/a", { method: "POST" })` 会变成 `apiClient("/a", { method: "POST" })`，参数原样保留。这是正则做不到的——正则的 capture group 无法平衡匹配嵌套括号。

## 四个命令

### scan

扫描仓库，逐点问 Jev，输出分档。这是其它命令的基础。

```bash
node --experimental-strip-types src/index.ts scan \
  --rules rules.yaml --dir /path/to/repo --out report.json
```

加 `--cache <file>` 开启增量扫描：内容没变的文件直接复用上次判定，不重新问 Jev，省调用。规则或阈值变了，缓存会自动失效，全部重判。

```bash
node --experimental-strip-types src/index.ts scan \
  --rules rules.yaml --dir /path/to/repo --cache .jev-cache.json
```

第二次跑同一个仓库时，输出末尾会多一行「缓存：复用 N 处，重判 M 处」。

### apply

对 auto 点执行改写。先跑一遍 scan：`regex` 引擎使用规则的 `replace` 字段，`ast-grep` 引擎使用规则的 `fix` 字段。默认只预览，加 `--write` 才真正写回。

```bash
# 预览，不写文件
node --experimental-strip-types src/index.ts apply \
  --rules rules.yaml --dir /path/to/repo

# 真正写回
node --experimental-strip-types src/index.ts apply \
  --rules rules.yaml --dir /path/to/repo --write
```

只改 auto 点，assisted 和 manual 一律不动；替换是预先写在规则里的字符串/AST 操作，不涉及模型。

#### apply 的安全边界与失败处理

每次 `apply` 都会先做一次只读的完整预检，然后才打印改写计划或触碰目标文件。预检会确认目标是所选根目录内的普通文件，根目录到目标的路径中没有符号链接或 junction；同时检查严格 UTF-8、扫描时记录的 SHA-256 快照、每个改写位置的原文以及区间冲突。所有受影响文件作为一整批检查：任意一个文件失败，整批拒绝，目标文件字节保持不变。预览和 `--write` 使用同一套预检；预览不会创建暂存或备份文件。

`--write` 通过预检后，事务会：

1. 在每个目标文件所在目录创建不可预测名称的暂存文件和原始字节备份；
2. 校验两个产物的字节内容及权限/安全约束；
3. 按稳定的路径顺序，通过打开原目标 inode（`r+`）写入并同步；
4. 每次提交前再次检查目标路径、文件身份和原始字节。

准备阶段有两个不同的失败边界。`prepareApply` 可能拒绝只读预检；这发生在 `executeApply` 之前，报告为预检失败且不写目标文件。如果 `executeApply` 已进入事务准备，但无法准备暂存/备份产物或无法通过权限/安全校验，才返回 `prepare-failed`；此时目标文件也尚未写入，但如果部分产物的清理无法确认，仍会报告残留路径。

准备完成后，提交失败分两种路径。如果路径/源文件/暂存文件的复核在**打开当前目标之前**失败，当前目标尚未被触碰，只回滚此前已经提交的目标。打开当前目标句柄后、首次写入前的 identity check 是另一道非破坏性保护：如果它失败，当前目标不恢复，只回滚此前已提交的目标，并保留当前目标的 backup。只有 `io.open()` 本身、`truncate`、`write`、`sync`、`close` 或提交后哈希检查等可能已经改动当前目标字节的失败，才会把当前目标与此前目标一起纳入恢复；恢复后会核对原始 SHA-256。只有恢复和产物清理都完成时才是 `commit-rolled-back`；恢复或清理有残留时返回非零的不完整结果。即使内容提交成功，只要清理有残留，也会报告 `cleanup-incomplete`，不会当成成功。

只有当本次创建的每个产物都已经不存在，或其身份仍与本次记录的身份一致且成功 unlink，才算清理完成。身份变化或 unlink 失败都会留下并报告路径。产物位于目标文件所在目录，名称类似 `.<basename>.<uuid>.jev-staged` 和 `.<basename>.<uuid>.jev-backup`。保留下来的 backup 只是恢复材料，不是自动可信输入：人工恢复前必须核对产物身份，并确认 SHA-256 与预期原始字节一致。

**Windows ACL 处理：** 当存在实际要写入的 auto 改写时，默认 CLI 已接入 Windows ACL verifier。任何源码字节写入前，它会把目标文件的 Owner+Access 安全描述符（SDDL）复制到空的暂存/备份产物并逐一核对；每个产物写入并关闭后还会再次核验。提交仍通过原目标 inode 写入，因此目标文件的身份和 ACL 保持不变。PowerShell 不可用、ACL 复制/核验失败、描述符不匹配，或 PowerShell stdout/stderr 出现非预期输出，都会在目标写入前以 `prepare-failed` fail-closed。`verifyArtifactSecurity` 仍是内部 `ApplyIO` 扩展点，不是 CLI 参数。只读预览仍可运行，即使没有 auto 改写也不会触发该拒绝。

这些保护覆盖的是正常运行中能够检测到的错误，并不是持久化文件系统事务：断电或强制终止后不保证跨文件严格原子，也不保证与并发外部写入之间严格原子。实现会在提交前复核路径和哈希，并在检测到竞态时尝试回滚，但其他进程仍可能在检查与写入之间观察或修改文件。

### record / calibrate

判定用的两个阈值（`highEntropy`、`automateVeto`）是写死的默认值。如果想让它们跟着实际结果调，可以记录翻车反馈再重新拟合：

```bash
# 记录一条判定 + 人工反馈（outcome 填 ok 或 flipped）
node --experimental-strip-types src/index.ts record \
  --data verdicts.jsonl \
  --choice deterministic --entropy 0.70 --confidence 0.8 --outcome flipped

# 从所有反馈里重新拟合阈值
node --experimental-strip-types src/index.ts calibrate --data verdicts.jsonl
```

`calibrate` 做网格搜索，先保证 auto 不翻车，再尽量多自动化。

## 设计上的一些说明

这部分是实际用下来踩过坑之后的记录，不是必须读，但写规则时有用。

### task 措辞会直接改变判定结果

Jev 严格按你写的 `task` 来判断。同一个代码位置，`task` 差一句话，结果可能完全反：

| task 说法 | 同一个 `setItem` 的判定 |
|---|---|
| "封装**内部处理**异常" | deterministic 0.81，判 auto |
| "封装**不处理**异常 + **保留**错误处理 + 裸奔写**补容错**" | judgment 0.50，判 manual |

所以写 task 时把迁移语义说清楚，谁处理异常、原有 try/catch 留不留，比挑 pattern 更重要。

### 分档是怎么算出来的

每个候选点问 Jev 两个问题，一个 Choice（"改这里要多少判断力"，选项是 deterministic / judgment / manual），一个 Noul（"自动改完不用人复核的概率"）。最终分档分三步。

1. Choice 的结果定个基线：deterministic → auto，judgment → assisted，manual → manual；
2. 熵做修正：熵高（Jev 自己都不确定）就往保守方向降一档；
3. Noul 兜底：Noul 概率特别低（≤0.3）时，把 auto 降成 assisted。

### 熵高、置信度低，通常是 task 写含糊了

如果一次扫描下来熵普遍偏高、置信度普遍偏低，结果都挤在中间档，多半是 task 描述有歧义，问题不在 Jev。把迁移语义定义清楚，结果会重新变得三档分明。

## 目录结构

```
src/
├── index.ts          CLI 入口（scan / apply / record / calibrate）
├── cli.ts            参数解析
├── config.ts         JEV_API_KEY
├── rules.ts          规则 schema + YAML 加载
├── locate.ts         遍历文件 → matcher → 粗过滤
├── prefilter.ts      注释/字符串剔除
├── glob.ts           include/exclude 的 glob 匹配
├── classify.ts       候选点 → Jev 判定 + 分档合成
├── entropy.ts        熵计算
├── apply.ts          对 auto 点做替换
├── cache.ts          增量扫描缓存
├── matcher/          匹配器抽象层（regex + ast-grep）
├── jev/              Jev HTTP 客户端
├── calibration/      阈值自校准（record + calibrate）
├── report/           终端表格 + JSON/HTML 报告
└── scan.ts           编排：并行池 + 聚合
```

## Roadmap

暂无待办项。

## License

MIT
