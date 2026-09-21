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

- ❌ **不执行改写**。它只「圈出候选点 + 判断每个点能不能自动化」。真正改写交给 ast-grep / codemod / coding agent。
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

规则**只负责圈出候选改动点**，不负责改写：

```yaml
id: fetch-to-apiclient
description: 把原生 fetch 升级到 apiClient 封装
engine: regex                 # v1 只有 regex（ast-grep 预留 v2）
language: typescript
pattern: "fetch\\s*\\("
context: 3                    # 前后各 3 行，喂给 Jev 的上下文
task: |                       # 迁移目标和背景，喂给 Jev
  把所有原生 fetch(...) 升级到团队的 apiClient 封装，语义保持不变。
```

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

## 目录结构

```
src/
├── index.ts          CLI 入口
├── cli.ts            参数解析
├── config.ts         JEV_API_KEY
├── rules.ts          规则 schema（zod）+ YAML 加载
├── locate.ts         遍历文件 → matcher → 粗过滤
├── prefilter.ts      注释/字符串剔除
├── classify.ts       一个候选点 → Jev 判定 + 双信号合成
├── entropy.ts        熵计算 + 分档
├── matcher/          匹配器抽象层（C 方案：接口化，v1 只实现 regex）
├── jev/              Jev HTTP 客户端（超时/重试/回退）
├── report/           终端表格 + JSON 报告
└── scan.ts           编排：并行池 + 聚合
```

## Roadmap

- [ ] v2：`apply` 命令，对 `auto` 点执行真实改写（接 ast-grep）
- [ ] v2：`ast-grep` matcher（接口已留好）
- [ ] v2：阈值自校准——回看低熵点实际翻车率，自动调整熵阈值
- [ ] v2：HTML 可视化报告
- [ ] v3：增量扫描缓存（只重判上次变过的点）

## License

MIT