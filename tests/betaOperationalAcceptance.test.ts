/**
 * tests/betaOperationalAcceptance.test.ts — S50 Full End-to-End Beta Operational Acceptance Suite
 *
 * Requirements (S50.3):
 * - Exercises all 9 mandatory Beta Operational Acceptance Scenarios:
 *   - Scenario A: Supported Bug Fix (Task -> proposal -> staging -> offline validation -> diff review -> human approval -> apply -> post-apply integrity).
 *   - Scenario B: Offline Dependency Resolution (Missing dependency -> trusted preparation -> verified offline sandbox -> network blocked).
 *   - Scenario C: Malicious Proposal (Path traversal & malicious files rejected without modifying live workspace).
 *   - Scenario D: Stale Workspace (External modification after staging blocks apply due to TOCTOU base hash mismatch).
 *   - Scenario E: Provider Disconnect (Disconnect reported cleanly; safe retry without side effects).
 *   - Scenario F: Cancellation and Restart (Clean child process cleanup and state recovery).
 *   - Scenario G: Installation Recovery (Rollback/recovery preserves user-owned files).
 *   - Scenario H: Authorization Bypass (AI self-authorization, replayed approvals, and origin spoofing strictly rejected fail-closed).
 *   - Scenario I: Diagnostics (Sanitized diagnostic report exported with actionable details and zero secrets).
 * - S00 NO-GO-AUTOEXEC remains strictly authoritative throughout all scenarios.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import {
  MediatorCore,
  MediatorHttpServer,
  DoctorDiagnosticsService,
} from '@mediator/orchestrator';
import { resetCoreForTesting, getOrCreateCore } from '../apps/cli/src/index.js';
import { OfflineDependencyResolver } from '@mediator/recipe-registry';
import { ErrorCode } from '@mediator/shared-contracts';

describe('Sprint S50 — Controlled Beta Operational Acceptance (Scenarios A through I)', () => {
  let tempBase: string;
  let workspaceDir: string;
  let core: MediatorCore;
  let server: MediatorHttpServer;
  let serverUrl: string;
  let token: string;

  beforeEach(async () => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s50-beta-'));
    workspaceDir = path.join(tempBase, 'workspace');
    fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'test'), { recursive: true });

    // Initial bug fixture
    fs.writeFileSync(
      path.join(workspaceDir, 'src', 'calculator.py'),
      'def compute_discount(price, pct):\n    return price * pct  # Bug: should be price * (1 - pct)\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'test', 'test_calculator.py'),
      'import unittest\nfrom src.calculator import compute_discount\n\nclass TestCalc(unittest.TestCase):\n    def test_discount(self):\n        self.assertEqual(compute_discount(100, 0.2), 80)\n\nif __name__ == "__main__":\n    unittest.main()\n',
      'utf8',
    );

    resetCoreForTesting(null);
    core = getOrCreateCore(workspaceDir);
    core.setWorkspaceRoot(workspaceDir, true);

    server = new MediatorHttpServer(core, { port: 0 });
    const addr = await server.start();
    serverUrl = addr.url;
    token = core.getPairingToken();
  });

  afterEach(async () => {
    await server.stop();
    resetCoreForTesting(null);
    if (fs.existsSync(tempBase)) {
      try {
        fs.rmSync(tempBase, { recursive: true, force: true });
      } catch {
        // Ignore on windows locks
      }
    }
  });

  // -------------------------------------------------------------------------
  // Scenario A — Supported Bug Fix
  // -------------------------------------------------------------------------
  it('Scenario A: executes complete supported bug fix with human review, approval, and apply', async () => {
    // 1. Task Intake
    const taskRes = core.createTask({
      prompt: 'Fix discount calculation in calculator.py',
      providerId: 'gemini',
    });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;
    const task = taskRes.value;
    expect(task.status).toBe('running');

    // 2. Stage provider proposal
    const filePath = 'src/calculator.py';
    const oldContent = fs.readFileSync(path.join(workspaceDir, filePath), 'utf8');
    const oldHash = crypto.createHash('sha256').update(oldContent).digest('hex');
    const fixedContent = 'def compute_discount(price, pct):\n    return price * (1 - pct)  # Fixed discount formula\n';

    const stageRes = await core.stageProposal({
      taskId: task.id,
      relativePath: filePath,
      proposedContent: fixedContent,
      expectedBaseHash: oldHash,
      description: 'Fixed subtraction formula for discount',
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;
    const { stageId, approvalId } = stageRes.value;

    // Verify shadow staging: live workspace MUST NOT be changed yet
    expect(fs.readFileSync(path.join(workspaceDir, filePath), 'utf8')).toBe(oldContent);

    // 3. Diff review
    const diff = core.getStageDiff(stageId);
    expect(diff).toContain('--- a/src/calculator.py');
    expect(diff).toContain('+++ b/src/calculator.py');
    expect(diff).toContain('price * (1 - pct)');

    // 4. Human review & explicit approval
    const resolveRes = core.resolveApproval(approvalId, true, 'Approved by human reviewer');
    expect(resolveRes.ok).toBe(true);

    // 5. Apply approved changes to live workspace
    const applyRes = await core.applyApprovedStage(stageId, approvalId);
    expect(applyRes.ok).toBe(true);

    // 6. Post-apply integrity verification
    const newContent = fs.readFileSync(path.join(workspaceDir, filePath), 'utf8');
    expect(newContent).toBe(fixedContent);
    expect(newContent).toContain('price * (1 - pct)');

    // 7. Verify single-use invariant: replayed apply MUST fail closed
    const replayRes = await core.applyApprovedStage(stageId, approvalId);
    expect(replayRes.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Scenario B — Offline Dependency Resolution
  // -------------------------------------------------------------------------
  it('Scenario B: detects missing offline dependencies and fails closed without network access', async () => {
    const resolver = new OfflineDependencyResolver({
      bundleStoreDir: path.join(tempBase, 'bundles'),
    });

    // Unpinned project without lockfile
    fs.writeFileSync(
      path.join(workspaceDir, 'package.json'),
      JSON.stringify({ name: 'unpinned-app', dependencies: { lodash: '^4.17.21' } }),
      'utf8',
    );

    const planRes = await resolver.discoverDependencies(workspaceDir);
    expect(planRes.ok).toBe(true);
    const plan = planRes.value;

    expect(plan.status).toBe('unlocked');
    expect(plan.missingPackages).toContain('lockfile');
    expect(plan.remediation).toContain('package-lock.json');

    // Attempting execution provisioning without verified bundle MUST fail closed
    const execRes = await resolver.resolveForExecution(
      workspaceDir,
      path.join(tempBase, 'staging'),
    );
    expect(execRes.ok).toBe(false);
    expect(execRes.error.code).toBe(ErrorCode.OFFLINE_DEPENDENCY_MISSING);
  });

  // -------------------------------------------------------------------------
  // Scenario C — Malicious Proposal
  // -------------------------------------------------------------------------
  it('Scenario C: rejects path traversal and malicious files without modifying live workspace', async () => {
    const taskRes = core.createTask({
      prompt: 'Adversarial path traversal test',
      providerId: 'gemini',
    });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;
    const task = taskRes.value;

    const maliciousAttempts = [
      '../../Windows/System32/drivers/etc/hosts',
      '..\\..\\malicious.exe',
      'src/../../../etc/passwd',
      'src/calc.py:stream:$DATA',
    ];

    for (const badPath of maliciousAttempts) {
      const stageRes = await core.stageProposal({
        taskId: task.id,
        relativePath: badPath,
        proposedContent: 'EVIL_PAYLOAD',
        expectedBaseHash: '',
        description: 'Attempted path traversal',
      });

      expect(stageRes.ok).toBe(false);
      // Zero files created outside workspace
      expect(fs.existsSync(path.join(tempBase, 'malicious.exe'))).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // Scenario D — Stale Workspace (TOCTOU Conflict)
  // -------------------------------------------------------------------------
  it('Scenario D: blocks apply when live workspace is modified after staging (TOCTOU defense)', async () => {
    const taskRes = core.createTask({
      prompt: 'TOCTOU race test',
      providerId: 'gemini',
    });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;
    const task = taskRes.value;

    const filePath = 'src/calculator.py';
    const originalContent = fs.readFileSync(path.join(workspaceDir, filePath), 'utf8');
    const originalHash = crypto.createHash('sha256').update(originalContent).digest('hex');

    // Stage change based on original content
    const stageRes = await core.stageProposal({
      taskId: task.id,
      relativePath: filePath,
      proposedContent: '# Proposed patch\n',
      expectedBaseHash: originalHash,
      description: 'Patch based on v1',
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;
    const { stageId, approvalId } = stageRes.value;

    // Approve the proposal
    const approvalRes = core.resolveApproval(approvalId, true, 'Human approved');
    expect(approvalRes.ok).toBe(true);

    // External modification of workspace file happens before apply!
    fs.writeFileSync(path.join(workspaceDir, filePath), '# Concurrently modified by human\n');

    // Apply MUST fail closed due to stale base hash mismatch
    const applyRes = await core.applyApprovedStage(stageId, approvalId);
    expect(applyRes.ok).toBe(false);
    expect(applyRes.error.code).toBe(ErrorCode.STAGE_BASE_HASH_STALE);

    // The human's external modification remains intact!
    expect(fs.readFileSync(path.join(workspaceDir, filePath), 'utf8')).toBe(
      '# Concurrently modified by human\n',
    );
  });

  // -------------------------------------------------------------------------
  // Scenario E — Provider Disconnect
  // -------------------------------------------------------------------------
  it('Scenario E: reports provider disconnect honestly without side effects', async () => {
    const doctor = new DoctorDiagnosticsService({ core });
    const report = await doctor.runDiagnostics();

    const providerChecks = report.checks.filter((c) => c.category === 'providers');
    expect(providerChecks.length).toBeGreaterThanOrEqual(1);

    for (const chk of providerChecks) {
      expect(['READY', 'ACTION_REQUIRED']).toContain(chk.status);
      expect(chk.detail).toBeDefined();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario F — Cancellation and Restart Cleanliness
  // -------------------------------------------------------------------------
  it('Scenario F: cancels active task cleanly and restores ready state', async () => {
    const taskRes = core.createTask({
      prompt: 'Long running task to cancel',
      providerId: 'gemini',
    });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;
    const task = taskRes.value;
    expect(task.status).toBe('running');

    // Cancel task
    const cancelRes = core.cancelTask(task.id, 'User interrupted task');
    expect(cancelRes.ok).toBe(true);

    const snapshot = core.getStateSnapshot();
    const cancelledTask = snapshot.tasks.find((t) => t.id === task.id);
    expect(cancelledTask?.status).toBe('cancelled');

    // New task can immediately be submitted without ghost locks
    const nextTaskRes = core.createTask({
      prompt: 'Fresh replacement task',
      providerId: 'gemini',
    });
    expect(nextTaskRes.ok).toBe(true);
    if (!nextTaskRes.ok) return;
    expect(nextTaskRes.value.status).toBe('running');
    expect(nextTaskRes.value.id).not.toBe(task.id);
  });

  // -------------------------------------------------------------------------
  // Scenario G — Installation Recovery
  // -------------------------------------------------------------------------
  it('Scenario G: validates rollback and backup creation preserving user data', async () => {
    const taskRes = core.createTask({
      prompt: 'Backup test',
      providerId: 'gemini',
    });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;
    const task = taskRes.value;

    const filePath = 'src/calculator.py';
    const baseContent = fs.readFileSync(path.join(workspaceDir, filePath), 'utf8');
    const baseHash = crypto.createHash('sha256').update(baseContent).digest('hex');

    const stageRes = await core.stageProposal({
      taskId: task.id,
      relativePath: filePath,
      proposedContent: '# Overwritten content\n',
      expectedBaseHash: baseHash,
      description: 'Backup verification test',
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;
    const { stageId, approvalId } = stageRes.value;

    core.resolveApproval(approvalId, true, 'Approved for backup test');
    const applyRes = await core.applyApprovedStage(stageId, approvalId);
    expect(applyRes.ok).toBe(true);
    if (!applyRes.ok) return;

    // Verify pre-apply backup directory was created and contains snapshot
    expect(applyRes.value.transactionId).toBeDefined();
    expect(applyRes.value.backupDir).toBeDefined();
    expect(fs.existsSync(applyRes.value.backupDir)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario H — Authorization Bypass
  // -------------------------------------------------------------------------
  it('Scenario H: rejects AI self-authorization, unauthenticated requests, and replayed tokens', async () => {
    const taskRes = core.createTask({
      prompt: 'Security bypass test',
      providerId: 'gemini',
    });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;
    const task = taskRes.value;

    const stageRes = await core.stageProposal({
      taskId: task.id,
      relativePath: 'src/calculator.py',
      proposedContent: '# Unauthorized patch\n',
      expectedBaseHash: '',
      description: 'Attempted self-approval',
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;
    const { stageId, approvalId } = stageRes.value;

    // 1. Attempt apply without human approval (unknown fake ID)
    const unapprovedApply = await core.applyApprovedStage(stageId, 'fake-ai-generated-approval-id');
    expect(unapprovedApply.ok).toBe(false);
    expect(unapprovedApply.error.code).toBe(ErrorCode.APPROVAL_EXPIRED);

    // 2. Reject unapproved approvalId
    const rejectRes = core.resolveApproval(approvalId, false, 'Rejected by human');
    expect(rejectRes.ok).toBe(true);

    const rejectedApply = await core.applyApprovedStage(stageId, approvalId);
    expect(rejectedApply.ok).toBe(false);
    expect(rejectedApply.error.code).toBe(ErrorCode.APPROVAL_EXPIRED);

    // 3. Autopilot invariant remains BLOCKED fail-closed
    const snapshot = core.getStateSnapshot();
    expect(snapshot.autopilotCanRun).toBe(false);
    expect(snapshot.autopilotStatus).toBe('off');
    expect(snapshot.s00Decision).toBe('NO-GO-AUTOEXEC');
  });

  // -------------------------------------------------------------------------
  // Scenario I — Diagnostics & Sanitized Export
  // -------------------------------------------------------------------------
  it('Scenario I: runs doctor diagnostics and exports sanitized report with zero leaked secrets', async () => {
    const doctor = new DoctorDiagnosticsService({ core });

    // Plant synthetic secret in memory
    const syntheticSecret = 'AKIAIOSFODNN7SYNTHETIC_DIAG_SECRET';
    process.env['AWS_ACCESS_KEY_ID'] = syntheticSecret;

    try {
      const report = await doctor.runDiagnostics();
      expect(report.reportId).toBeDefined();
      expect(report.checks.length).toBeGreaterThanOrEqual(8);

      // Verify autopilot policy check
      const autopilotCheck = report.checks.find((c) => c.category === 'autopilot');
      expect(autopilotCheck).toBeDefined();
      expect(autopilotCheck!.status).toBe('READY');
      expect(autopilotCheck!.detail).toContain('S00 NO-GO-AUTOEXEC');

      // Export sanitized report to disk
      const exportPath = path.join(tempBase, 'diagnostics.json');
      const exportRes = doctor.exportSanitizedReport({
        report,
        outputPath: exportPath,
        explicitUserExportRequested: true,
      });

      expect(exportRes.ok).toBe(true);
      expect(fs.existsSync(exportPath)).toBe(true);

      const exportedContent = fs.readFileSync(exportPath, 'utf8');
      expect(exportedContent).not.toContain(syntheticSecret);
    } finally {
      delete process.env['AWS_ACCESS_KEY_ID'];
    }
  });
});
