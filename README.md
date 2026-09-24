# jev-entropy-gate

English | [中文](./README.zh-CN.md)

Uses Jev's probability entropy to decide which code-migration/refactor sites can be safely auto-rewritten, and which need a human.

## What problem it solves

During a large migration (say, replacing every `fetch` with `apiClient`, or every `console.error` with a unified `logger`), candidate sites usually fall into three buckets:

- Most are mechanical replacements you can't get wrong;
- Some need context to rewrite correctly;
- A few will break things if rewritten (error handling, concurrency, edge cases).

Judging each site with an LLM is slow and expensive; running a regex across everything risks breaking the "needs context" cases.

This tool sends each candidate to Jev and asks "how much judgment does rewriting this take", then uses the **entropy** of the probability distribution (how certain Jev is) to split candidates into three tiers:

| Probability distribution | Entropy | Result |
|---|---|---|
| `{0.98, 0.01, 0.01}` | low, very certain | auto, rewrite automatically |
| `{0.60, 0.30, 0.10}` | medium, leans but hesitates | assisted, AI rewrites + human review |
| `{0.34, 0.33, 0.33}` | high, unsure | manual, human rewrites |

## What it is and isn't

`jev-entropy-gate` is a CLI with four subcommands:

- `scan`: scan a repo, ask Jev per site, output tiers;
- `apply`: rewrite the auto sites;
- `record` / `calibrate`: log flips, then re-fit the decision thresholds.

Some boundaries first:

- **It does not call a coding agent, nor an LLM, to rewrite code.** The only model call is Jev inside `scan`, and Jev only judges — it produces no code. `apply`'s rewrite is the replacement written in the rule (`console.warn(` to `logger.warn(`), a pure string or AST operation with no model involved.
- **It is not a quality scorer.** It asks "does rewriting this need a human", not "is this code good".
- **The regex engine can't do structural rewrites.** Regex does text replacement only; for AST-level rewrites (e.g. preserving nested arguments), use the ast-grep engine.

## Install and quick start

Requires Node.js 22.18.0+ (the published CLI runs its bundled JavaScript build).

Install the published package as the global `jevg` command, or run the source directly while developing.

### As a command (recommended)

Install the latest published package from npm:

```bash
npm install --global jev-entropy-gate
```

Check the installed command, then use it from any directory:

```bash
jevg --help
```

For local development from a checkout, install the package directory instead:

```bash
npm install -g .
# or, for development with a symlink so changes apply instantly:
# npm link
```

Then `jevg` works from any directory:

```bash
export JEV_API_KEY="..."   # get one at https://console.typesafe.ai/

jevg scan --rules rules.yaml --dir /path/to/repo --out report.json
jevg apply --rules rules.yaml --dir /path/to/repo --write
jevg record --data verdicts.jsonl --choice deterministic --entropy 0.7 --confidence 0.8 --outcome flipped
jevg calibrate --data verdicts.jsonl
```

### Run the source directly

Or skip the global install and run with Node's native TS support:

```bash
export JEV_API_KEY="..."

npm install
node --experimental-strip-types src/index.ts scan \
  --rules examples/migrate.fetch-to-apiclient.yaml \
  --dir examples/demo-project \
  --out report.json
```

The `--out` extension picks the format: `.html` produces a self-contained visual report (open in a browser), `.json` produces structured data.

Terminal output looks like:

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

## Rule file format

A rule locates candidate sites (`pattern`) and defines how to rewrite them. Two engines:

**regex engine** (default), regex matching + regex replacement:

```yaml
id: fetch-to-apiclient
description: 把原生 fetch 升级到 apiClient 封装
engine: regex
pattern: "fetch\\s*\\("
replace: "apiClient("         # optional, apply uses it for the rewrite
context: 3                    # context lines on each side, fed to Jev
task: |                       # migration goal, fed to Jev
  把所有原生 fetch(...) 升级到团队的 apiClient 封装，语义保持不变。
```

`replace` supports regex capture groups. `pattern: "console\\.(log|warn|error)\\("` with `replace: "logger.$1("` turns `console.warn(` into `logger.warn(`.

**ast-grep engine**, AST-pattern matching + metavariable rewrite. AST patterns are syntax-aware, so they don't match false positives inside strings or comments:

