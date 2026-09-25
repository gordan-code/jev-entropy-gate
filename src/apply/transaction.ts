import { lstat, open as fsOpen, readFile, unlink } from "node:fs/promises";
import type { BigIntStats, Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { relative, resolve, join, sep, isAbsolute, dirname, basename } from "node:path";
import { computeFileHash } from "../cache.ts";
import type { Rewrite } from "../apply.ts";
import { validateRewrites } from "./validate.ts";
import { applyWindowsArtifactAcl } from "./windows-acl.ts";

type FileStats = Stats | BigIntStats;

/** A single target after all read-only preflight checks have passed. */
export interface ApplyPlan {
  /** The path as it appeared in the rewrite candidates. */
  file: string;
  /** Absolute path to the checked regular file. */
  path: string;
  /** Exact bytes read before any rewrite is applied. */
  original: Buffer;
  /** Exact UTF-8 bytes that would be written by the apply transaction. */
  next: Buffer;
  /** Original mode returned by lstat for the target. */
  mode: number;
  /** The validated rewrites belonging to this target. */
  rewrites: Rewrite[];
  /** The root used for path-component checks. */
  rootDir: string;
  /** Stable filesystem identity captured during prepareApply. */
  identity: FileIdentity;
}

/** Device, file-id, and creation time used to detect replaced paths, including inode reuse. */
export interface FileIdentity {
  dev: string;
  ino: string;
  birthtimeNs: string;
}

export interface PrepareError {
  /** The rewrite file path associated with this failure. */
  file: string;
  /** A stable human-readable explanation; no file writes have occurred. */
  reason: string;
}

export interface PrepareSuccess {
  ok: true;
  plans: ApplyPlan[];
}

export interface PrepareRejected {
  ok: false;
  errors: PrepareError[];
}

export type PrepareResult = PrepareSuccess | PrepareRejected;

/** The subset of a file handle needed by the transactional writer. */
export interface ApplyFileHandle {
  write(data: Uint8Array): Promise<unknown>;
  truncate(length?: number): Promise<unknown>;
  sync(): Promise<unknown>;
  stat(): Promise<FileStats>;
  close(): Promise<unknown>;
}

/**
 * File-system operations used by executeApply. Tests can replace individual
 * operations to exercise failures without changing permissions or relying on
 * platform-specific errors.
 */
export interface ApplyIO {
  readFile(path: string): Promise<Buffer>;
  lstat(path: string): Promise<FileStats>;
  open(path: string, flags: string | number, mode?: number): Promise<ApplyFileHandle>;
  unlink(path: string): Promise<void>;
  /**
   * Optional platform-specific proof that a newly-created artifact is no
   * wider than its target. Node's mode argument is not an ACL proof on
   * Windows; callers that can verify the security descriptor may provide this
   * hook. The before-write phase runs while the artifact is still empty; the
   * after-write phase runs after its handle has been closed.
   */
  verifyArtifactSecurity?: (
    artifactPath: string,
    targetPath: string,
    targetMode: number,
    requestedMode: number,
    phase: "before-write" | "after-write"
  ) => Promise<boolean>;
}

export interface ApplyError {
  file: string;
  reason: string;
  backupPath?: string;
  stagedPath?: string;
}

export interface ApplyResidual {
  file: string;
  reason: string;
  backupPath: string;
  stagedPath?: string;
}

export interface ExecuteSuccess {
  ok: true;
  status: "committed";
  files: string[];
}

export type ExecuteFailureStatus =
  | "prepare-failed"
  | "commit-rolled-back"
  | "rollback-incomplete"
  | "cleanup-incomplete";

export interface ExecuteFailure {
  ok: false;
  status: ExecuteFailureStatus;
  errors: ApplyError[];
  residuals: ApplyResidual[];
  committedFiles?: string[];
}

export type ExecuteResult = ExecuteSuccess | ExecuteFailure;

interface ApplyArtifact {
  plan: ApplyPlan;
  stagedPath: string;
  backupPath: string;
  stagedCreated: boolean;
  backupCreated: boolean;
  stagedIdentity?: FileIdentity;
  backupIdentity?: FileIdentity;
  stagedMayContainSourceBytes: boolean;
  backupMayContainSourceBytes: boolean;
}

const defaultApplyIO: ApplyIO = {
  readFile: async (path) => Buffer.from(await readFile(path)),
  lstat: async (path) => lstat(path, { bigint: true }),
  open: async (path, flags, mode) => {
    const handle = await fsOpen(path, flags, mode);
    return {
      write: (data: Uint8Array) => handle.write(data),
      truncate: (length?: number) => handle.truncate(length),
      sync: () => handle.sync(),
      stat: () => handle.stat({ bigint: true }),
      close: () => handle.close()
    };
  },
  unlink: async (path) => unlink(path),
  ...(process.platform === "win32"
    ? {
        verifyArtifactSecurity: async (
          artifactPath: string,
          targetPath: string,
          _targetMode: number,
          _requestedMode: number,
          phase: "before-write" | "after-write"
        ): Promise<boolean> => {
          await applyWindowsArtifactAcl(artifactPath, targetPath, phase);
          return true;
        }
      }
    : {})
};

interface RewriteGroup {
  file: string;
  targetPath: string;
  rewrites: Rewrite[];
}

/**
 * Read and validate every target of an apply operation without creating any
 * temporary files or changing the target files. A single invalid target
 * rejects the complete batch, while all targets are still checked so callers
 * can present every independent preflight error at once.
 */
export async function prepareApply(
  rootDir: string,
  rewrites: Rewrite[],
  io: ApplyIO = defaultApplyIO
): Promise<PrepareResult> {
  const rootAbs = resolve(rootDir);
  const groups = groupRewrites(rootAbs, rewrites);
  const plans: ApplyPlan[] = [];
  const errors: PrepareError[] = [];

  for (const group of groups) {
    try {
      const plan = await prepareGroup(rootAbs, group, io);
      plans.push(plan);
    } catch (error) {
      errors.push({ file: group.file, reason: errorMessage(error) });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plans };
}

function groupRewrites(rootAbs: string, rewrites: Rewrite[]): RewriteGroup[] {
  // Group by the normalized absolute path, not only by the spelling of the
  // relative path. This prevents aliases such as "a.ts" and "./a.ts" from
  // becoming two independently prepared targets.
  const groups = new Map<string, RewriteGroup>();
  for (const rewrite of rewrites) {
    const targetPath = resolve(rootAbs, rewrite.file);
    const existing = groups.get(targetPath);
    if (existing) {
      existing.rewrites.push(rewrite);
    } else {
      groups.set(targetPath, { file: rewrite.file, targetPath, rewrites: [rewrite] });
    }
  }
  return [...groups.values()];
}

async function prepareGroup(rootAbs: string, group: RewriteGroup, io: ApplyIO): Promise<ApplyPlan> {
  const relativePath = relative(rootAbs, group.targetPath);
  if (isOutsideRoot(relativePath)) {
    throw new Error(`目标路径越出 apply 根目录（path outside root）：${group.file}`);
  }

  // Check every path component before reading bytes. lstat is deliberate:
  // stat would follow a link and could make an apparently in-root path point
  // outside the selected root.
  const targetStat = await checkPathComponents(io, rootAbs, group.targetPath, relativePath);
  const targetIdentity = fileIdentity(targetStat);
  if (!targetIdentity) {
    throw new Error(`无法确认目标文件身份（dev/ino 不可用），拒绝改写：${group.file}`);
  }

  for (let index = 0; index < group.rewrites.length; index++) {
    if (!group.rewrites[index]!.sourceHash) {
      throw new Error(`改写 #${index} 缺少 sourceHash，无法确认原始文件版本。`);
    }
  }

  const hashes = new Set(group.rewrites.map((rewrite) => rewrite.sourceHash));
  if (hashes.size !== 1) {
    throw new Error(`同一文件的候选点 sourceHash 不一致，拒绝整批改写。`);
  }

  const original = await io.readFile(group.targetPath);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original);
  } catch {
    throw new Error(`目标文件不是严格有效的 UTF-8，拒绝改写。`);
  }

  const actualHash = computeFileHash(original);
  const expectedHash = group.rewrites[0]!.sourceHash!;
  if (actualHash !== expectedHash) {
    throw new Error(
      `sourceHash 不匹配：文件可能已在扫描后变化（expected ${expectedHash}, actual ${actualHash}）。`
    );
  }

  let nextContent: string;
  try {
    nextContent = validateRewrites(content, group.rewrites);
  } catch (error) {
    throw new Error(`改写预检失败：${errorMessage(error)}`);
  }

  const plan: ApplyPlan = {
    file: group.file,
    path: group.targetPath,
    original,
    next: Buffer.from(nextContent, "utf8"),
    mode: Number(targetStat.mode),
    rewrites: group.rewrites,
    rootDir: rootAbs,
    identity: targetIdentity
  };
  // Keep the public plan's historical enumerable fields unchanged while
  // retaining the checked root for executeApply's later path revalidation.
  Object.defineProperty(plan, "rootDir", {
    configurable: false,
    enumerable: false,
    value: rootAbs,
    writable: false
  });
  Object.defineProperty(plan, "identity", {
    configurable: false,
    enumerable: false,
    value: targetIdentity,
    writable: false
  });
  return plan;
}

