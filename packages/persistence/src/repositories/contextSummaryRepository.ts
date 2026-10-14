/**
 * @mediator/persistence — Context Summary Repository (S10)
 *
 * Privacy & Safety:
 * - Bounded, redacted task summaries and references.
 * - Never stores complete browser conversation bodies, raw .env contents or raw terminal dumps.
 */

import { safeRedactString } from '../auditEvent.js';
import { type DatabaseConnection } from '../database.js';

export const MAX_CONTEXT_SUMMARY_BYTES = 64 * 1024; // 64 KB cap per summary

export interface ContextSummaryRecord {
  readonly summaryId: string;
  readonly taskId: string;
  readonly topic: string;
  readonly summaryText: string;
  readonly byteLength: number;
  readonly createdAt: number;
}

export interface RecordSummaryParams {
  readonly summaryId: string;
  readonly taskId: string;
  readonly topic: string;
  readonly summaryText: string;
  readonly createdAt?: number | undefined;
}

export class ContextSummaryRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public recordSummary(params: RecordSummaryParams): ContextSummaryRecord {
    const now = params.createdAt ?? Date.now();
    // 1. Redact secrets
    let safeText = safeRedactString(params.summaryText);

    // 2. Bound size
    let buf = Buffer.from(safeText, 'utf8');
    if (buf.byteLength > MAX_CONTEXT_SUMMARY_BYTES) {
      safeText = buf.subarray(0, MAX_CONTEXT_SUMMARY_BYTES).toString('utf8');
      buf = Buffer.from(safeText, 'utf8');
    }

    const byteLength = buf.byteLength;

    const stmt = this.db.prepare(`
      INSERT INTO context_summaries (
        summary_id,
        task_id,
        topic,
        summary_text,
        byte_length,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?);
    `);

    stmt.run(params.summaryId, params.taskId, params.topic, safeText, byteLength, now);

    return {
      summaryId: params.summaryId,
      taskId: params.taskId,
      topic: params.topic,
      summaryText: safeText,
      byteLength,
      createdAt: now,
    };
  }

  public getSummariesForTask(taskId: string): ContextSummaryRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        summary_id,
        task_id,
        topic,
        summary_text,
        byte_length,
        created_at
      FROM context_summaries
      WHERE task_id = ?
      ORDER BY created_at ASC;
    `);

    const rows = stmt.all(taskId) as Array<{
      summary_id: string;
      task_id: string;
      topic: string;
      summary_text: string;
      byte_length: number;
      created_at: number;
    }>;

    return rows.map((r) => ({
      summaryId: r.summary_id,
      taskId: r.task_id,
      topic: r.topic,
      summaryText: r.summary_text,
      byteLength: r.byte_length,
      createdAt: r.created_at,
    }));
  }

  public getLatestSummaryForTask(taskId: string, topic?: string): ContextSummaryRecord | undefined {
    let sql = `
      SELECT
        summary_id,
        task_id,
        topic,
        summary_text,
        byte_length,
        created_at
      FROM context_summaries
      WHERE task_id = ?
    `;
    const params: string[] = [taskId];
    if (topic !== undefined) {
      sql += ' AND topic = ?';
      params.push(topic);
    }
    sql += ' ORDER BY created_at DESC LIMIT 1;';
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as {
      summary_id: string;
      task_id: string;
      topic: string;
      summary_text: string;
      byte_length: number;
      created_at: number;
    } | undefined;

    if (!row) return undefined;
    return {
      summaryId: row.summary_id,
      taskId: row.task_id,
      topic: row.topic,
      summaryText: row.summary_text,
      byteLength: row.byte_length,
      createdAt: row.created_at,
    };
  }

  public deleteSummariesForTask(taskId: string, topic?: string): number {
    let sql = 'DELETE FROM context_summaries WHERE task_id = ?';
    const params: string[] = [taskId];
    if (topic !== undefined) {
      sql += ' AND topic = ?';
      params.push(topic);
    }
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return Number(result.changes);
  }
}