```yaml
id: fetch-to-apiclient-ast
description: 用 ast-grep 把原生 fetch 升级到 apiClient 封装
engine: ast-grep
language: typescript            # typescript/javascript/tsx/jsx/css/html
pattern: "fetch($$$ARGS)"       # AST pattern; $$$ARGS is a "zero or more nodes" metavariable
fix: "apiClient($$$ARGS)"       # structural rewrite; metavariables are replaced with matched text
context: 3
task: |
  把所有原生 fetch(...) 升级到团队的 apiClient 封装，语义保持不变。
```

ast-grep's `$NAME` matches a single node, `$$$NAME` matches zero or more. Metavariables in `fix` are replaced with the matched source, so `fetch("/a", { method: "POST" })` becomes `apiClient("/a", { method: "POST" })` with the arguments intact. Regex can't do this — capture groups can't balance nested parentheses.

## The four commands

### scan

Scan a repo, ask Jev per site, output tiers. The basis for everything else.

```bash
node --experimental-strip-types src/index.ts scan \
  --rules rules.yaml --dir /path/to/repo --out report.json
```

Add `--cache <file>` for incremental scanning: files whose content hasn't changed reuse the previous verdict without calling Jev again. If the rule or thresholds change, the cache invalidates and everything is re-judged.

```bash
node --experimental-strip-types src/index.ts scan \
  --rules rules.yaml --dir /path/to/repo --cache .jev-cache.json
```

On the second run over the same repo, output ends with a line like `缓存：复用 N 处，重判 M 处`.

### apply

Rewrite the auto sites. Runs a scan first, then applies the rule's `replace` field for the `regex` engine or its `fix` field for the `ast-grep` engine. Previews by default; add `--write` to actually write files.

```bash
# preview, no file writes
node --experimental-strip-types src/index.ts apply \
  --rules rules.yaml --dir /path/to/repo

# actually write
node --experimental-strip-types src/index.ts apply \
  --rules rules.yaml --dir /path/to/repo --write
```

Only auto sites are touched (assisted and manual are left alone); the replacement is a pure regular expression or AST rewrite with no model involved.

#### Apply safety and failure boundaries

Every `apply` run performs a read-only preflight before it prints the rewrite plan or changes a target. The preflight checks that every target is a regular file inside the selected root and that no path component is a symlink or junction. It also checks strict UTF-8 decoding, the SHA-256 snapshot captured during scanning, the original text at every rewrite range, and range conflicts. All affected files are checked as one batch: if any check fails, the whole batch is rejected and no target bytes are written. Preview and `--write` use the same preflight; preview creates no staging or backup files.

With `--write`, the transaction then:

1. creates an unpredictable staging file and an original-byte backup beside each target;
2. verifies both artifact contents and their security/mode constraints;
3. commits in a stable path order by writing through the existing target inode (`r+`) and syncing it; and
4. rechecks the target path, file identity, and bytes before each commit.

Preparation has two distinct failure boundaries. `prepareApply` may reject its read-only preflight; this is reported as a preflight failure before `executeApply`, and no target file is written. If `executeApply` reaches transaction preparation but cannot stage/backup an artifact or verify its security/mode, it returns `prepare-failed`; no target file has been written, though a partially-created artifact may be reported if its cleanup cannot be confirmed.

After preparation, commit failures have two different paths. If the path/source/staged recheck fails **before the current target is opened**, that target has not been touched and only targets committed earlier are restored. The identity check immediately after opening the current target handle is another pre-write guard: if it fails, the current target is not restored; only earlier commits are rolled back and the current target's backup is retained. Only failures in `io.open()` itself, `truncate`, `write`, `sync`, `close`, or the post-write hash check are treated as potentially having changed the current target, so it is restored along with earlier commits. Recovery is verified with the original SHA-256. `commit-rolled-back` means recovery and artifact cleanup completed; recovery or cleanup residuals produce a non-zero incomplete result instead. After an otherwise successful commit, any cleanup residual is reported as `cleanup-incomplete` rather than success.

