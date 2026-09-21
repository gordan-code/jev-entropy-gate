# jev-entropy-gate

> 用 Jev 的概率**熵**，决定哪些迁移/重构改动点能安全地交给机器自动做，哪些必须人来判断。

不再问「这个改动对不对」，而是问「Jev 有多确定这个改动要不要人判断」——用概率分布的**熵**在「自动化」和「人工」之间切出第三条边界。

## 为什么看「熵」，而不是看「选的哪个」

普通分类只看 argmax（概率最大的那个选项）。但同样的 argmax，背后可能是三种完全不同的确定度：

| 概率分布 | 熵 | 含义 | 正确处置 |
|---|---|---|---|
| `{0.98, 0.01, 0.01}` | 低 | 极度确定 | **放心自动化** |
| `{0.60, 0.30, 0.10}` | 中 | 有倾向但犹豫 | AI 改 + 人复核 |
| `{0.34, 0.33, 0.33}` | 高 | 完全拿不准 | **强制人工** |

只看 argmax 会把这三种**全当成同一种**处理——这正是自动化翻车的根源。Jev 便宜到能对全仓库每个候选点都吐一次**完整概率分布**，且因为它是用 RLCD（Reinforcement Learning for Calibrated Decisions）训练的，这些概率是**校准过的**，所以熵在这里是有工程意义的信号，不是装饰。

## 它不做什么（边界）

- ⚠️ **改写能力有限**。`scan` 只「圈点 + 判断」；`apply` 只会对 auto 点做**机械的正则替换**（如 `console.warn(` → `logger.warn(`），不做结构性改写——那交给 ast-grep / codemod（v2）。
- ❌ 不是 MCP，不是给 coding agent 的反馈环。它是一个**独立 CLI**，服务对象是**人和自动化流水线**。
- ❌ 不是质量打分器。它问的是**「改这里要不要人判断」**，不是「这段代码好不好」。

## 快速开始

要求 **Node.js ≥ 22.18**（项目用原生 TypeScript 运行，import 带 `.ts` 后缀，零构建依赖）。

```bash
export JEV_API_KEY="..."   # 从 https://console.typesafe.ai/ 获取

npm install
npm run scan -- \
  --rules examples/migrate.fetch-to-apiclient.yaml \
  --dir examples/demo-project \
  --out report.json \
  --concurrency 8
```

> 本项目**不依赖 tsx**：直接用 Node 原生的 TypeScript 支持（`--experimental-strip-types`）运行源码。import 使用 `.ts` 后缀（而非 `.js`），这是 Node 原生 type stripping 的要求，也让 `npm test` / `npm run scan` 不必先 bundle。
>
> `--out` 的扩展名决定输出格式：`.html` 结尾出**可视化报告**（自包含单文件，双击浏览器打开），`.json` 结尾出结构化数据。例如把上面命令的 `--out report.json` 改成 `--out report.html` 即可。

输出（终端表格）：

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

同时写一份结构化 `report.json`，含每个点的完整概率分布、熵、置信度、代码位置，供任何后续执行器消费。

## 规则文件怎么写

规则负责**圈出候选点**，`replace` 字段负责**定义怎么替换**（只有 `apply` 命令用到它）：

```yaml
id: fetch-to-apiclient
description: 把原生 fetch 升级到 apiClient 封装
engine: regex                 # v1 只有 regex（ast-grep 预留 v2）
language: typescript
pattern: "fetch\\s*\\("
replace: "apiClient("         # 替换映射：匹配到的文本做正则替换（可选）
context: 3                    # 前后各 3 行，喂给 Jev 的上下文
task: |                       # 迁移目标和背景，喂给 Jev
  把所有原生 fetch(...) 升级到团队的 apiClient 封装，语义保持不变。
```

`replace` 用正则的 capture group 语法。比如 `pattern: "console\\.(log|warn|error)\\("` + `replace: "logger.$1("`，会把 `console.warn(` 变成 `logger.warn(`。

## 工作原理（管线）

```
规则文件(YAML) ──圈出候选点──▶ matcher ──▶ 本地粗过滤 ──▶ 逐点问 Jev
                                                             │
                                    每个点两个问题：          │
                                    ① Choice「需多少判断力？」│
                                    ② Noul「无需人复核吗？」 │
                                                             ▼
                                                    概率分布 → 算熵
                                                             │
                                                    choice 定基线   ├─▶ 终端表格
                                                    熵修正 + Noul 兜底 └─▶ report.json
```

### 三信号合成：choice 定基线，熵做修正，Noul 兜底

每个候选点问 Jev 两个问题，返回三类信号，最终分档由它们**分层合成**：

1. **`choice`（Jev 选了什么）定基线**
   - `deterministic`（机械替换）→ 基线 `auto`
   - `judgment`（需理解上下文）→ 基线 `assisted`
   - `manual`（机器改写不安全）→ 基线 `manual`

2. **熵做修正（决定"信不信这个 choice"）**
   - 熵是概率分布的扁平程度。熵高 = Jev 自己都不确定选对没 → 基线向保守方向**降一级**（`auto`→`assisted`→`manual`），但**不会升级**。

3. **Noul 兜底（保险丝）**
   - 额外问一句「自动改写后不需要人工复核的概率？」。只有当这个值 **≤ 0.3**（Jev 强烈认为不安全）时，才把 `auto` 否决为 `assisted`。

> 为什么不是「只看熵」？因为熵只告诉你"分布平不平"，丢掉了"平的分布里到底谁在领先"。一个扁平分布如果冠军是 `manual`，就该是 `manual`；一个尖锐分布如果冠军是 `deterministic`，就该是 `auto`。**先看 choice 定方向，再用熵定信心**，才对得上真实数据（0.35 / 0.71 / 0.92 的熵阶梯分别对应 auto / manual / manual）。

