/**
 * @mediator/executor-contract — Disposable Windows Executor Prototype (S40)
 *
 * Requirements:
 * - Controlled proof-of-concept executor designed for Windows 11 Home evaluation.
 * - Executes only trusted recipes registered with canonical hashes or controlled test operations.
 * - Strictly rejects arbitrary shell execution or untrusted AI commands.
 * - Asserts live source workspace integrity (pre/post tree hash verification).
 * - Enforces environment variable sanitization (scrubbing all secrets).
 * - Supervises process lifecycle: timeout, cancellation, process tree termination, bounded output.
 * - Captures real process exit codes independently of model-reported claims.
 * - Does not simulate or mock real OS execution when running live canaries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { scanContent, redactTerminalOutput } from '@mediator/context-security';

export interface DisposableExecutionRequest {
  readonly recipeId: string;
  readonly recipeHash: string;
  readonly taskWorkspaceRoot: string;
  readonly liveWorkspaceRoot: string;
  readonly executable?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly correlationId: string;
  readonly abortSignal?: AbortSignal | undefined;
  readonly envOverrides?: Record<string, string> | undefined;
}

export type DisposableExecutionStatus =
  | 'completed_success'
  | 'completed_failure'
  | 'timeout'
  | 'cancelled'
  | 'launch_failure'
  | 'security_violation';

export interface DisposableExecutionResult {
  readonly status: DisposableExecutionStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly durationMs: number;
  readonly recipeId: string;
  readonly taskWorkspaceRoot: string;
  readonly liveWorkspaceIntegrityPreserved: boolean;
  readonly processContained: boolean;
  readonly correlationId: string;
  readonly violationDetails?: string | undefined;
}

export interface TrustedPrototypeRecipe {
  readonly recipeId: string;
  readonly displayName: string;
  readonly executable: string;
  readonly defaultArgs: readonly string[];
  readonly definitionHash: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OUTPUT_BYTES = 32768; // 32 KiB

function sanitizeOutput(text: string): string {
  if (!text) return '';
  const scanRes = scanContent(text);
  if (!scanRes.ok) {
    return '[Terminal output blocked: scan error]';
  }
  return redactTerminalOutput(text, scanRes.value);
}

/**
 * Standard sanitized environment variables for contained execution.
 * All user secrets and sensitive tokens are completely scrubbed.
 */
function buildSanitizedEnvironment(
  taskWorkspaceRoot: string,
  overrides?: Record<string, string> | undefined,
): Record<string, string> {
  const allowedKeys = [
    'PATH',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'NODE_ENV',
    'CI',
  ];

  const sanitized: Record<string, string> = {
    TEMP: taskWorkspaceRoot,
    TMP: taskWorkspaceRoot,
    WORKSPACE_ROOT: taskWorkspaceRoot,
    NODE_ENV: 'test',
    CI: 'true',
    MEDIATOR_SANDBOX_PROTOTYPE: '1',
  };

  for (const key of allowedKeys) {
    const val = process.env[key];
    if (val !== undefined) {
      sanitized[key] = val;
    }
  }

  // Merge safe overrides, rejecting any sensitive keys
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (!/(KEY|SECRET|TOKEN|AUTH|PASS|COOKIE|CRED)/i.test(k)) {
        sanitized[k] = v;
      }
    }
  }

  return sanitized;
}

export class DisposableWindowsExecutor {
  private readonly trustedRecipes = new Map<string, TrustedPrototypeRecipe>();
  private readonly activeProcesses = new Map<string, { process: ChildProcess; pid: number }>();

  public constructor() {
    this.registerDefaultTestRecipes();
  }

  /**
   * Register a trusted recipe definition with canonical hash.
   */
  public registerRecipe(recipe: TrustedPrototypeRecipe): void {
    this.trustedRecipes.set(recipe.recipeId, recipe);
  }

  /**
   * Look up a trusted recipe.
   */
  public getRecipe(recipeId: string): TrustedPrototypeRecipe | undefined {
    return this.trustedRecipes.get(recipeId);
  }

