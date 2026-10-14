/**
 * @mediator/orchestrator — Startup Recovery & Reconciliation Service (S25)
 *
 * Requirements:
 * - Authoritative startup reconciliation across crash, restart, and disconnects:
 *   1. Reconciles task, session, actions, staged files, approvals, conversation identity, capabilities.
 *   2. CRITICAL INVARIANT: Never replay an action whose completion status is unknown.
 *   3. In-flight actions are durably marked 'unknown' or 'recovery-required'.
 *   4. Stage conflicts, expired approvals, and conversation drift are identified.
 *   5. Safe resume requires strict revalidation of all boundary contracts.
 *   6. Discarding staged data or blind auto-retries is forbidden.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type RecoveryStatus,
  type ReconciliationReport,
  type ActionRecordSummary,
  type ConversationIdentity,
  type S00ExecutionDecision,
  type Result,
  ok,
  err,
  ErrorCode,
  makeMediatorError,
  type MediatorError,
} from '@mediator/shared-contracts';
import { StageStore } from '@mediator/stage-store';

export interface RecoveryReconcileOptions {
  readonly workspaceRoot: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly s00Decision: S00ExecutionDecision;
  readonly activeConversation?: ConversationIdentity | undefined;
  readonly expectedConversation?: ConversationIdentity | undefined;
  readonly stageStore?: StageStore | undefined;
  readonly rawActions?: readonly ActionRecordSummary[] | undefined;
  readonly pendingApproval?: {
    readonly approvalId: string;
    readonly expiresAt: number;
    readonly payloadHash: string;
    readonly consumed: boolean;
  } | undefined;
  readonly capabilityFreshnessTimestamp?: number | undefined;
  readonly capabilityTtlMs?: number | undefined;
}

export interface SafeResumeOptions {
  readonly taskId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly resolvedActionIds?: readonly string[] | undefined;
  readonly explicitUserConfirmation: boolean;
}

export class OrchestratorRecoveryService {
  private latestReports: Map<string, ReconciliationReport> = new Map();

  /**
   * Reconciles startup state and produces an authoritative ReconciliationReport.
   */
  public reconcileStartup(options: RecoveryReconcileOptions): ReconciliationReport {
    const {
      workspaceRoot,
      taskId,
      sessionId,
      correlationId,
      s00Decision,
      activeConversation,
      expectedConversation,
      stageStore,
      rawActions = [],
      pendingApproval,
      capabilityFreshnessTimestamp,
      capabilityTtlMs = 86400000, // 24h
    } = options;

    const reconciliationId = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const blockers: string[] = [];
    const unknownActions: ActionRecordSummary[] = [];

    // 1. Reconcile Actions: Mark in-flight as unknown / recovery-required
    // INVARIANT: Never replay an action whose completion status is unknown
    for (const action of rawActions) {
      if (action.status === 'in-flight' || action.status === 'unknown') {
        const markedUnknown: ActionRecordSummary = {
          ...action,
          status: 'unknown',
          failureReason: 'Operation was interrupted or in-flight during shutdown; outcome unknown.',
        };
        unknownActions.push(markedUnknown);
        blockers.push(`Action "${action.actionId}" has unknown completion status and cannot be replayed automatically.`);
      }
    }

    // 2. Reconcile Staging & Conflicts
    let stageConflictDetected = false;
    if (stageStore) {
      const stages = stageStore.getStagesForTask(taskId);
      for (const st of stages) {
        const stagedFiles = stageStore.listStagedChanges(st.stageId);
        if (stagedFiles.some((f) => f.conflictStatus !== 'clean')) {
          stageConflictDetected = true;
          blockers.push('Stage conflict detected in staged files. Resolve before resuming.');
          break;
        }
      }
    } else {
      // Direct disk check if stage metadata exists in workspace
      const stageMetaPath = path.join(workspaceRoot, '.mediator', 'staging', taskId, 'meta.json');
      if (fs.existsSync(stageMetaPath)) {
        try {
          const raw = fs.readFileSync(stageMetaPath, 'utf8');
          const meta = JSON.parse(raw) as { hasConflicts?: boolean };
          if (meta.hasConflicts) {
            stageConflictDetected = true;
            blockers.push('Stage metadata records unresolved live file conflicts.');
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    // 3. Reconcile Approvals
    let expiredApprovalsCount = 0;
    if (pendingApproval) {
      if (pendingApproval.consumed) {
        blockers.push(`Pending approval "${pendingApproval.approvalId}" was already consumed.`);
      } else if (Date.now() > pendingApproval.expiresAt) {
        expiredApprovalsCount++;
        blockers.push(`Pending approval "${pendingApproval.approvalId}" expired at ${new Date(pendingApproval.expiresAt).toISOString()}.`);
      }
    }

    // 4. Reconcile Conversation Identity
    let conversationIdentityVerified = true;
    if (expectedConversation && activeConversation) {
      if (
        expectedConversation.conversationId !== activeConversation.conversationId ||
        expectedConversation.provider !== activeConversation.provider
      ) {
        conversationIdentityVerified = false;
        blockers.push(
          `Conversation identity mismatch (expected "${expectedConversation.conversationId}", active "${activeConversation.conversationId}").`,
        );
      }
    } else if (expectedConversation && !activeConversation) {
      conversationIdentityVerified = false;
      blockers.push('Browser conversation is not attached.');
    }

    // 5. Reconcile Capabilities & S00 Decision
    let capabilityStatusValid = true;
    if (capabilityFreshnessTimestamp) {
      if (Date.now() - capabilityFreshnessTimestamp > capabilityTtlMs) {
        capabilityStatusValid = false;
        blockers.push('Executor capability evidence is stale. Fresh canary evaluation required.');
      }
    }
    if (s00Decision !== 'NO-GO-AUTOEXEC') {
      // S00 invariant check: must match canonical active decision
      blockers.push(`Unexpected S00 decision "${s00Decision}"; repository requires NO-GO-AUTOEXEC.`);
    }

    // 6. Determine overall recovery status
    let status: RecoveryStatus = 'recovery-not-required';
    const canSafeResume = blockers.length === 0 && unknownActions.length === 0;

    if (unknownActions.length > 0) {
      status = 'unknown-completion';
    } else if (stageConflictDetected || expiredApprovalsCount > 0 || !conversationIdentityVerified || !capabilityStatusValid) {
      status = 'recovery-required';
    } else if (blockers.length > 0) {
      status = 'paused-for-user';
    } else if (rawActions.length > 0) {
      status = 'recovered';
    }

    const report: ReconciliationReport = {
      reconciliationId,
      taskId,
      sessionId,
      status,
      unknownActions,
      expiredApprovalsCount,
      stageConflictDetected,
      conversationIdentityVerified,
      capabilityStatusValid,
      canSafeResume,
      safeResumeBlockers: blockers,
      timestamp: Date.now(),
      correlationId,
    };

    this.latestReports.set(taskId, report);
    return report;
  }

  /**
   * Evaluates whether safe resume is permitted for a task.
   * Fails closed if unknown actions, conflicts, or mismatches remain unresolved.
   */
  public requestSafeResume(options: SafeResumeOptions): Result<ReconciliationReport, MediatorError> {
    const { taskId, sessionId, correlationId, resolvedActionIds = [], explicitUserConfirmation } = options;
    const existing = this.latestReports.get(taskId);

    if (!existing) {
      return err(
        makeMediatorError(
          ErrorCode.RECOVERY_RECONCILIATION_REQUIRED,
          `Task "${taskId}" has not performed startup reconciliation. Reconcile before resuming.`,
          { taskId, sessionId, correlationId },
        ),
      );
    }

    if (!explicitUserConfirmation) {
      return err(
        makeMediatorError(
          ErrorCode.APPROVAL_REQUIRED,
          `Resume for task "${taskId}" requires explicit user confirmation.`,
          { taskId, sessionId, correlationId },
        ),
      );
    }

    // Check if all unknown actions have been explicitly acknowledged/resolved by user
    const remainingUnknown = existing.unknownActions.filter(
      (a) => !resolvedActionIds.includes(a.actionId),
    );

    if (remainingUnknown.length > 0) {
      return err(
        makeMediatorError(
          ErrorCode.RECOVERY_ACTION_UNKNOWN,
          `Cannot resume task "${taskId}": ${remainingUnknown.length} action(s) still have unknown status and cannot be replayed.`,
          { taskId, sessionId, correlationId, detail: { remainingUnknown: remainingUnknown.map((u) => u.actionId) } },
        ),
      );
    }

    // Recheck safe resume blockers
    if (!existing.canSafeResume && remainingUnknown.length === 0 && existing.stageConflictDetected) {
      return err(
        makeMediatorError(
          ErrorCode.STAGE_CONFLICT,
          `Cannot resume task "${taskId}": stage conflict remains unresolved.`,
          { taskId, sessionId, correlationId },
        ),
      );
    }

    if (!existing.conversationIdentityVerified) {
      return err(
        makeMediatorError(
          ErrorCode.CONVERSATION_MISMATCH,
          `Cannot resume task "${taskId}": conversation identity is unverified or mismatched.`,
          { taskId, sessionId, correlationId },
        ),
      );
    }

    // Successfully transitioned to recovered
    const updatedReport: ReconciliationReport = {
      ...existing,
      status: 'recovered',
      canSafeResume: true,
      unknownActions: [],
      safeResumeBlockers: [],
      timestamp: Date.now(),
    };

    this.latestReports.set(taskId, updatedReport);
    return ok(updatedReport);
  }

  public getReport(taskId: string): ReconciliationReport | undefined {
    return this.latestReports.get(taskId);
  }

  public clearReport(taskId: string): void {
    this.latestReports.delete(taskId);
  }
}
