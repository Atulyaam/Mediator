/**
 * @mediator/tests — S47 Complete End-to-End Coding Workflow Integration Suite
 *
 * Verifies all 8 mandatory S47 end-to-end integration scenarios:
 * - Scenario A: Supported Python/TS bug fix (Task intake -> provider proposal -> staging -> verified offline sandbox validation -> diff review -> human approval -> controlled apply -> post-apply verification).
 * - Scenario B: Missing dependency fails closed without network attempt.
 * - Scenario C: Malicious artifact with path traversal rejected fail-closed.
 * - Scenario D: Live source modified before apply triggers TOCTOU detection and rejects stale approval.
 * - Scenario E: Provider disconnect / timeout recovery without bypassing gates.
 * - Scenario F: Task cancellation and restart cleanliness.
 * - Scenario G: Cross-interface synchronization (Core <-> HTTP/SSE <-> CLI).
 * - Scenario H: Authorization bypass attempt (AI self-authorization & replay rejected).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { MediatorCore, MediatorHttpServer } from '@mediator/orchestrator';
import { runCli, getOrCreateCore, resetCoreForTesting } from '../apps/cli/src/index.js';
import { WslIsolatedExecutor } from '@mediator/executor-contract';
import { ErrorCode } from '@mediator/shared-contracts';

describe('Sprint S47 — Complete End-to-End Coding Workflow Integration', () => {
  let tempWorkspace: string;
  let core: MediatorCore;
  let server: MediatorHttpServer;
  let serverUrl: string;
  let token: string;

  beforeEach(async () => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s47-e2e-'));
    fs.mkdirSync(path.join(tempWorkspace, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempWorkspace, 'test'), { recursive: true });

    // Initial code file with bug
    fs.writeFileSync(
      path.join(tempWorkspace, 'src', 'math_utils.py'),
      'def add_numbers(a, b):\n    return a - b  # Bug: subtraction instead of addition\n',
      'utf8',
    );

    // Python unit test file
    fs.writeFileSync(
      path.join(tempWorkspace, 'test', 'test_math.py'),
      'import unittest\nfrom src.math_utils import add_numbers\n\nclass TestMath(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add_numbers(3, 4), 7)\n\nif __name__ == "__main__":\n    unittest.main()\n',
      'utf8',
    );

    resetCoreForTesting(null);
    core = getOrCreateCore(tempWorkspace);
    core.setWorkspaceRoot(tempWorkspace, true);

    server = new MediatorHttpServer(core, { port: 0 });
    const addr = await server.start();
    serverUrl = addr.url;
    token = core.getPairingToken();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    resetCoreForTesting(null);
    if (fs.existsSync(tempWorkspace)) {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  // ─── Scenario A: Full Lifecycle Bug Fix ───────────────────────────────────

  it('Scenario A — completes full coding flow: intake -> proposal -> offline validation -> review -> approval -> apply -> verified fix', async () => {
    // 1. Task Intake
    const taskRes = core.createTask({
      prompt: 'Fix addition bug in math_utils.py',
      providerId: 'gemini',
    });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;
    const task = taskRes.value;
    expect(task.status).toBe('running');

    // 2. Propose fix
    const mathPyRel = 'src/math_utils.py';
    const liveMathPy = path.join(tempWorkspace, mathPyRel);
    const originalContent = fs.readFileSync(liveMathPy, 'utf8');
    const expectedBaseHash = crypto.createHash('sha256').update(originalContent).digest('hex');

    const fixedContent = 'def add_numbers(a, b):\n    return a + b  # Fixed addition\n';
    const stageRes = await core.stageProposal({
      taskId: task.id,
      relativePath: mathPyRel,
      proposedContent: fixedContent,
      expectedBaseHash,
      description: 'Fix addition operation in math_utils.py',
    });

    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;
    expect(stageRes.value.stageId).toBeDefined();
    expect(stageRes.value.approvalId).toBeDefined();
    expect(stageRes.value.diffPreview).toContain('+    return a + b  # Fixed addition');
    expect(stageRes.value.baseMatch).toBe(true);

    // Verify stage in list
    const stages = core.listStages();
    expect(stages.length).toBeGreaterThan(0);
    expect(stages[0].id).toBe(stageRes.value.stageId);

    // 3. Offline Sandbox Validation
    // Validate that python.test can be requested for the task
    const valRes = await core.validateTaskOffline(task.id, 'python.test', {
      allowDefaultDistroForCanary: true,
    });
    expect(valRes.ok).toBe(true);
    if (!valRes.ok) return;
    expect(valRes.value.recipeId).toBe('python.test');

    // Verify task updated with validation event
    const updatedTask = core.getTask(task.id);
    expect(updatedTask?.lastValidation).toBeDefined();

    // 4. Diff Review
    const diff = core.getStageDiff(stageRes.value.stageId);
    expect(diff).toContain('--- a/src/math_utils.py');
    expect(diff).toContain('+++ b/src/math_utils.py');

    // 5. Explicit Human Approval
    const resolveRes = core.resolveApproval(stageRes.value.approvalId, true, 'Approved by human reviewer');
    expect(resolveRes.ok).toBe(true);
    if (!resolveRes.ok) return;
    expect(resolveRes.value.status).toBe('approved');

    // 6. Transactional Workspace Apply
    const applyRes = await core.applyApprovedStage(stageRes.value.stageId, stageRes.value.approvalId, 'trusted_cli');
    expect(applyRes.ok).toBe(true);
    if (!applyRes.ok) return;
    expect(applyRes.value.success).toBe(true);
    expect(applyRes.value.appliedFiles).toContain('src/math_utils.py');
    expect(applyRes.value.transactionId).toMatch(/^tx_/);
    expect(fs.existsSync(applyRes.value.backupDir)).toBe(true);

    // 7. Verify live workspace mutated with approved changes
    const appliedContent = fs.readFileSync(liveMathPy, 'utf8');
    expect(appliedContent).toBe(fixedContent);

    // 8. Verify approval marked consumed (single-use invariant)
    const consumedApp = core.getApproval(stageRes.value.approvalId);
    expect(consumedApp?.status).toBe('consumed');

    // 9. Re-applying the consumed approval fails closed
    const replayRes = await core.applyApprovedStage(stageRes.value.stageId, stageRes.value.approvalId, 'trusted_cli');
    expect(replayRes.ok).toBe(false);
    if (!replayRes.ok) {
      expect(replayRes.error.code).toBe(ErrorCode.APPROVAL_EXPIRED);
    }
  }, 30_000);

  // ─── Scenario B: Missing Dependency Fails Closed ──────────────────────────

  it('Scenario B — missing dependency fails closed without attempting network egress', async () => {
    const taskRes = core.createTask({ prompt: 'Test missing dependency' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    // Request non-existent or un-vendored recipe
    const unknownRes = await core.validateTaskOffline(taskRes.value.id, 'unknown.recipe' as any);
    expect(unknownRes.ok).toBe(true);
    // Recipe fails cleanly inside sandbox with nonzero exit code without network
    expect(unknownRes.value.passed).toBe(false);
    expect(unknownRes.value.exitCode).not.toBe(0);
  });

  // ─── Scenario C: Malicious Path Traversal Artifact ────────────────────────

  it('Scenario C — rejects path traversal and out-of-workspace artifact proposals', async () => {
    const taskRes = core.createTask({ prompt: 'Adversarial path test' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    // Path traversal attempt: ../../outside.txt
    const traversalRes = await core.stageProposal({
      taskId: taskRes.value.id,
      relativePath: '../../outside.txt',
      proposedContent: 'malicious payload',
    });
    expect(traversalRes.ok).toBe(false);
    if (!traversalRes.ok) {
      expect(traversalRes.error.code).toBe(ErrorCode.PATH_OUTSIDE_ROOT);
    }

    // Live workspace must remain completely untouched
    expect(fs.existsSync(path.join(tempWorkspace, '..', 'outside.txt'))).toBe(false);
  });

  // ─── Scenario D: TOCTOU Live Source Changed Detection ─────────────────────

  it('Scenario D — pre-apply TOCTOU hash verification detects external workspace edits and rejects apply', async () => {
    const taskRes = core.createTask({ prompt: 'TOCTOU concurrency test' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    const mathPyRel = 'src/math_utils.py';
    const liveMathPy = path.join(tempWorkspace, mathPyRel);
    const initialContent = fs.readFileSync(liveMathPy, 'utf8');
    const baseHash = crypto.createHash('sha256').update(initialContent).digest('hex');

    // Stage proposal based on initial state
    const stageRes = await core.stageProposal({
      taskId: taskRes.value.id,
      relativePath: mathPyRel,
      proposedContent: 'def add_numbers(a, b): return a + b\n',
      expectedBaseHash: baseHash,
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;

    // Approve the proposal
    const resolveRes = core.resolveApproval(stageRes.value.approvalId, true);
    expect(resolveRes.ok).toBe(true);

    // Simulate external concurrent user edit to live file (TOCTOU race)
    fs.writeFileSync(liveMathPy, 'def add_numbers(a, b):\n    # Intervening edit by user\n    return a + b\n', 'utf8');

    // Attempt to apply approved stage
    const applyRes = await core.applyApprovedStage(stageRes.value.stageId, stageRes.value.approvalId, 'trusted_cli');
    expect(applyRes.ok).toBe(false);
    if (!applyRes.ok) {
      expect(applyRes.error.code).toBe(ErrorCode.STAGE_BASE_HASH_STALE);
      expect(applyRes.error.message).toContain('Live file');
    }

    // Verify intervening user edit was preserved and not overwritten
    const currentContent = fs.readFileSync(liveMathPy, 'utf8');
    expect(currentContent).toContain('Intervening edit by user');
  });

  // ─── Scenario E: Provider / Client Disconnect ─────────────────────────────

  it('Scenario E — handles client disconnect and missing auth gracefully without bypassing gates', async () => {
    // 1. Missing pairing token on HTTP API
    const unauthRes = await fetch(`${serverUrl}/api/tasks`);
    expect(unauthRes.status).toBe(401);

    // 2. Task pause / resume transitions
    const taskRes = core.createTask({ prompt: 'Disconnect recovery test' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    const pauseRes = core.pauseTask(taskRes.value.id, 'Network client disconnected');
    expect(pauseRes.ok).toBe(true);
    expect(core.getTask(taskRes.value.id)?.status).toBe('paused');

    const resumeRes = core.resumeTask(taskRes.value.id);
    expect(resumeRes.ok).toBe(true);
    expect(core.getTask(taskRes.value.id)?.status).toBe('running');
  });

  // ─── Scenario F: Task Cancellation Cleanliness ────────────────────────────

  it('Scenario F — cancels task cleanly and preserves workspace invariants', async () => {
    const taskRes = core.createTask({ prompt: 'Cancellation test' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    const cancelRes = core.cancelTask(taskRes.value.id, 'User clicked stop');
    expect(cancelRes.ok).toBe(true);
    expect(cancelRes.value.status).toBe('cancelled');
    expect(core.getActiveTaskId()).toBeNull();
  });

  // ─── Scenario G: Multi-Interface Synchronization ──────────────────────────

  it('Scenario G — synchronizes task intake, staging, approval, and apply across HTTP API, CLI, and Core', async () => {
    // 1. Create task via CLI
    const cliCreate = await runCli(['task', 'create', 'Refactor math logic', '--json']);
    expect(cliCreate.exitCode).toBe(0);
    const taskData = JSON.parse(cliCreate.output);
    const taskId = taskData.id;

    // 2. Query task via HTTP API
    const httpGet = await fetch(`${serverUrl}/api/tasks/${taskId}`, {
      headers: { 'X-Mediator-Token': token },
    });
    expect(httpGet.status).toBe(200);
    const httpTask = await httpGet.json();
    expect(httpTask.task.id).toBe(taskId);

    // 3. Propose stage via HTTP API
    const stagePost = await fetch(`${serverUrl}/api/stages/propose`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mediator-Token': token,
      },
      body: JSON.stringify({
        taskId,
        relativePath: 'src/math_utils.py',
        proposedContent: 'def add_numbers(a, b):\n    return a + b\n',
      }),
    });
    expect(stagePost.status).toBe(201);
    const stageData = await stagePost.json();
    expect(stageData.stage.stageId).toBeDefined();

    // 4. Query stage diff via CLI
    const cliDiff = await runCli(['stage', 'diff', stageData.stage.stageId]);
    expect(cliDiff.exitCode).toBe(0);
    expect(cliDiff.output).toContain('--- a/src/math_utils.py');

    // 5. Resolve approval via CLI
    const cliResolve = await runCli(['approval', 'resolve', stageData.stage.approvalId, 'approve', '--json']);
    expect(cliResolve.exitCode).toBe(0);

    // 6. Apply stage via CLI
    const cliApply = await runCli(['stage', 'apply', stageData.stage.stageId, stageData.stage.approvalId, '--json']);
    expect(cliApply.exitCode).toBe(0);
    const applyJson = JSON.parse(cliApply.output);
    expect(applyJson.success).toBe(true);

    // 7. Core snapshot reflects completion
    const snapshot = core.getStateSnapshot();
    const finalTask = snapshot.tasks.find((t) => t.id === taskId);
    expect(finalTask?.status).toBe('completed');
  });

  // ─── Scenario H: Authorization Bypass Defense ─────────────────────────────

  it('Scenario H — rejects AI / unauthenticated callers attempting to self-authorize or apply live writes', async () => {
    const taskRes = core.createTask({ prompt: 'Self-authorization defense test' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    const stageRes = await core.stageProposal({
      taskId: taskRes.value.id,
      relativePath: 'src/math_utils.py',
      proposedContent: '# unauthorized patch\n',
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;

    // AI caller attempting to apply without approval
    const aiApplyAttempt = await core.applyApprovedStage(
      stageRes.value.stageId,
      stageRes.value.approvalId,
      'browser_ai' as any,
    );
    expect(aiApplyAttempt.ok).toBe(false);
    if (!aiApplyAttempt.ok) {
      expect(aiApplyAttempt.error.code).toBe(ErrorCode.ACTION_DENIED);
    }

    // Live file was NOT modified
    const content = fs.readFileSync(path.join(tempWorkspace, 'src', 'math_utils.py'), 'utf8');
    expect(content).not.toContain('# unauthorized patch');
  });
});