Cleanup is complete only when every artifact created by this run is either already absent or still has the identity captured for this run and is successfully unlinked. An identity mismatch or unlink error leaves the path reported. Artifacts are placed in the target's directory and have names like `.<basename>.<uuid>.jev-staged` and `.<basename>.<uuid>.jev-backup`. A retained backup is recovery material, not trusted input: before manual recovery, verify its artifact identity and confirm its SHA-256 matches the expected original bytes.

**Windows ACL handling:** when there are auto rewrites to write, the default CLI uses the built-in Windows ACL verifier. Before any source bytes are written, it copies and compares the target's Owner+Access security descriptor (SDDL) to each empty staging and backup artifact; after writing and closing each artifact, it verifies the descriptor again. The commit still writes through the original target inode, so the target's identity and ACL remain attached. PowerShell unavailability, ACL copy/verification failure, descriptor mismatch, or any unexpected PowerShell stdout/stderr causes a fail-closed `prepare-failed` result before the target is written. `verifyArtifactSecurity` remains an internal `ApplyIO` extension hook, not a CLI option. Read-only preview can still run, including when there are no auto rewrites.

These safeguards cover errors detectable during a normal run, not a durable filesystem transaction. They do **not** promise strict cross-file atomicity after power loss or forced process termination, and they do not provide strict atomicity against concurrent external writers. The implementation rechecks paths and hashes and attempts rollback when it detects a race, but another process can still observe or make changes between checks and writes.

### record / calibrate

The two decision thresholds (`highEntropy`, `automateVeto`) are hard-coded defaults. To tune them against real outcomes, record flips then re-fit:

```bash
# record one verdict + human feedback (outcome is ok or flipped)
node --experimental-strip-types src/index.ts record \
  --data verdicts.jsonl \
  --choice deterministic --entropy 0.70 --confidence 0.8 --outcome flipped

# re-fit thresholds from all feedback
node --experimental-strip-types src/index.ts calibrate --data verdicts.jsonl
```

`calibrate` grid-searches, first guaranteeing no auto flips, then maximizing automation.

## Design notes

Notes from real usage, not required reading, but useful when writing rules.

### task wording directly changes the verdict

Jev judges strictly by the `task` you write. The same code site can flip completely with one different phrase:

| task wording | verdict on the same `setItem` |
|---|---|
| "封装**内部处理**异常" | deterministic 0.81, auto |
| "封装**不处理**异常 + **保留**错误处理 + 裸奔写**补容错**" | judgment 0.50, manual |

So be precise about the migration semantics in `task` — who handles errors, whether existing try/catch stays, how edge cases are defined — more important than picking the pattern.

### How tiers are computed

Each site asks Jev two questions: a Choice ("how much judgment does rewriting this take", options deterministic / judgment / manual) and a Noul ("probability no human review is needed after auto-rewrite"). The final tier comes in three steps:

1. Choice sets a baseline: deterministic → auto, judgment → assisted, manual → manual;
2. Entropy corrects: high entropy (Jev unsure of itself) demotes one notch toward conservative;
3. Noul is the fuse: a very low Noul (≤0.3) demotes auto to assisted.

### High entropy + low confidence usually means the task is vague

If a scan comes back with uniformly high entropy and low confidence, with results clustered in the middle tier, the task description is probably ambiguous — it's not Jev failing. Clarify the migration semantics and the results separate into three distinct tiers again.

## Directory layout

```
src/
├── index.ts          CLI entry (scan / apply / record / calibrate)
├── cli.ts            argument parsing
├── config.ts         JEV_API_KEY
├── rules.ts          rule schema + YAML loading
├── locate.ts         walk files → matcher → prefilter
├── prefilter.ts      strip comments/strings
├── glob.ts           include/exclude glob matching
├── classify.ts       candidate → Jev verdict + tier synthesis
├── entropy.ts        entropy calculation
├── apply.ts          rewrite auto sites
├── cache.ts          incremental scan cache
├── matcher/          matcher abstraction (regex + ast-grep)
├── jev/              Jev HTTP client
├── calibration/      threshold self-calibration (record + calibrate)
├── report/           terminal table + JSON/HTML report
└── scan.ts           orchestration: concurrency pool + aggregation
```

## Roadmap

Nothing pending.

## License

MIT