async function checkPathComponents(
  io: Pick<ApplyIO, "lstat">,
  rootAbs: string,
  targetPath: string,
  relativePath: string
): Promise<FileStats> {
  const rootStat = await io.lstat(rootAbs);
  rejectLink(rootAbs, rootStat);
  if (!rootStat.isDirectory()) {
    throw new Error(`apply 根路径不是目录（not a directory）：${rootAbs}`);
  }

  let current = rootAbs;
  const components = relativePath.split(sep).filter((component) => component.length > 0);
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]!);
    const stats = await io.lstat(current);
    rejectLink(current, stats);

    if (index < components.length - 1 && !stats.isDirectory()) {
      throw new Error(`路径祖先不是目录：${current}`);
    }
  }

  const targetStat = components.length === 0 ? rootStat : await io.lstat(targetPath);
  rejectLink(targetPath, targetStat);
  if (!targetStat.isFile()) {
    throw new Error(`目标不是普通文件（not a regular file）：${targetPath}`);
  }
  return targetStat;
}

function rejectLink(path: string, stats: FileStats): void {
  if (stats.isSymbolicLink()) {
    throw new Error(`路径包含符号链接或 junction，拒绝改写：${path}`);
  }
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stage, commit and (when needed) restore a fully prepared apply operation.
 *
 * This function intentionally writes through the existing target inode. It
 * never replaces a target path with a temporary file, which keeps the target's
 * ACL and other platform metadata attached to the original inode.
 */
export async function executeApply(
  inputPlans: ApplyPlan[],
  io: ApplyIO = defaultApplyIO
): Promise<ExecuteResult> {
  const plans = [...inputPlans].sort((a, b) => a.file.localeCompare(b.file));
  const invalidPlans = plans.filter(
    (plan) =>
      typeof plan.rootDir !== "string" ||
      !isAbsolute(plan.rootDir) ||
      typeof plan.path !== "string" ||
      !isAbsolute(plan.path) ||
      !isValidFileIdentity(plan.identity)
  );
  if (invalidPlans.length > 0) {
    return {
      ok: false,
      status: "prepare-failed",
      errors: invalidPlans.map((plan) => ({
        file: plan.file,
        reason: typeof plan.rootDir !== "string" || !isAbsolute(plan.rootDir)
          ? "缺少 rootDir，无法证明目标路径仍在 apply 根目录边界内。"
          : typeof plan.path !== "string" || !isAbsolute(plan.path)
            ? "目标路径不是绝对路径，无法证明其位于 apply 根目录边界内。"
            : "缺少目标文件身份（dev/ino），无法安全提交。"
      })),
      residuals: []
    };
  }
  if (process.platform === "win32" && !io.verifyArtifactSecurity) {
    return {
      ok: false,
      status: "prepare-failed",
      errors: plans.map((plan) => ({
        file: plan.file,
        reason: "无法通过 Node 安全验证 Windows ACL/私有性，拒绝写入（需提供 verifyArtifactSecurity）。"
      })),
      residuals: []
    };
  }
  const artifacts: ApplyArtifact[] = [];

  // Preparation is deliberately separate from committing: any staging or
  // backup failure must leave every target byte-for-byte untouched.
  for (const plan of plans) {
    let stagedPath = "";
    let backupPath = "";
    let artifact: ApplyArtifact | undefined;

    try {
      const id = randomUUID();
      if (!isSafeArtifactToken(id)) {
        throw new Error("暂存/备份随机标识不安全，拒绝构造产物路径。");
      }
      const base = basename(plan.path);
      const directory = dirname(plan.path);
      stagedPath = join(directory, `.${base}.${id}.jev-staged`);
      backupPath = join(directory, `.${base}.${id}.jev-backup`);
      if (
        dirname(stagedPath) !== directory ||
        dirname(backupPath) !== directory ||
        !isSafeArtifactPath(stagedPath, directory) ||
        !isSafeArtifactPath(backupPath, directory)
      ) {
        throw new Error("暂存/备份路径越出目标目录，拒绝构造产物路径。");
      }
      const currentArtifact: ApplyArtifact = {
        plan,
        stagedPath,
        backupPath,
        stagedCreated: false,
        backupCreated: false,
        stagedMayContainSourceBytes: false,
        backupMayContainSourceBytes: false
      };
      artifact = currentArtifact;
      const targetStat = await checkPlanPath(io, plan);
      const privateMode = temporaryMode(Number(targetStat.mode));
      await createArtifact(
        io,
        stagedPath,
        plan.next,
        privateMode,
        plan.path,
        Number(targetStat.mode),
        () => {
          currentArtifact.stagedCreated = true;
        },
        (identity) => {
          currentArtifact.stagedIdentity = identity;
        },
        () => {
          currentArtifact.stagedMayContainSourceBytes = true;
        }
      );
      const stagedBytes = await io.readFile(stagedPath);
      if (computeFileHash(stagedBytes) !== computeFileHash(plan.next)) {
        throw new Error("暂存 SHA-256 校验不符，拒绝提交（staged hash mismatch）。");
      }
      await createArtifact(
        io,
        backupPath,
        plan.original,
        privateMode,
        plan.path,
        Number(targetStat.mode),
        () => {
          currentArtifact.backupCreated = true;
        },
        (identity) => {
          currentArtifact.backupIdentity = identity;
        },
        () => {
          currentArtifact.backupMayContainSourceBytes = true;
        }
      );
      const backupBytes = await io.readFile(backupPath);
      if (computeFileHash(backupBytes) !== computeFileHash(plan.original)) {
        throw new Error("备份 SHA-256 校验不符，拒绝提交（backup hash mismatch）。");
      }
      artifacts.push(currentArtifact);
    } catch (error) {
      // If an injected/open implementation created an artifact before throwing,
      // include this artifact in best-effort cleanup as well.
      if (artifact) {
        artifacts.push(artifact);
      }
      const cleanup = await cleanupArtifacts(io, artifacts);
      return {
        ok: false,
        status: "prepare-failed",
        errors: [
          {
            file: plan.file,
            reason: errorMessage(error),
            ...(backupPath ? { backupPath } : {}),
            ...(stagedPath ? { stagedPath } : {})
          },
          ...cleanup.errors
        ],
        residuals: cleanup.residuals
      };
    }
  }

  const committed: ApplyArtifact[] = [];
  for (const artifact of artifacts) {
    const { plan } = artifact;
    try {
      await verifyCurrentTarget(io, plan);
    } catch (error) {
      const trigger: ApplyError = {
        file: plan.file,
        reason: errorMessage(error),
        backupPath: artifact.backupPath,
        stagedPath: artifact.stagedPath
      };
      return await rollbackAfterFailure(io, artifacts, committed, committed, trigger);
    }

    let handle: ApplyFileHandle | undefined;
    let stagedBytes: Buffer;
    try {
      // Staged-file validation is a pre-commit check. Until the target handle
      // is opened, a failure must not classify the current target as touched.
      stagedBytes = await readAndVerifyStaged(io, artifact);
    } catch (error) {
      const trigger: ApplyError = {
        file: plan.file,
        reason: errorMessage(error),
        backupPath: artifact.backupPath,
        stagedPath: artifact.stagedPath
      };
      return await rollbackAfterFailure(io, artifacts, committed, committed, trigger);
    }

    try {
      // A commit-call failure is considered potentially destructive even when
      // open/truncate/write failed before we can know whether bytes changed.
      handle = await io.open(plan.path, "r+");
      try {
        await verifyHandleIdentity(handle, plan);
      } catch (error) {
        try {
          await handle.close();
        } catch (closeError) {
          error = new Error(`${errorMessage(error)}；关闭句柄失败：${errorMessage(closeError)}`);
        }
        handle = undefined;
        const trigger: ApplyError = {
          file: plan.file,
          reason: errorMessage(error),
          backupPath: artifact.backupPath,
          stagedPath: artifact.stagedPath
        };
        return await rollbackAfterFailure(io, artifacts, committed, committed, trigger, [artifact]);
      }
      await handle.truncate(0);
      await writeAll(handle, stagedBytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      const committedBytes = await io.readFile(plan.path);
      if (computeFileHash(committedBytes) !== computeFileHash(plan.next)) {
        throw new Error("提交后目标 SHA-256 校验不符，进入恢复（commit hash mismatch）。");
      }
      committed.push(artifact);
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The original commit error is more useful; rollback still runs.
        }
      }
      const trigger: ApplyError = {
        file: plan.file,
        reason: errorMessage(error),
        backupPath: artifact.backupPath,
        stagedPath: artifact.stagedPath
      };
      return await rollbackAfterFailure(io, artifacts, [...committed, artifact], committed, trigger);
    }
  }

  const cleanup = await cleanupArtifacts(io, artifacts);
  if (cleanup.errors.length > 0 || cleanup.residuals.length > 0) {
    return {
      ok: false,
      status: "cleanup-incomplete",
      errors: cleanup.errors,
      residuals: cleanup.residuals,
      committedFiles: committed.map(({ plan }) => plan.file)
    };
  }

  return { ok: true, status: "committed", files: committed.map(({ plan }) => plan.file) };
}

