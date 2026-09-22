# `apply --write` 安全执行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `apply` 在全量预检后才写入，并在正常运行中的提交失败后尽力恢复整批文件。

**Architecture:** 定位阶段记录原始字节哈希；纯改写规划附带快照；安全模块先预检全批、再暂存和备份，最后逐文件在原 inode 上写入，失败时从备份恢复并核验。CLI 只负责调用与展示。写入原 inode 是为了保留 Windows ACL 等现有元数据；跨文件与并发写入不声称严格原子。

**Tech Stack:** Node.js 22.18+、TypeScript、`node:fs/promises`、`node:crypto`、`node:test`、现有 regex／ast-grep matcher。

**规格:** `helloagents/specs/2026-09-22-safe-apply-design.md`

---

## 文件边界

- `src/locate.ts`：原始字节读取、严格 UTF-8 解码、候选点快照。
- `src/types.ts`：`Candidate.sourceHash` 可选字段（直接调用 matcher 的测试仍可构造候选点；安全执行必须拒绝缺失值）。
- `src/cache.ts`、`src/scan.ts`：完整原始字节 SHA-256、缓存版本与旧条目失效。
- `src/apply.ts`：维持纯规划，`Rewrite` 透传 `sourceHash`。
- 新建 `src/apply/validate.ts`：纯范围验证、冲突判定、生成新内容。
- 新建 `src/apply/transaction.ts`：路径检查、全量预检、暂存、备份、提交与回滚；提供可注入的文件操作接口用于故障测试。
- `src/index.ts`：预览／写入调用安全模块，按失败类型输出并设置退出码。
- 新建 `test/apply-safety.test.ts`、`test/apply-transaction.test.ts`，扩充 `test/cache.test.ts`、`test/apply.test.ts`。
- 实施后同步 `README.md`、`README.zh-CN.md` 及 `helloagents/` 知识库和变更记录。

## Task 1：文件快照与缓存版本

**Files:** `src/locate.ts`、`src/types.ts`、`src/cache.ts`、`src/scan.ts`、`test/cache.test.ts`；新建 `test/locate-snapshot.test.ts`。

- [ ] **Step 1 — 写失败测试。** 在临时目录创建 `fetch('/a')`，断言 `locate()` 返回候选点的 `sourceHash` 为对原始 Buffer 做 `sha256(...).digest('hex')` 的 64 字符值；创建包含 `0xff` 的文件，断言它不产生候选点。缓存测试写入没有 `version` 的旧 JSON，断言 `loadCache()` 返回 `undefined`；新缓存往返及第二次 `scan()` 复用时都保留 `sourceHash`。
- [ ] **Step 2 — 确认失败。** 运行 `node --test --experimental-strip-types --experimental-test-isolation=none test/locate-snapshot.test.ts test/cache.test.ts`；预期新增断言失败。
- [ ] **Step 3 — 最小实现。** `Candidate` 增加 `sourceHash?: string`。`locate()` 用 `readFile(file)` 得 Buffer，`new TextDecoder('utf-8', { fatal: true }).decode(bytes)`；解码失败时跳过文件；对 bytes 做完整 SHA-256 并赋给该文件的所有候选点。`computeFileHash` 接受 `string | Buffer`，返回完整 SHA-256；`scan()` 缓存比较改读 Buffer。`ScanCache` 增加 `version: 2`，`loadCache()` 拒绝版本不符或任何缓存 site 缺 `sourceHash` 的文件条目（可整份缓存失效），`saveCache()` 写入版本 2。
- [ ] **Step 4 — 验证。** 运行 `npm test`、`npm run typecheck`；预期全绿。特别确认无缓存 `scan()` 的 site 也有 `sourceHash`。
- [ ] **Step 5 — 提交。** `git add src/locate.ts src/types.ts src/cache.ts src/scan.ts test/cache.test.ts test/locate-snapshot.test.ts`；`git commit -m "feat: capture source snapshots for safe apply"`。

## Task 2：纯改写验证

