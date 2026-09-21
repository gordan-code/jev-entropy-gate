# jev-entropy-gate

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

需要 Node.js 22.18 以上（用 Node 原生 TypeScript 支持直接跑源码，不依赖 tsx）。

两种用法：装成全局命令 `jevg`，或者直接跑源码脚本。

### 装成命令行（推荐）

在项目目录里执行，把 `jevg` 命令装到全局：

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

对 auto 点执行改写。先跑一遍 scan，再把判为 auto 的点按 `replace` 字段替换。默认只预览，加 `--write` 才真正写回。

```bash
# 预览，不写文件
node --experimental-strip-types src/index.ts apply \
  --rules rules.yaml --dir /path/to/repo

# 真正写回
node --experimental-strip-types src/index.ts apply \
  --rules rules.yaml --dir /path/to/repo --write
```

只改 auto 点，assisted 和 manual 一律不动；替换是纯正则，不涉及模型。

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