async function createArtifact(
  io: ApplyIO,
  path: string,
  bytes: Buffer,
  mode: number,
  targetPath: string,
  targetMode: number,
  onCreated: () => void,
  onIdentity: (identity: FileIdentity) => void,
  onMayContainSourceBytes: () => void
): Promise<void> {
  let handle: ApplyFileHandle;
  try {
    handle = await io.open(path, "wx", mode);
  } catch (error) {
    // A faulty wrapper can create the path and then throw. Probe only
    // non-collision errors: an EEXIST path belongs to somebody else and must
    // never be claimed by this transaction. A path observed after any other
    // open failure is tracked without an identity, so cleanup reports it but
    // cannot unlink it.
    if (!isAlreadyExists(error)) {
      try {
        await io.lstat(path);
        onCreated();
      } catch {
        // No observable artifact; leave it unowned and let the original error
        // drive cleanup/reporting.
      }
    }
    throw error;
  }
  onCreated();
  let failure: unknown;
  let identity: FileIdentity | undefined;
  try {
    identity = await captureHandleIdentity(handle, path);
    onIdentity(identity);
    await verifyArtifactSecurity(io, path, targetPath, targetMode, mode, "before-write");
    await verifyArtifactPathIdentity(io, path, identity);
    await verifyArtifactHandleIdentity(handle, path, identity);
    onMayContainSourceBytes();
    await writeAll(handle, bytes);
    await handle.sync();
  } catch (error) {
    failure = error;
  }

  try {
    await handle.close();
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;

  if (!identity) {
    throw new Error(`无法确认暂存/备份句柄身份，拒绝继续：${path}`);
  }
  await verifyArtifactPathIdentity(io, path, identity);
  await verifyArtifactSecurity(io, path, targetPath, targetMode, mode, "after-write");
  await verifyArtifactPathIdentity(io, path, identity);
}

async function captureHandleIdentity(handle: ApplyFileHandle, path: string): Promise<FileIdentity> {
  const stats = await handle.stat();
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`暂存/备份句柄不是普通文件，拒绝继续：${path}`);
  }
  const identity = fileIdentity(stats);
  if (!identity) throw new Error(`无法确认暂存/备份句柄身份，拒绝继续：${path}`);
  return identity;
}

