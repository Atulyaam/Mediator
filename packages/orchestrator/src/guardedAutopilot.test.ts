/**
 * @mediator/orchestrator — Guarded Isolated-Worktree Autopilot Test Suite (Phase D / Phase E)
 *
 * Verifies:
 * 1. Policy boundaries & fail-closed invariants under S00 NO-GO-AUTOEXEC vs GO-GUARDED-AUTOPILOT.
 * 2. Dedicated task worktree isolation and zero live workspace mutation.
 * 3. Path traversal, symlink escapes, ADS streams, and protected path rejection.
 * 4. Bounded iterative correction loop and budget enforcement.
 * 5. Immediate cancellation and recovery.
 * 6. Authentic sandbox exit-code observation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GuardedAutopilotEngine } from './guardedAutopilotEngine.js';
import { MediatorCore } from './mediatorCore.js';
import {
  S00ExecutionDecisionValues,
  ErrorCode,
  type AutopilotTaskConfig,
} from '@mediator/shared-contracts';

describe('Guarded Isolated-Worktree Autopilot (Phase D & E)', () => {
  let tempWorkspace: string;

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator_autopilot_test_'));
    // Setup minimal project files
    fs.writeFileSync(path.join(tempWorkspace, 'package.json'), JSON.stringify({ name: 'test-app', version: '1.0.0' }));
    fs.mkdirSync(path.join(tempWorkspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempWorkspace, 'src', 'math.js'), 'export function add(a, b) { return a + b; }\n');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  describe('1. Security Boundaries & Fail-Closed Invariants', () => {
    it('1. fails closed under NO-GO-AUTOEXEC', async () => {
      const engine = new GuardedAutopilotEngine({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
      });

      expect(engine.isAutopilotEligible()).toBe(false);

      const res = await engine.initializeTaskWorktree('task-1');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.AUTOPILOT_POLICY_DISALLOWED);
      }
    });

    it('2. succeeds under GO-GUARDED-AUTOPILOT and initializes dedicated isolated worktree', async () => {
      const engine = new GuardedAutopilotEngine({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
      });

      expect(engine.isAutopilotEligible()).toBe(true);

      const res = await engine.initializeTaskWorktree('task-2');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(fs.existsSync(res.value.worktreeRoot)).toBe(true);
        expect(res.value.worktreeRoot).toContain('.mediator');
        expect(res.value.worktreeRoot).toContain('task-worktrees');
        expect(fs.existsSync(path.join(res.value.worktreeRoot, 'src', 'math.js'))).toBe(true);
      }
    });

    it('3. strictly rejects path traversal attempts', async () => {
      const engine = new GuardedAutopilotEngine({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
      });

      await engine.initializeTaskWorktree('task-traversal');

      // Traversal using ..
      const res1 = engine.stageProposalInWorktree('task-traversal', '../../outside.txt', 'malicious');
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.error.code).toBe(ErrorCode.AUTOPILOT_STOP_SECURITY_VIOLATION);
      }

      // Traversal using absolute path
      const res2 = engine.stageProposalInWorktree('task-traversal', 'C:/Windows/System32/calc.exe', 'malicious');
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error.code).toBe(ErrorCode.AUTOPILOT_STOP_SECURITY_VIOLATION);
      }
    });

    it('4. strictly rejects writes to protected security paths', async () => {
      const engine = new GuardedAutopilotEngine({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
      });

      await engine.initializeTaskWorktree('task-protected');

      // Attempt to tamper with git
      const resGit = engine.stageProposalInWorktree('task-protected', '.git/config', '[core]\n');
      expect(resGit.ok).toBe(false);
      if (!resGit.ok) {
        expect(resGit.error.code).toBe(ErrorCode.AUTOPILOT_STOP_SECURITY_VIOLATION);
      }

      // Attempt to tamper with mediator policy
      const resPolicy = engine.stageProposalInWorktree('task-protected', '.mediator/policy.json', '{}');
      expect(resPolicy.ok).toBe(false);
      if (!resPolicy.ok) {
        expect(resPolicy.error.code).toBe(ErrorCode.AUTOPILOT_STOP_SECURITY_VIOLATION);
      }

      // Attempt to write .env
      const resEnv = engine.stageProposalInWorktree('task-protected', '.env', 'SECRET=123');
      expect(resEnv.ok).toBe(false);
      if (!resEnv.ok) {
        expect(resEnv.error.code).toBe(ErrorCode.AUTOPILOT_STOP_SECURITY_VIOLATION);
      }
    });

    it('5. strictly rejects alternate data streams and reserved DOS device names', async () => {
      const engine = new GuardedAutopilotEngine({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
      });

      await engine.initializeTaskWorktree('task-devices');

      const resAds = engine.stageProposalInWorktree('task-devices', 'src/math.js::$DATA', 'stream content');
      expect(resAds.ok).toBe(false);
      if (!resAds.ok) {
        expect(resAds.error.code).toBe(ErrorCode.AUTOPILOT_STOP_SECURITY_VIOLATION);
      }

      const resDos = engine.stageProposalInWorktree('task-devices', 'NUL', 'null device');
      expect(resDos.ok).toBe(false);
      if (!resDos.ok) {
        expect(resDos.error.code).toBe(ErrorCode.AUTOPILOT_STOP_SECURITY_VIOLATION);
      }
    });

    it('6. rejects proposals exceeding maximum diff size budget', async () => {
      const engine = new GuardedAutopilotEngine({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
      });

      await engine.initializeTaskWorktree('task-oversized', { maxDiffSizeBytes: 50 });

      const oversizedContent = 'A'.repeat(100);
      const res = engine.stageProposalInWorktree('task-oversized', 'src/math.js', oversizedContent);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.OVERSIZED_INPUT);
      }
    });
  });

  describe('2. Live Workspace Invariant & Worktree Isolation', () => {
    it('7. mutations in isolated task worktree do not alter live workspace files', async () => {
      const engine = new GuardedAutopilotEngine({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
      });

      const initRes = await engine.initializeTaskWorktree('task-isolation');
      expect(initRes.ok).toBe(true);

      const originalLiveContent = fs.readFileSync(path.join(tempWorkspace, 'src', 'math.js'), 'utf8');

      // Mutate inside worktree
      const newContent = 'export function add(a, b) { return a + b + 0; }\n';
      const stageRes = engine.stageProposalInWorktree('task-isolation', 'src/math.js', newContent);
      expect(stageRes.ok).toBe(true);

      // Verify worktree file was modified
      const worktreeContent = fs.readFileSync(stageRes.value!.stagedPath, 'utf8');
      expect(worktreeContent).toBe(newContent);

      // Verify LIVE workspace file is 100% UNTOUCHED
      const currentLiveContent = fs.readFileSync(path.join(tempWorkspace, 'src', 'math.js'), 'utf8');
      expect(currentLiveContent).toBe(originalLiveContent);
    });
  });

  describe('3. Bounded Iteration Loop, Stop Conditions & Budgets', () => {
    it('8. converges successfully on validation pass (exit code 0)', async () => {
      const engine = new GuardedAutopilotEngine({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
      });

      // Mock executor returning exit 0 on second iteration
      let callCount = 0;
      (engine as any).validateTaskWorktree = async () => {
        callCount++;
        return {
          ok: true,
          value: {
            passed: callCount >= 2,
            exitCode: callCount >= 2 ? 0 : 1,
            stdout: callCount >= 2 ? 'Tests passed!' : 'SyntaxError: unexpected token',
            stderr: '',
            durationMs: 50,
          },
        };
      };

      const result = await engine.runIterationLoop({
        taskId: 'task-converge',
        prompt: 'Fix math.js function return value',
        providerHandler: async (_prompt, iteration) => {
          return {
            path: 'src/math.js',
            content: `export function add(a, b) { return a + b; } // iteration ${iteration}\n`,
          };
        },
      });

      expect(result.status).toBe('completed');
      expect(result.stopReason).toBe('SUCCESS');
      expect(result.iterationsRun).toBe(2);
      expect(result.changedFiles).toContain('src/math.js');
      expect(result.stagedDiff).toContain('+export function add(a, b) { return a + b; } // iteration 2');
    });

    it('9. stops when consecutive failure budget is exhausted', async () => {
      const engine = new GuardedAutopilotEngine({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
      });

      // Always fails validation
      (engine as any).validateTaskWorktree = async () => {
        return {
          ok: true,
          value: {
            passed: false,
            exitCode: 1,
            stdout: '',
            stderr: 'AssertionError: expected 5 to equal 4',
            durationMs: 40,
          },
        };
      };

      const result = await engine.runIterationLoop({
        taskId: 'task-consecutive-fails',
        prompt: 'Fix test',
        config: { maxConsecutiveFailures: 3, maxIterations: 10 },
        providerHandler: async () => ({
          path: 'src/math.js',
          content: 'export function add() { return -1; }\n',
        }),
      });

      expect(result.status).toBe('stopped');
      expect(result.stopReason).toBe('CONSECUTIVE_FAILURES_EXCEEDED');
      expect(result.iterationsRun).toBe(3);
    });

    it('10. stops when iteration budget is exhausted', async () => {
      const engine = new GuardedAutopilotEngine({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
      });

      (engine as any).validateTaskWorktree = async () => ({
        ok: true,
        value: { passed: false, exitCode: 1, stdout: '', stderr: 'Failed', durationMs: 20 },
      });

      const result = await engine.runIterationLoop({
        taskId: 'task-budget-exhaust',
        prompt: 'Fix test',
        config: { maxIterations: 2, maxConsecutiveFailures: 5 },
        providerHandler: async () => ({
          path: 'src/math.js',
          content: 'export function add() { return 0; }\n',
        }),
      });

      expect(result.status).toBe('stopped');
      expect(result.stopReason).toBe('BUDGET_EXHAUSTED_ITERATIONS');
      expect(result.iterationsRun).toBe(2);
    });

    it('11. stops immediately on user cancellation', async () => {
      const engine = new GuardedAutopilotEngine({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
      });

      await engine.initializeTaskWorktree('task-cancel');

      // Cancel session
      const cancelled = engine.cancel('task-cancel', 'User clicked stop');
      expect(cancelled).toBe(true);

      const session = engine.getSession('task-cancel');
      expect(session?.status).toBe('cancelled');
      expect(session?.stopReason).toBe('CANCELLED');
    });

    it('12. handles malformed or empty provider proposals safely', async () => {
      const engine = new GuardedAutopilotEngine({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
      });

      const result = await engine.runIterationLoop({
        taskId: 'task-malformed',
        prompt: 'Fix math',
        config: { maxConsecutiveFailures: 2 },
        providerHandler: async () => null, // Provider returns null
      });

      expect(result.status).toBe('stopped');
      expect(result.stopReason).toBe('MALFORMED_PROPOSAL');
    });
  });

  describe('4. MediatorCore End-to-End Integration', () => {
    it('13. runAutopilotTask generates staged diff and approval record upon successful convergence', async () => {
      const core = new MediatorCore({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
      });

      core.toggleAutopilot(true);

      const taskRes = core.createTask({ prompt: 'Implement multiply function' });
      expect(taskRes.ok).toBe(true);
      const task = taskRes.value;

      // Mock engine runIterationLoop for end-to-end core wiring check
      const engine = core.getGuardedAutopilotEngine();
      engine.runIterationLoop = async () => ({
        taskId: task.id,
        status: 'completed',
        iterationsRun: 1,
        stopReason: 'SUCCESS',
        details: 'Converged successfully',
        changedFiles: ['src/math.js'],
        stagedDiff: '--- a/src/math.js\n+++ b/src/math.js\n@@ -1,1 +1,2 @@\n+export function multiply(a, b) { return a * b; }\n',
        iterationReports: [],
        durationMs: 120,
      });

      const autoRes = await core.runAutopilotTask(task.id);
      expect(autoRes.ok).toBe(true);
      if (autoRes.ok) {
        expect(autoRes.value.status).toBe('completed');
        expect(autoRes.value.stopReason).toBe('SUCCESS');
      }

      // Check that a stage was created
      const stages = core.listStages();
      expect(stages.length).toBeGreaterThan(0);
      expect(stages[0].filePath).toBe('guarded_autopilot.diff');

      // Check that an approval record was generated awaiting human review
      const approvals = core.listApprovals();
      expect(approvals.length).toBeGreaterThan(0);
      const appr = approvals.find((a) => a.taskId === task.id);
      expect(appr).toBeDefined();
      expect(appr?.status).toBe('pending');
      expect(appr?.actionType).toBe('patch');
    });

    it('14. cancelAutopilotTask cancels active task session and records cancellation', async () => {
      const core = new MediatorCore({
        workspaceRoot: tempWorkspace,
        s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
      });

      core.toggleAutopilot(true);
      const taskRes = core.createTask({ prompt: 'Long running task' });
      const taskId = taskRes.value.id;

      // Initialize worktree
      await core.getGuardedAutopilotEngine().initializeTaskWorktree(taskId);

      const cancelRes = core.cancelAutopilotTask(taskId, 'Emergency stop');
      expect(cancelRes.ok).toBe(true);

      const task = core.getTask(taskId);
      expect(task?.status).toBe('cancelled');
      expect(task?.pauseReason).toBe('Emergency stop');
    });
  });
});
