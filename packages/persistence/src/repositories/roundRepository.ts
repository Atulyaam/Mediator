/**
 * @mediator/persistence — Round Repository (S10)
 */

import { type DatabaseConnection } from '../database.js';
import { PersistenceError, PersistenceErrorCode } from '../errors.js';

export interface RoundRecord {
  readonly roundId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly roundNumber: number;
  readonly sequenceStart: number;
  readonly sequenceEnd?: number | undefined;
  readonly state: string;
  readonly resultStatus?: string | undefined;
  readonly baseStateHash: string;
  readonly startedAt: number;
  readonly completedAt?: number | undefined;
}

export interface StartRoundParams {
  readonly roundId?: string | undefined;
  readonly sessionId: string;
  readonly taskId: string;
  readonly roundNumber: number;
  readonly sequenceStart: number;
  readonly state: string;
  readonly baseStateHash: string;
  readonly startedAt?: number | undefined;
}

export class RoundRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public startRound(params: StartRoundParams): RoundRecord {
    const roundId = params.roundId ?? `rnd_${params.sessionId}_${params.roundNumber}`;
    const startedAt = params.startedAt ?? Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO rounds (
        round_id,
        session_id,
        task_id,
        round_number,
        sequence_start,
        sequence_end,
        state,
        result_status,
        base_state_hash,
        started_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL);
    `);

    stmt.run(
      roundId,
      params.sessionId,
      params.taskId,
      params.roundNumber,
      params.sequenceStart,
      params.state,
      params.baseStateHash,
      startedAt,
    );

    return {
      roundId,
      sessionId: params.sessionId,
      taskId: params.taskId,
      roundNumber: params.roundNumber,
      sequenceStart: params.sequenceStart,
      state: params.state,
      baseStateHash: params.baseStateHash,
      startedAt,
    };
  }

  public completeRound(
    roundId: string,
    sequenceEnd: number,
    state: string,
    resultStatus: string,
  ): RoundRecord {
    const completedAt = Date.now();
    const existing = this.getRound(roundId);
    if (!existing) {
      throw new PersistenceError(PersistenceErrorCode.RECORD_NOT_FOUND, `Round '${roundId}' not found`);
    }

    const stmt = this.db.prepare(`
      UPDATE rounds
      SET sequence_end = ?, state = ?, result_status = ?, completed_at = ?
      WHERE round_id = ?;
    `);

    stmt.run(sequenceEnd, state, resultStatus, completedAt, roundId);

    return {
      ...existing,
      sequenceEnd,
      state,
      resultStatus,
      completedAt,
    };
  }

  public getRound(roundId: string): RoundRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        round_id,
        session_id,
        task_id,
        round_number,
        sequence_start,
        sequence_end,
        state,
        result_status,
        base_state_hash,
        started_at,
        completed_at
      FROM rounds
      WHERE round_id = ?;
    `);

    const row = stmt.get(roundId) as
      | {
          round_id: string;
          session_id: string;
          task_id: string;
          round_number: number;
          sequence_start: number;
          sequence_end: number | null;
          state: string;
          result_status: string | null;
          base_state_hash: string;
          started_at: number;
          completed_at: number | null;
        }
      | undefined;

    if (!row) return null;

    return {
      roundId: row.round_id,
      sessionId: row.session_id,
      taskId: row.task_id,
      roundNumber: row.round_number,
      sequenceStart: row.sequence_start,
      sequenceEnd: row.sequence_end ?? undefined,
      state: row.state,
      resultStatus: row.result_status ?? undefined,
      baseStateHash: row.base_state_hash,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
    };
  }

  public getRoundsForSession(sessionId: string): RoundRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        round_id,
        session_id,
        task_id,
        round_number,
        sequence_start,
        sequence_end,
        state,
        result_status,
        base_state_hash,
        started_at,
        completed_at
      FROM rounds
      WHERE session_id = ?
      ORDER BY round_number ASC;
    `);

    const rows = stmt.all(sessionId) as Array<{
      round_id: string;
      session_id: string;
      task_id: string;
      round_number: number;
      sequence_start: number;
      sequence_end: number | null;
      state: string;
      result_status: string | null;
      base_state_hash: string;
      started_at: number;
      completed_at: number | null;
    }>;

    return rows.map((r) => ({
      roundId: r.round_id,
      sessionId: r.session_id,
      taskId: r.task_id,
      roundNumber: r.round_number,
      sequenceStart: r.sequence_start,
      sequenceEnd: r.sequence_end ?? undefined,
      state: r.state,
      resultStatus: r.result_status ?? undefined,
      baseStateHash: r.base_state_hash,
      startedAt: r.started_at,
      completedAt: r.completed_at ?? undefined,
    }));
  }
}
