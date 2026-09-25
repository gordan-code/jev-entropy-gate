import { spawn as spawnProcess, type SpawnOptions } from "node:child_process";

/** The two points at which an artifact's security descriptor is checked. */
export type WindowsAclPhase = "before-write" | "after-write";

/**
 * The small part of a spawned process used by the ACL verifier.  Keeping the
 * runner injectable makes protocol and failure handling testable without
 * requiring PowerShell (or NTFS) on the development platform.
 */
export interface WindowsAclChild {
  stdout: WindowsAclStream | null;
  stderr: WindowsAclStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}

export interface WindowsAclStream {
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}

/** Injectable equivalent of child_process.spawn for deterministic tests. */
export type WindowsAclRunner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => WindowsAclChild;

/** Keep a wedged PowerShell process from making an apply operation hang. */
export const WINDOWS_ACL_TIMEOUT_MS = 5_000;

/** Bound both streams so an accidental/profile-generated flood cannot exhaust memory. */
export const WINDOWS_ACL_MAX_OUTPUT_BYTES = 64 * 1024;

/*
 * This script is deliberately static.  Paths and the phase are supplied only
 * through environment variables, so a filename can never become PowerShell
 * source or an argument interpreted by a shell.
 */
const POWERSHELL_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
try {
    $targetPath = $env:JEV_ACL_TARGET
    $artifactPath = $env:JEV_ACL_ARTIFACT
    $phase = $env:JEV_ACL_PHASE

    if ($phase -ne 'before-write' -and $phase -ne 'after-write') {
        throw 'Unknown Windows ACL phase.'
    }
    if ([string]::IsNullOrEmpty($targetPath) -or [string]::IsNullOrEmpty($artifactPath)) {
        throw 'Windows ACL target and artifact paths are required.'
    }

    $sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
    $targetAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $targetPath -ErrorAction Stop

    if ($phase -eq 'before-write') {
        Microsoft.PowerShell.Security\Set-Acl -LiteralPath $artifactPath -AclObject $targetAcl -ErrorAction Stop
    }

    $artifactAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $artifactPath -ErrorAction Stop
    $targetSddl = $targetAcl.GetSecurityDescriptorSddlForm($sections)
    $artifactSddl = $artifactAcl.GetSecurityDescriptorSddlForm($sections)
    if ($targetSddl -cne $artifactSddl) {
        throw 'Windows ACL security descriptor mismatch.'
    }

    [Console]::Out.WriteLine('OK')
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`;

const ENCODED_POWERSHELL_SCRIPT = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");

/**
 * Copy (before-write) or verify (after-write) Owner+Access ACL SDDL for an
 * artifact.  Any protocol, process, or PowerShell failure rejects so callers
 * can fail closed before committing a transaction.
 */
export async function applyWindowsArtifactAcl(
  artifactPath: string,
  targetPath: string,
  phase: WindowsAclPhase,
  runner: WindowsAclRunner = defaultWindowsAclRunner
): Promise<void> {
  if (phase !== "before-write" && phase !== "after-write") {
    throw new Error(`Windows ACL verification rejected unknown phase: ${String(phase)}`);
  }
  if (typeof artifactPath !== "string" || artifactPath.length === 0) {
    throw new Error("Windows ACL verification requires an artifact path.");
  }
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new Error("Windows ACL verification requires a target path.");
  }

  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_POWERSHELL_SCRIPT] as const;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JEV_ACL_TARGET: targetPath,
    JEV_ACL_ARTIFACT: artifactPath,
    JEV_ACL_PHASE: phase
  };
  normalizeWindowsPowerShellModulePath(env);

  const options: SpawnOptions = {
    shell: false,
    windowsHide: true,
    env
  };

  await runAclProcess(runner, args, options);
}

/**
 * `powershell.exe` is Windows PowerShell 5.1. PowerShell 7 module directories
 * can contain incompatible modules; remove those entries and ensure the
 * Windows PowerShell built-in module directory is searched first.
 */
export function normalizeWindowsPowerShellModulePath(env: NodeJS.ProcessEnv): void {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  const windowsPowerShellModules =
    typeof systemRoot === "string" && systemRoot.length > 0
      ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`
      : undefined;
  const entries = typeof env.PSModulePath === "string" ? env.PSModulePath.split(";") : [];
  const isPowerShell7ModulePath = (entry: string): boolean =>
    /(?:^|[\\/])powershell7(?:[\\/]|$)/i.test(entry) ||
    /(?:^|[\\/])powershell[\\/]+7(?:[\\/]|$)/i.test(entry);
  const normalizedWindowsPowerShellModules = windowsPowerShellModules
    ?.replace(/[\\/]+$/, "")
    .toLowerCase();
  const compatible = entries.filter((entry) => {
    const normalizedEntry = entry.replace(/[\\/]+$/, "").toLowerCase();
    return (
      entry.length > 0 &&
      !isPowerShell7ModulePath(entry) &&
      normalizedEntry !== normalizedWindowsPowerShellModules
    );
  });
  const modulePaths = [...(windowsPowerShellModules ? [windowsPowerShellModules] : []), ...compatible];
  if (modulePaths.length > 0) env.PSModulePath = modulePaths.join(";");
  else delete env.PSModulePath;
}

