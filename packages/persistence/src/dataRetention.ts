/**
 * @mediator/persistence — User Data Retention & Privacy Controls (S28)
 *
 * Requirements:
 * - Local-only privacy controls: clear task data, prune old records, and purge all user data.
 * - Atomically deletes task artifacts in correct foreign-key dependency order.
 * - Appends tamper-evident audit event to hash chain documenting the purge without leaking secrets.
 * - Preserves SQLite audit log integrity and verifies chain health after operation.
 */

import { type DatabaseConnection } from './database.js';
import { AuditRepository, type AuditVerificationResult } from './auditRepository.js';

export interface PurgeSummary {
  readonly success: boolean;
  readonly purgedTasksCount: number;
  readonly purgedSessionsCount: number;
  readonly purgedActionsCount: number;
  readonly purgedApprovalsCount: number;
  readonly purgedEvidenceCount: number;
  readonly auditEventId: string;
  readonly chainVerification: AuditVerificationResult;
}

export class DataRetentionManager {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly auditRepo: AuditRepository,
  ) {}

  /**
   * Purge a specific task and all its associated artifacts (sessions, rounds, actions, approvals, staged changes, handoffs).
   * Appends an immutable audit event recording the purge.
   */
  public purgeTaskData(taskId: string, correlationId: string = 'corr_purge'): PurgeSummary {
    return this.db.transaction(() => {
      // 1. Count items before deletion for honest audit report
      const sessionCountStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE task_id = ?');
      const actionCountStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM actions WHERE task_id = ?');
      const approvalCountStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM approvals WHERE task_id = ?');
      const evidenceCountStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM evidence WHERE task_id = ?');

      const sessionsCount = (sessionCountStmt.get(taskId) as { cnt: number })?.cnt ?? 0;
      const actionsCount = (actionCountStmt.get(taskId) as { cnt: number })?.cnt ?? 0;
      const approvalsCount = (approvalCountStmt.get(taskId) as { cnt: number })?.cnt ?? 0;
      const evidenceCount = (evidenceCountStmt.get(taskId) as { cnt: number })?.cnt ?? 0;

      // 2. Cascade delete in safe foreign-key order
      // Stages & Staged Files
      this.db.prepare(`
        DELETE FROM staged_files WHERE stage_id IN (SELECT stage_id FROM stages WHERE task_id = ?)
      `).run(taskId);
      this.db.prepare(`
        DELETE FROM stage_checkpoints WHERE task_id = ?
      `).run(taskId);
      this.db.prepare('DELETE FROM stages WHERE task_id = ?').run(taskId);

      // Apply transactions
      this.db.prepare('DELETE FROM apply_transactions WHERE task_id = ?').run(taskId);

      // Handoffs and Reviews
      this.db.prepare('DELETE FROM review_requests WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM handoffs WHERE task_id = ?').run(taskId);

      // Evidence, Summaries, Approvals, Actions, Rounds, Sessions, Tasks
      this.db.prepare('DELETE FROM evidence WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM context_summaries WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM approvals WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM actions WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM rounds WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM sessions WHERE task_id = ?').run(taskId);
      const taskDelResult = this.db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);

      const tasksPurged = Number(taskDelResult.changes);

      // 3. Append immutable audit event
      const auditEvt = this.auditRepo.appendEvent({
        taskId,
        sessionId: 'retention_policy',
        correlationId,
        eventType: 'user_data_purged',
        actor: 'user',
        outcome: 'allowed',
        details: {
          purgedTaskId: taskId,
          purgedTasksCount: tasksPurged,
          purgedSessionsCount: sessionsCount,
          purgedActionsCount: actionsCount,
          purgedApprovalsCount: approvalsCount,
          purgedEvidenceCount: evidenceCount,
        },
      });

      // 4. Verify hash chain integrity
      const verification = this.auditRepo.verifyChain();

      return {
        success: tasksPurged > 0 && verification.valid,
        purgedTasksCount: tasksPurged,
        purgedSessionsCount: sessionsCount,
        purgedActionsCount: actionsCount,
        purgedApprovalsCount: approvalsCount,
        purgedEvidenceCount: evidenceCount,
        auditEventId: auditEvt.eventId,
        chainVerification: verification,
      };
    });
  }

  /**
   * Purge completed tasks older than retention threshold (ms).
   */
  public purgeCompletedTasksOlderThan(
    retentionMs: number,
    correlationId: string = 'corr_retention_prune',
  ): PurgeSummary {
    const cutoffTime = Date.now() - retentionMs;
    const stmt = this.db.prepare(`
      SELECT task_id FROM tasks
      WHERE state IN (
        'VERIFIED_COMPLETE',
        'USER_ACCEPTED_UNVERIFIED',
        'STOPPED',
        'FAILED_SAFE',
        'DENIED',
        'completed',
        'cancelled',
        'failed'
      )
      AND updated_at < ?
    `);

    const rows = stmt.all(cutoffTime) as Array<{ task_id: string }>;
    let totalTasks = 0;
    let totalSessions = 0;
    let totalActions = 0;
    let totalApprovals = 0;
    let totalEvidence = 0;
    let lastAuditId = 'none';

    for (const row of rows) {
      const result = this.purgeTaskData(row.task_id, correlationId);
      totalTasks += result.purgedTasksCount;
      totalSessions += result.purgedSessionsCount;
      totalActions += result.purgedActionsCount;
      totalApprovals += result.purgedApprovalsCount;
      totalEvidence += result.purgedEvidenceCount;
      lastAuditId = result.auditEventId;
    }

    const verification = this.auditRepo.verifyChain();

    return {
      success: verification.valid,
      purgedTasksCount: totalTasks,
      purgedSessionsCount: totalSessions,
      purgedActionsCount: totalActions,
      purgedApprovalsCount: totalApprovals,
      purgedEvidenceCount: totalEvidence,
      auditEventId: lastAuditId,
      chainVerification: verification,
    };
  }

  /**
   * Complete clear of all user task and project data, leaving only the immutable audit ledger.
   */
  public clearAllUserData(correlationId: string = 'corr_clear_all'): PurgeSummary {
    return this.db.transaction(() => {
      const taskStmt = this.db.prepare('SELECT task_id FROM tasks');
      const rows = taskStmt.all() as Array<{ task_id: string }>;

      let totalTasks = 0;
      let totalSessions = 0;
      let totalActions = 0;
      let totalApprovals = 0;
      let totalEvidence = 0;

      for (const row of rows) {
        const res = this.purgeTaskData(row.task_id, correlationId);
        totalTasks += res.purgedTasksCount;
        totalSessions += res.purgedSessionsCount;
        totalActions += res.purgedActionsCount;
        totalApprovals += res.purgedApprovalsCount;
        totalEvidence += res.purgedEvidenceCount;
      }

      // Also clean project memory
      this.db.prepare('DELETE FROM project_memory_items').run();
      this.db.prepare('DELETE FROM project_maps').run();

      const auditEvt = this.auditRepo.appendEvent({
        taskId: 'global',
        sessionId: 'user_privacy_clear',
        correlationId,
        eventType: 'all_user_data_cleared',
        actor: 'user',
        outcome: 'allowed',
        details: {
          totalTasksPurged: totalTasks,
          totalSessionsPurged: totalSessions,
          totalActionsPurged: totalActions,
        },
      });

      const verification = this.auditRepo.verifyChain();

      return {
        success: verification.valid,
        purgedTasksCount: totalTasks,
        purgedSessionsCount: totalSessions,
        purgedActionsCount: totalActions,
        purgedApprovalsCount: totalApprovals,
        purgedEvidenceCount: totalEvidence,
        auditEventId: auditEvt.eventId,
        chainVerification: verification,
      };
    });
  }
}
