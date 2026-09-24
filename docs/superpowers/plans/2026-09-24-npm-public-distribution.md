# npm Public Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish-ready npm package that runs the built CLI from its tarball and validates supported OS/architecture combinations in CI, without automatically publishing.

**Architecture:** Bundle the TypeScript CLI and pure-JavaScript dependencies into ESM `dist/index.js`, externalize the pinned `@ast-grep/napi` native dependency, and make the existing `bin/jevg.mjs` import the bundle. Restrict npm contents with a files allowlist, validate actual tarball installation in an isolated global prefix, and add a six-platform GitHub Actions matrix.

**Tech Stack:** Node.js 22.18.0, npm, TypeScript, esbuild, `@ast-grep/napi` 0.45.3, GitHub Actions.

---

## File Map

- Modify `package.json`: public package metadata, explicit allowlist, lifecycle and package-validation scripts, and Node floor.
- Modify `README.md` and `README.zh-CN.md`: document public npm installation, supported Node floor, and use of the built global CLI.
- Modify `package-lock.json`: synchronize package metadata, use canonical public npm registry URLs rather than a third-party mirror, and preserve exact native packages at 0.45.3.
- Modify `bin/jevg.mjs`: import `main` from the built ESM entry, call it with `process.argv.slice(2)`, and set `process.exitCode` from its result.
- Preserve the `src/index.ts` direct-entry guard so importing the module does not implicitly execute the CLI; the wrapper will call exported `main` exactly once.
- Modify/add `test/cli-packaging.test.ts`: tests for the distribution entry and package allowlist policy.
- Add `scripts/assert-package-files.mjs`: validate `npm pack --dry-run --ignore-scripts --json` file paths against the allowed package contents and reject secrets, source, tests, reports, and source maps.
- Add `scripts/smoke-packed-cli.mjs`: build and pack, assert the actual tarball file list, install the tarball using npm global mode into an isolated temporary prefix, resolve `jevg` and prove its path is under that prefix, then run `jevg --help` with the isolated prefix prepended to PATH.
- Add `LICENSE`: MIT license text consistent with `package.json` license metadata.
- Add `THIRD_PARTY_NOTICES.md`: include bundled `yaml` ISC and `zod` MIT license texts because these dependencies are embedded into the published bundle.
- Add `.github/workflows/ci.yml`: pull-request and push validation across the six fixed runner labels and Node 22.18.0; no npm publishing credentials or publish step.
- Keep `helloagents/`, `.env`, `.env.example`, source, tests, reports, and development configuration out of the npm tarball. Do not add `helloagents/` to `.gitignore`.

## Task 1: Run the CLI from its ESM build

**Files:** `package.json`, `bin/jevg.mjs`, `test/cli-packaging.test.ts`

- [ ] **Step 1: Add failing distribution-entry tests.** Add a structural check asserting the executable wrapper imports `{ main }` from `../dist/index.js`, calls it with `process.argv.slice(2)`, maps its result to `process.exitCode`, and does not reference `src/index.ts` or `--experimental-strip-types`. Add subprocess tests that run `node bin/jevg.mjs --help` and verify help output/exit code 0, then an invalid argument and verify exit code 1/error output. Configure `npm test` to build first so `dist/index.js` exists when integration tests run.
- [ ] **Step 2: Run the focused test and verify it fails on the current wrapper.**

Run: `npm test`
Expected: FAIL because the structural test finds the old source wrapper and/or built CLI invocation fails.

- [ ] **Step 3: Update the build command and wrapper.** Set esbuild `--external:@ast-grep/napi` and target Node 22.18; preserve ESM output and `"type": "module"`, and ensure the bundle exports `main`. Change `bin/jevg.mjs` to keep the shebang, import `{ main }` from `../dist/index.js`, call `main(process.argv.slice(2))`, and set `process.exitCode` from the result. Preserve the source direct-entry guard; when wrapper imports the bundle, the guard must not execute `main` itself, so the wrapper call executes the CLI exactly once. Do not alter scan/apply behavior.
- [ ] **Step 4: Run focused tests, typecheck, build, and CLI smoke.**

Run: `npm test`
Expected: PASS, including actual help and invalid-argument subprocess behavior against a fresh build.

Run: `npm run typecheck; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node bin/jevg.mjs --help`
Expected: typecheck/build succeed and help text is printed, with native ast-grep module resolvable.

- [ ] **Step 5: Commit the isolated build-entry change.**

Run: `git add package.json bin/jevg.mjs test/cli-packaging.test.ts; git commit -m "改用构建产物运行CLI"`
Expected: one commit containing only build-entry implementation and its test.

## Task 2: Make and verify a safe, publishable npm tarball

**Files:** `package.json`, `package-lock.json`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `scripts/assert-package-files.mjs`, `scripts/smoke-packed-cli.mjs`, `test/cli-packaging.test.ts`

- [ ] **Step 1: Add failing tests for package metadata and denylisted content.** Verify metadata is publishable (`private` absent/false, `type: module`, `engines.node >=22.18.0`, `@ast-grep/napi` exactly `0.45.3`), exact expected entries are allowed, and `.env`, `.env.example`, `helloagents/`, source, tests, reports, configs, source maps, nested secrets, and arbitrary files under `bin/` or `dist/` are rejected.
- [ ] **Step 2: Run the focused tests and confirm the current package configuration fails.**

