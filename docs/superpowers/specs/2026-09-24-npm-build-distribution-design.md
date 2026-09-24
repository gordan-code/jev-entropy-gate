# npm 构建与公开分发设计

**状态：** 已获用户确认并审阅
**日期：** 2026-09-24

## 目标

让全局安装的 `jevg` 真正运行已构建的 JavaScript 产物，并准备将 CLI 发布到公开 npm registry。保持 ast-grep 的原生功能，并覆盖 Windows、Linux、macOS 的 x64 与 arm64；最低 Node.js 版本维持 `>=22.18`。发布由用户手动操作，不由 CI 自动发布。

## 当前问题

- `npm run build` 使用 esbuild bundle，但 `@ast-grep/napi` 会动态加载平台原生 `.node` 模块，当前 bundle 因此失败。
- 构建入口输出到 `dist/index.js`，但 `bin/jevg.mjs` 仍启动 `src/index.ts`，所以即使构建成功也不会运行该产物。
- `package.json` 当前为 `private: true`，不能发布到 npm。

## 方案选择

采用“打包纯 JavaScript、将原生依赖外置”的方案：

- esbuild 输出 Node.js ESM bundle，包元数据保留 `"type": "module"`，将 `@ast-grep/napi` 标为 external；esbuild 会保留 external 包的运行时 import，供 Node.js 从安装后的依赖树解析。参见 [esbuild External](https://esbuild.github.io/api/#external)。
- `yaml` 与 `zod` 纳入 bundle；`@ast-grep/napi` 保留为运行时依赖，使 npm 在安装时提供匹配当前平台的原生依赖。
- 固定当前已验证的 `@ast-grep/napi` 版本 `0.45.3`；升级时须重新验证六种平台的原生包可用性与 smoke test。当前 lockfile 已包含六个目标组合对应的 optional native packages，包括 Windows ARM64 `@ast-grep/napi-win32-arm64-msvc`。
- `bin/jevg.mjs` 保留可执行 shebang，但改为启动 `dist/index.js`，不再 spawn Node 的 TypeScript strip-types 模式。

不选择全部外置依赖，以避免运行时依赖树与安装目录结构成为不必要的 bundle 约束；不选择按平台分别打包原生模块，以避免自建平台选择和二进制封装逻辑。

## npm 包内容与元数据

- 保留包名 `jev-entropy-gate`，首发版本为 `0.1.0`；发布前再检查名称可用性。当前 npm registry 查询返回 404，但不视为预留保证。
- 移除 `private: true`，补齐公开分发所需元数据（仓库、license、engines 等）；不自动发布。
- `bin` 指向 `bin/jevg.mjs`；包文件采用显式白名单，仅包含 `package.json`、`bin/jevg.mjs`、`dist/index.js`、中英文 README、项目 LICENSE 与第三方许可证声明；不生成或发布 source map。因 `yaml`/`zod` 被合并进 bundle，第三方许可证声明须覆盖其许可证文本。
- 明确不包含 `.env`、`.env.example`、`helloagents/`、源码、测试、报告或开发配置。`@ast-grep/napi` 是唯一必需的运行时依赖；`yaml`/`zod` 随 bundle 提供。
- 配置 `prepack` 构建产物；使用 `npm pack --dry-run` 审核包清单，并由自动化断言 tarball 文件路径均符合白名单。npm 的 `files` 字段用于限定发布文件，`prepack` 在 `npm pack`/`npm publish` 前运行。参见 [npm package.json](https://docs.npmjs.com/cli/v10/configuring-npm/package-json/)、[npm lifecycle scripts](https://docs.npmjs.com/cli/v8/using-npm/scripts/)、[npm pack](https://docs.npmjs.com/cli/v10/commands/npm-pack/)。

## CI 与发布流程

- 在 GitHub Actions 的 PR 与 push 验证矩阵中覆盖 6 个原生组合：Windows/Linux/macOS × x64/arm64。使用固定 runner labels：`windows-2025`、`windows-11-arm`、`ubuntu-24.04`、`ubuntu-24.04-arm`、`macos-15-intel`、`macos-14`，避免 `*-latest` 迁移造成不可预期变化。官方 runner 文档当前列有这些平台/架构标签：[runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
- CI 使用 Node.js `22.18.0`（最低支持版本）执行矩阵；每个任务执行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`、`npm pack`。将实际 tarball 安装到隔离临时前缀，例如 `npm install --global --prefix <tmp-prefix> <tarball>`，修改 PATH 并调用该 prefix 下的 `jevg --help`（Windows 使用对应全局 shim）；测试必须确认实际执行的是安装后的包入口而非 workspace 文件。CLI 入口加载时须能解析 `@ast-grep/napi` 原生模块。
- CI 只构建和验证，不持有 npm token，不执行发布。所有矩阵通过后，由用户审核 tarball 内容、版本、包名和 npm 账户，再手动发布；首次公开发布需再次明确授权。
- 公开 npm 包及包名/版本不可复用风险，以 npm 官方文档为准：[package visibility](https://docs.npmjs.com/about-public-packages/)、[publishing](https://docs.npmjs.com/cli/v10/commands/npm-publish/)。

## 失败处理与安全边界

- 构建、打包清单、tarball 安装、CLI 启动、原生模块加载或任一平台测试失败时，CI 必须失败，不能生成“可发布”结论。
- 不把 `JEV_API_KEY` 或其他发布凭据写入包、仓库或 CI 测试日志；CI 不配置 npm 发布令牌。
- `.env.example` 仅列有 `JEV_API_KEY` 变量名，没有实际值；它与 `.env` 一样不进入包。
- 包名查询结果可能变化，且 unscoped npm 包为公开包；发布前复核目标名称、版本和 tarball 清单。
- 发布后同一名称和版本不可再次发布；如首发内容有误，需要发布新版本。不会在此设计或实施流程中实际执行 `npm publish`。

## 验收标准

1. `npm run build` 在六个目标环境中通过，产物中没有指向源码 `.ts` 的运行入口；`@ast-grep/napi` 保留为外置运行时模块。
2. `jevg` 命令从全局安装后的 tarball 启动 `dist/index.js`；在六个目标环境中执行 `jevg --help` 成功并加载原生模块。
3. 六平台矩阵的 typecheck、测试、build、tarball 安装与 smoke test 全通过。
4. `npm pack --dry-run` 与实包清单通过精确文件清单断言；只包含许可声明、README、CLI wrapper 和构建入口相关文件；`.env`、`.env.example`、`helloagents/`、源码、测试、报告、source maps 与开发配置均未包含。
5. 首发配置为 `0.1.0`，手动发布步骤可在 CI 通过后执行；设计/实现阶段不发布。

## 不在范围内

- 生成 standalone 可执行文件或内嵌平台原生二进制。
- 自动 bump 版本、自动创建 release 或自动 publish。
- 降低最低 Node.js 版本，或改变 scan/apply 的业务行为。
- 公开发布前的 npm 账户、包名最终拥有权及凭据设置；这些只在经用户确认的发布步骤处理。
