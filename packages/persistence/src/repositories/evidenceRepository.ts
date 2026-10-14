/**
 * @mediator/persistence — Evidence Repository (S10)
 *
 * Security Invariant:
 * - Maintains evidence levels strictly: agent-reported, mediator-observed, executor-verified.
 * - Storing or reading a database row never upgrades an agent's claim into verified execution evidence.
 */

import { type EvidenceLevelValue } from '@mediator/shared-contracts';
import { safeRedactString } from '../auditEvent.js';
import { type DatabaseConnection } from '../database.js';

export interface EvidenceRecord {
  readonly evidenceId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly actionId?: string | undefined;
  readonly roundNumber?: number | undefined;
  readonly source: string;
  readonly evidenceLevel: EvidenceLevelValue;
  readonly verificationStatus: 'unverified' | 'verified' | 'rejected';
  readonly exitCode?: number | undefined;
  readonly evidenceHash: string;
  readonly summarySafe: string;
  readonly createdAt: number;
}

export interface RecordEvidenceParams {
  readonly evidenceId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly actionId?: string | undefined;
  readonly roundNumber?: number | undefined;
  readonly source: string;
  readonly evidenceLevel: EvidenceLevelValue;
  readonly verificationStatus: 'unverified' | 'verified' | 'rejected';
  readonly exitCode?: number | undefined;
  readonly evidenceHash: string;
  readonly summary: string;
  readonly createdAt?: number | undefined;
}

export class EvidenceRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public recordEvidence(params: RecordEvidenceParams): EvidenceRecord {
    const now = params.createdAt ?? Date.now();
    const safeSummary = safeRedactString(params.summary);

    const stmt = this.db.prepare(`
      INSERT INTO evidence (
        evidence_id,
        task_id,
        session_id,
        action_id,
        round_number,
        source,
        evidence_level,
        verification_status,
        exit_code,
        evidence_hash,
        summary_safe,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    stmt.run(
      params.evidenceId,
      params.taskId,
      params.sessionId,
      params.actionId ?? null,
      params.roundNumber ?? null,
      params.source,
      params.evidenceLevel,
      params.verificationStatus,
      params.exitCode ?? null,
      params.evidenceHash,
      safeSummary,
      now,
    );

    return {
      evidenceId: params.evidenceId,
      taskId: params.taskId,
      sessionId: params.sessionId,
      actionId: params.actionId,
      roundNumber: params.roundNumber,
      source: params.source,
      evidenceLevel: params.evidenceLevel,
      verificationStatus: params.verificationStatus,
      exitCode: params.exitCode,
      evidenceHash: params.evidenceHash,
      summarySafe: safeSummary,
      createdAt: now,
    };
  }

  public getEvidence(evidenceId: string): EvidenceRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        evidence_id,
        task_id,
        session_id,
        action_id,
        round_number,
        source,
        evidence_level,
        verification_status,
        exit_code,
        evidence_hash,
        summary_safe,
        created_at
      FROM evidence
      WHERE evidence_id = ?;
    `);

    const row = stmt.get(evidenceId) as
      | {
          evidence_id: string;
          task_id: string;
          session_id: string;
          action_id: string | null;
          round_number: number | null;
          source: string;
          evidence_level: string;
          verification_status: string;
          exit_code: number | null;
          evidence_hash: string;
          summary_safe: string;
          created_at: number;
        }
      | undefined;

    if (!row) return null;

    return {
      evidenceId: row.evidence_id,
      taskId: row.task_id,
      sessionId: row.session_id,
      actionId: row.action_id ?? undefined,
      roundNumber: row.round_number ?? undefined,
      source: row.source,
      evidenceLevel: row.evidence_level as EvidenceLevelValue,
      verificationStatus: row.verification_status as EvidenceRecord['verificationStatus'],
      exitCode: row.exit_code ?? undefined,
      evidenceHash: row.evidence_hash,
      summarySafe: row.summary_safe,
      createdAt: row.created_at,
    };
  }

  public getEvidenceForTask(taskId: string): EvidenceRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        evidence_id,
        task_id,
        session_id,
        action_id,
        round_number,
        source,
        evidence_level,
        verification_status,
        exit_code,
        evidence_hash,
        summary_safe,
        created_at
      FROM evidence
      WHERE task_id = ?
      ORDER BY created_at ASC;
    `);

    const rows = stmt.all(taskId) as Array<{
      evidence_id: string;
      task_id: string;
      session_id: string;
      action_id: string | null;
      round_number: number | null;
      source: string;
      evidence_level: string;
      verification_status: string;
      exit_code: number | null;
      evidence_hash: string;
      summary_safe: string;
      created_at: number;
    }>;

    return rows.map((r) => ({
      evidenceId: r.evidence_id,
      taskId: r.task_id,
      sessionId: r.session_id,
      actionId: r.action_id ?? undefined,
      roundNumber: r.round_number ?? undefined,
      source: r.source,
      evidenceLevel: r.evidence_level as EvidenceLevelValue,
      verificationStatus: r.verification_status as EvidenceRecord['verificationStatus'],
      exitCode: r.exit_code ?? undefined,
      evidenceHash: r.evidence_hash,
      summarySafe: r.summary_safe,
      createdAt: r.created_at,
    }));
  }
}
