/**
 * @mediator/persistence — Audit Event Repository & Hash Chain Verifier (S10)
 *
 * Requirements:
 * - Append-only tamper-evident audit event store.
 * - Atomic event insertion with strict chain index and previous-hash verification.
 * - Full chain verification routine detecting missing, reordered, modified, or deleted events.
 * - Safe redaction of details using context-security redactor.
 */

import { randomUUID } from 'node:crypto';
import { type DatabaseConnection } from './database.js';
import {
  AUDIT_GENESIS_HASH,
  computeAuditEventHash,
  sanitizeAuditDetails,
  type CanonicalAuditPayload,
} from './auditEvent.js';

export interface AuditEventRecord {
  readonly eventId: string;
  readonly chainIndex: number;
  readonly timestamp: number;
  readonly taskId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly eventType: string;
  readonly actor: string;
  readonly outcome: string;
  readonly details: Record<string, unknown>;
  readonly previousEventHash: string;
  readonly eventHash: string;
}

export interface CreateAuditEventParams {
  readonly eventId?: string | undefined;
  readonly timestamp?: number | undefined;
  readonly taskId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly eventType: string;
  readonly actor?: string | undefined;
  readonly outcome?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;
}

export interface AuditVerificationResult {
  readonly valid: boolean;
  readonly verifiedCount: number;
  readonly tipHash: string | null;
  readonly failedAtChainIndex?: number | undefined;
  readonly failedAtEventId?: string | undefined;
  readonly reason?: string | undefined;
  readonly expectedHash?: string | undefined;
  readonly actualHash?: string | undefined;
}

export class AuditRepository {
  constructor(private readonly db: DatabaseConnection) {}

