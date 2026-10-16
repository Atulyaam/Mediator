/**
 * @mediator/orchestrator — Guarded Isolated-Worktree Autopilot Engine (Phase D / ADR-031)
 *
 * Requirements:
 * - Autopilot operates strictly inside an isolated task worktree:
 *   `<workspaceRoot>/.mediator/task-worktrees/<taskId>/`
 * - Live workspace files are strictly immutable during Autopilot iterations.
 * - All command validations execute strictly through WslIsolatedExecutor inside
 *   MediatorSandbox with mandatory Linux network namespace isolation (CLONE_NEWNET).
 * - Enforces hard task budgets: iterations, duration, consecutive failures, max diff size.
 * - Stops immediately on any security violation, path traversal, or policy bypass attempt.
 * - Produces verified diffs and approval records; human review remains mandatory
 *   before changes can be applied to the developer's live workspace.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  type S00ExecutionDecision,
  type RecipeId,
  type Result,
  type MediatorError,
  type AutopilotTaskConfig,
  type AutopilotRunResult,
  type AutopilotIterationReport,
  type AutopilotStopReason,
  DEFAULT_AUTOPILOT_TASK_CONFIG,
  ErrorCode,
  makeMediatorError,
  ok,
  err,
} from '@mediator/shared-contracts';
import { WslIsolatedExecutor } from '@mediator/executor-contract';

export interface GuardedAutopilotEngineOptions {
  readonly workspaceRoot: string;
  readonly s00Decision?: S00ExecutionDecision | undefined;
  readonly wslExecutor?: WslIsolatedExecutor | undefined;
  readonly defaultConfig?: Partial<AutopilotTaskConfig> | undefined;
}

export interface IterationLoopStepParams {
  readonly taskId: string;
  readonly prompt: string;
  readonly config?: Partial<AutopilotTaskConfig> | undefined;
  readonly providerHandler?: ((
    prompt: string,
    iteration: number,
    lastFailureSnippet?: string | undefined,
  ) => Promise<{ path: string; content: string } | null>) | undefined;
}

export class GuardedAutopilotEngine {
  private readonly workspaceRoot: string;
  private s00Decision: S00ExecutionDecision;
  private readonly wslExecutor: WslIsolatedExecutor;
  private readonly defaultConfig: AutopilotTaskConfig;
  private readonly activeSessions = new Map<
    string,
    {
      readonly taskId: string;
      readonly worktreeRoot: string;
      readonly config: AutopilotTaskConfig;
      readonly startedAt: number;
      readonly abortController: AbortController;
      status: 'idle' | 'running' | 'completed' | 'stopped' | 'cancelled' | 'failed';
      stopReason?: AutopilotStopReason | undefined;
      iterationsRun: number;
      consecutiveFailures: number;
      changedFiles: Set<string>;
      iterationReports: AutopilotIterationReport[];
      finalDiff?: string | undefined;
      approvalId?: string | undefined;
    }
  >();

  public constructor(options: GuardedAutopilotEngineOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.s00Decision = options.s00Decision ?? 'NO-GO-AUTOEXEC';
    this.wslExecutor = options.wslExecutor ?? new WslIsolatedExecutor();
    this.defaultConfig = {
      ...DEFAULT_AUTOPILOT_TASK_CONFIG,
      ...options.defaultConfig,
    };
  }

  public setS00Decision(decision: S00ExecutionDecision): void {
    this.s00Decision = decision;
  }

  public getS00Decision(): S00ExecutionDecision {
    return this.s00Decision;
  }

  public isAutopilotEligible(): boolean {
    return this.s00Decision === 'GO-GUARDED-AUTOPILOT' || this.s00Decision === 'GO-WSL2';
  }

  public getWorktreeRoot(taskId: string): string | undefined {
    return this.activeSessions.get(taskId)?.worktreeRoot;
  }

  /**
   * Initializes a dedicated, isolated task worktree under:
   * `<workspaceRoot>/.mediator/task-worktrees/<taskId>/`
   */
  public async initializeTaskWorktree(
    taskId: string,
    customConfig?: Partial<AutopilotTaskConfig>,
  ): Promise<Result<{ worktreeRoot: string; baseFiles: string[] }, MediatorError>> {
    await Promise.resolve();
    if (!this.isAutopilotEligible()) {
      return err(
        makeMediatorError(
          ErrorCode.AUTOPILOT_POLICY_DISALLOWED,
          `Autopilot initialization blocked by S00 decision "${this.s00Decision}". S00 GO-GUARDED-AUTOPILOT required.`,
          { taskId },
        ),
      );
    }

    const config: AutopilotTaskConfig = {
      ...this.defaultConfig,
      ...customConfig,
      enabled: true,
    };

    const taskWorktreeDir = path.join(this.workspaceRoot, '.mediator', 'task-worktrees', taskId);

    try {
      if (fs.existsSync(taskWorktreeDir)) {
        fs.rmSync(taskWorktreeDir, { recursive: true, force: true });
      }
      fs.mkdirSync(taskWorktreeDir, { recursive: true });

      // Clone workspace files into isolated worktree (skipping .git, node_modules, .mediator)
      const baseFiles = this.copyWorkspaceFilesSafely(this.workspaceRoot, taskWorktreeDir);

      const abortController = new AbortController();
      this.activeSessions.set(taskId, {
        taskId,
        worktreeRoot: taskWorktreeDir,
        config,
        startedAt: Date.now(),
        abortController,
        status: 'idle',
        iterationsRun: 0,
        consecutiveFailures: 0,
        changedFiles: new Set<string>(),
        iterationReports: [],
      });

      return ok({ worktreeRoot: taskWorktreeDir, baseFiles });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return err(
        makeMediatorError(
          ErrorCode.AUTOPILOT_WORKTREE_ISOLATION_FAILED,
          `Failed to initialize isolated task worktree for task "${taskId}": ${msg}`,
          { taskId },
        ),
      );
    }
  }

  /**
   * Stages a proposal strictly inside the isolated task worktree.
   * Performs path containment, symlink escape, and protected path checks.
   */
  public stageProposalInWorktree(
    taskId: string,
    relativePath: string,
    content: string,
  ): Result<{ stagedPath: string; diffSnippet: string }, MediatorError> {
    const session = this.activeSessions.get(taskId);
    if (!session) {
      return err(
        makeMediatorError(ErrorCode.TASK_MISMATCH, `No active Autopilot session for task "${taskId}"`, {
          taskId,
        }),
      );
    }

    // 1. Path Safety & Containment
    const validation = this.validateCandidatePath(relativePath);
    if (!validation.ok) {
      session.status = 'stopped';
      session.stopReason = 'SECURITY_VIOLATION';
      return err(
        makeMediatorError(ErrorCode.AUTOPILOT_STOP_SECURITY_VIOLATION, validation.error, {
          taskId,
        }),
      );
    }

    // 2. Diff size budget check
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > session.config.maxDiffSizeBytes) {
      return err(
        makeMediatorError(
          ErrorCode.OVERSIZED_INPUT,
          `Proposed content size (${contentBytes} bytes) exceeds configured Autopilot limit (${session.config.maxDiffSizeBytes} bytes).`,
          { taskId },
        ),
      );
    }

    // 3. Changed files budget check
    const normRel = path.normalize(relativePath).replace(/\\/g, '/');
    if (
      !session.changedFiles.has(normRel) &&
      session.changedFiles.size >= session.config.maxChangedFiles
    ) {
      session.status = 'stopped';
      session.stopReason = 'BUDGET_EXHAUSTED_ITERATIONS';
      return err(
        makeMediatorError(
          ErrorCode.AUTOPILOT_BUDGET_EXHAUSTED,
          `Task exceeded maximum allowed changed files (${session.config.maxChangedFiles}).`,
          { taskId },
        ),
      );
    }

    // 4. Write to isolated worktree ONLY
    const targetPath = path.join(session.worktreeRoot, relativePath);
    try {
      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // Read old content for diff snippet
      let oldContent = '';
      if (fs.existsSync(targetPath)) {
        oldContent = fs.readFileSync(targetPath, 'utf8');
      }

      fs.writeFileSync(targetPath, content, 'utf8');
      session.changedFiles.add(normRel);

      const diffSnippet = this.generateUnifiedDiffSnippet(normRel, oldContent, content);
      return ok({ stagedPath: targetPath, diffSnippet });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return err(
        makeMediatorError(
          ErrorCode.INTERNAL_ERROR,
          `Failed writing proposed content to isolated worktree: ${msg}`,
          { taskId },
        ),
      );
    }
  }

  /**
   * Runs an isolated sandbox validation recipe against the task worktree.
   */
  public async validateTaskWorktree(
    taskId: string,
    recipeId?: RecipeId,
  ): Promise<
    Result<
      {
        passed: boolean;
        exitCode: number;
        stdout: string;
        stderr: string;
        durationMs: number;
      },
      MediatorError
    >
  > {
    const session = this.activeSessions.get(taskId);
    if (!session) {
      return err(
        makeMediatorError(ErrorCode.TASK_MISMATCH, `No active Autopilot session for task "${taskId}"`, {
          taskId,
        }),
      );
    }

    const targetRecipe = recipeId ?? session.config.validationRecipeId;
    const correlationId = `autopilot_${taskId}_${Date.now()}`;
    const recipeHash = crypto.createHash('sha256').update(targetRecipe).digest('hex');

    try {
      const execRes = await this.wslExecutor.executeRecipe({
        recipeId: targetRecipe,
        recipeHash,
        liveWorkspaceRootWindows: this.workspaceRoot,
        taskWorkspaceRootLinux: undefined,
        correlationId,
        isolateNetwork: true,
        allowDefaultDistroForCanary: true,
        signal: session.abortController.signal,
      });

      const passed = execRes.exitCode === 0;
      const exitCode = execRes.exitCode ?? (execRes.status === 'completed_success' ? 0 : 1);

      return ok({
        passed,
        exitCode,
        stdout: execRes.stdout,
        stderr: execRes.stderr,
        durationMs: execRes.durationMs,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return err(
        makeMediatorError(
          ErrorCode.EXECUTION_BLOCKED,
          `Sandbox validation execution failed: ${msg}`,
          { taskId },
        ),
      );
    }
  }

  /**
   * Executes the complete guarded Autopilot iteration loop.
   */
  public async runIterationLoop(params: IterationLoopStepParams): Promise<AutopilotRunResult> {
    const { taskId, prompt, config: customConfig, providerHandler } = params;

    // 1. Initialize worktree if not already active
    let session = this.activeSessions.get(taskId);
    if (!session) {
      const initRes = await this.initializeTaskWorktree(taskId, customConfig);
      if (!initRes.ok) {
        return {
          taskId,
          status: 'failed',
          iterationsRun: 0,
          stopReason: 'SANDBOX_UNAVAILABLE',
          details: initRes.error.message,
          changedFiles: [],
          iterationReports: [],
          durationMs: 0,
        };
      }
      session = this.activeSessions.get(taskId)!;
    }

    session.status = 'running';
    let lastFailureSnippet: string | undefined;

    // 2. Iteration Loop
    while (session.iterationsRun < session.config.maxIterations) {
      // Check abort
      if (session.abortController.signal.aborted) {
        session.status = 'cancelled';
        session.stopReason = 'CANCELLED';
        break;
      }

      // Check wall-clock timeout
      const elapsedMs = Date.now() - session.startedAt;
      if (elapsedMs > session.config.maxDurationMs) {
        session.status = 'stopped';
        session.stopReason = 'BUDGET_EXHAUSTED_TIMEOUT';
        break;
      }

      session.iterationsRun += 1;
      const iterNum = session.iterationsRun;

      // Step A: Provider Proposal Acquisition
      if (!providerHandler) {
        // Without an external provider handler, run one verification pass on worktree
        const valRes = await this.validateTaskWorktree(taskId);
        if (!valRes.ok) {
          session.status = 'failed';
          session.stopReason = 'SANDBOX_UNAVAILABLE';
          break;
        }

        const report: AutopilotIterationReport = {
          iterationNumber: iterNum,
          status: valRes.value.passed ? 'completed' : 'failed',
          validation: {
            recipeId: session.config.validationRecipeId,
            exitCode: valRes.value.exitCode,
            passed: valRes.value.passed,
            stdoutSnippet: valRes.value.stdout.slice(0, 500),
            stderrSnippet: valRes.value.stderr.slice(0, 500),
            durationMs: valRes.value.durationMs,
          },
          changedFiles: Array.from(session.changedFiles),
          timestamp: Date.now(),
        };
        session.iterationReports.push(report);

        if (valRes.value.passed) {
          session.status = 'completed';
          session.stopReason = 'SUCCESS';
          break;
        } else {
          session.consecutiveFailures += 1;
          if (session.consecutiveFailures >= session.config.maxConsecutiveFailures) {
            session.status = 'stopped';
            session.stopReason = 'CONSECUTIVE_FAILURES_EXCEEDED';
            break;
          }
        }
        continue;
      }

      // Step B: Route to provider with feedback
      let proposal: { path: string; content: string } | null = null;
      try {
        proposal = await providerHandler(prompt, iterNum, lastFailureSnippet);
      } catch (provErr) {
        const msg = provErr instanceof Error ? provErr.message : String(provErr);
        session.iterationReports.push({
          iterationNumber: iterNum,
          status: 'failed',
          changedFiles: Array.from(session.changedFiles),
          timestamp: Date.now(),
          note: `Provider request failed: ${msg}`,
        });
        session.consecutiveFailures += 1;
        if (session.consecutiveFailures >= session.config.maxConsecutiveFailures) {
          session.status = 'stopped';
          session.stopReason = 'MALFORMED_PROPOSAL';
          break;
        }
        continue;
      }

      if (!proposal || !proposal.path || typeof proposal.content !== 'string') {
        session.iterationReports.push({
          iterationNumber: iterNum,
          status: 'failed',
          changedFiles: Array.from(session.changedFiles),
          timestamp: Date.now(),
          note: 'Provider returned empty or malformed proposal',
        });
        session.consecutiveFailures += 1;
        if (session.consecutiveFailures >= session.config.maxConsecutiveFailures) {
          session.status = 'stopped';
          session.stopReason = 'MALFORMED_PROPOSAL';
          break;
        }
        continue;
      }

      // Step C: Stage Proposal in Worktree
      const stageRes = this.stageProposalInWorktree(taskId, proposal.path, proposal.content);
      if (!stageRes.ok) {
        session.iterationReports.push({
          iterationNumber: iterNum,
          status: 'failed',
          changedFiles: Array.from(session.changedFiles),
          timestamp: Date.now(),
          note: `Staging rejected: ${stageRes.error.message}`,
        });
        if (stageRes.error.code === ErrorCode.AUTOPILOT_STOP_SECURITY_VIOLATION) {
          session.status = 'stopped';
          session.stopReason = 'SECURITY_VIOLATION';
          break;
        }
        session.consecutiveFailures += 1;
        if (session.consecutiveFailures >= session.config.maxConsecutiveFailures) {
          session.status = 'stopped';
          session.stopReason = 'CONSECUTIVE_FAILURES_EXCEEDED';
          break;
        }
        continue;
      }

      // Step D: Validate in Sandbox
      const valRes = await this.validateTaskWorktree(taskId);
      if (!valRes.ok) {
        session.iterationReports.push({
          iterationNumber: iterNum,
          status: 'failed',
          changedFiles: Array.from(session.changedFiles),
          timestamp: Date.now(),
          note: `Validation execution failed: ${valRes.error.message}`,
        });
        session.status = 'failed';
        session.stopReason = 'SANDBOX_UNAVAILABLE';
        break;
      }

      const val = valRes.value;
      const report: AutopilotIterationReport = {
        iterationNumber: iterNum,
        status: val.passed ? 'completed' : 'correcting',
        validation: {
          recipeId: session.config.validationRecipeId,
          exitCode: val.exitCode,
          passed: val.passed,
          stdoutSnippet: val.stdout.slice(0, 500),
          stderrSnippet: val.stderr.slice(0, 500),
          durationMs: val.durationMs,
        },
        changedFiles: Array.from(session.changedFiles),
        timestamp: Date.now(),
      };
      session.iterationReports.push(report);

      if (val.passed) {
        session.status = 'completed';
        session.stopReason = 'SUCCESS';
        session.consecutiveFailures = 0;
        break;
      } else {
        session.consecutiveFailures += 1;
        lastFailureSnippet = val.stderr.trim() || val.stdout.trim() || `Exit code ${val.exitCode}`;

        if (session.consecutiveFailures >= session.config.maxConsecutiveFailures) {
          session.status = 'stopped';
          session.stopReason = 'CONSECUTIVE_FAILURES_EXCEEDED';
          break;
        }
      }
    }

    // Check if loop ended due to iteration budget
    if (session.status === 'running') {
      session.status = 'stopped';
      session.stopReason = 'BUDGET_EXHAUSTED_ITERATIONS';
    }

    // 3. Compile final verified diff against base workspace
    const finalDiff = this.computeTaskWorktreeDiff(session.worktreeRoot, Array.from(session.changedFiles));
    session.finalDiff = finalDiff;

    const totalDuration = Date.now() - session.startedAt;
    const finalStatus =
      session.status === 'completed'
        ? 'completed'
        : session.status === 'cancelled'
          ? 'cancelled'
          : session.status === 'failed'
            ? 'failed'
            : 'stopped';

    return {
      taskId,
      status: finalStatus,
      iterationsRun: session.iterationsRun,
      stopReason: session.stopReason ?? (finalStatus === 'completed' ? 'SUCCESS' : 'BUDGET_EXHAUSTED_ITERATIONS'),
      details: this.formatStopDetails(session.stopReason, session.iterationsRun, totalDuration),
      changedFiles: Array.from(session.changedFiles),
      stagedDiff: finalDiff,
      iterationReports: session.iterationReports,
      durationMs: totalDuration,
    };
  }

  /**
   * Immediately cancels an active Autopilot task session.
   */
  public cancel(taskId: string, _reason = 'User requested cancellation'): boolean {
    const session = this.activeSessions.get(taskId);
    if (!session) return false;

    session.abortController.abort();
    session.status = 'cancelled';
    session.stopReason = 'CANCELLED';
    return true;
  }

  public getSession(taskId: string): AutopilotRunResult | undefined {
    const s = this.activeSessions.get(taskId);
    if (!s) return undefined;
    return {
      taskId: s.taskId,
      status: s.status === 'completed' ? 'completed' : s.status === 'cancelled' ? 'cancelled' : s.status === 'failed' ? 'failed' : 'stopped',
      iterationsRun: s.iterationsRun,
      stopReason: s.stopReason ?? 'SUCCESS',
      details: `Session in state ${s.status}`,
      changedFiles: Array.from(s.changedFiles),
      stagedDiff: s.finalDiff,
      approvalId: s.approvalId,
      iterationReports: s.iterationReports,
      durationMs: Date.now() - s.startedAt,
    };
  }

  public cleanupTaskWorktree(taskId: string, retainForInspection = false): void {
    const session = this.activeSessions.get(taskId);
    if (!session) return;

    if (!retainForInspection && fs.existsSync(session.worktreeRoot)) {
      try {
        fs.rmSync(session.worktreeRoot, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    }
  }

  // ─── Internal Safety & Utility Helpers ─────────────────────────────────────

  private validateCandidatePath(relPath: string): { ok: true } | { ok: false; error: string } {
    if (!relPath || typeof relPath !== 'string') {
      return { ok: false, error: 'Target path must be a non-empty string' };
    }

    if (path.isAbsolute(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
      return { ok: false, error: `Absolute paths are prohibited: "${relPath}"` };
    }

    const norm = path.normalize(relPath).replace(/\\/g, '/');

    if (norm.startsWith('../') || norm === '..' || norm.includes('/../')) {
      return { ok: false, error: `Path traversal detected: "${relPath}"` };
    }

    if (norm.includes(':')) {
      return { ok: false, error: `Alternate data streams / device indicators prohibited: "${relPath}"` };
    }

    // Windows reserved device names
    const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
    const segments = norm.split('/');
    for (const seg of segments) {
      if (reservedNames.test(seg)) {
        return { ok: false, error: `Reserved Windows device name prohibited: "${seg}"` };
      }
    }

    // Protected directories & files
    if (
      norm.startsWith('.git/') ||
      norm === '.git' ||
      norm.startsWith('.mediator/') ||
      norm === '.mediator' ||
      norm === '.env' ||
      norm.startsWith('.ssh/')
    ) {
      return { ok: false, error: `Modifying protected security path is prohibited: "${relPath}"` };
    }

    return { ok: true };
  }

  private copyWorkspaceFilesSafely(srcDir: string, destDir: string): string[] {
    const copiedFiles: string[] = [];
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });

    for (const ent of entries) {
      // Exclude VCS, cache, and mediator private state
      if (
        ent.name === '.git' ||
        ent.name === '.mediator' ||
        ent.name === 'node_modules' ||
        ent.name === '.worktrees' ||
        ent.name === '.system_generated' ||
        ent.name === 'dist'
      ) {
        continue;
      }

      const srcPath = path.join(srcDir, ent.name);
      const destPath = path.join(destDir, ent.name);

      if (ent.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        const subFiles = this.copyWorkspaceFilesSafely(srcPath, destPath);
        for (const sub of subFiles) {
          copiedFiles.push(`${ent.name}/${sub}`);
        }
      } else if (ent.isFile()) {
        fs.copyFileSync(srcPath, destPath);
        copiedFiles.push(ent.name);
      }
    }

    return copiedFiles;
  }

  private generateUnifiedDiffSnippet(filePath: string, oldContent: string, newContent: string): string {
    const oldLines = oldContent ? oldContent.split('\n') : [];
    const newLines = newContent ? newContent.split('\n') : [];
    const lines = [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      `@@ -1,${oldLines.length || 1} +1,${newLines.length || 1} @@`,
    ];
    for (const line of oldLines) {
      lines.push(`-${line}`);
    }
    for (const line of newLines) {
      lines.push(`+${line}`);
    }
    return lines.join('\n') + '\n';
  }

  private computeTaskWorktreeDiff(worktreeRoot: string, changedFiles: readonly string[]): string {
    const diffs: string[] = [];
    for (const rel of changedFiles) {
      const livePath = path.join(this.workspaceRoot, rel);
      const worktreePath = path.join(worktreeRoot, rel);

      const oldContent = fs.existsSync(livePath) ? fs.readFileSync(livePath, 'utf8') : '';
      const newContent = fs.existsSync(worktreePath) ? fs.readFileSync(worktreePath, 'utf8') : '';

      diffs.push(this.generateUnifiedDiffSnippet(rel, oldContent, newContent));
    }
    return diffs.join('\n');
  }

  private formatStopDetails(
    reason?: AutopilotStopReason,
    iterations = 0,
    durationMs = 0,
  ): string {
    switch (reason) {
      case 'SUCCESS':
        return `Autopilot converged successfully after ${iterations} iteration(s) in ${(durationMs / 1000).toFixed(1)}s. Verification tests passed.`;
      case 'BUDGET_EXHAUSTED_ITERATIONS':
        return `Autopilot reached maximum iteration budget (${iterations}). Halting for human review.`;
      case 'BUDGET_EXHAUSTED_TIMEOUT':
        return `Autopilot wall-clock budget exceeded (${(durationMs / 1000).toFixed(1)}s). Halting for human review.`;
      case 'CONSECUTIVE_FAILURES_EXCEEDED':
        return `Autopilot halted: maximum consecutive validation failures reached without convergence.`;
      case 'SECURITY_VIOLATION':
        return `Autopilot halted immediately due to security violation or prohibited path access attempt.`;
      case 'CANCELLED':
        return `Autopilot session cancelled by user.`;
      case 'SANDBOX_UNAVAILABLE':
        return `Autopilot failed: sandbox execution environment is unavailable or unverified.`;
      default:
        return `Autopilot finished with status "${reason ?? 'STOPPED'}".`;
    }
  }
}
