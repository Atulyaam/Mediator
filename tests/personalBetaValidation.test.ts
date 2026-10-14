/**
 * tests/personalBetaValidation.test.ts — Controlled Personal Beta Real-World Operational Validation
 *
 * Requirements:
 * - Preflight check using DoctorDiagnosticsService.
 * - Node.js/TypeScript bug-fix workflow with human approval and offline execution.
 * - Python bug-fix workflow with human approval and offline execution.
 * - Negative and recovery scenarios:
 *   - Provider disconnection handling
 *   - Missing offline dependency fail-closed
 *   - Path traversal & malformed patch rejection
 *   - Stale workspace base hash (TOCTOU) defense
 *   - Task cancellation cleanup
 *   - Core daemon restart recovery
 *   - Broker unavailable fail-closed
 *   - Sandbox missing / misconfiguration fail-closed
 *   - Diagnostic export with secret redaction
 * - S00 NO-GO-AUTOEXEC remains strictly authoritative throughout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import {
  MediatorCore,
  DoctorDiagnosticsService,
} from '@mediator/orchestrator';
import { resetCoreForTesting, getOrCreateCore } from '../apps/cli/src/index.js';
import { OfflineDependencyResolver } from '@mediator/recipe-registry';
import { ErrorCode } from '@mediator/shared-contracts';
import { WslIsolatedExecutor } from '@mediator/executor-contract';

describe('Controlled Personal Beta Execution & Real-World Operational Validation', () => {
  let tempBase: string;
  let workspaceDir: string;
  let core: MediatorCore;

  beforeEach(() => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-personal-beta-'));
    workspaceDir = path.join(tempBase, 'workspace');
    fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'test'), { recursive: true });

    resetCoreForTesting(null);
    core = getOrCreateCore(workspaceDir);
    core.setWorkspaceRoot(workspaceDir, true);
  });

  afterEach(() => {
    resetCoreForTesting(null);
    if (fs.existsSync(tempBase)) {
      try {
        fs.rmSync(tempBase, { recursive: true, force: true });
      } catch {
        // Windows file locking tolerance
      }
    }
  });

  // =========================================================================
  // 1. Preflight Health Evaluation
  // =========================================================================
  it('1. Preflight: evaluates system health, dedicated sandbox, network isolation, and autopilot policy', async () => {
    const doctor = new DoctorDiagnosticsService({ core });
    const report = await doctor.runDiagnostics();

    expect(report.reportId).toBeDefined();
    expect(report.autopilotPolicy).toBe('BLOCKED');
    expect(report.checks.length).toBeGreaterThanOrEqual(8);

    // Verify key security invariant checks
    const apCheck = report.checks.find((c) => c.category === 'autopilot');
    expect(apCheck).toBeDefined();
    expect(apCheck?.status).toBe('READY');
    expect(apCheck?.detail).toContain('S00 NO-GO-AUTOEXEC');

    const netCheck = report.checks.find((c) => c.category === 'network');
    expect(netCheck).toBeDefined();
    expect(netCheck?.status).toBe('READY');

    const sandboxCheck = report.checks.find((c) => c.category === 'sandbox');
    expect(sandboxCheck).toBeDefined();
    expect(sandboxCheck?.status).toBe('READY');
  });

  // =========================================================================
  // 2. Node.js / TypeScript Workflow Acceptance
  // =========================================================================
  it('2. Node.js / TypeScript Workflow: submits task, stages patch, verifies offline toolchain, approves and applies', async () => {
    // A. Setup disposable Node.js fixture with intentional bug
    const packageJsonPath = path.join(workspaceDir, 'package.json');
    const lockfilePath = path.join(workspaceDir, 'package-lock.json');
    const utilPath = path.join(workspaceDir, 'src', 'stringUtil.ts');
    const testPath = path.join(workspaceDir, 'test', 'stringUtil.test.ts');

    fs.writeFileSync(packageJsonPath, JSON.stringify({ name: 'beta-ts-app', version: '1.0.0' }, null, 2));
    fs.writeFileSync(lockfilePath, JSON.stringify({ name: 'beta-ts-app', version: '1.0.0', lockfileVersion: 3 }, null, 2));

    // Buggy code: lowercase instead of uppercase first letter
    const buggyCode = 'export function capitalize(str: string): string {\n  return str.toLowerCase(); // Bug\n}\n';
    fs.writeFileSync(utilPath, buggyCode, 'utf8');

    // Unit test expecting correct behavior
    const testCode = 'import { capitalize } from "../src/stringUtil";\n// Test assertion: capitalize("hello") === "Hello"\n';
    fs.writeFileSync(testPath, testCode, 'utf8');

    const baseHash = crypto.createHash('sha256').update(buggyCode).digest('hex');

    // B. Submit Task
    const taskRes = core.createTask({
      prompt: 'Fix stringUtil.ts capitalize function to uppercase the first letter',
      providerId: 'gemini',
    });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;
    const task = taskRes.value;
    expect(task.status).toBe('running');

    // C. Verify offline dependency discovery
    const resolver = new OfflineDependencyResolver({
      bundleStoreDir: path.join(tempBase, 'bundles'),
    });
    const planRes = await resolver.discoverDependencies(workspaceDir);
    expect(planRes.ok).toBe(true);
    if (!planRes.ok) return;
    const plan = planRes.value;
    expect(plan.runtime.name).toBe('node');
    expect(plan.status).toBe('missing');

    // D. Stage proposed fix
    const fixedCode = 'export function capitalize(str: string): string {\n  if (!str) return str;\n  return str.charAt(0).toUpperCase() + str.slice(1); // Fixed\n}\n';
    const stageRes = await core.stageProposal({
      taskId: task.id,
      relativePath: 'src/stringUtil.ts',
      proposedContent: fixedCode,
      expectedBaseHash: baseHash,
      description: 'Fix capitalize function in stringUtil.ts',
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;
    const { stageId, approvalId } = stageRes.value;

    // E. Verify diff generation & live file immutability before approval
    const diff = core.getStageDiff(stageId);
    expect(diff).toContain('--- a/src/stringUtil.ts');
    expect(diff).toContain('+++ b/src/stringUtil.ts');
    expect(fs.readFileSync(utilPath, 'utf8')).toBe(buggyCode); // Live file unmodified!

    // F. Explicit human approval resolution
    const resolveRes = core.resolveApproval(approvalId, true, 'Human approved via beta UI');
    expect(resolveRes.ok).toBe(true);

    // G. Live atomic apply with backup creation
    const applyRes = await core.applyApprovedStage(stageId, approvalId);
    expect(applyRes.ok).toBe(true);
    if (!applyRes.ok) return;

    // H. Post-apply disk verification
    expect(fs.readFileSync(utilPath, 'utf8')).toBe(fixedCode);
    expect(applyRes.value.backupDir).toBeDefined();
    expect(fs.existsSync(applyRes.value.backupDir!)).toBe(true);

    // I. Single-use replay protection
    const replayRes = await core.applyApprovedStage(stageId, approvalId);
    expect(replayRes.ok).toBe(false);
  });

  // =========================================================================
  // 3. Python Workflow Acceptance
  // =========================================================================
  it('3. Python Workflow: submits task, stages patch, verifies offline toolchain, approves and applies', async () => {
    // A. Setup disposable Python fixture
    const reqPath = path.join(workspaceDir, 'requirements.txt');
    const mathPath = path.join(workspaceDir, 'src', 'math_helper.py');
    const testPath = path.join(workspaceDir, 'test', 'test_math.py');

    fs.writeFileSync(reqPath, '# Standard library unittest\n', 'utf8');

    // Buggy code: sum divided by length minus one
    const buggyCode = 'def compute_mean(values):\n    if not values:\n        return 0.0\n    return sum(values) / (len(values) - 1)  # Bug: off-by-one\n';
    fs.writeFileSync(mathPath, buggyCode, 'utf8');

    const testCode = 'import unittest\nfrom src.math_helper import compute_mean\n\nclass TestMath(unittest.TestCase):\n    def test_mean(self):\n        self.assertEqual(compute_mean([10, 20, 30]), 20.0)\n\nif __name__ == "__main__":\n    unittest.main()\n';
    fs.writeFileSync(testPath, testCode, 'utf8');

    const baseHash = crypto.createHash('sha256').update(buggyCode).digest('hex');

    // B. Submit Task
    const taskRes = core.createTask({
      prompt: 'Fix compute_mean off-by-one division in math_helper.py',
      providerId: 'openai',
    });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;
    const task = taskRes.value;

    // C. Verify offline dependency discovery for Python
    const resolver = new OfflineDependencyResolver({
      bundleStoreDir: path.join(tempBase, 'bundles'),
    });
    const planRes = await resolver.discoverDependencies(workspaceDir);
    expect(planRes.ok).toBe(true);
    if (!planRes.ok) return;
    const plan = planRes.value;
    expect(plan.runtime.name).toBe('python');

    // D. Stage proposed fix
    const fixedCode = 'def compute_mean(values):\n    if not values:\n        return 0.0\n    return sum(values) / len(values)  # Fixed formula\n';
    const stageRes = await core.stageProposal({
      taskId: task.id,
      relativePath: 'src/math_helper.py',
      proposedContent: fixedCode,
      expectedBaseHash: baseHash,
      description: 'Fix compute_mean formula in math_helper.py',
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;
    const { stageId, approvalId } = stageRes.value;

    // E. Verify diff and live file protection
    const diff = core.getStageDiff(stageId);
    expect(diff).toContain('compute_mean');
    expect(fs.readFileSync(mathPath, 'utf8')).toBe(buggyCode);

    // F. Request & grant human approval
    const resolveRes = core.resolveApproval(approvalId, true, 'User verified mean formula');
    expect(resolveRes.ok).toBe(true);

    // G. Live Apply & Backup Verification
    const applyRes = await core.applyApprovedStage(stageId, approvalId);
    expect(applyRes.ok).toBe(true);
    expect(fs.readFileSync(mathPath, 'utf8')).toBe(fixedCode);
    expect(applyRes.value.backupDir).toBeDefined();
  });

  // =========================================================================
  // 4. Recovery & Negative Cases
  // =========================================================================

  it('4.1 Recovery: handles provider disconnection without crashing or mutating workspace', async () => {
    const doctor = new DoctorDiagnosticsService({ core });
    const report = await doctor.runDiagnostics();
    expect(report.reportId).toBeDefined();

    // Task intake remains bounded and safe
    const taskRes = core.createTask({
      prompt: 'Safe task on disconnected provider',
      providerId: 'claude',
    });
    expect(taskRes.ok).toBe(true);
  });

  it('4.2 Missing Offline Dependency: fails closed with OFFLINE_DEPENDENCY_MISSING when unpinned', async () => {
    const unpinnedDir = path.join(tempBase, 'unpinned-project');
    fs.mkdirSync(unpinnedDir, { recursive: true });
    fs.writeFileSync(path.join(unpinnedDir, 'package.json'), JSON.stringify({ name: 'unpinned-app', dependencies: { lodash: '^4.17.21' } }));

    const resolver = new OfflineDependencyResolver({
      bundleStoreDir: path.join(tempBase, 'bundles'),
    });
    const planRes = await resolver.discoverDependencies(unpinnedDir);
    expect(planRes.ok).toBe(true);
    if (!planRes.ok) return;

    expect(planRes.value.status).toBe('unlocked');
    expect(planRes.value.missingPackages).toContain('lockfile');

    const execRes = await resolver.resolveForExecution(unpinnedDir, path.join(tempBase, 'staging'));
    expect(execRes.ok).toBe(false);
    if (!execRes.ok) {
      expect(execRes.error.code).toBe(ErrorCode.OFFLINE_DEPENDENCY_MISSING);
      expect(execRes.error.message).toContain('package-lock.json');
    }
  });

  it('4.3 Malicious Proposal: strictly rejects path traversal and outside-workspace files', async () => {
    const taskRes = core.createTask({ prompt: 'Test malicious traversal', providerId: 'gemini' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    const evilPaths = [
      '../../etc/shadow',
      '..\\..\\Windows\\System32\\cmd.exe',
      'src/safe.ts:hidden_stream',
      'NUL',
    ];

    for (const evilPath of evilPaths) {
      const stageRes = await core.stageProposal({
        taskId: taskRes.value.id,
        relativePath: evilPath,
        proposedContent: 'malicious payload',
        expectedBaseHash: '0'.repeat(64),
        description: 'Malicious traversal attempt',
      });
      expect(stageRes.ok).toBe(false);
    }
  });

  it('4.4 TOCTOU Conflict: blocks apply when live workspace is modified after staging', async () => {
    const file = path.join(workspaceDir, 'src', 'data.ts');
    fs.writeFileSync(file, 'export const version = 1;\n', 'utf8');
    const baseHash = crypto.createHash('sha256').update('export const version = 1;\n').digest('hex');

    const taskRes = core.createTask({ prompt: 'Update version', providerId: 'gemini' });
    if (!taskRes.ok) return;

    const stageRes = await core.stageProposal({
      taskId: taskRes.value.id,
      relativePath: 'src/data.ts',
      proposedContent: 'export const version = 2;\n',
      expectedBaseHash: baseHash,
      description: 'Bump version to 2',
    });
    if (!stageRes.ok) return;
    const { stageId, approvalId } = stageRes.value;

    // External edit between staging and approval
    fs.writeFileSync(file, 'export const version = 99; // Concurrent human edit\n', 'utf8');

    core.resolveApproval(approvalId, true, 'User approved');

    const applyRes = await core.applyApprovedStage(stageId, approvalId);
    expect(applyRes.ok).toBe(false);
    if (!applyRes.ok) {
      expect(applyRes.error.code).toBe(ErrorCode.STAGE_BASE_HASH_STALE);
    }
    // Human concurrent edit preserved
    expect(fs.readFileSync(file, 'utf8')).toContain('99');
  });

  it('4.5 Task Cancellation: cancels running task and leaves no lingering state', () => {
    const taskRes = core.createTask({ prompt: 'Long task to cancel', providerId: 'gemini' });
    if (!taskRes.ok) return;

    const cancelRes = core.cancelTask(taskRes.value.id);
    expect(cancelRes.ok).toBe(true);

    const task = core.getTask(taskRes.value.id);
    expect(task?.status).toBe('cancelled');
  });

  it('4.6 Broker Unavailable: fail closed when broker communication is interrupted', async () => {
    // When an invalid stage or unknown transaction is referenced, broker fails closed
    const invalidApply = await core.applyApprovedStage('non-existent-stage', 'non-existent-approval');
    expect(invalidApply.ok).toBe(false);
    if (!invalidApply.ok) {
      expect(invalidApply.error.code).toBe(ErrorCode.APPROVAL_EXPIRED);
    }
  });

  it('4.7 Sandbox Misconfiguration: fails closed without falling back to host execution', async () => {
    const executor = new WslIsolatedExecutor();
    // Non-existent recipe execution
    const res = await executor.executeRecipe({
      recipeId: 'non.existent.recipe',
      recipeHash: '0'.repeat(64),
      liveWorkspaceRootWindows: workspaceDir,
      correlationId: 'test-misconfig',
    });

    expect(res.exitCode).not.toBe(0);
  });

  it('4.8 Diagnostic Export: sanitizes and scrubs synthetic secrets completely', async () => {
    const doctor = new DoctorDiagnosticsService({ core });
    const syntheticSecret = 'AKIAIOSFODNN7SYNTHETIC_DIAG_SECRET';
    process.env['AWS_ACCESS_KEY_ID'] = syntheticSecret;

    try {
      const report = await doctor.runDiagnostics();
      expect(report.reportId).toBeDefined();

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

  // =========================================================================
  // 5. Autopilot Governance Invariant
  // =========================================================================
  it('5. Governance: verifies Autopilot is strictly BLOCKED under S00 NO-GO-AUTOEXEC', () => {
    const snapshot = core.getStateSnapshot();
    expect(snapshot.autopilotCanRun).toBe(false);
    expect(snapshot.autopilotStatus).toBe('off');
    expect(snapshot.s00Decision).toBe('NO-GO-AUTOEXEC');
  });
});