**Files:** `src/apply.ts`、新建 `src/apply/validate.ts`、`test/apply.test.ts`、新建 `test/apply-safety.test.ts`。

- [ ] **Step 1 — 写失败测试。** 覆盖 `sourceHash` 透传、原文不符、负数／越界偏移、两个非零区间重叠、同偏移零宽插入、零宽插入与非零区间边界冲突；验证单独零宽插入（含 EOF）和 `after: ''` 删除合法。示例：`validateRewrites('ab', [{offset: 1,before:'',after:'X'}])` 得到 `aXb`；同偏移第二条插入应拒绝。
- [ ] **Step 2 — 确认失败。** 运行 `node --test --experimental-strip-types --experimental-test-isolation=none test/apply.test.ts test/apply-safety.test.ts`；预期新增断言失败。
- [ ] **Step 3 — 最小实现。** `Rewrite` 增加 `sourceHash?: string`，`planRewrites()` 从 candidate 透传。新建 `validateRewrites(content, rewrites): string`：所有偏移必须为安全整数且在 `[0, content.length]`；用半开区间 `[offset, offset + before.length)` 判断重叠；同偏移插入、插入落在非零区间内或边界均拒绝；`content.slice(offset,end) === before`；通过后调用现有 `applyToContent()`。不要把 `after.length === 0` 当成零宽匹配。
- [ ] **Step 4 — 验证。** 运行 `npm test`、`npm run typecheck`；预期全绿。
- [ ] **Step 5 — 提交。** `git add src/apply.ts src/apply/validate.ts test/apply.test.ts test/apply-safety.test.ts`；`git commit -m "feat: validate rewrite ranges before apply"`。

## Task 3：全量预检与只读预览

**Files:** 新建 `src/apply/transaction.ts`、`test/apply-transaction.test.ts`，修改 `src/index.ts`。

- [ ] **Step 1 — 写失败测试。** 用两个临时文件构造 auto 改写：`prepareApply(root, rewrites)` 应返回两份计划且不创建暂存文件。改变其中一个文件的未匹配位置，断言整批拒绝且两文件字节不变；若两个文件都有问题，结果应分别列出两个文件和原因。缺少 `sourceHash`、同一文件的候选点哈希不一致、目标或根目录为 symlink／junction、扫描根目录外路径、非普通文件均拒绝。链接测试在无创建权限的平台可按明确原因跳过。
- [ ] **Step 2 — 确认失败。** 运行 `node --test --experimental-strip-types --experimental-test-isolation=none test/apply-transaction.test.ts`；预期因 `prepareApply` 未实现失败。
- [ ] **Step 3 — 最小实现。** 在 `transaction.ts` 导出 `prepareApply(rootDir, rewrites)`。按文件分组，对每个目标**先**用 `path.relative(rootAbs, targetAbs)` 拒绝 `..`／绝对越界，逐级 `lstat()` 拒绝根目录、祖先和目标的 symlink／junction，并确认目标是普通文件；**之后**读取原始字节。严格 UTF-8 解码，计算 Buffer SHA-256，与每条 rewrite 的 `sourceHash` 比较；调用 `validateRewrites()`；保存原始 Buffer、新 Buffer、原 mode 和路径。遍历所有文件并聚合预检错误，任一错误则返回含 `{file, reason}` 数组的拒绝结果，不返回可提交计划。CLI 的 `runApply()` 在打印任何“将改写”或执行写入前调用它；预览只展示计划，不生成磁盘产物。CLI 逐项打印预检问题并返回非零退出码。
- [ ] **Step 4 — 验证。** 运行 `npm test`、`npm run typecheck`，再对示例目录用 mock Jev 的集成测试确认预览零写入；预期全绿。
- [ ] **Step 5 — 提交。** `git add src/apply/transaction.ts src/index.ts test/apply-transaction.test.ts`；`git commit -m "feat: preflight all apply targets before preview"`。

## Task 4：暂存、提交与回滚

**Files:** `src/apply/transaction.ts`、`src/index.ts`、`test/apply-transaction.test.ts`。