async function verifyArtifactPathIdentity(
  io: Pick<ApplyIO, "lstat">,
  path: string,
  expectedIdentity: FileIdentity
): Promise<void> {
  const stats = await io.lstat(path);
  rejectLink(path, stats);
  if (!stats.isFile()) throw new Error(`暂存/备份不是普通文件：${path}`);
  if (!sameIdentity(expectedIdentity, fileIdentity(stats))) {
    throw new Error(`暂存/备份身份已变化，拒绝继续（artifact inode mismatch）：${path}`);
  }
}

async function verifyArtifactHandleIdentity(
  handle: ApplyFileHandle,
  path: string,
  expectedIdentity: FileIdentity
): Promise<void> {
  const stats = await handle.stat();
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`暂存/备份句柄不是普通文件，拒绝继续：${path}`);
  }
  if (!sameIdentity(expectedIdentity, fileIdentity(stats))) {
    throw new Error(`暂存/备份句柄身份已变化，拒绝继续（handle inode mismatch）：${path}`);
  }
}

async function writeAll(handle: ApplyFileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes.subarray(offset));
    if (
      !result ||
      typeof result !== "object" ||
      !("bytesWritten" in result) ||
      typeof (result as { bytesWritten?: unknown }).bytesWritten !== "number"
    ) {
      throw new Error("文件写入未返回有效 bytesWritten，拒绝继续。");
    }
    const count = Number((result as { bytesWritten: number }).bytesWritten);
    const remaining = bytes.byteLength - offset;
    if (!Number.isSafeInteger(count) || count <= 0 || count > remaining) {
      throw new Error("文件写入返回无效 bytesWritten，拒绝继续。");
    }
    offset += count;
  }
}