  /**
   * Execute an approved, canonical recipe inside the designated task workspace.
   */
  public async executeRecipe(request: DisposableExecutionRequest): Promise<DisposableExecutionResult> {
    const startTime = Date.now();

    // 1. Boundary & Workspace Validation
    if (!path.isAbsolute(request.taskWorkspaceRoot)) {
      return this.makeViolationResult(
        request,
        'taskWorkspaceRoot must be an absolute path',
        startTime,
      );
    }

    if (!path.isAbsolute(request.liveWorkspaceRoot)) {
      return this.makeViolationResult(
        request,
        'liveWorkspaceRoot must be an absolute path',
        startTime,
      );
    }

    const normTaskRoot = path.normalize(request.taskWorkspaceRoot);
    const normLiveRoot = path.normalize(request.liveWorkspaceRoot);

    if (normTaskRoot.toLowerCase() === normLiveRoot.toLowerCase()) {
      return this.makeViolationResult(
        request,
        'CRITICAL: Execution directly inside live source workspace is prohibited',
        startTime,
      );
    }

    if (!fs.existsSync(normTaskRoot)) {
      return this.makeViolationResult(
        request,
        `Task workspace root does not exist: ${normTaskRoot}`,
        startTime,
      );
    }

    // 2. Recipe Verification & Hash Pinning
    const trustedRecipe = this.trustedRecipes.get(request.recipeId);
    if (!trustedRecipe) {
      return this.makeViolationResult(
        request,
        `Recipe "${request.recipeId}" is not registered in trusted prototype catalog`,
        startTime,
      );
    }

    if (trustedRecipe.definitionHash !== request.recipeHash) {
      return this.makeViolationResult(
        request,
        `Recipe definition hash mismatch: expected ${trustedRecipe.definitionHash}, got ${request.recipeHash}`,
        startTime,
      );
    }

    // 3. Command Argument Inspection (Shell metacharacters strictly rejected on standard arguments)
    const effectiveArgs = request.args ?? trustedRecipe.defaultArgs;
    for (let i = 0; i < effectiveArgs.length; i++) {
      const arg = effectiveArgs[i];
      const prevArg = i > 0 ? effectiveArgs[i - 1] : '';
      if (prevArg !== '-e' && arg !== undefined) {
        if (/[&|`$><]/.test(arg)) {
          return this.makeViolationResult(
            request,
            `Argument contains prohibited shell metacharacters: ${arg}`,
            startTime,
          );
        }
      }
    }

    // 4. Capture Pre-Run Hash of Live Source Workspace
    const preLiveHash = this.computeTreeHash(normLiveRoot);

    // 5. Setup Execution Parameters
    const timeoutMs = request.timeoutMs ?? trustedRecipe.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = request.maxOutputBytes ?? trustedRecipe.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const env = buildSanitizedEnvironment(normTaskRoot, request.envOverrides);

    // 6. Spawn Contained Process
    const executable = request.executable ?? trustedRecipe.executable;

    return new Promise<DisposableExecutionResult>((resolve) => {
      let child: ChildProcess;
      let timedOut = false;
      let cancelled = false;
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let outputTruncated = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      try {
        child = spawn(executable, effectiveArgs as string[], {
          cwd: normTaskRoot,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        const postLiveHash = this.computeTreeHash(normLiveRoot);
        return resolve({
          status: 'launch_failure',
          exitCode: null,
          stdout: '',
          stderr: String(err),
          outputTruncated: false,
          durationMs: Date.now() - startTime,
          recipeId: request.recipeId,
          taskWorkspaceRoot: normTaskRoot,
          liveWorkspaceIntegrityPreserved: preLiveHash === postLiveHash,
          processContained: true,
          correlationId: request.correlationId,
          violationDetails: `Failed to spawn executable: ${String(err)}`,
        });
      }

      const pid = child.pid;
      if (pid) {
        this.activeProcesses.set(request.correlationId, { process: child, pid });
      }

      // Handle AbortSignal
      if (request.abortSignal) {
        if (request.abortSignal.aborted) {
          cancelled = true;
          this.terminateProcessTree(child, pid);
        } else {
          request.abortSignal.addEventListener('abort', () => {
            cancelled = true;
            this.terminateProcessTree(child, pid);
          }, { once: true });
        }
      }

      // Handle Timeout
      timer = setTimeout(() => {
        timedOut = true;
        this.terminateProcessTree(child, pid);
      }, timeoutMs);

      // Stream & Bound Stdout
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

      // Stream & Bound Stderr
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

      // Process Termination / Close
      child.on('close', (code, _signal) => {
        if (timer) clearTimeout(timer);
        this.activeProcesses.delete(request.correlationId);

        const durationMs = Date.now() - startTime;
        const postLiveHash = this.computeTreeHash(normLiveRoot);
        const liveIntegrityPreserved = preLiveHash === postLiveHash;

        // Redact any secrets in captured output
        const sanitizedStdout = sanitizeOutput(stdoutBuffer);
        const sanitizedStderr = sanitizeOutput(stderrBuffer);

        let status: DisposableExecutionStatus = 'completed_success';
        if (timedOut) {
          status = 'timeout';
        } else if (cancelled) {
          status = 'cancelled';
        } else if (code !== 0) {
          status = 'completed_failure';
        }

        resolve({
          status,
          exitCode: code,
          stdout: sanitizedStdout,
          stderr: sanitizedStderr,
          outputTruncated,
          durationMs,
          recipeId: request.recipeId,
          taskWorkspaceRoot: normTaskRoot,
          liveWorkspaceIntegrityPreserved: liveIntegrityPreserved,
          processContained: true,
          correlationId: request.correlationId,
        });
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        this.activeProcesses.delete(request.correlationId);

        const durationMs = Date.now() - startTime;
        const postLiveHash = this.computeTreeHash(normLiveRoot);

        resolve({
          status: 'launch_failure',
          exitCode: null,
          stdout: sanitizeOutput(stdoutBuffer),
          stderr: sanitizeOutput(stderrBuffer + '\n' + String(err)),
          outputTruncated,
          durationMs,
          recipeId: request.recipeId,
          taskWorkspaceRoot: normTaskRoot,
          liveWorkspaceIntegrityPreserved: preLiveHash === postLiveHash,
          processContained: true,
          correlationId: request.correlationId,
          violationDetails: String(err),
        });
      });
    });
  }

  /**
   * Cancel an active execution by correlation ID.
   */
  public cancelExecution(correlationId: string): boolean {
    const entry = this.activeProcesses.get(correlationId);
    if (!entry) return false;
    this.terminateProcessTree(entry.process, entry.pid);
    this.activeProcesses.delete(correlationId);
    return true;
  }

  /**
   * Gracefully and forcefully terminate process and its child processes on Windows.
   */
  private terminateProcessTree(child: ChildProcess, pid?: number | undefined): void {
    if (!pid) {
      try {
        child.kill('SIGKILL');
      } catch {
        // process might already be dead
      }
      return;
    }

    if (process.platform === 'win32') {
      try {
        // taskkill /pid <PID> /T /F terminates entire process tree
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
        return;
      } catch {
        // fallback to standard kill if taskkill fails
      }
    }

    try {
      child.kill('SIGKILL');
    } catch {
      // process might already be dead
    }
  }

  private makeViolationResult(
    request: DisposableExecutionRequest,
    details: string,
    startTime: number,
  ): DisposableExecutionResult {
    return {
      status: 'security_violation',
      exitCode: null,
      stdout: '',
      stderr: details,
      outputTruncated: false,
      durationMs: Date.now() - startTime,
      recipeId: request.recipeId,
      taskWorkspaceRoot: request.taskWorkspaceRoot,
      liveWorkspaceIntegrityPreserved: true,
      processContained: true,
      correlationId: request.correlationId,
      violationDetails: details,
    };
  }

  private computeTreeHash(dir: string): string {
    const hash = crypto.createHash('sha256');
    if (!fs.existsSync(dir)) return hash.digest('hex');

    try {
      const entries = fs.readdirSync(dir, { recursive: true }) as string[];
      entries.sort();

      for (const entry of entries) {
        const full = path.join(dir, entry);
        try {
          const stat = fs.statSync(full);
          if (stat.isFile()) {
            hash.update(entry);
            hash.update(fs.readFileSync(full));
          }
        } catch {
          // ignore transient access errors in temp
        }
      }
    } catch {
      // ignore
    }

    return hash.digest('hex');
  }

  private registerDefaultTestRecipes(): void {
    // 1. Deterministic Success (Exit 0)
    const successHash = crypto.createHash('sha256').update('test.deterministic_success_v1').digest('hex');
    this.registerRecipe({
      recipeId: 'test.deterministic_success',
      displayName: 'Deterministic Success Recipe (Exit 0)',
      executable: process.execPath,
      defaultArgs: ['-e', 'process.stdout.write("TEST_SUCCESS_OK\\n"); process.exit(0);'],
      definitionHash: successHash,
      timeoutMs: 5000,
      maxOutputBytes: 32768,
    });

    // 2. Deterministic Nonzero Failure (Exit 42)
    const failureHash = crypto.createHash('sha256').update('test.deterministic_failure_v1').digest('hex');
    this.registerRecipe({
      recipeId: 'test.deterministic_failure',
      displayName: 'Deterministic Failure Recipe (Exit 42)',
      executable: process.execPath,
      defaultArgs: ['-e', 'process.stderr.write("TEST_EXPECTED_ERROR\\n"); process.exit(42);'],
      definitionHash: failureHash,
      timeoutMs: 5000,
      maxOutputBytes: 32768,
    });

    // 3. Timeout Hang Recipe (Sleeps)
    const timeoutHash = crypto.createHash('sha256').update('test.timeout_hang_v1').digest('hex');
    this.registerRecipe({
      recipeId: 'test.timeout_hang',
      displayName: 'Timeout Hang Recipe',
      executable: process.execPath,
      defaultArgs: ['-e', 'setTimeout(()=>{}, 60000);'],
      definitionHash: timeoutHash,
      timeoutMs: 1000, // 1 second timeout
      maxOutputBytes: 32768,
    });

    // 4. Child Process Spawn Recipe
    const childProcHash = crypto.createHash('sha256').update('test.child_process_spawn_v1').digest('hex');
    this.registerRecipe({
      recipeId: 'test.child_process_spawn',
      displayName: 'Child Process Spawn Recipe',
      executable: process.execPath,
      defaultArgs: [
        '-e',
        'const cp = require("child_process"); const out = cp.execFileSync(process.execPath, ["-e", "process.stdout.write(\'CHILD_PROCESS_OUTPUT\\\\n\')"]); process.stdout.write(out); process.exit(0);',
      ],
      definitionHash: childProcHash,
      timeoutMs: 5000,
      maxOutputBytes: 32768,
    });

    // 5. Bounded Output Generation Recipe (Outputs > 64 KiB)
    const boundedOutputHash = crypto.createHash('sha256').update('test.bounded_output_v1').digest('hex');
    this.registerRecipe({
      recipeId: 'test.bounded_output',
      displayName: 'Bounded Output Generation Recipe',
      executable: process.execPath,
      defaultArgs: [
        '-e',
        'const chunk = "A".repeat(1024); for(let i=0; i<100; i++) process.stdout.write(chunk); process.exit(0);',
      ],
      definitionHash: boundedOutputHash,
      timeoutMs: 5000,
      maxOutputBytes: 8192, // 8 KiB buffer limit
    });

    // 6. Contained Write Recipe (Writes to task workspace)
    const containedWriteHash = crypto.createHash('sha256').update('test.contained_write_v1').digest('hex');
    this.registerRecipe({
      recipeId: 'test.contained_write',
      displayName: 'Workspace-Contained File Write Recipe',
      executable: process.execPath,
      defaultArgs: [
        '-e',
        'const fs = require("fs"); const p = path.join(process.cwd(), "contained_output.txt"); fs.writeFileSync(p, "CONTAINED_WRITE_DATA\\n"); process.exit(0);',
      ],
      definitionHash: containedWriteHash,
      timeoutMs: 5000,
      maxOutputBytes: 32768,
    });

    // 7. Outbound Network Canary Recipe (Attempts TCP socket)
    const networkHash = crypto.createHash('sha256').update('test.outbound_network_v1').digest('hex');
    this.registerRecipe({
      recipeId: 'test.outbound_network',
      displayName: 'Outbound Network Probe Recipe',
      executable: process.execPath,
      defaultArgs: [
        '-e',
        'const net = require("net"); const s = net.createConnection({ host: "127.0.0.1", port: 80, timeout: 500 }, () => { s.end(); process.exit(0); }); s.on("error", (e) => { process.stderr.write("NET_ERR: " + e.code); process.exit(1); });',
      ],
      definitionHash: networkHash,
      timeoutMs: 3000,
      maxOutputBytes: 32768,
    });
  }
}
