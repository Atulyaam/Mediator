/**
 * @mediator/stage-store — Apply Transaction Journal Repository (S14)
 *
 * Persists apply transactions, per-file mutation records, and rollback
 * checkpoints to SQLite for durable recovery and audit trails.
 */

import { type DatabaseConnection } from '@mediator/persistence';
import { type StageChangeType } from './stageTypes.js';
import {
  type ApplyTransactionRecord,
  type ApplyItemRecord,
  type ApplyTransactionStatus,
  type ApplyItemStatus,
} from './applyTypes.js';

interface RawTransactionRow {
  readonly transaction_id: string;
  readonly task_id: string;
  readonly stage_id: string;
  readonly approval_id: string;
  readonly payload_hash: string;
  readonly status: string;
  readonly backup_dir: string;
  readonly created_at: number;
  readonly completed_at: number | null;
  readonly error_message: string | null;
}

export class ApplyJournal {
  constructor(private readonly db: DatabaseConnection) {}

  public createTransaction(record: ApplyTransactionRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO apply_transactions (
        transaction_id,
        task_id,
        stage_id,
        approval_id,
        payload_hash,
        status,
        backup_dir,
        created_at,
        completed_at,
        error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    stmt.run(
      record.transactionId,
      record.taskId,
      record.stageId,
      record.approvalId,
      record.payloadHash,
      record.status,
      record.backupDir,
      record.createdAt,
      record.completedAt ?? null,
      record.errorMessage ?? null,
    );
  }

  public updateTransactionStatus(
    transactionId: string,
    status: ApplyTransactionStatus,
    errorMessage?: string,
  ): void {
    const stmt = this.db.prepare(`
      UPDATE apply_transactions
      SET status = ?, completed_at = ?, error_message = ?
      WHERE transaction_id = ?;
    `);
    stmt.run(status, Date.now(), errorMessage ?? null, transactionId);
  }

  public createItem(item: ApplyItemRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO apply_transaction_items (
        item_id,
        transaction_id,
        relative_path,
        operation,
        base_hash,
        post_apply_hash,
        status,
        backup_path,
        target_path,
        applied_at,
        error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    stmt.run(
      item.itemId,
      item.transactionId,
      item.relativePath,
      item.operation,
      item.baseHash ?? null,
      item.postApplyHash ?? null,
      item.status,
      item.backupPath ?? null,
      item.targetPath ?? null,
      item.appliedAt ?? null,
      item.errorMessage ?? null,
    );
  }

  public updateItemStatus(
    itemId: string,
    status: ApplyItemStatus,
    postApplyHash?: string,
    errorMessage?: string,
  ): void {
    const stmt = this.db.prepare(`
      UPDATE apply_transaction_items
      SET status = ?, post_apply_hash = COALESCE(?, post_apply_hash), applied_at = ?, error_message = ?
      WHERE item_id = ?;
    `);
    stmt.run(status, postApplyHash ?? null, Date.now(), errorMessage ?? null, itemId);
  }

  public getTransaction(transactionId: string): ApplyTransactionRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        transaction_id,
        task_id,
        stage_id,
        approval_id,
        payload_hash,
        status,
        backup_dir,
        created_at,
        completed_at,
        error_message
      FROM apply_transactions
      WHERE transaction_id = ?;
    `);

    const row = stmt.get(transactionId) as {
      transaction_id: string;
      task_id: string;
      stage_id: string;
      approval_id: string;
      payload_hash: string;
      status: string;
      backup_dir: string;
      created_at: number;
      completed_at?: number | null;
      error_message?: string | null;
    } | undefined;

    if (!row) return null;

    return {
      transactionId: row.transaction_id,
      taskId: row.task_id,
      stageId: row.stage_id,
      approvalId: row.approval_id,
      payloadHash: row.payload_hash,
      status: row.status as ApplyTransactionStatus,
      backupDir: row.backup_dir,
      createdAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
      errorMessage: row.error_message ?? undefined,
    };
  }

  public listTransactionItems(transactionId: string): ApplyItemRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        item_id,
        transaction_id,
        relative_path,
        operation,
        base_hash,
        post_apply_hash,
        status,
        backup_path,
        target_path,
        applied_at,
        error_message
      FROM apply_transaction_items
      WHERE transaction_id = ?;
    `);

    const rows = stmt.all(transactionId) as Array<{
      item_id: string;
      transaction_id: string;
      relative_path: string;
      operation: string;
      base_hash?: string | null;
      post_apply_hash?: string | null;
      status: string;
      backup_path?: string | null;
      target_path?: string | null;
      applied_at?: number | null;
      error_message?: string | null;
    }>;

    return rows.map((r) => ({
      itemId: r.item_id,
      transactionId: r.transaction_id,
      relativePath: r.relative_path,
      operation: r.operation as StageChangeType,
      baseHash: r.base_hash ?? null,
      postApplyHash: r.post_apply_hash ?? undefined,
      status: r.status as ApplyItemStatus,
      backupPath: r.backup_path ?? undefined,
      targetPath: r.target_path ?? undefined,
      appliedAt: r.applied_at ?? undefined,
      errorMessage: r.error_message ?? undefined,
    }));
  }

  public findIncompleteTransactions(taskId?: string): ApplyTransactionRecord[] {
    const sql = taskId
      ? `SELECT * FROM apply_transactions WHERE task_id = ? AND status IN ('preflight', 'applying');`
      : `SELECT * FROM apply_transactions WHERE status IN ('preflight', 'applying');`;

    const stmt = this.db.prepare(sql);
    const rows = (taskId ? stmt.all(taskId) : stmt.all()) as unknown as RawTransactionRow[];

    return rows.map((r) => ({
      transactionId: r.transaction_id,
      taskId: r.task_id,
      stageId: r.stage_id,
      approvalId: r.approval_id,
      payloadHash: r.payload_hash,
      status: r.status as ApplyTransactionStatus,
      backupDir: r.backup_dir,
      createdAt: r.created_at,
      completedAt: r.completed_at ?? undefined,
      errorMessage: r.error_message ?? undefined,
    }));
  }
}