function defaultWindowsAclRunner(
  command: string,
  args: readonly string[],
  options: SpawnOptions
): WindowsAclChild {
  return spawnProcess(command, args, options);
}

function runAclProcess(
  runner: WindowsAclRunner,
  args: readonly string[],
  options: SpawnOptions
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: WindowsAclChild | undefined;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const clearTimer = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };

    const terminate = (): void => {
      try {
        child?.kill();
      } catch {
        // The original verifier failure is the actionable result.
      }
    };

    const fail = (error: unknown, kill = true): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      if (kill) terminate();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const collect = (which: "stdout" | "stderr", chunk: unknown): void => {
      if (settled) return;
      let bytes: Buffer;
      try {
        bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string);
      } catch (error) {
        fail(new Error(`Windows ACL ${which} stream produced invalid bytes: ${String(error)}`));
        return;
      }
      if (which === "stdout") {
        stdoutBytes += bytes.byteLength;
        if (stdoutBytes > WINDOWS_ACL_MAX_OUTPUT_BYTES) {
          fail(new Error("Windows ACL stdout exceeds the output limit."));
          return;
        }
        stdoutChunks.push(bytes);
      } else {
        stderrBytes += bytes.byteLength;
        if (stderrBytes > WINDOWS_ACL_MAX_OUTPUT_BYTES) {
          fail(new Error("Windows ACL stderr exceeds the output limit."));
          return;
        }
        stderrChunks.push(bytes);
      }
    };

    const complete = (code: number | null, signal: NodeJS.Signals | null | undefined): void => {
      if (settled) return;
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      if (code !== 0 || signal != null) {
        const detail = stderr.byteLength > 0 ? ` stderr=${stderr.toString("utf8", 0, 4_096)}` : "";
        fail(new Error(`Windows ACL PowerShell exited unsuccessfully (code ${String(code)}, signal ${String(signal)}).${detail}`), false);
        return;
      }
      if (stderr.byteLength !== 0) {
        fail(new Error("Windows ACL PowerShell wrote to stderr."), false);
        return;
      }
      if (!stdout.equals(Buffer.from("OK\r\n", "ascii")) && !stdout.equals(Buffer.from("OK\n", "ascii"))) {
        fail(new Error("Windows ACL PowerShell returned an unexpected stdout protocol."), false);
        return;
      }
      settled = true;
      clearTimer();
      resolve();
    };

    try {
      child = runner("powershell.exe", args, options);
      if (!child || !child.stdout || !child.stderr) {
        fail(new Error("Windows ACL PowerShell did not expose stdout/stderr streams."));
        return;
      }

      child.stdout.on("data", (chunk) => collect("stdout", chunk));
      child.stderr.on("data", (chunk) => collect("stderr", chunk));
      child.stdout.on("error", (error) => fail(new Error(`Windows ACL stdout stream failed: ${String(error)}`)));
      child.stderr.on("error", (error) => fail(new Error(`Windows ACL stderr stream failed: ${String(error)}`)));
      child.on("error", (error) => fail(new Error(`Windows ACL PowerShell spawn failed: ${String(error)}`)));
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => complete(code, signal));

      timeout = setTimeout(() => {
        fail(new Error("Windows ACL PowerShell timed out."));
      }, WINDOWS_ACL_TIMEOUT_MS);
      // A test runner (or an unusual child implementation) may report close
      // synchronously while listeners are being attached.  Do not leave a
      // timer behind after the promise has already settled.
      if (settled) clearTimer();
    } catch (error) {
      fail(new Error(`Windows ACL PowerShell spawn failed: ${String(error)}`));
    }
  });
}