- [ ] **Step 1 — 写失败测试。** 覆盖正常两文件提交、暂存第二文件失败时目标零变化、第二文件提交前源文件被改时保留该外部改动并恢复第一文件、第二文件写入一半后抛错时两文件恢复、恢复本身失败时保留备份并报告路径、恢复后哈希不符时报告不完整，以及成功／回滚成功后的产物清理。增加 CLI 端到端测试：预览零写入、`--write` 成功确实写入、故障时非零退出及逐项错误展示。故障注入用 `ApplyIO` 接口或等价钩子在指定文件／阶段抛错，不依赖权限位。
- [ ] **Step 2 — 确认失败。** 运行 `node --test --experimental-strip-types --experimental-test-isolation=none test/apply-transaction.test.ts`；预期新增事务断言失败。
- [ ] **Step 3 — 最小实现（准备）。** 导出 `executeApply(plan, io?)`。默认 IO 包装 `readFile`、`lstat`、`open`、`unlink` 等；用 `randomUUID()` + 独占创建 (`wx`) 为每个目标在同目录写 staged bytes，并以独占备份保留原始 bytes。暂存与备份权限不得宽于原目标；优先用私有模式 `0o600`，若平台无法保证私有性则在触碰目标前拒绝。备份写完后核对其 SHA-256。准备任一失败只清理本次产物，不碰目标。
- [ ] **Step 4 — 最小实现（提交与恢复）。** 按相对路径排序后提交，提交前重新验证路径和原始字节哈希。写入通过打开**现有目标文件**为 `r+`、`truncate(0)`、写入 staged bytes、`sync()`、关闭完成，避免替换 inode／ACL。提交前检查失败时只恢复此前已提交文件；提交调用失败时把当前文件也加入恢复。恢复从备份字节写回现有文件并核对原始哈希；未确认恢复的备份不得清理。返回结构化 `commit-rolled-back`／`rollback-incomplete`（或等价错误类型），附目标与残留路径。**移除 `runApply()` 现有的逐文件 `writeFile` 循环**，`--write` 必须且只能调用 `executeApply()`；CLI 逐项打印失败文件、原因及备份路径，清理失败也报告，所有失败返回非零。
- [ ] **Step 5 — 验证。** 运行 `npm test`、`npm run typecheck`；预期全绿。确认目标文件基本 mode 不变；在 Windows 测试 ACL 不因原 inode 写入而被替换。
- [ ] **Step 6 — 提交。** `git add src/apply/transaction.ts src/index.ts test/apply-transaction.test.ts`；`git commit -m "feat: roll back failed apply transactions"`。

## Task 5：文档、回归与知识库

**Files:** `README.md`、`README.zh-CN.md`、`helloagents/CHANGELOG.md`、`helloagents/project.md`、`helloagents/wiki/modules/apply.md`、`helloagents/history/index.md`（若知识库流程要求）。

- [ ] **Step 1 — 更新文档。** 两份 README 明确预览预检、整批拒绝、正常错误回滚、不能保证断电／强制终止／并发外部写入严格原子、失败备份位置。知识库记录组件边界与验证结果；缺少的核心知识库文件在此阶段创建，不覆盖现有用户文档。
- [ ] **Step 2 — 回归。** 运行 `npm test`、`npm run typecheck`、`npm run build`；预期全绿。运行 `git diff --check`；预期无空白错误。检查 `git status --short`，只应有本任务文档改动。
- [ ] **Step 3 — 提交。** `git add README.md README.zh-CN.md helloagents/CHANGELOG.md helloagents/project.md helloagents/wiki/modules/apply.md`，若创建其他知识库索引也一并加入；`git commit -m "docs: explain safe apply and rollback limits"`。

## 执行完成判据

- 全量预检失败时目标文件原始字节零变化。
- 故障注入下提交失败、回滚成功时所有受影响目标恢复原始字节；恢复失败时保留备份并准确报告。
- CLI 预览不生成暂存文件，所有失败返回非零。
- 旧缓存不会绕过快照验证；无效 UTF-8 不参与改写。
- `npm test`、`npm run typecheck`、`npm run build` 全通过。
