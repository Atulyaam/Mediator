/**
 * @mediator/persistence — S28 Data Retention & Privacy Controls Test Suite
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskState } from '@mediator/shared-contracts';
import {
  DatabaseConnection,
  runMigrations,
  AuditRepository,
  TaskRepository,
  SessionRepository,
  ActionRepository,
  ApprovalRepository,
  EvidenceRepository,
  DataRetentionManager,
} from './index.js';

describe('Sprint S28 — User Data Retention, Privacy & Audit Integrity', () => {
  let tempDir: string;
  let tempDbPath: string;
  let db: DatabaseConnection;
  let auditRepo: AuditRepository;
  let taskRepo: TaskRepository;
  let sessionRepo: SessionRepository;
  let actionRepo: ActionRepository;
  let approvalRepo: ApprovalRepository;
  let evidenceRepo: EvidenceRepository;
  let retentionManager: DataRetentionManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s28-retention-test-'));
    tempDbPath = path.join(tempDir, 'test.db');
    db = new DatabaseConnection({ path: tempDbPath });
    db.open();
    runMigrations(db);

    auditRepo = new AuditRepository(db);
    taskRepo = new TaskRepository(db);
    sessionRepo = new SessionRepository(db);
    actionRepo = new ActionRepository(db);
    approvalRepo = new ApprovalRepository(db);
    evidenceRepo = new EvidenceRepository(db);
    retentionManager = new DataRetentionManager(db, auditRepo);
  });

  afterEach(() => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('purges a specific task while appending an immutable audit event and keeping chain valid', () => {
    const taskId = 'task_purge_1';
    const sessionId = 'sess_purge_1';
    const actionId = 'act_purge_1';

    taskRepo.createTask({
      taskId,
      goalSummary: 'Test purge task',
      state: TaskState.VERIFIED_COMPLETE,
    });

    sessionRepo.createSession({
      sessionId,
      taskId,
      providerId: 'google-gemini',
      conversationId: 'conv_123',
      lifecycleState: 'active',
      protocolVersion: '1.0.0',
      baseStateHash: 'sha256_base',
      nonce: 'nonce_secret_123',
    });

    actionRepo.recordAction({
      actionId,
      taskId,
      sessionId,
      roundNumber: 1,
      sequenceNumber: 1,
      actionType: 'patch',
      payloadHash: 'hash_payload',
      parameters: { path: 'test.ts' },
      status: 'accepted',
      policyDecision: 'ALLOW',
    });

    approvalRepo.createApproval({
      approvalId: 'appr_purge_1',
      actionId,
      taskId,
      sessionId,
      changeHash: 'hash_change',
      requestingCaller: 'ide',
    });
    approvalRepo.resolveApproval('appr_purge_1', 'approved', 'user');

    evidenceRepo.recordEvidence({
      evidenceId: 'evi_purge_1',
      taskId,
      sessionId,
      actionId,
      source: 'ide',
      evidenceLevel: 'ide-diagnostic-observed',
      verificationStatus: 'verified',
      evidenceHash: 'hash_evidence',
      summary: 'Verification passed',
    });

    // Verify task exists before purge
    expect(taskRepo.getTask(taskId)).not.toBeNull();

    // Execute purge
    const result = retentionManager.purgeTaskData(taskId, 'corr_test_purge');

    expect(result.success).toBe(true);
    expect(result.purgedTasksCount).toBe(1);
    expect(result.purgedSessionsCount).toBe(1);
    expect(result.purgedActionsCount).toBe(1);
    expect(result.purgedApprovalsCount).toBe(1);
    expect(result.purgedEvidenceCount).toBe(1);
    expect(result.chainVerification.valid).toBe(true);

    // Verify task no longer exists
    expect(taskRepo.getTask(taskId)).toBeNull();

    // Verify audit event exists and details are sanitized
    const tip = auditRepo.getTip();
    expect(tip).not.toBeNull();
    expect(tip?.eventType).toBe('user_data_purged');
    expect(tip?.details).toMatchObject({
      purgedTaskId: taskId,
      purgedTasksCount: 1,
    });
  });

  it('prunes completed tasks older than retention threshold while preserving active tasks', () => {
    const oldTaskId = 'task_old_completed';
    const recentTaskId = 'task_recent_active';

    const oldTime = Date.now() - 100000;

    taskRepo.createTask({
      taskId: oldTaskId,
      goalSummary: 'Old completed task',
      state: TaskState.VERIFIED_COMPLETE,
    });
    // Manually backdate updated_at for old task
    db.prepare('UPDATE tasks SET updated_at = ? WHERE task_id = ?').run(oldTime, oldTaskId);

    taskRepo.createTask({
      taskId: recentTaskId,
      goalSummary: 'Recent active task',
      state: TaskState.TASK_DEFINED,
    });

    const purgeResult = retentionManager.purgeCompletedTasksOlderThan(50000, 'corr_prune_test');
    expect(purgeResult.success).toBe(true);
    expect(purgeResult.purgedTasksCount).toBe(1);
    expect(purgeResult.chainVerification.valid).toBe(true);

    // Old completed task was purged
    expect(taskRepo.getTask(oldTaskId)).toBeNull();
    // Active task remains untouched
    expect(taskRepo.getTask(recentTaskId)).not.toBeNull();
  });

  it('clears all user data on demand and leaves a verified audit chain', () => {
    taskRepo.createTask({
      taskId: 'task_to_clear_1',
      goalSummary: 'Clear me 1',
      state: TaskState.VERIFIED_COMPLETE,
    });
    taskRepo.createTask({
      taskId: 'task_to_clear_2',
      goalSummary: 'Clear me 2',
      state: TaskState.FAILED_SAFE,
    });

    const result = retentionManager.clearAllUserData('corr_clear_all_test');
    expect(result.success).toBe(true);
    expect(result.purgedTasksCount).toBe(2);
    expect(result.chainVerification.valid).toBe(true);

    expect(taskRepo.getTask('task_to_clear_1')).toBeNull();
    expect(taskRepo.getTask('task_to_clear_2')).toBeNull();

    const tip = auditRepo.getTip();
    expect(tip?.eventType).toBe('all_user_data_cleared');
  });

  it('strictly prohibits direct SQLite modification or deletion of audit events', () => {
    auditRepo.appendEvent({
      taskId: 'task_immutability',
      sessionId: 'sess_immutability',
      correlationId: 'corr_immutability',
      eventType: 'security_probe',
      actor: 'test',
      outcome: 'recorded',
    });

    // Attempting direct UPDATE on audit_events must fail via trigger
    expect(() => {
      db.prepare("UPDATE audit_events SET outcome = 'tampered'").run();
    }).toThrow(/Audit events are immutable and append-only/);

    // Attempting direct DELETE on audit_events must fail via trigger
    expect(() => {
      db.prepare('DELETE FROM audit_events').run();
    }).toThrow(/Audit events are immutable and append-only/);
  });
});