### 本地粗过滤（省钱）

进 Jev 之前，先用零成本手段扔掉明显不是真实代码的命中点（注释里、字符串字面量里）。Jev 虽便宜但全仓库逐点跑也不是免费，噪声还会污染熵统计。

## 规则设计指南（三次真实扫描的教训）

这一节来自在真实项目（Vue + Spring Boot 仓库）上三次扫描的实测，不是纸面推演。

### 1. task 措辞是决定性的

Jev 严格按你给的迁移语义来判定，**task 里每一个措辞都会改变结果**。同一个代码位置，只改一句 task：

| task 措辞 | `setItem`（裸奔写）的判定 |
|---|---|
| 「封装**内部处理**异常」 | `deterministic 0.81` → auto（封装兜底，裸奔反而最省事） |
| 「封装**不处理**异常 + **保留**错误处理 + 裸奔写**补容错**」 | `judgment 0.50` → manual（要补容错，必须人看） |

同一个点的 `deterministic` 概率从 0.81 暴跌到 0.07。所以写 task 时，**把迁移语义定义精确**——谁处理异常、原有 try/catch 留不留、边界情况怎么算——比挑 pattern 更重要。

### 2. choice 和熵比 band 更该被看

`band` 是合成后的三档，会掩盖 Jev 的真实判断。看原始 `choice` / `probabilities` / `entropy` 才能知道它到底怎么想的：

- 两个点都判 `assisted`，可能一个是"确定需理解"（choice=judgment、熵低），另一个是"机械但很犹豫"（choice=deterministic、熵高）——band 一样，含义完全不同。

### 3. 高熵 + 低置信 = task 有歧义的警报

当 task 描述含糊时，Jev 不会"硬给一个答案"，而是**整体变得不确定**：熵普遍升高、confidence 普遍掉到 0.5 以下、结果挤在中间档。

这不是 Jev 不行，而是它在反向告诉你：**"你的迁移定义还不够清晰，先别急着自动化。"**

> 把 `jev-entropy-gate` 当仪表用：清晰的定义 → 熵低、置信高、三档分明；含糊的定义 → 熵高、置信低、全挤中间。它顺带帮你检验"你自己想清楚要迁什么了没有"。

## 阈值自校准

`resolveBand` 里的两个阈值（`highEntropy = 0.65`、`automateVeto = 0.3`）是启发式起点，不是真理。当你积累了真实的"翻车反馈"后，可以让它们自己长出来：

```bash
# 1. 记录一条判定 + 人工反馈（choice / entropy / confidence / outcome）
node --experimental-strip-types src/index.ts record \
  --data verdicts.jsonl \
  --choice deterministic --entropy 0.70 --confidence 0.8 --outcome flipped

# 2. 从所有反馈里重新拟合最优阈值
node --experimental-strip-types src/index.ts calibrate --data verdicts.jsonl
```

`calibrate` 用网格搜索，目标**按优先级**：

1. **最小化 `auto` 翻车数**——自动改了却需要返工，是最贵的失败，所以安全优先。
2. **同翻车数下最大化 `auto` 成功数**——多自动化、少浪费人工 review。

拟合结果会直接告诉你：该把 `highEntropy` / `automateVeto` 调到多少，以及是否优于当前默认值。

> 一个反直觉的细节：如果反馈里**没有翻车**，校准会往"最宽松"方向调（最大化 auto）。这不是 bug——没有坏记录时，理性选择就是大胆自动化。翻车数据一进来，阈值立刻收紧。

## apply 命令（对 auto 点执行改写）

`apply` 先跑一遍 `scan`，然后把**判为 auto 的点**按规则里的 `replace` 字段做机械替换：

```bash
# 默认预览，不写回文件
node --experimental-strip-types src/index.ts apply \
  --rules examples/migrate.console-to-logger.yaml \
  --dir /path/to/repo

# 加 --write 才真正写回
node --experimental-strip-types src/index.ts apply \
  --rules examples/migrate.console-to-logger.yaml \
  --dir /path/to/repo --write
```

输出示例（预览模式）：

```
apply · console-to-logger
将改写 11 处（涉及 3 个文件）：

  src/stores/themeStore.ts:15  console.warn(  →  logger.warn(
  src/stores/themeStore.ts:41  console.warn(  →  logger.warn(
  ...
```

三条关键规则：

- **只改 auto 点**。assisted / manual 点一律不动——它们正是"需要人判断"的地方，自动改反而危险。
- **默认 dry-run**。不写回文件，先看预览；确认没问题再加 `--write`。
- **只做机械替换**。`replace` 是纯正则替换，改不了结构（那留给 ast-grep v2）。

## 目录结构

```
src/
├── index.ts          CLI 入口（scan / apply / record / calibrate）
├── cli.ts            参数解析
├── config.ts         JEV_API_KEY
├── rules.ts          规则 schema（zod）+ YAML 加载
├── locate.ts         遍历文件 → matcher → 粗过滤
├── prefilter.ts      注释/字符串剔除
├── glob.ts           include/exclude 的极简 glob 匹配
├── classify.ts       一个候选点 → Jev 判定 + 三信号合成
├── entropy.ts        熵计算
├── apply.ts          对 auto 点做机械替换
├── matcher/          匹配器抽象层（v1 只实现 regex）
├── jev/              Jev HTTP 客户端（超时/重试/回退）
├── calibration/      阈值自校准（record + calibrate）
├── report/           终端表格 + JSON/HTML 报告
└── scan.ts           编排：并行池 + 聚合
```

## Roadmap

- [ ] v2：`ast-grep` matcher + 结构化改写（接口已留好）
- [ ] v2：HTML 可视化报告
- [ ] v3：增量扫描缓存（只重判上次变过的点）

## License

MIT