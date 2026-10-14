/**
 * @mediator/stage-store — Live Apply-Back & Rollback Tests (Sprint S14)
 *
 * Requirements:
 * - Approval binding to exact payload hash, target paths, and 120s expiry.
 * - Single-use approval consumption and tampering prevention.
 * - Live workspace apply-back with atomic replacement on same volume.
 * - Post-apply hash verification.
 * - Conflict detection immediately before write phase.
 * - Interrupted and failed transaction rollback.
 * - Never overwriting intervening user edits (recovery_required).
 * - Durable SQLite journaling and restart recovery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  DatabaseConnection,
  runMigrations,
  TaskRepository,
} from '@mediator/persistence';
import { TaskState } from '@mediator/shared-contracts';
import {
  type WorkspaceRootState,
  inspectWorkspaceRoot,
} from '@mediator/workspace-boundary';
import { type CallerIdentity } from '@mediator/policy-engine';
import { StageStore } from './stageStore.js';
import { ApprovalService } from './approvalService.js';
import { ApplyService } from './applyService.js';
import { ApplyJournal } from './applyJournal.js';
import { StageStorage } from './stageStorage.js';
import { ApplyError, ApplyErrorCode } from './applyErrors.js';
import { computeSha256 } from './stageSnapshot.js';

describe('Sprint S14 — Apply-Back, Trusted Approval & Rollback', () => {
  let tempDir: string;
  let workspaceDir: string;
  let stagingDir: string;
  let backupDir: string;
  let dbPath: string;
  let db: DatabaseConnection;
  let workspace: WorkspaceRootState;
  let stageStore: StageStore;
  let stageStorage: StageStorage;
  let approvalService: ApprovalService;
  let applyService: ApplyService;
  let applyJournal: ApplyJournal;

  const taskId = 'task_s14_apply_test';
  const stageId = 'stage_s14_apply_test';

  const trustedUiCaller: CallerIdentity = {
    id: 'user_ide_session',
    type: 'ide',
    isTrustedUI: true,
  };

  const untrustedMcpCaller: CallerIdentity = {
    id: 'mcp_agent',
    type: 'mcp',
    isTrustedUI: false,
  };

  const untrustedAiCaller: CallerIdentity = {
    id: 'ai_web_chat',
    type: 'browser',
    isTrustedUI: false,
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator_s14_test_'));
    workspaceDir = path.join(tempDir, 'workspace');
    stagingDir = path.join(tempDir, 'staging');
    backupDir = path.join(tempDir, 'backups');
    dbPath = path.join(tempDir, 'test.db');

    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });

    // Seed fixture workspace files
    fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'Hello live world\nOriginal content.\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'deleteMe.txt'), 'File to be deleted\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'renameMe.txt'), 'File to be renamed\n', 'utf8');

    const rawWs = inspectWorkspaceRoot(workspaceDir, 'ide');
    workspace = {
      ...rawWs,
      confirmationStatus: 'confirmed',
    };

    db = new DatabaseConnection({ path: dbPath });
    db.open();
    runMigrations(db);

    const taskRepo = new TaskRepository(db);
    taskRepo.createTask({
      taskId,
      goalSummary: 'Sprint S14 Apply-Back Task',
      state: TaskState.TASK_DEFINED,
    });

    stageStorage = new StageStorage(stagingDir);
    stageStore = new StageStore(db, { baseStagingDir: stagingDir });
    stageStore.createStage({ taskId, workspace, stageId });

    approvalService = new ApprovalService();
    applyJournal = new ApplyJournal(db);
    applyService = new ApplyService(db, stageStorage, approvalService, { baseBackupDir: backupDir });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. Approval request binds to exact payload hash and expires after timeout', () => {
    // Stage an edit
    stageStore.applyPatch(stageId, {
      patchId: 'p1',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { edits: [{ search: 'Original content.', replace: 'Updated staged content.' }] },
    }, workspace);

    const files = stageStore.listStagedChanges(stageId, workspace);
    const approval = approvalService.createApprovalRequest({
      taskId,
      stageId,
      workspaceIdentity: workspace.canonicalPath!,
      files,
      caller: trustedUiCaller,
      timeoutMs: 100, // 100 ms for test expiration
    });

    expect(approval.status).toBe('pending');
    expect(approval.payloadHash).toBeTruthy();
    expect(approval.targetPaths).toEqual(['hello.txt']);

    // Wait for expiration
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(() => {
          approvalService.resolveApproval({
            approvalId: approval.approvalId,
            resolution: 'approved',
            caller: trustedUiCaller,
          });
        }).toThrow(ApplyError);

        try {
          approvalService.resolveApproval({
            approvalId: approval.approvalId,
            resolution: 'approved',
            caller: trustedUiCaller,
          });
        } catch (err) {
          expect((err as ApplyError).code).toBe(ApplyErrorCode.APPROVAL_EXPIRED);
        }
        resolve();
      }, 150);
    });
  });

  it('2. Untrusted callers (MCP, AI browser) CANNOT resolve approvals', () => {
    stageStore.applyPatch(stageId, {
      patchId: 'p2',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { content: 'New content\n' },
    }, workspace);

    const files = stageStore.listStagedChanges(stageId, workspace);
    const approval = approvalService.createApprovalRequest({
      taskId,
      stageId,
      workspaceIdentity: workspace.canonicalPath!,
      files,
      caller: trustedUiCaller,
    });

    // MCP caller attempts to self-approve
    expect(() => {
      approvalService.resolveApproval({
        approvalId: approval.approvalId,
        resolution: 'approved',
        caller: untrustedMcpCaller,
      });
    }).toThrow(ApplyError);

    try {
      approvalService.resolveApproval({
        approvalId: approval.approvalId,
        resolution: 'approved',
        caller: untrustedMcpCaller,
      });
    } catch (err) {
      expect((err as ApplyError).code).toBe(ApplyErrorCode.CALLER_UNAUTHORIZED);
    }

    // AI browser caller attempts to approve
    expect(() => {
      approvalService.resolveApproval({
        approvalId: approval.approvalId,
        resolution: 'approved',
        caller: untrustedAiCaller,
      });
    }).toThrow(ApplyError);

    try {
      approvalService.resolveApproval({
        approvalId: approval.approvalId,
        resolution: 'approved',
        caller: untrustedAiCaller,
      });
    } catch (err) {
      expect((err as ApplyError).code).toBe(ApplyErrorCode.CALLER_UNAUTHORIZED);
    }
  });

  it('3. Trusted user approval enables apply-back to live workspace', () => {
    // Stage a new file and a modification
    stageStore.applyPatch(stageId, {
      patchId: 'p3_mod',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { edits: [{ search: 'Original content.', replace: 'Approved applied content.' }] },
    }, workspace);

    stageStore.applyPatch(stageId, {
      patchId: 'p3_new',
      taskId,
      stageId,
      relativePath: 'created.txt',
      operation: 'create',
      payload: { content: 'Newly created live file\n' },
    }, workspace);

    const files = stageStore.listStagedChanges(stageId, workspace);
    const approvalReq = approvalService.createApprovalRequest({
      taskId,
      stageId,
      workspaceIdentity: workspace.canonicalPath!,
      files,
      caller: trustedUiCaller,
    });

    // Trusted user approves
    approvalService.resolveApproval({
      approvalId: approvalReq.approvalId,
      resolution: 'approved',
      caller: trustedUiCaller,
    });

    // Apply to live workspace
    const res = applyService.applyToWorkspace(stageId, approvalReq.approvalId, workspace, trustedUiCaller);
    expect(res.status).toBe('applied');
    expect(res.appliedCount).toBe(2);

    // Verify live files have been updated
    const liveHello = fs.readFileSync(path.join(workspaceDir, 'hello.txt'), 'utf8');
    expect(liveHello).toContain('Approved applied content.');

    const liveCreated = fs.readFileSync(path.join(workspaceDir, 'created.txt'), 'utf8');
    expect(liveCreated).toBe('Newly created live file\n');
  });

  it('4. Replaying a consumed approval is rejected (single-use invariant)', () => {
    stageStore.applyPatch(stageId, {
      patchId: 'p4',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { content: 'Single use test\n' },
    }, workspace);

    const files = stageStore.listStagedChanges(stageId, workspace);
    const approvalReq = approvalService.createApprovalRequest({
      taskId,
      stageId,
      workspaceIdentity: workspace.canonicalPath!,
      files,
      caller: trustedUiCaller,
    });

    approvalService.resolveApproval({
      approvalId: approvalReq.approvalId,
      resolution: 'approved',
      caller: trustedUiCaller,
    });

    // First apply succeeds
    applyService.applyToWorkspace(stageId, approvalReq.approvalId, workspace, trustedUiCaller);

    // Second apply with same approval must fail with APPROVAL_ALREADY_CONSUMED
    expect(() => {
      applyService.applyToWorkspace(stageId, approvalReq.approvalId, workspace, trustedUiCaller);
    }).toThrow(ApplyError);

    try {
      applyService.applyToWorkspace(stageId, approvalReq.approvalId, workspace, trustedUiCaller);
    } catch (err) {
      expect((err as ApplyError).code).toBe(ApplyErrorCode.APPROVAL_ALREADY_CONSUMED);
    }
  });

  it('5. Payload tampering or stage changes invalidate approval at consume time', () => {
    stageStore.applyPatch(stageId, {
      patchId: 'p5',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { content: 'Initial approved text\n' },
    }, workspace);

    const files = stageStore.listStagedChanges(stageId, workspace);
    const approvalReq = approvalService.createApprovalRequest({
      taskId,
      stageId,
      workspaceIdentity: workspace.canonicalPath!,
      files,
      caller: trustedUiCaller,
    });

    approvalService.resolveApproval({
      approvalId: approvalReq.approvalId,
      resolution: 'approved',
      caller: trustedUiCaller,
    });

    // Now someone sneakily stages another edit AFTER approval was granted!
    stageStore.applyPatch(stageId, {
      patchId: 'p5_tamper',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { content: 'Sneaky unapproved text\n' },
    }, workspace);

    // Apply must detect payload hash mismatch and reject!
    expect(() => {
      applyService.applyToWorkspace(stageId, approvalReq.approvalId, workspace, trustedUiCaller);
    }).toThrow(ApplyError);

    try {
      applyService.applyToWorkspace(stageId, approvalReq.approvalId, workspace, trustedUiCaller);
    } catch (err) {
      expect((err as ApplyError).code).toBe(ApplyErrorCode.APPROVAL_PAYLOAD_MISMATCH);
    }
  });

  it('6. Live conflict right before apply blocks the operation safely', () => {
    stageStore.applyPatch(stageId, {
      patchId: 'p6',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { content: 'Proposed update\n' },
    }, workspace);

    const files = stageStore.listStagedChanges(stageId, workspace);
    const approvalReq = approvalService.createApprovalRequest({
      taskId,
      stageId,
      workspaceIdentity: workspace.canonicalPath!,
      files,
      caller: trustedUiCaller,
    });

    approvalService.resolveApproval({
      approvalId: approvalReq.approvalId,
      resolution: 'approved',
      caller: trustedUiCaller,
    });

    // User modifies the live file right before apply!
    fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'User intervening edit\n', 'utf8');

    // Apply must fail with APPLY_CONFLICT and preserve user's edit
    expect(() => {
      applyService.applyToWorkspace(stageId, approvalReq.approvalId, workspace, trustedUiCaller);
    }).toThrow(ApplyError);

    try {
      applyService.applyToWorkspace(stageId, approvalReq.approvalId, workspace, trustedUiCaller);
    } catch (err) {
      expect((err as ApplyError).code).toBe(ApplyErrorCode.APPLY_CONFLICT);
    }

    // User edit preserved
    const currentLive = fs.readFileSync(path.join(workspaceDir, 'hello.txt'), 'utf8');
    expect(currentLive).toBe('User intervening edit\n');
  });

  it('7. Destructive proposals (delete, rename) execute on live workspace upon approved apply', () => {
    stageStore.applyPatch(stageId, {
      patchId: 'p7_del',
      taskId,
      stageId,
      relativePath: 'deleteMe.txt',
      operation: 'delete-proposed',
      payload: {},
    }, workspace);

    stageStore.applyPatch(stageId, {
      patchId: 'p7_ren',
      taskId,
      stageId,
      relativePath: 'renameMe.txt',
      operation: 'rename-proposed',
      payload: { targetPath: 'renamedSuccess.txt' },
    }, workspace);

    const files = stageStore.listStagedChanges(stageId, workspace);
    const approvalReq = approvalService.createApprovalRequest({
      taskId,
      stageId,
      workspaceIdentity: workspace.canonicalPath!,
      files,
      caller: trustedUiCaller,
    });

    expect(approvalReq.isDestructive).toBe(true);
    expect(approvalReq.requiresManualReview).toBe(true);

    approvalService.resolveApproval({
      approvalId: approvalReq.approvalId,
      resolution: 'approved',
      caller: trustedUiCaller,
    });

    applyService.applyToWorkspace(stageId, approvalReq.approvalId, workspace, trustedUiCaller);

    // Verify live workspace: deleteMe was removed, renameMe was moved
    expect(fs.existsSync(path.join(workspaceDir, 'deleteMe.txt'))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, 'renameMe.txt'))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, 'renamedSuccess.txt'))).toBe(true);
  });

  it('8. Post-apply rollback cleanly restores modified and created files', () => {
    const originalHello = fs.readFileSync(path.join(workspaceDir, 'hello.txt'), 'utf8');

    stageStore.applyPatch(stageId, {
      patchId: 'p8_mod',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { content: 'Will be rolled back\n' },
    }, workspace);

    stageStore.applyPatch(stageId, {
      patchId: 'p8_new',
      taskId,
      stageId,
      relativePath: 'addedTemp.txt',
      operation: 'create',
      payload: { content: 'Will be unlinked\n' },
    }, workspace);

    const files = stageStore.listStagedChanges(stageId, workspace);
    const approvalReq = approvalService.createApprovalRequest({
      taskId,
      stageId,
      workspaceIdentity: workspace.canonicalPath!,
      files,
      caller: trustedUiCaller,
    });

    approvalService.resolveApproval({
      approvalId: approvalReq.approvalId,
      resolution: 'approved',
      caller: trustedUiCaller,
    });

    const applyRes = applyService.applyToWorkspace(stageId, approvalReq.approvalId, workspace, trustedUiCaller);
    expect(applyRes.status).toBe('applied');

    // Now invoke post-apply rollback!
    const rollbackRes = applyService.rollbackTransaction(applyRes.transactionId, workspace);
    expect(rollbackRes.status).toBe('rolled_back');
    expect(rollbackRes.rolledBackCount).toBe(2);

    // Verify hello.txt restored to original, and addedTemp.txt was unlinked
    expect(fs.readFileSync(path.join(workspaceDir, 'hello.txt'), 'utf8')).toBe(originalHello);
    expect(fs.existsSync(path.join(workspaceDir, 'addedTemp.txt'))).toBe(false);
  });

  it('9. Rollback NEVER overwrites intervening user edits (recovery_required)', () => {
    stageStore.applyPatch(stageId, {
      patchId: 'p9',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { content: 'Mediator applied change\n' },
    }, workspace);

    const files = stageStore.listStagedChanges(stageId, workspace);
    const approvalReq = approvalService.createApprovalRequest({
      taskId,
      stageId,
      workspaceIdentity: workspace.canonicalPath!,
      files,
      caller: trustedUiCaller,
    });

    approvalService.resolveApproval({
      approvalId: approvalReq.approvalId,
      resolution: 'approved',
      caller: trustedUiCaller,
    });

    const applyRes = applyService.applyToWorkspace(stageId, approvalReq.approvalId, workspace, trustedUiCaller);

    // User makes a subsequent edit to hello.txt after Mediator applied it
    fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'User subsequent edit that must be protected!\n', 'utf8');

    // Now attempt rollback: it must NOT overwrite the user subsequent edit!
    const rollbackRes = applyService.rollbackTransaction(applyRes.transactionId, workspace);
    expect(rollbackRes.status).toBe('recovery_required');
    expect(rollbackRes.recoveryRequiredCount).toBe(1);

    // Verify user edit is STILL PRESENT!
    expect(fs.readFileSync(path.join(workspaceDir, 'hello.txt'), 'utf8')).toBe('User subsequent edit that must be protected!\n');
  });

  it('10. Transactions and journals persist durably across database reopen', () => {
    stageStore.applyPatch(stageId, {
      patchId: 'p10',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { content: 'Persistent apply test\n' },
    }, workspace);

    const files = stageStore.listStagedChanges(stageId, workspace);
    const approvalReq = approvalService.createApprovalRequest({
      taskId,
      stageId,
      workspaceIdentity: workspace.canonicalPath!,
      files,
      caller: trustedUiCaller,
    });

    approvalService.resolveApproval({
      approvalId: approvalReq.approvalId,
      resolution: 'approved',
      caller: trustedUiCaller,
    });

    const applyRes = applyService.applyToWorkspace(stageId, approvalReq.approvalId, workspace, trustedUiCaller);

    // Close and reopen database
    db.close();

    const db2 = new DatabaseConnection({ path: dbPath });
    db2.open();

    const journal2 = new ApplyJournal(db2);
    const tx = journal2.getTransaction(applyRes.transactionId);
    expect(tx).not.toBeNull();
    expect(tx?.status).toBe('applied');
    expect(tx?.payloadHash).toBe(approvalReq.payloadHash);

    const items = journal2.listTransactionItems(applyRes.transactionId);
    expect(items.length).toBe(1);
    expect(items[0]?.relativePath).toBe('hello.txt');
    expect(items[0]?.status).toBe('applied');

    db2.close();
  });
});