function temporaryMode(targetMode: number): number {
  // Keep only owner permission bits. This gives ordinary 0644/0664 targets a
  // private 0600 temporary file and never grants group/other access that the
  // target did not already have. Owner execute/read-only modes remain usable
  // through the already-open descriptor on POSIX.
  return targetMode & 0o700;
}

async function verifyArtifactSecurity(
  io: ApplyIO,
  artifactPath: string,
  targetPath: string,
  targetMode: number,
  requestedMode: number,
  phase: "before-write" | "after-write"
): Promise<void> {
  if (io.verifyArtifactSecurity) {
    if (!(await io.verifyArtifactSecurity(artifactPath, targetPath, targetMode, requestedMode, phase))) {
      throw new Error(
        `无法证明暂存/备份权限不宽于目标，拒绝写入（${phase}）：${artifactPath}`
      );
    }
    return;
  }

  // Windows' Node lstat().mode is a compatibility projection, not the NTFS
  // DACL. Do not pretend that an 0600 mode argument secured a file whose ACL
  // we cannot inspect; a caller must provide an explicit descriptor verifier.
  if (process.platform === "win32") {
    throw new Error(
      `无法通过 Node 安全验证 Windows ACL/私有性，拒绝写入（需提供 verifyArtifactSecurity，${phase}）：${artifactPath}`
    );
  }

  const stats = await io.lstat(artifactPath);
  rejectLink(artifactPath, stats);
  if (!stats.isFile()) throw new Error(`暂存/备份不是普通文件：${artifactPath}`);
  const actualMode = Number(stats.mode);
  if (!Number.isFinite(actualMode)) {
    throw new Error(`无法读取暂存/备份实际权限，拒绝写入：${artifactPath}`);
  }

  const actualPerms = actualMode & 0o777;
  const targetPerms = targetMode & 0o777;
  const requestedPerms = requestedMode & 0o777;
  if ((actualPerms & ~targetPerms) !== 0 || (actualPerms & ~requestedPerms) !== 0) {
    throw new Error(
      `暂存/备份权限宽于目标（target ${targetPerms.toString(8)}, actual ${actualPerms.toString(8)}），拒绝写入：${artifactPath}`
    );
  }
}