  /**
   * Append a new audit event to the tamper-evident hash chain.
   * Atomically assigns the next chain index, verifies previous hash, and inserts the row.
   */
  public appendEvent(params: CreateAuditEventParams): AuditEventRecord {
    return this.db.transaction(() => {
      // 1. Get current tip
      const tipStmt = this.db.prepare(`
        SELECT event_id, chain_index, event_hash
        FROM audit_events
        ORDER BY chain_index DESC
        LIMIT 1;
      `);
      const tipRow = tipStmt.get() as
        | { event_id: string; chain_index: number; event_hash: string }
        | undefined;

      const chainIndex = tipRow ? tipRow.chain_index + 1 : 0;
      const previousEventHash = tipRow ? tipRow.event_hash : AUDIT_GENESIS_HASH;

      const eventId = params.eventId ?? `evt_${randomUUID()}`;
      const timestamp = params.timestamp ?? Date.now();
      const actor = params.actor ?? 'mediator';
      const outcome = params.outcome ?? 'allowed';

      // 2. Sanitize details via context security
      const rawDetails = params.details ?? {};
      const sanitizedDetails = sanitizeAuditDetails(rawDetails);

      // 3. Compute canonical SHA-256 event hash
      const payload: CanonicalAuditPayload = {
        chainIndex,
        eventId,
        timestamp,
        taskId: params.taskId,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        eventType: params.eventType,
        actor,
        outcome,
        details: sanitizedDetails,
        previousEventHash,
      };

      const eventHash = computeAuditEventHash(payload);
      const detailsJson = JSON.stringify(sanitizedDetails);

      // 4. Insert row
      const insertStmt = this.db.prepare(`
        INSERT INTO audit_events (
          event_id,
          chain_index,
          timestamp,
          task_id,
          session_id,
          correlation_id,
          event_type,
          actor,
          outcome,
          details_json,
          previous_event_hash,
          event_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);

      insertStmt.run(
        eventId,
        chainIndex,
        timestamp,
        params.taskId,
        params.sessionId,
        params.correlationId,
        params.eventType,
        actor,
        outcome,
        detailsJson,
        previousEventHash,
        eventHash,
      );

      return {
        eventId,
        chainIndex,
        timestamp,
        taskId: params.taskId,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        eventType: params.eventType,
        actor,
        outcome,
        details: sanitizedDetails,
        previousEventHash,
        eventHash,
      };
    });
  }

  /**
   * Verifies the integrity of the audit hash chain from genesis to tip.
   * Reports the first invalid event ID and reason without leaking secrets.
   */
  public verifyChain(options: { fromIndex?: number } = {}): AuditVerificationResult {
    const fromIndex = options.fromIndex ?? 0;
    const stmt = this.db.prepare(`
      SELECT
        event_id,
        chain_index,
        timestamp,
        task_id,
        session_id,
        correlation_id,
        event_type,
        actor,
        outcome,
        details_json,
        previous_event_hash,
        event_hash
      FROM audit_events
      ORDER BY chain_index ASC;
    `);

    const rows = stmt.all() as Array<{
      event_id: string;
      chain_index: number;
      timestamp: number;
      task_id: string;
      session_id: string;
      correlation_id: string;
      event_type: string;
      actor: string;
      outcome: string;
      details_json: string;
      previous_event_hash: string;
      event_hash: string;
    }>;

    if (rows.length === 0) {
      return {
        valid: true,
        verifiedCount: 0,
        tipHash: null,
      };
    }

    let expectedIndex = fromIndex;
    let expectedPreviousHash = AUDIT_GENESIS_HASH;

    if (fromIndex > 0) {
      const prevRow = rows.find((r) => r.chain_index === fromIndex - 1);
      if (!prevRow) {
        return {
          valid: false,
          verifiedCount: 0,
          tipHash: null,
          failedAtChainIndex: fromIndex,
          reason: `Cannot verify from index ${fromIndex}: preceding event not found`,
        };
      }
      expectedPreviousHash = prevRow.event_hash;
    }

    let verifiedCount = 0;
    let lastHash: string | null = null;

    for (const row of rows) {
      if (row.chain_index < fromIndex) {
        continue;
      }

      // 1. Check sequence monotonicity
      if (row.chain_index !== expectedIndex) {
        return {
          valid: false,
          verifiedCount,
          tipHash: lastHash,
          failedAtChainIndex: row.chain_index,
          failedAtEventId: row.event_id,
          reason: `Broken chain index: expected ${expectedIndex}, got ${row.chain_index}`,
        };
      }

      // 2. Check previous hash link
      if (row.previous_event_hash !== expectedPreviousHash) {
        return {
          valid: false,
          verifiedCount,
          tipHash: lastHash,
          failedAtChainIndex: row.chain_index,
          failedAtEventId: row.event_id,
          reason: `Previous hash mismatch at event ${row.event_id}`,
          expectedHash: expectedPreviousHash,
          actualHash: row.previous_event_hash,
        };
      }

      // 3. Recompute canonical hash
      let parsedDetails: Record<string, unknown>;
      try {
        parsedDetails = JSON.parse(row.details_json) as Record<string, unknown>;
      } catch {
        return {
          valid: false,
          verifiedCount,
          tipHash: lastHash,
          failedAtChainIndex: row.chain_index,
          failedAtEventId: row.event_id,
          reason: `Invalid details_json serialization at event ${row.event_id}`,
        };
      }

      const payload: CanonicalAuditPayload = {
        chainIndex: row.chain_index,
        eventId: row.event_id,
        timestamp: row.timestamp,
        taskId: row.task_id,
        sessionId: row.session_id,
        correlationId: row.correlation_id,
        eventType: row.event_type,
        actor: row.actor,
        outcome: row.outcome,
        details: parsedDetails,
        previousEventHash: row.previous_event_hash,
      };

      const recomputedHash = computeAuditEventHash(payload);
      if (recomputedHash !== row.event_hash) {
        return {
          valid: false,
          verifiedCount,
          tipHash: lastHash,
          failedAtChainIndex: row.chain_index,
          failedAtEventId: row.event_id,
          reason: `Tampered event payload hash at event ${row.event_id}`,
          expectedHash: recomputedHash,
          actualHash: row.event_hash,
        };
      }

      expectedPreviousHash = row.event_hash;
      lastHash = row.event_hash;
      expectedIndex++;
      verifiedCount++;
    }

    return {
      valid: true,
      verifiedCount,
      tipHash: lastHash,
    };
  }

  public getEventsByTaskId(taskId: string): AuditEventRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        event_id,
        chain_index,
        timestamp,
        task_id,
        session_id,
        correlation_id,
        event_type,
        actor,
        outcome,
        details_json,
        previous_event_hash,
        event_hash
      FROM audit_events
      WHERE task_id = ?
      ORDER BY chain_index ASC;
    `);

    const rows = stmt.all(taskId) as Array<{
      event_id: string;
      chain_index: number;
      timestamp: number;
      task_id: string;
      session_id: string;
      correlation_id: string;
      event_type: string;
      actor: string;
      outcome: string;
      details_json: string;
      previous_event_hash: string;
      event_hash: string;
    }>;

    return rows.map((r) => ({
      eventId: r.event_id,
      chainIndex: r.chain_index,
      timestamp: r.timestamp,
      taskId: r.task_id,
      sessionId: r.session_id,
      correlationId: r.correlation_id,
      eventType: r.event_type,
      actor: r.actor,
      outcome: r.outcome,
      details: JSON.parse(r.details_json) as Record<string, unknown>,
      previousEventHash: r.previous_event_hash,
      eventHash: r.event_hash,
    }));
  }

  public getTip(): AuditEventRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        event_id,
        chain_index,
        timestamp,
        task_id,
        session_id,
        correlation_id,
        event_type,
        actor,
        outcome,
        details_json,
        previous_event_hash,
        event_hash
      FROM audit_events
      ORDER BY chain_index DESC
      LIMIT 1;
    `);

    const row = stmt.get() as
      | {
          event_id: string;
          chain_index: number;
          timestamp: number;
          task_id: string;
          session_id: string;
          correlation_id: string;
          event_type: string;
          actor: string;
          outcome: string;
          details_json: string;
          previous_event_hash: string;
          event_hash: string;
        }
      | undefined;

    if (!row) return null;

    return {
      eventId: row.event_id,
      chainIndex: row.chain_index,
      timestamp: row.timestamp,
      taskId: row.task_id,
      sessionId: row.session_id,
      correlationId: row.correlation_id,
      eventType: row.event_type,
      actor: row.actor,
      outcome: row.outcome,
      details: JSON.parse(row.details_json) as Record<string, unknown>,
      previousEventHash: row.previous_event_hash,
      eventHash: row.event_hash,
    };
  }
}
