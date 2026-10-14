/**
 * @mediator/persistence — Action Repository (S10)
 *
 * Security & Replay Invariants:
 * - Single-use action IDs tracked across sessions and crashes.
 * - Sensitive parameters are redacted via context-security; raw file bodies and secrets are never stored.
 * - Crash recovery marks in-flight actions as 'uncertain'.
 */

import { type DatabaseConnection } from '../database.js';
import { sanitizeAuditDetails } from '../auditEvent.js';
import { PersistenceError, PersistenceErrorCode } from '../errors.js';

export interface ActionRecord {
  readonly actionId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly roundNumber: number;
  readonly sequenceNumber: number;
  readonly actionType: string;
  readonly payloadHash: string;
  readonly parametersSafe: Record<string, unknown>;
  readonly status: 'proposed' | 'accepted' | 'denied' | 'pending_approval' | 'executing' | 'completed' | 'failed' | 'uncertain';
  readonly policyDecision: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'UNSUPPORTED';
  readonly policyReason?: string | undefined;
  readonly idempotent: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly outcomeDetails?: string | undefined;
}

export interface RecordActionParams {
  readonly actionId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly roundNumber: number;
  readonly sequenceNumber: number;
  readonly actionType: string;
  readonly payloadHash: string;
  readonly parameters?: Record<string, unknown> | undefined;
  readonly status: 'proposed' | 'accepted' | 'denied' | 'pending_approval' | 'executing' | 'completed' | 'failed' | 'uncertain';
  readonly policyDecision: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'UNSUPPORTED';
  readonly policyReason?: string | undefined;
  readonly idempotent?: boolean | undefined;
  readonly createdAt?: number | undefined;
  readonly outcomeDetails?: string | undefined;
}

export class ActionRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public recordAction(params: RecordActionParams): ActionRecord {
    const now = params.createdAt ?? Date.now();
    const rawParams = params.parameters ?? {};
    const safeParams = sanitizeAuditDetails(rawParams);
    const paramsJson = JSON.stringify(safeParams);
    const idempotentInt = params.idempotent ? 1 : 0;

    const stmt = this.db.prepare(`
      INSERT INTO actions (
        action_id,
        task_id,
        session_id,
        round_number,
        sequence_number,
        action_type,
        payload_hash,
        parameters_safe,
        status,
        policy_decision,
        policy_reason,
        idempotent,
        created_at,
        updated_at,
        outcome_details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    try {
      stmt.run(
        params.actionId,
        params.taskId,
        params.sessionId,
        params.roundNumber,
        params.sequenceNumber,
        params.actionType,
        params.payloadHash,
        paramsJson,
        params.status,
        params.policyDecision,
        params.policyReason ?? null,
        idempotentInt,
        now,
        now,
        params.outcomeDetails ?? null,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed') || msg.includes('FOREIGN KEY constraint failed')) {
        throw new PersistenceError(PersistenceErrorCode.CONSTRAINT_VIOLATION, msg, { error: msg });
      }
      throw new PersistenceError(PersistenceErrorCode.DATABASE_CORRUPT, msg, { error: msg });
    }

    return {
      actionId: params.actionId,
      taskId: params.taskId,
      sessionId: params.sessionId,
      roundNumber: params.roundNumber,
      sequenceNumber: params.sequenceNumber,
      actionType: params.actionType,
      payloadHash: params.payloadHash,
      parametersSafe: safeParams,
      status: params.status,
      policyDecision: params.policyDecision,
      policyReason: params.policyReason,
      idempotent: Boolean(params.idempotent),
      createdAt: now,
      updatedAt: now,
      outcomeDetails: params.outcomeDetails,
    };
  }

  public getAction(actionId: string): ActionRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        action_id,
        task_id,
        session_id,
        round_number,
        sequence_number,
        action_type,
        payload_hash,
        parameters_safe,
        status,
        policy_decision,
        policy_reason,
        idempotent,
        created_at,
        updated_at,
        outcome_details
      FROM actions
      WHERE action_id = ?;
    `);

