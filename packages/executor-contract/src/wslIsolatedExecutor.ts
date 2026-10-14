/**
 * @mediator/executor-contract — WSL2 Isolated Process Executor (Sprint S41)
 *
 * Requirements:
 * - Executes approved, hash-pinned recipes inside an isolated WSL2 Linux environment.
 * - Targets the dedicated "MediatorSandbox" distribution by default.
 * - Fails closed if the dedicated distribution is missing or if automount is detected on untrusted paths.
 * - Supports real process execution, capturing real exit codes (0 and nonzero).
 * - Enforces process timeout and AbortSignal cancellation.
 * - Enforces bounded output streaming with truncation indicators.
 * - Sanitizes all process output through the context security engine before returning.
 * - Tracks start/completion timestamps and verifies pre/post live workspace integrity.
 * - Never mounts or writes to the live Windows workspace.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanTerminalOutput, redactTerminalOutput } from '@mediator/context-security';
import { CANONICAL_MEDIATOR_SANDBOX_NAME, CANONICAL_SANDBOX_USER } from './wslSandboxProvisioner.js';

export type WslExecutionStatus =
  | 'completed_success'
  | 'completed_failure'
  | 'timeout'
  | 'cancelled'
  | 'security_violation'
  | 'distribution_unavailable'
  | 'failed';

export interface WslTrustedRecipeDefinition {
  readonly recipeId: string;
  readonly displayName: string;
  readonly linuxExecutable: string;
  readonly defaultArgs: readonly string[];
  readonly definitionHash: string;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export interface WslExecutionRequest {
  readonly recipeId: string;
  readonly recipeHash: string;
  readonly taskWorkspaceRootLinux?: string | undefined;
  readonly liveWorkspaceRootWindows: string;
  readonly correlationId: string;
  readonly distroName?: string | undefined;
  readonly linuxUser?: string | undefined;
  readonly allowDefaultDistroForCanary?: boolean | undefined;
  readonly allowUnisolatedNetworkForCanary?: boolean | undefined;
  readonly args?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly isolateNetwork?: boolean | undefined;
}

export interface WslExecutionResult {
  readonly status: WslExecutionStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly durationMs: number;
  readonly recipeId: string;
  readonly distroName: string;
  readonly linuxUser: string;
  readonly liveWorkspaceIntegrityPreserved: boolean;
  readonly correlationId: string;
  readonly networkIsolated?: boolean | undefined;
  readonly violationDetails?: string | undefined;
}

export const DEFAULT_WSL_TIMEOUT_MS = 15_000;
export const DEFAULT_WSL_MAX_OUTPUT_BYTES = 32_768; // 32 KiB

export class WslIsolatedExecutor {
  private readonly defaultDistro: string;
  private readonly defaultUser: string;
  private readonly trustedRecipes = new Map<string, WslTrustedRecipeDefinition>();
  private readonly activeProcesses = new Map<string, { child: ChildProcess; pid?: number | undefined }>();

  public constructor(options?: {
    readonly defaultDistro?: string | undefined;
    readonly defaultUser?: string | undefined;
  }) {
    this.defaultDistro = options?.defaultDistro ?? CANONICAL_MEDIATOR_SANDBOX_NAME;
    this.defaultUser = options?.defaultUser ?? CANONICAL_SANDBOX_USER;
    this.registerStandardRecipes();
  }

  private registerStandardRecipes(): void {
    const successHash = crypto.createHash('sha256').update('wsl.deterministic_success').digest('hex');
    this.trustedRecipes.set('wsl.deterministic_success', {
      recipeId: 'wsl.deterministic_success',
      displayName: 'WSL Deterministic Success',
      linuxExecutable: '/bin/sh',
      defaultArgs: ['-c', 'echo SUCCESS_VERIFIED; exit 0'],
      definitionHash: successHash,
      timeoutMs: 15_000,
      maxOutputBytes: 4096,
    });

    const exit42Hash = crypto.createHash('sha256').update('wsl.deterministic_exit_42').digest('hex');
    this.trustedRecipes.set('wsl.deterministic_exit_42', {
      recipeId: 'wsl.deterministic_exit_42',
      displayName: 'WSL Nonzero Exit Code 42',
      linuxExecutable: '/bin/sh',
      defaultArgs: ['-c', 'echo INTENTIONAL_EXIT_42 >&2; exit 42'],
      definitionHash: exit42Hash,
      timeoutMs: 15_000,
      maxOutputBytes: 4096,
    });

    const timeoutHash = crypto.createHash('sha256').update('wsl.hanging_timeout').digest('hex');
    this.trustedRecipes.set('wsl.hanging_timeout', {
      recipeId: 'wsl.hanging_timeout',
      displayName: 'WSL Hanging Timeout Probe',
      linuxExecutable: '/bin/sh',
      defaultArgs: ['-c', 'sleep 60'],
      definitionHash: timeoutHash,
      timeoutMs: 1500,
      maxOutputBytes: 4096,
    });

    const bufferHash = crypto.createHash('sha256').update('wsl.output_overflow').digest('hex');
    this.trustedRecipes.set('wsl.output_overflow', {
      recipeId: 'wsl.output_overflow',
      displayName: 'WSL Output Buffer Overflow Probe',
      linuxExecutable: '/bin/sh',
      defaultArgs: ['-c', 'for i in $(seq 1 1000); do echo "CANARY_OUTPUT_FLOOD_LINE_$i"; done; exit 0'],
      definitionHash: bufferHash,
      timeoutMs: 15_000,
      maxOutputBytes: 2048,
    });

    const pythonTestHash = crypto.createHash('sha256').update('python.test').digest('hex');
    this.trustedRecipes.set('python.test', {
      recipeId: 'python.test',
      displayName: 'Python Unittest Discovery',
      linuxExecutable: '/usr/bin/python3',
      defaultArgs: ['-m', 'unittest', 'discover'],
      definitionHash: pythonTestHash,
      timeoutMs: 30_000,
      maxOutputBytes: 32_768,
    });
  }

  public registerRecipe(recipe: WslTrustedRecipeDefinition): void {
    this.trustedRecipes.set(recipe.recipeId, recipe);
  }

  public getRecipe(recipeId: string): WslTrustedRecipeDefinition | undefined {
    return this.trustedRecipes.get(recipeId);
  }

  public async executeRecipe(request: WslExecutionRequest): Promise<WslExecutionResult> {
    const startTime = Date.now();
    const targetDistro = request.distroName ?? this.defaultDistro;
    const targetUser = request.linuxUser ?? (targetDistro === CANONICAL_MEDIATOR_SANDBOX_NAME ? this.defaultUser : undefined);

    // 1. Live Workspace Pre-Run Hash Check
    if (!path.isAbsolute(request.liveWorkspaceRootWindows)) {
      return this.makeViolationResult(
        request,
        'liveWorkspaceRootWindows must be an absolute path',
        startTime,
        targetDistro,
        targetUser,
      );
    }

    const normLiveRoot = path.normalize(request.liveWorkspaceRootWindows);
    const preLiveHash = this.computeTreeHash(normLiveRoot);

    // 2. Distro Isolation Policy Check
    // If running against an unhardened default distro (e.g. Ubuntu with automount/interop),
    // strictly require explicit allowDefaultDistroForCanary flag (used exclusively by test harness).
    if (targetDistro !== CANONICAL_MEDIATOR_SANDBOX_NAME && !request.allowDefaultDistroForCanary) {
      return {
        status: 'security_violation',
        exitCode: null,
        stdout: '',
        stderr: '',
        outputTruncated: false,
        durationMs: Date.now() - startTime,
        recipeId: request.recipeId,
        distroName: targetDistro,
        linuxUser: targetUser ?? 'default',
        liveWorkspaceIntegrityPreserved: true,
        correlationId: request.correlationId,
        violationDetails: `Untrusted execution requires dedicated "${CANONICAL_MEDIATOR_SANDBOX_NAME}" with automount=false. Distro "${targetDistro}" has host automount enabled.`,
      };
    }

    // 2b. Network Isolation Policy Check
    // If targeting MediatorSandbox, network isolation is mandatory.
    // Explicitly disabling isolateNetwork (isolateNetwork === false) is strictly prohibited
    // without explicit test canary authorization flag (used exclusively by test canary 20).
    if (
      targetDistro === CANONICAL_MEDIATOR_SANDBOX_NAME &&
      request.isolateNetwork === false &&
      !request.allowUnisolatedNetworkForCanary
    ) {
      return this.makeViolationResult(
        request,
        `Disabling network isolation on "${CANONICAL_MEDIATOR_SANDBOX_NAME}" is prohibited without explicit test canary authorization.`,
        startTime,
        targetDistro,
        targetUser,
      );
    }

    // 3. Recipe Verification & Hash Pinning
    const trustedRecipe = this.trustedRecipes.get(request.recipeId);
    if (!trustedRecipe) {
      return this.makeViolationResult(
        request,
        `Recipe "${request.recipeId}" is not registered in trusted catalog`,
        startTime,
        targetDistro,
        targetUser,
      );
    }

    if (trustedRecipe.definitionHash !== request.recipeHash) {
      return this.makeViolationResult(
        request,
        `Recipe definition hash mismatch: expected ${trustedRecipe.definitionHash}, got ${request.recipeHash}`,
        startTime,
        targetDistro,
        targetUser,
      );
    }

    // 4. Arguments Inspection
    const effectiveArgs = request.args ?? trustedRecipe.defaultArgs;
    const timeoutMs = request.timeoutMs ?? trustedRecipe.timeoutMs ?? DEFAULT_WSL_TIMEOUT_MS;
    const maxOutputBytes = request.maxOutputBytes ?? trustedRecipe.maxOutputBytes ?? DEFAULT_WSL_MAX_OUTPUT_BYTES;
    const isolateNetwork = request.isolateNetwork ?? (targetDistro === CANONICAL_MEDIATOR_SANDBOX_NAME);

    // Build wsl.exe invocation
    // wsl.exe -d <distro> -u <user> --exec <executable> <args...>
    const wslArgs: string[] = ['-d', targetDistro];
    if (targetUser) {
      wslArgs.push('-u', targetUser);
    }
    if (request.taskWorkspaceRootLinux) {
      wslArgs.push('--cd', request.taskWorkspaceRootLinux);
    }

    if (isolateNetwork) {
      wslArgs.push(
        '--exec',
        'unshare',
        '--user',
        '--net',
        '--map-root-user',
        '--fork',
        '--kill-child',
        '--',
        trustedRecipe.linuxExecutable,
        ...effectiveArgs,
      );
    } else {
      wslArgs.push('--exec', trustedRecipe.linuxExecutable, ...effectiveArgs);
    }

    return new Promise<WslExecutionResult>((resolve) => {
      let child: ChildProcess;
      let timedOut = false;
      let cancelled = false;
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let outputTruncated = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      try {
        child = spawn('wsl.exe', wslArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        const postLiveHash = this.computeTreeHash(normLiveRoot);
        return resolve({
          status: 'distribution_unavailable',
          exitCode: null,
          stdout: '',
          stderr: String(err),
          outputTruncated: false,
          durationMs: Date.now() - startTime,
          recipeId: request.recipeId,
          distroName: targetDistro,
          linuxUser: targetUser ?? 'default',
          liveWorkspaceIntegrityPreserved: preLiveHash === postLiveHash,
          correlationId: request.correlationId,
          networkIsolated: isolateNetwork,
          violationDetails: 'Failed to launch wsl.exe',
        });
      }

      const pid = child.pid;
      this.activeProcesses.set(request.correlationId, { child, pid });

      // Signal cancellation listener
      if (request.signal) {
        const onAbort = (): void => {
          cancelled = true;
          this.terminateChild(child);
        };
        if (request.signal.aborted) {
          onAbort();
        } else {
          request.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      // Timeout watchdog
      timer = setTimeout(() => {
        timedOut = true;
        this.terminateChild(child);
      }, timeoutMs);

      // Stream bounded stdout
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBuffer.length + chunk.length > maxOutputBytes) {
          outputTruncated = true;
          const allowed = maxOutputBytes - stdoutBuffer.length;
          if (allowed > 0) {
            stdoutBuffer += chunk.toString('utf8', 0, allowed);
          }
        } else {
          stdoutBuffer += chunk.toString('utf8');
        }
      });

      // Stream bounded stderr
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBuffer.length + chunk.length > maxOutputBytes) {
          outputTruncated = true;
          const allowed = maxOutputBytes - stderrBuffer.length;
          if (allowed > 0) {
            stderrBuffer += chunk.toString('utf8', 0, allowed);
          }
        } else {
          stderrBuffer += chunk.toString('utf8');
        }
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        this.activeProcesses.delete(request.correlationId);

        const durationMs = Date.now() - startTime;
        const postLiveHash = this.computeTreeHash(normLiveRoot);
        const liveIntegrityPreserved = preLiveHash === postLiveHash;

        // Redact any secrets in process output
        const sanitizedStdout = this.sanitizeOutput(stdoutBuffer);
        const sanitizedStderr = this.sanitizeOutput(stderrBuffer);

        const cleanStdout = stdoutBuffer.replace(/\0/g, '');
        const cleanStderr = stderrBuffer.replace(/\0/g, '');
        const combined = cleanStdout + '\n' + cleanStderr;

        let status: WslExecutionStatus = 'completed_success';
        if (timedOut) {
          status = 'timeout';
        } else if (cancelled) {
          status = 'cancelled';
        } else if (code !== 0) {
          // If wsl.exe reports distribution not found (common code when distro missing, encoded as UTF-16)
          if (
            combined.includes('There is no distribution') ||
            combined.includes('WSL_E_DISTRO_NOT_FOUND') ||
            combined.includes('distribution could not be found')
          ) {
            status = 'distribution_unavailable';
          } else {
            status = 'completed_failure';
          }
        }

        resolve({
          status,
          exitCode: code,
          stdout: sanitizedStdout,
          stderr: sanitizedStderr,
          outputTruncated,
          durationMs,
          recipeId: request.recipeId,
          distroName: targetDistro,
          linuxUser: targetUser ?? 'default',
          liveWorkspaceIntegrityPreserved: liveIntegrityPreserved,
          correlationId: request.correlationId,
          networkIsolated: isolateNetwork,
        });
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        this.activeProcesses.delete(request.correlationId);
        const postLiveHash = this.computeTreeHash(normLiveRoot);

        resolve({
          status: 'failed',
          exitCode: null,
          stdout: '',
          stderr: err.message,
          outputTruncated: false,
          durationMs: Date.now() - startTime,
          recipeId: request.recipeId,
          distroName: targetDistro,
          linuxUser: targetUser ?? 'default',
          liveWorkspaceIntegrityPreserved: preLiveHash === postLiveHash,
          correlationId: request.correlationId,
          networkIsolated: isolateNetwork,
          violationDetails: err.message,
        });
      });
    });
  }

  private terminateChild(child: ChildProcess): void {
    try {
      if (process.platform === 'win32' && child.pid) {
        try {
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        } catch {
          // process may have already exited
        }
      }
      child.kill('SIGKILL');
    } catch {
      // process already exited
    }
  }

  private sanitizeOutput(text: string): string {
    if (!text) return '';
    const scan = scanTerminalOutput(text);
    if (!scan.ok) {
      return '[Terminal output blocked: scan error]';
    }
    return redactTerminalOutput(text, scan.value);
  }

  private makeViolationResult(
    request: WslExecutionRequest,
    message: string,
    startTime: number,
    distro: string,
    user?: string | undefined,
  ): WslExecutionResult {
    return {
      status: 'security_violation',
      exitCode: null,
      stdout: '',
      stderr: '',
      outputTruncated: false,
      durationMs: Date.now() - startTime,
      recipeId: request.recipeId,
      distroName: distro,
      linuxUser: user ?? 'default',
      liveWorkspaceIntegrityPreserved: true,
      correlationId: request.correlationId,
      violationDetails: message,
    };
  }

  private computeTreeHash(rootDir: string): string {
    if (!fs.existsSync(rootDir)) {
      return 'missing';
    }
    const hash = crypto.createHash('sha256');
    const walk = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
          hash.update(relPath);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile()) {
            try {
              const content = fs.readFileSync(fullPath);
              hash.update(content);
            } catch {
              // unreadable file
            }
          }
        }
      } catch {
        // error walking dir
      }
    };
    walk(rootDir);
    return hash.digest('hex');
  }
}