async function checkPlanPath(io: ApplyIO, plan: ApplyPlan): Promise<FileStats> {
  if (plan.rootDir) {
    const rootAbs = resolve(plan.rootDir);
    const relativePath = relative(rootAbs, plan.path);
    if (isOutsideRoot(relativePath)) {
      throw new Error(`目标路径越出 apply 根目录（path outside root）：${plan.file}`);
    }
    return checkPathComponents(io, rootAbs, plan.path, relativePath);
  }

  return checkAllAncestorComponents(io, plan.path);
}

async function checkAllAncestorComponents(io: ApplyIO, targetPath: string): Promise<FileStats> {
  const targetAbs = resolve(targetPath);
  const targetStat = await io.lstat(targetAbs);
  rejectLink(targetAbs, targetStat);
  if (!targetStat.isFile()) throw new Error(`目标不是普通文件：${targetAbs}`);

  let current = dirname(targetAbs);
  for (;;) {
    const stats = await io.lstat(current);
    rejectLink(current, stats);
    if (!stats.isDirectory()) throw new Error(`路径祖先不是目录：${current}`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return targetStat;
}

async function verifyCurrentTarget(io: ApplyIO, plan: ApplyPlan): Promise<void> {
  const currentStat = await checkPlanPath(io, plan);
  if (!sameIdentity(plan.identity, fileIdentity(currentStat))) {
    throw new Error(`目标文件身份已变化，拒绝写入（path/inode mismatch）：${plan.path}`);
  }
  const current = await io.readFile(plan.path);
  const expected = computeFileHash(plan.original);
  const actual = computeFileHash(current);
  if (actual !== expected) {
    throw new Error(
      `提交前源文件已变化，拒绝写入（expected ${expected}, actual ${actual}）。`
    );
  }
}

async function verifyHandleIdentity(handle: ApplyFileHandle, plan: ApplyPlan): Promise<void> {
  const handleStat = await handle.stat();
  if (!sameIdentity(plan.identity, fileIdentity(handleStat))) {
    throw new Error(`打开后的目标文件身份已变化，拒绝写入（handle inode mismatch）：${plan.path}`);
  }
}

async function readAndVerifyStaged(io: ApplyIO, artifact: ApplyArtifact): Promise<Buffer> {
  const staged = await io.readFile(artifact.stagedPath);
  if (computeFileHash(staged) !== computeFileHash(artifact.plan.next)) {
    throw new Error("暂存文件在提交前发生变化，拒绝写入（staged hash mismatch）。");
  }
  return staged;
}

interface CleanupResult {
  errors: ApplyError[];
  residuals: ApplyResidual[];
}

async function cleanupArtifacts(io: ApplyIO, artifacts: ApplyArtifact[]): Promise<CleanupResult> {
  const errors: ApplyError[] = [];
  const residuals: ApplyResidual[] = [];
  for (const artifact of artifacts) {
    const paths: Array<[string, boolean, FileIdentity | undefined, boolean]> = [
      [
        artifact.stagedPath,
        artifact.stagedCreated,
        artifact.stagedIdentity,
        artifact.stagedMayContainSourceBytes
      ],
      [
        artifact.backupPath,
        artifact.backupCreated,
        artifact.backupIdentity,
        artifact.backupMayContainSourceBytes
      ]
    ];
    for (const [path, created, identity, mayContainSourceBytes] of paths) {
      if (!created) continue;
      await collectCleanupForPath(
        io,
        artifact,
        path,
        identity,
        mayContainSourceBytes,
        errors,
        residuals
      );
    }
  }
  return { errors, residuals };
}

async function rollbackAfterFailure(
  io: ApplyIO,
  artifacts: ApplyArtifact[],
  affected: ApplyArtifact[],
  committed: ApplyArtifact[],
  trigger: ApplyError,
  retainBackups: ApplyArtifact[] = []
): Promise<ExecuteFailure> {
  const errors: ApplyError[] = [trigger];
  const residuals: ApplyResidual[] = [];
  const affectedSet = new Set(affected);
  const retainedBackupSet = new Set(retainBackups);
  const restored = new Set<ApplyArtifact>();

  // Restore in reverse commit order. The target whose commit call failed is
  // included by the caller even if open/truncate threw before any bytes moved.
  for (const artifact of [...affected].reverse()) {
    try {
      await restoreArtifact(io, artifact);
      restored.add(artifact);
    } catch (error) {
      const reason = withSourceBytesWarning(
        `恢复失败：${errorMessage(error)}`,
        artifact.backupMayContainSourceBytes
      );
      errors.push({
        file: artifact.plan.file,
        reason,
        backupPath: artifact.backupPath,
        stagedPath: artifact.stagedPath
      });
      residuals.push({
        file: artifact.plan.file,
        reason,
        backupPath: artifact.backupPath,
        stagedPath: artifact.stagedPath
      });
    }
  }

  // Confirmed restores may release their backup; failed restores must retain
  // the backup for manual recovery. Staging files are safe to remove in both
  // cases, but failures are reported as residual artifacts.
  for (const artifact of artifacts) {
    if (!affectedSet.has(artifact)) {
      // A later, not-yet-committed artifact was never touched. Its artifacts
      // are always disposable after a commit failure.
      if (artifact.stagedCreated) {
        await collectCleanupForPath(
          io,
          artifact,
          artifact.stagedPath,
          artifact.stagedIdentity,
          artifact.stagedMayContainSourceBytes,
          errors,
          residuals
        );
      }
      if (artifact.backupCreated) {
        if (retainedBackupSet.has(artifact)) {
          const reason = `${withSourceBytesWarning(
            "目标文件身份校验失败，保留备份供人工恢复",
            artifact.backupMayContainSourceBytes
          )}：${artifact.backupPath}`;
          const retained: ApplyResidual = {
            file: artifact.plan.file,
            reason,
            backupPath: artifact.backupPath,
            stagedPath: artifact.stagedPath
          };
          errors.push({ ...retained });
          residuals.push(retained);
        } else {
          await collectCleanupForPath(
            io,
            artifact,
            artifact.backupPath,
            artifact.backupIdentity,
            artifact.backupMayContainSourceBytes,
            errors,
            residuals
          );
        }
      }
      continue;
    }

    if (artifact.stagedCreated) {
      await collectCleanupForPath(
        io,
        artifact,
        artifact.stagedPath,
        artifact.stagedIdentity,
        artifact.stagedMayContainSourceBytes,
        errors,
        residuals
      );
    }
    if (restored.has(artifact) && artifact.backupCreated) {
      await collectCleanupForPath(
        io,
        artifact,
        artifact.backupPath,
        artifact.backupIdentity,
        artifact.backupMayContainSourceBytes,
        errors,
        residuals
      );
    }
  }

  return {
    ok: false,
    status: residuals.length > 0 ? "rollback-incomplete" : "commit-rolled-back",
    errors,
    residuals,
    committedFiles: committed.map(({ plan }) => plan.file)
  };
}

async function restoreArtifact(io: ApplyIO, artifact: ApplyArtifact): Promise<void> {
  const backup = await io.readFile(artifact.backupPath);
  if (computeFileHash(backup) !== computeFileHash(artifact.plan.original)) {
    throw new Error("备份 SHA-256 校验不符，无法恢复（backup hash mismatch）。");
  }

  await checkPlanPath(io, artifact.plan);
  const handle = await io.open(artifact.plan.path, "r+");
  let failure: unknown;
  try {
    await verifyHandleIdentity(handle, artifact.plan);
    await handle.truncate(0);
    await writeAll(handle, backup);
    await handle.sync();
  } catch (error) {
    failure = error;
  }

  try {
    await handle.close();
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;

  const restored = await io.readFile(artifact.plan.path);
  if (computeFileHash(restored) !== computeFileHash(artifact.plan.original)) {
    throw new Error("恢复后 SHA-256 校验不符，恢复不完整（restore hash mismatch）。");
  }
}

async function collectCleanupForPath(
  io: ApplyIO,
  artifact: ApplyArtifact,
  path: string,
  expectedIdentity: FileIdentity | undefined,
  mayContainSourceBytes: boolean,
  errors: ApplyError[],
  residuals: ApplyResidual[]
): Promise<void> {
  if (!expectedIdentity) {
    const reason = `${withSourceBytesWarning(
      "无法确认产物身份，拒绝清理",
      mayContainSourceBytes
    )}：${path}`;
    const residual: ApplyResidual = {
      file: artifact.plan.file,
      reason,
      backupPath: artifact.backupPath,
      stagedPath: artifact.stagedPath
    };
    residuals.push(residual);
    errors.push({ ...residual });
    return;
  }

  try {
    const current = await io.lstat(path);
    const currentIdentity = fileIdentity(current);
    if (!sameIdentity(expectedIdentity, currentIdentity)) {
      const reason = `${withSourceBytesWarning(
        "产物身份已变化，拒绝清理（artifact inode mismatch）",
        mayContainSourceBytes
      )}：${path}`;
      const residual: ApplyResidual = {
        file: artifact.plan.file,
        reason,
        backupPath: artifact.backupPath,
        stagedPath: artifact.stagedPath
      };
      residuals.push(residual);
      errors.push({ ...residual });
      return;
    }
    await io.unlink(path);
  } catch (error) {
    if (isNotFound(error)) return;
    const reason = `${withSourceBytesWarning("清理产物失败", mayContainSourceBytes)}：${errorMessage(error)}`;
    const residual: ApplyResidual = {
      file: artifact.plan.file,
      reason,
      backupPath: artifact.backupPath,
      stagedPath: artifact.stagedPath
    };
    residuals.push(residual);
    errors.push({ ...residual });
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function withSourceBytesWarning(reason: string, mayContainSourceBytes: boolean): string {
  return mayContainSourceBytes ? `${reason}（可能含源码）` : reason;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "ERROR_FILE_EXISTS")
  );
}

function isSafeArtifactToken(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSafeArtifactPath(path: string, directory: string): boolean {
  return resolve(dirname(path)) === resolve(directory) && basename(path).startsWith(".");
}

function fileIdentity(stats: FileStats): FileIdentity | undefined {
  const { dev, ino } = stats;
  // Node exposes nanosecond bigint timestamp fields at runtime for BigIntStats;
  // some @types/node versions omit those fields from the declaration.
  const { birthtimeNs } = stats as FileStats & { birthtimeNs?: number | bigint };
  const devValue = identityPart(dev, false);
  const inoValue = identityPart(ino, true);
  const birthtimeValue = birthtimeNs === undefined ? undefined : identityPart(birthtimeNs, true);
  if (devValue === undefined || inoValue === undefined || birthtimeValue === undefined) return undefined;
  return { dev: devValue, ino: inoValue, birthtimeNs: birthtimeValue };
}

function identityPart(value: number | bigint, requirePositive: boolean): string | undefined {
  if (typeof value === "bigint") {
    if (value < 0n || (requirePositive && value === 0n)) return undefined;
    return value.toString();
  }
  if (!Number.isSafeInteger(value) || value < 0 || (requirePositive && value === 0)) return undefined;
  return String(value);
}

function isValidFileIdentity(value: unknown): value is FileIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.dev === "string" &&
    /^\d+$/.test(candidate.dev) &&
    typeof candidate.ino === "string" &&
    /^\d+$/.test(candidate.ino) &&
    candidate.ino !== "0" &&
    typeof candidate.birthtimeNs === "string" &&
    /^\d+$/.test(candidate.birthtimeNs) &&
    candidate.birthtimeNs !== "0"
  );
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs
  );
}