    const row = stmt.get(actionId) as
      | {
          action_id: string;
          task_id: string;
          session_id: string;
          round_number: number;
          sequence_number: number;
          action_type: string;
          payload_hash: string;
          parameters_safe: string;
          status: string;
          policy_decision: string;
          policy_reason: string | null;
          idempotent: number;
          created_at: number;
          updated_at: number;
          outcome_details: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      actionId: row.action_id,
      taskId: row.task_id,
      sessionId: row.session_id,
      roundNumber: row.round_number,
      sequenceNumber: row.sequence_number,
      actionType: row.action_type,
      payloadHash: row.payload_hash,
      parametersSafe: JSON.parse(row.parameters_safe) as Record<string, unknown>,
      status: row.status as ActionRecord['status'],
      policyDecision: row.policy_decision as ActionRecord['policyDecision'],
      policyReason: row.policy_reason ?? undefined,
      idempotent: row.idempotent === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      outcomeDetails: row.outcome_details ?? undefined,
    };
  }

  public updateActionStatus(
    actionId: string,
    status: ActionRecord['status'],
    outcomeDetails?: string,
  ): ActionRecord {
    const now = Date.now();
    const existing = this.getAction(actionId);
    if (!existing) {
      throw new PersistenceError(PersistenceErrorCode.RECORD_NOT_FOUND, `Action '${actionId}' not found`);
    }

    const nextDetails = outcomeDetails ?? existing.outcomeDetails ?? null;

    const stmt = this.db.prepare(`
      UPDATE actions
      SET status = ?, outcome_details = ?, updated_at = ?
      WHERE action_id = ?;
    `);

    stmt.run(status, nextDetails, now, actionId);

    return {
      ...existing,
      status,
      outcomeDetails: nextDetails ?? undefined,
      updatedAt: now,
    };
  }

  public getActionsForSession(sessionId: string): ActionRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        action_id,
        task_id,
        session_id,
        round_number,
        sequence_number,
        action_type,
        payload_hash,
        parameters_safe,
        status,
        policy_decision,
        policy_reason,
        idempotent,
        created_at,
        updated_at,
        outcome_details
      FROM actions
      WHERE session_id = ?
      ORDER BY sequence_number ASC;
    `);

    const rows = stmt.all(sessionId) as Array<{
      action_id: string;
      task_id: string;
      session_id: string;
      round_number: number;
      sequence_number: number;
      action_type: string;
      payload_hash: string;
      parameters_safe: string;
      status: string;
      policy_decision: string;
      policy_reason: string | null;
      idempotent: number;
      created_at: number;
      updated_at: number;
      outcome_details: string | null;
    }>;

    return rows.map((r) => ({
      actionId: r.action_id,
      taskId: r.task_id,
      sessionId: r.session_id,
      roundNumber: r.round_number,
      sequenceNumber: r.sequence_number,
      actionType: r.action_type,
      payloadHash: r.payload_hash,
      parametersSafe: JSON.parse(r.parameters_safe) as Record<string, unknown>,
      status: r.status as ActionRecord['status'],
      policyDecision: r.policy_decision as ActionRecord['policyDecision'],
      policyReason: r.policy_reason ?? undefined,
      idempotent: r.idempotent === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      outcomeDetails: r.outcome_details ?? undefined,
    }));
  }

  public getConsumedActionIdsForSession(sessionId: string): Set<string> {
    const stmt = this.db.prepare(`
      SELECT action_id
      FROM actions
      WHERE session_id = ?;
    `);
    const rows = stmt.all(sessionId) as Array<{ action_id: string }>;
    return new Set(rows.map((r) => r.action_id));
  }

  public getAllConsumedActionIds(): Set<string> {
    const stmt = this.db.prepare(`
      SELECT action_id FROM actions;
    `);
    const rows = stmt.all() as Array<{ action_id: string }>;
    return new Set(rows.map((r) => r.action_id));
  }

  public getHighestSequenceForSession(sessionId: string): number {
    const stmt = this.db.prepare(`
      SELECT MAX(sequence_number) as max_seq
      FROM actions
      WHERE session_id = ?;
    `);
    const row = stmt.get(sessionId) as { max_seq?: number | null } | undefined;
    return row?.max_seq ?? -1;
  }

  /**
   * Marks in-flight operations ('proposed', 'executing') as 'uncertain'.
   * Invariant: Never assume in-flight actions succeeded after restart, and never replay them blindly.
   */
  public markInFlightActionsUncertain(sessionId?: string): number {
    const now = Date.now();
    let stmt;
    if (sessionId) {
      stmt = this.db.prepare(`
        UPDATE actions
        SET status = 'uncertain', outcome_details = 'Marked uncertain during restart reconciliation', updated_at = ?
        WHERE session_id = ? AND status IN ('proposed', 'executing');
      `);
      const res = stmt.run(now, sessionId);
      return Number(res.changes);
    } else {
      stmt = this.db.prepare(`
        UPDATE actions
        SET status = 'uncertain', outcome_details = 'Marked uncertain during restart reconciliation', updated_at = ?
        WHERE status IN ('proposed', 'executing');
      `);
      const res = stmt.run(now);
      return Number(res.changes);
    }
  }
}
