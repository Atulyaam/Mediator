/**
 * @mediator/persistence — Approval Repository (S10)
 *
 * Security Invariants:
 * - Single-use: once consumed, an approval cannot be reused.
 * - An approval request remains 'pending' until resolved by a trusted caller.
 * - Expired approvals cannot be resolved or consumed.
 * - Persisting an approval request must never turn it into an approval.
 */

import { type DatabaseConnection } from '../database.js';
import { PersistenceError, PersistenceErrorCode } from '../errors.js';

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly actionId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly changeHash: string;
  readonly requestingCaller: string;
  readonly status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
  readonly requestedAt: number;
  readonly expiresAt: number;
  readonly resolvedAt?: number | undefined;
  readonly resolvedBy?: string | undefined;
  readonly resolutionReason?: string | undefined;
  readonly consumedAt?: number | undefined;
}

export interface CreateApprovalParams {
  readonly approvalId: string;
  readonly actionId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly changeHash: string;
  readonly requestingCaller: string;
  readonly timeoutMs?: number | undefined;
  readonly requestedAt?: number | undefined;
}

export class ApprovalRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public createApproval(params: CreateApprovalParams): ApprovalRecord {
    const now = params.requestedAt ?? Date.now();
    const timeout = params.timeoutMs ?? 300_000; // default 5 minutes
    const expiresAt = now + timeout;

    const stmt = this.db.prepare(`
      INSERT INTO approvals (
        approval_id,
        action_id,
        task_id,
        session_id,
        change_hash,
        requesting_caller,
        status,
        requested_at,
        expires_at,
        resolved_at,
        resolved_by,
        resolution_reason,
        consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL);
    `);

    stmt.run(
      params.approvalId,
      params.actionId,
      params.taskId,
      params.sessionId,
      params.changeHash,
      params.requestingCaller,
      now,
      expiresAt,
    );

    return {
      approvalId: params.approvalId,
      actionId: params.actionId,
      taskId: params.taskId,
      sessionId: params.sessionId,
      changeHash: params.changeHash,
      requestingCaller: params.requestingCaller,
      status: 'pending',
      requestedAt: now,
      expiresAt,
    };
  }

  public getApproval(approvalId: string): ApprovalRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        approval_id,
        action_id,
        task_id,
        session_id,
        change_hash,
        requesting_caller,
        status,
        requested_at,
        expires_at,
        resolved_at,
        resolved_by,
        resolution_reason,
        consumed_at
      FROM approvals
      WHERE approval_id = ?;
    `);

    const row = stmt.get(approvalId) as
      | {
          approval_id: string;
          action_id: string;
          task_id: string;
          session_id: string;
          change_hash: string;
          requesting_caller: string;
          status: string;
          requested_at: number;
          expires_at: number;
          resolved_at: number | null;
          resolved_by: string | null;
          resolution_reason: string | null;
          consumed_at: number | null;
        }
      | undefined;

    if (!row) return null;

    let status = row.status as ApprovalRecord['status'];
    // Evaluate expiration
    if (status === 'pending' && Date.now() > row.expires_at) {
      status = 'expired';
      const updateStmt = this.db.prepare(`
        UPDATE approvals SET status = 'expired' WHERE approval_id = ?;
      `);
      updateStmt.run(approvalId);
    }

    return {
      approvalId: row.approval_id,
      actionId: row.action_id,
      taskId: row.task_id,
      sessionId: row.session_id,
      changeHash: row.change_hash,
      requestingCaller: row.requesting_caller,
      status,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
      resolutionReason: row.resolution_reason ?? undefined,
      consumedAt: row.consumed_at ?? undefined,
    };
  }

  public resolveApproval(
    approvalId: string,
    resolution: 'approved' | 'denied',
    resolvedBy: string,
    reason?: string,
  ): ApprovalRecord {
    const existing = this.getApproval(approvalId);
    if (!existing) {
      throw new PersistenceError(PersistenceErrorCode.RECORD_NOT_FOUND, `Approval '${approvalId}' not found`);
    }

    if (existing.status !== 'pending') {
      throw new PersistenceError(
        PersistenceErrorCode.MUTATION_DENIED,
        `Cannot resolve approval in status '${existing.status}'`,
      );
    }

    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE approvals
      SET status = ?, resolved_at = ?, resolved_by = ?, resolution_reason = ?
      WHERE approval_id = ?;
    `);

    stmt.run(resolution, now, resolvedBy, reason ?? null, approvalId);

    return {
      ...existing,
      status: resolution,
      resolvedAt: now,
      resolvedBy,
      resolutionReason: reason,
    };
  }

  public consumeApproval(approvalId: string, actionId: string): ApprovalRecord {
    const existing = this.getApproval(approvalId);
    if (!existing) {
      throw new PersistenceError(PersistenceErrorCode.RECORD_NOT_FOUND, `Approval '${approvalId}' not found`);
    }

    if (existing.actionId !== actionId) {
      throw new PersistenceError(
        PersistenceErrorCode.CONSTRAINT_VIOLATION,
        `Approval '${approvalId}' is scoped to action '${existing.actionId}', not '${actionId}'`,
      );
    }

    if (existing.status !== 'approved') {
      throw new PersistenceError(
        PersistenceErrorCode.MUTATION_DENIED,
        `Cannot consume approval in status '${existing.status}' (must be 'approved')`,
      );
    }

    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE approvals
      SET status = 'consumed', consumed_at = ?
      WHERE approval_id = ?;
    `);

    stmt.run(now, approvalId);

    return {
      ...existing,
      status: 'consumed',
      consumedAt: now,
    };
  }

  public expirePendingApprovals(): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE approvals
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at < ?;
    `);
    const res = stmt.run(now);
    return Number(res.changes);
  }
}
