/**
 * @mediator/persistence — Session Repository (S10)
 *
 * Security:
 * - Stores SHA-256 hash of nonce (nonce_hash), NEVER raw plaintext nonce.
 * - Protects session progression and tracks recovery status.
 */

import { createHash } from 'node:crypto';
import { type DatabaseConnection } from '../database.js';
import { PersistenceError, PersistenceErrorCode } from '../errors.js';

export interface SessionRecord {
  readonly sessionId: string;
  readonly taskId: string;
  readonly providerId: string;
  readonly conversationId: string;
  readonly branchOrMessageId?: string | undefined;
  readonly lifecycleState: string;
  readonly protocolVersion: string;
  readonly currentRound: number;
  readonly currentSequence: number;
  readonly baseStateHash: string;
  readonly nonceHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recoveryStatus: string;
}

export interface CreateSessionParams {
  readonly sessionId: string;
  readonly taskId: string;
  readonly providerId: string;
  readonly conversationId: string;
  readonly branchOrMessageId?: string | undefined;
  readonly lifecycleState: string;
  readonly protocolVersion: string;
  readonly currentRound?: number | undefined;
  readonly currentSequence?: number | undefined;
  readonly baseStateHash: string;
  /**
   * Raw nonce is hashed with SHA-256 before storage; the plaintext nonce is never stored.
   */
  readonly nonce: string;
  readonly createdAt?: number | undefined;
  readonly recoveryStatus?: string | undefined;
}

export class SessionRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public static hashNonce(nonce: string): string {
    return createHash('sha256').update(nonce.trim()).digest('hex');
  }

  public createSession(params: CreateSessionParams): SessionRecord {
    const now = params.createdAt ?? Date.now();
    const nonceHash = SessionRepository.hashNonce(params.nonce);
    const round = params.currentRound ?? 0;
    const sequence = params.currentSequence ?? 0;
    const recoveryStatus = params.recoveryStatus ?? 'active';

    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        session_id,
        task_id,
        provider_id,
        conversation_id,
        branch_or_message_id,
        lifecycle_state,
        protocol_version,
        current_round,
        current_sequence,
        base_state_hash,
        nonce_hash,
        created_at,
        updated_at,
        recovery_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    stmt.run(
      params.sessionId,
      params.taskId,
      params.providerId,
      params.conversationId,
      params.branchOrMessageId ?? null,
      params.lifecycleState,
      params.protocolVersion,
      round,
      sequence,
      params.baseStateHash,
      nonceHash,
      now,
      now,
      recoveryStatus,
    );

    return {
      sessionId: params.sessionId,
      taskId: params.taskId,
      providerId: params.providerId,
      conversationId: params.conversationId,
      branchOrMessageId: params.branchOrMessageId,
      lifecycleState: params.lifecycleState,
      protocolVersion: params.protocolVersion,
      currentRound: round,
      currentSequence: sequence,
      baseStateHash: params.baseStateHash,
      nonceHash,
      createdAt: now,
      updatedAt: now,
      recoveryStatus,
    };
  }

  public getSession(sessionId: string): SessionRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        session_id,
        task_id,
        provider_id,
        conversation_id,
        branch_or_message_id,
        lifecycle_state,
        protocol_version,
        current_round,
        current_sequence,
        base_state_hash,
        nonce_hash,
        created_at,
        updated_at,
        recovery_status
      FROM sessions
      WHERE session_id = ?;
    `);

    const row = stmt.get(sessionId) as
      | {
          session_id: string;
          task_id: string;
          provider_id: string;
          conversation_id: string;
          branch_or_message_id: string | null;
          lifecycle_state: string;
          protocol_version: string;
          current_round: number;
          current_sequence: number;
          base_state_hash: string;
          nonce_hash: string;
          created_at: number;
          updated_at: number;
          recovery_status: string;
        }
      | undefined;

    if (!row) return null;

    return {
      sessionId: row.session_id,
      taskId: row.task_id,
      providerId: row.provider_id,
      conversationId: row.conversation_id,
      branchOrMessageId: row.branch_or_message_id ?? undefined,
      lifecycleState: row.lifecycle_state,
      protocolVersion: row.protocol_version,
      currentRound: row.current_round,
      currentSequence: row.current_sequence,
      baseStateHash: row.base_state_hash,
      nonceHash: row.nonce_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      recoveryStatus: row.recovery_status,
    };
  }

  public updateSessionProgress(
    sessionId: string,
    round: number,
    sequence: number,
    baseStateHash: string,
  ): SessionRecord {
    const now = Date.now();
    const existing = this.getSession(sessionId);
    if (!existing) {
      throw new PersistenceError(PersistenceErrorCode.RECORD_NOT_FOUND, `Session '${sessionId}' not found`);
    }

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET current_round = ?, current_sequence = ?, base_state_hash = ?, updated_at = ?
      WHERE session_id = ?;
    `);

    stmt.run(round, sequence, baseStateHash, now, sessionId);

    return {
      ...existing,
      currentRound: round,
      currentSequence: sequence,
      baseStateHash,
      updatedAt: now,
    };
  }

  public updateRecoveryStatus(sessionId: string, status: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET recovery_status = ?, updated_at = ?
      WHERE session_id = ?;
    `);
    stmt.run(status, now, sessionId);
  }

  public getActiveSessions(): SessionRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        session_id,
        task_id,
        provider_id,
        conversation_id,
        branch_or_message_id,
        lifecycle_state,
        protocol_version,
        current_round,
        current_sequence,
        base_state_hash,
        nonce_hash,
        created_at,
        updated_at,
        recovery_status
      FROM sessions
      WHERE recovery_status = 'active';
    `);

    const rows = stmt.all() as Array<{
      session_id: string;
      task_id: string;
      provider_id: string;
      conversation_id: string;
      branch_or_message_id: string | null;
      lifecycle_state: string;
      protocol_version: string;
      current_round: number;
      current_sequence: number;
      base_state_hash: string;
      nonce_hash: string;
      created_at: number;
      updated_at: number;
      recovery_status: string;
    }>;

    return rows.map((r) => ({
      sessionId: r.session_id,
      taskId: r.task_id,
      providerId: r.provider_id,
      conversationId: r.conversation_id,
      branchOrMessageId: r.branch_or_message_id ?? undefined,
      lifecycleState: r.lifecycle_state,
      protocolVersion: r.protocol_version,
      currentRound: r.current_round,
      currentSequence: r.current_sequence,
      baseStateHash: r.base_state_hash,
      nonceHash: r.nonce_hash,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      recoveryStatus: r.recovery_status,
    }));
  }
}
