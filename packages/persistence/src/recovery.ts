/**
 * @mediator/persistence — Startup Crash Recovery & Reconciliation (S10)
 *
 * Core Invariant:
 * "After a restart, Mediator must not assume that an action with an uncertain outcome
 * completed successfully, and it must never blindly replay that action."
 *
 * Requirements:
 * - Mark in-flight actions ('proposed', 'executing') as 'uncertain'.
 * - Mark non-terminal tasks as 'reconciliation_required' (TaskState.PAUSED).
 * - Mark active sessions as 'reconciliation_required' (requiring safe reattachment).
 * - Expire pending approvals that timed out during shutdown.
 * - Load all consumed action IDs and highest sequences to ensure S08 replay protection persists.
 * - Append an immutable recovery audit event to the hash chain.
 */

import { TaskState } from '@mediator/shared-contracts';
import { type ReplayGuard } from '@mediator/protocol';
import { type DatabaseConnection } from './database.js';
import { TaskRepository } from './repositories/taskRepository.js';
import { SessionRepository } from './repositories/sessionRepository.js';
import { ActionRepository } from './repositories/actionRepository.js';
import { ApprovalRepository } from './repositories/approvalRepository.js';
import { AuditRepository } from './auditRepository.js';

export type RecoveryOutcome =
  | 'restored'
  | 'reconciliation_required'
  | 'failed_safe'
  | 'invalid_state';

export interface RecoveryReport {
  readonly outcome: RecoveryOutcome;
  readonly affectedTasks: number;
  readonly uncertainActionsCount: number;
  readonly expiredApprovalsCount: number;
  readonly consumedActionIds: string[];
  readonly activeSessionsRequiringReconciliation: string[];
  readonly auditChainVerified: boolean;
  readonly details: string[];
}

export interface ReconcileOptions {
  readonly replayGuard?: ReplayGuard | undefined;
  readonly auditRepository?: AuditRepository | undefined;
}

export class RecoveryManager {
  private readonly taskRepo: TaskRepository;
  private readonly sessionRepo: SessionRepository;
  private readonly actionRepo: ActionRepository;
  private readonly approvalRepo: ApprovalRepository;
  private readonly auditRepo: AuditRepository;

  constructor(private readonly db: DatabaseConnection) {
    this.taskRepo = new TaskRepository(db);
    this.sessionRepo = new SessionRepository(db);
    this.actionRepo = new ActionRepository(db);
    this.approvalRepo = new ApprovalRepository(db);
    this.auditRepo = new AuditRepository(db);
  }

  /**
   * Performs deterministic startup recovery and reconciliation.
   */
  public runStartupRecovery(options: ReconcileOptions = {}): RecoveryReport {
    return this.db.transaction(() => {
      const details: string[] = [];

      // 1. Verify audit chain integrity on startup
      const auditRepo = options.auditRepository ?? this.auditRepo;
      const chainCheck = auditRepo.verifyChain();
      if (!chainCheck.valid) {
        details.push(
          `Audit chain integrity check failed at index ${chainCheck.failedAtChainIndex ?? 'unknown'}: ${chainCheck.reason ?? 'corrupted'}`,
        );
        return {
          outcome: 'invalid_state',
          affectedTasks: 0,
          uncertainActionsCount: 0,
          expiredApprovalsCount: 0,
          consumedActionIds: [],
          activeSessionsRequiringReconciliation: [],
          auditChainVerified: false,
          details,
        };
      }

      // 2. Mark in-flight actions as uncertain
      // INVARIANT: Never assume an in-flight action succeeded, and never replay it blindly.
      const uncertainActionsCount = this.actionRepo.markInFlightActionsUncertain();
      if (uncertainActionsCount > 0) {
        details.push(`Marked ${uncertainActionsCount} in-flight actions as 'uncertain'`);
      }

      // 3. Mark non-terminal tasks as reconciliation_required / PAUSED
      const activeTasks = this.taskRepo.listActiveTasks();
      let affectedTasks = 0;
      for (const task of activeTasks) {
        // If task was in an active in-flight phase (VALIDATING, STAGING, EXECUTING, SANITIZING), pause it
        if (
          task.state === TaskState.VALIDATING ||
          task.state === TaskState.STAGING ||
          task.state === TaskState.EXECUTING ||
          task.state === TaskState.SANITIZING ||
          task.state === TaskState.WAITING_FOR_AI
        ) {
          this.taskRepo.updateTaskState(
            task.taskId,
            TaskState.PAUSED,
            'reconciliation_required',
            { pauseReason: 'Unexpected shutdown during in-flight operation' },
          );
          affectedTasks++;
          details.push(`Task '${task.taskId}' transitioned from ${task.state} to PAUSED (reconciliation_required)`);
        }
      }

      // 4. Mark active sessions as reconciliation_required
      const activeSessions = this.sessionRepo.getActiveSessions();
      const reconciledSessionIds: string[] = [];
      for (const session of activeSessions) {
        this.sessionRepo.updateRecoveryStatus(session.sessionId, 'reconciliation_required');
        reconciledSessionIds.push(session.sessionId);
        details.push(`Session '${session.sessionId}' marked 'reconciliation_required' (reattachment required)`);
      }

      // 5. Expire pending approvals that timed out
      const expiredApprovalsCount = this.approvalRepo.expirePendingApprovals();
      if (expiredApprovalsCount > 0) {
        details.push(`Expired ${expiredApprovalsCount} pending approvals whose deadline elapsed`);
      }

      // 6. Collect all consumed action IDs for S08 replay guard continuity across restart
      const consumedActionIds = Array.from(this.actionRepo.getAllConsumedActionIds());
      if (options.replayGuard && consumedActionIds.length > 0) {
        // Seed consumed IDs into active ReplayGuard if provided
        if (typeof (options.replayGuard as unknown as { seedConsumedState?: (ids: string[]) => void }).seedConsumedState === 'function') {
          (options.replayGuard as unknown as { seedConsumedState: (ids: string[]) => void }).seedConsumedState(consumedActionIds);
        }
      }

      // 7. Determine overall recovery outcome
      let outcome: RecoveryOutcome = 'restored';
      if (uncertainActionsCount > 0 || affectedTasks > 0 || reconciledSessionIds.length > 0) {
        outcome = 'reconciliation_required';
      }

      // 8. Record a durable audit event documenting the recovery operation
      auditRepo.appendEvent({
        taskId: activeTasks[0]?.taskId ?? 'system',
        sessionId: reconciledSessionIds[0] ?? 'system',
        correlationId: `recovery_${Date.now()}`,
        eventType: 'RECOVERY_PERFORMED',
        actor: 'mediator',
        outcome: 'allowed',
        details: {
          outcome,
          affectedTasks,
          uncertainActionsCount,
          expiredApprovalsCount,
          consumedActionIdsCount: consumedActionIds.length,
          reconciledSessionCount: reconciledSessionIds.length,
        },
      });

      return {
        outcome,
        affectedTasks,
        uncertainActionsCount,
        expiredApprovalsCount,
        consumedActionIds,
        activeSessionsRequiringReconciliation: reconciledSessionIds,
        auditChainVerified: true,
        details,
      };
    });
  }
}