Run: `node --test --experimental-strip-types --experimental-test-isolation=none test/cli-packaging.test.ts`
Expected: FAIL on current `private: true`, incomplete npm files metadata, and missing package-validation behavior.

- [ ] **Step 3: Implement package metadata, licenses, docs, and validation scripts.** Remove `private: true`; retain package name and version `jev-entropy-gate@0.1.0`; set Node floor to `>=22.18.0`; add repository metadata and explicit `files` whitelist for exactly `bin/jevg.mjs`, `dist/index.js`, both READMEs, `LICENSE`, and `THIRD_PARTY_NOTICES.md`; add `prepack` build. Bundle `yaml`/`zod` and move them to `devDependencies`; set only `@ast-grep/napi` as a runtime dependency at exact version `0.45.3`. Regenerate lockfile metadata against `https://registry.npmjs.org` so CI does not rely on a third-party mirror. Add MIT text to `LICENSE`, complete bundled dependencies' ISC/MIT license notices to `THIRD_PARTY_NOTICES.md`, and document installation/use of the global CLI in both READMEs. Validate actual tarball file paths against an exact file manifest (not merely directory prefixes) and do not emit source maps. Ensure the tarball smoke script packs into a dedicated temporary directory, validates tarball filename stays within it, avoids shell-interpolating Windows paths, and independently cleans both temporary prefix and pack directory without masking original errors.
- [ ] **Step 4: Verify expected failure cases and run package validation.**

Run: `node --test --experimental-strip-types --experimental-test-isolation=none test/cli-packaging.test.ts`
Expected: PASS, including denylist and manifest checks.

Run: `npm run typecheck; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm pack --dry-run --ignore-scripts --json | node scripts/assert-package-files.mjs`
Expected: typecheck/build pass, pure JSON package listing is accepted, and no excluded file is present. `--ignore-scripts` avoids lifecycle build logs contaminating JSON stdout; build was run explicitly first.

- [ ] **Step 5: Install the actual tarball globally in an isolated prefix and smoke-test it.** `package:smoke` must first build, pack with `--ignore-scripts --json`, and run the same allowlist assertion against the actual tarball file list. Install using npm `--global --prefix <temp-prefix> <tarball>`, prepend the platform-specific global executable directory to PATH, resolve `jevg`, assert its path is under the temporary prefix, run `jevg --help`, and return nonzero on any failure. On Windows use the prefix shim; on Unix use `<prefix>/bin/jevg`. Clean up in a `finally` path.

Run: `npm run package:smoke`
Expected: command succeeds from the installed tarball rather than the workspace entry; temporary artifacts are removed.

- [ ] **Step 6: Commit package metadata and tarball validation.**

Run: `git add package.json package-lock.json LICENSE THIRD_PARTY_NOTICES.md README.md README.zh-CN.md scripts test/cli-packaging.test.ts; git commit -m "完善npm包分发校验"`
Expected: one commit containing package metadata, tarball validation, and tests.

## Task 3: Add six-platform CI validation

**Files:** `.github/workflows/ci.yml`

- [ ] **Step 1: Create a workflow with the six fixed runner labels.** Matrix labels: `windows-2025`, `windows-11-arm`, `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15-intel`, and `macos-14`; run on pull requests and pushes. Use Node.js `22.18.0` to validate the minimum supported runtime.
- [ ] **Step 2: Configure each matrix job to install, test, build, and smoke-test.** Steps: checkout, setup Node 22.18.0 with npm cache, `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, package manifest allowlist validation, and `npm run package:smoke`. The smoke script itself must validate the actual tarball file list against the allowlist before install. Ensure CI has no npm token, `npm publish`, release action, or publish workflow.
- [ ] **Step 3: Validate the workflow and rerun all local checks.**

Run: `npm ci; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run typecheck; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run package:smoke`
Expected: all local checks pass on the current host; remote six-platform confirmation is provided by GitHub Actions after push.

Review `.github/workflows/ci.yml` to confirm all six labels are present, event triggers are PR/push only, and there are no secret references or publishing steps.

- [ ] **Step 4: Commit the CI workflow.**

Run: `git add .github/workflows/ci.yml; git commit -m "添加六平台发布验证"`
Expected: workflow is committed separately from package implementation.

## Final Verification

- [ ] Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run package:smoke` successfully.
- [ ] Confirm the package dry-run JSON has only allowlisted entries and excludes `.env`, `.env.example`, `helloagents/`, TypeScript sources, tests, reports, developer configs, and source maps.
- [ ] Confirm no source entry remains in `bin/jevg.mjs`, `npm publish` was not run, and no npm publish token is configured in CI.
- [ ] Review the complete branch diff and request a final code review before integration.

## Release Boundary

Implementation must stop after local validation and CI workflow creation. Do not run `npm publish`, claim the package name, create a release, or configure publication credentials; those require a separate explicit user instruction and fresh checks.
