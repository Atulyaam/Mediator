/**
 * @mediator/persistence — Handoff Repository (S17)
 *
 * Persists bounded IDE agent handoff metadata and lifecycle state in SQLite.
 * Storing or retrieving a handoff record NEVER implies that an agent was
 * automatically contacted or that its report is verified.
 */

import {
  type HandoffRecord,
  type HandoffStatusValue,
  HandoffStatus,
} from '@mediator/shared-contracts';
import { type DatabaseConnection } from '../database.js';

interface HandoffRow {
  handoff_id: string;
  task_id: string;
  session_id: string;
  stage_id: string | null;
  workspace_root: string;
  correlation_id: string;
  status: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  prompt_hash: string;
  prompt_preview_safe: string;
  allowed_scope: string;
  expected_schema_version: string;
  caller_source: string;
  cancellation_reason: string | null;
  linked_approval_id: string | null;
  audit_ref: string | null;
}

function rowToRecord(row: HandoffRow): HandoffRecord {
  let allowedScope: string[] = [];
  try {
    const parsed = JSON.parse(row.allowed_scope) as unknown;
    if (Array.isArray(parsed)) {
      allowedScope = parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    allowedScope = [];
  }

  return {
    handoffId: row.handoff_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    stageId: row.stage_id ?? undefined,
    workspaceRoot: row.workspace_root,
    correlationId: row.correlation_id,
    status: row.status as HandoffStatusValue,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    promptHash: row.prompt_hash,
    promptPreviewSafe: row.prompt_preview_safe,
    allowedScope,
    expectedReportSchemaVersion: row.expected_schema_version,
    callerSource: row.caller_source,
    cancellationReason: row.cancellation_reason ?? undefined,
    linkedApprovalId: row.linked_approval_id ?? undefined,
    auditRef: row.audit_ref ?? undefined,
  };
}

export class HandoffRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public createHandoff(record: HandoffRecord): HandoffRecord {
    const stmt = this.db.prepare(`
      INSERT INTO handoffs (
        handoff_id,
        task_id,
        session_id,
        stage_id,
        workspace_root,
        correlation_id,
        status,
        created_at,
        updated_at,
        expires_at,
        prompt_hash,
        prompt_preview_safe,
        allowed_scope,
        expected_schema_version,
        caller_source,
        cancellation_reason,
        linked_approval_id,
        audit_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    stmt.run(
      record.handoffId,
      record.taskId,
      record.sessionId,
      record.stageId ?? null,
      record.workspaceRoot,
      record.correlationId,
      record.status,
      record.createdAt,
      record.updatedAt,
      record.expiresAt,
      record.promptHash,
      record.promptPreviewSafe,
      JSON.stringify(record.allowedScope),
      record.expectedReportSchemaVersion,
      record.callerSource,
      record.cancellationReason ?? null,
      record.linkedApprovalId ?? null,
      record.auditRef ?? null,
    );

    return record;
  }

  public getHandoff(handoffId: string): HandoffRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM handoffs WHERE handoff_id = ?;
    `);
    const row = stmt.get(handoffId) as HandoffRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  public listHandoffsForTask(taskId: string): readonly HandoffRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM handoffs WHERE task_id = ? ORDER BY created_at DESC;
    `);
    const rows = stmt.all(taskId) as unknown as HandoffRow[];
    return rows.map(rowToRecord);
  }

  public updateHandoffStatus(
    handoffId: string,
    status: HandoffStatusValue,
    extra?: {
      cancellationReason?: string;
      linkedApprovalId?: string;
      auditRef?: string;
      updatedAt?: number;
    },
  ): HandoffRecord | null {
    const now = extra?.updatedAt ?? Date.now();
    const existing = this.getHandoff(handoffId);
    if (!existing) return null;

    const cancellationReason = extra?.cancellationReason ?? existing.cancellationReason ?? null;
    const linkedApprovalId = extra?.linkedApprovalId ?? existing.linkedApprovalId ?? null;
    const auditRef = extra?.auditRef ?? existing.auditRef ?? null;

    const stmt = this.db.prepare(`
      UPDATE handoffs
      SET status = ?, updated_at = ?, cancellation_reason = ?, linked_approval_id = ?, audit_ref = ?
      WHERE handoff_id = ?;
    `);
    stmt.run(status, now, cancellationReason, linkedApprovalId, auditRef, handoffId);

    return this.getHandoff(handoffId);
  }

  public expireStaleHandoffs(now: number = Date.now()): number {
    const stmt = this.db.prepare(`
      UPDATE handoffs
      SET status = ?, updated_at = ?
      WHERE expires_at < ? AND status IN (?, ?);
    `);
    const result = stmt.run(
      HandoffStatus.EXPIRED,
      now,
      now,
      HandoffStatus.PREPARED,
      HandoffStatus.WAITING_FOR_AGENT,
    );
    return Number(result.changes);
  }
}
