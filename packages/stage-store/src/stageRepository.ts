/**
 * @mediator/stage-store — Staging Metadata Persistence (S12)
 *
 * Requirements:
 * - Persists and retrieves stages, staged files, and checkpoints in SQLite.
 * - Enforces atomic transaction semantics for multi-entity updates.
 * - Converts between SQLite database rows and strongly-typed staging domain objects.
 * - Handles corrupt or missing rows gracefully with typed errors.
 */

import { type DatabaseConnection } from '@mediator/persistence';
import { type PolicyDecisionType } from '@mediator/policy-engine';
import {
  type StageRecord,
  type StagedFileRecord,
  type StageCheckpointRecord,
  type StageStatus,
  type StageChangeType,
  type StageConflictStatus,
} from './stageTypes.js';
import { StageError, StageErrorCode } from './stageErrors.js';

interface StageRow {
  stage_id: string;
  task_id: string;
  workspace_identity: string;
  canonical_workspace_path: string;
  status: string;
  checkpoint_id: string | null;
  stage_version: number;
  parent_checkpoint_id: string | null;
  created_at: number;
  updated_at: number;
  metadata: string | null;
}

interface StagedFileRow {
  stage_id: string;
  relative_path: string;
  source_exists_at_base: number;
  base_content_hash: string | null;
  base_mtime_ms: number | null;
  base_size_bytes: number | null;
  staged_content_hash: string;
  byte_length: number;
  encoding: string;
  change_type: string;
  is_protected: number;
  policy_decision: string;
  requires_manual_review: number;
  target_path: string | null;
  conflict_status: string;
  conflict_reason: string | null;
  staged_storage_path: string;
  created_at: number;
  updated_at: number;
}

interface StageCheckpointRow {
  checkpoint_id: string;
  stage_id: string;
  task_id: string;
  description: string | null;
  snapshot_json: string;
  created_at: number;
}

export class StageRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public createStage(stage: StageRecord): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO stages (
          stage_id, task_id, workspace_identity, canonical_workspace_path,
          status, checkpoint_id, stage_version, parent_checkpoint_id,
          created_at, updated_at, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);

      stmt.run(
        stage.stageId,
        stage.taskId,
        stage.workspaceIdentity,
        stage.canonicalWorkspacePath,
        stage.status,
        stage.checkpointId,
        stage.stageVersion,
        stage.parentCheckpointId,
        stage.createdAt,
        stage.updatedAt,
        stage.metadata ? JSON.stringify(stage.metadata) : null,
      );
    } catch (err) {
      throw new StageError(
        StageErrorCode.PERSISTENCE_FAILED,
        `Failed to create stage in database: ${err instanceof Error ? err.message : String(err)}`,
        { stageId: stage.stageId, taskId: stage.taskId },
      );
    }
  }

  public getStage(stageId: string): StageRecord | null {
    try {
      const stmt = this.db.prepare('SELECT * FROM stages WHERE stage_id = ?;');
      const row = stmt.get(stageId) as unknown as StageRow | undefined;
      if (!row) return null;
      return this.mapStageRow(row);
    } catch (err) {
      if (err instanceof StageError) throw err;
      throw new StageError(
        StageErrorCode.PERSISTENCE_FAILED,
        `Failed to query stage '${stageId}': ${err instanceof Error ? err.message : String(err)}`,
        { stageId },
      );
    }
  }

  public getStagesForTask(taskId: string): StageRecord[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM stages WHERE task_id = ? ORDER BY created_at DESC;');
      const rows = stmt.all(taskId) as unknown as StageRow[];
      return rows.map((r) => this.mapStageRow(r));
    } catch (err) {
      throw new StageError(
        StageErrorCode.PERSISTENCE_FAILED,
        `Failed to query stages for task '${taskId}': ${err instanceof Error ? err.message : String(err)}`,
        { taskId },
      );
    }
  }

  public updateStageStatus(
    stageId: string,
    status: StageStatus,
    checkpointId?: string | null,
  ): void {
    try {
      if (checkpointId !== undefined) {
        const stmt = this.db.prepare(`
          UPDATE stages
          SET status = ?, checkpoint_id = ?, updated_at = ?
          WHERE stage_id = ?;
        `);
        stmt.run(status, checkpointId, Date.now(), stageId);
      } else {
        const stmt = this.db.prepare(`
          UPDATE stages
          SET status = ?, updated_at = ?
          WHERE stage_id = ?;
        `);
        stmt.run(status, Date.now(), stageId);
      }
    } catch (err) {
      throw new StageError(
        StageErrorCode.PERSISTENCE_FAILED,
        `Failed to update stage '${stageId}' status: ${err instanceof Error ? err.message : String(err)}`,
        { stageId },
      );
    }
  }

  public saveStagedFile(record: StagedFileRecord): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO staged_files (
          stage_id, relative_path, source_exists_at_base, base_content_hash,
          base_mtime_ms, base_size_bytes, staged_content_hash, byte_length,
          encoding, change_type, is_protected, policy_decision,
          requires_manual_review, target_path, conflict_status, conflict_reason,
          staged_storage_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stage_id, relative_path) DO UPDATE SET
          source_exists_at_base = excluded.source_exists_at_base,
          base_content_hash = excluded.base_content_hash,
          base_mtime_ms = excluded.base_mtime_ms,
          base_size_bytes = excluded.base_size_bytes,
          staged_content_hash = excluded.staged_content_hash,
          byte_length = excluded.byte_length,
          encoding = excluded.encoding,
          change_type = excluded.change_type,
          is_protected = excluded.is_protected,
          policy_decision = excluded.policy_decision,
          requires_manual_review = excluded.requires_manual_review,
          target_path = excluded.target_path,
          conflict_status = excluded.conflict_status,
          conflict_reason = excluded.conflict_reason,
          staged_storage_path = excluded.staged_storage_path,
          updated_at = excluded.updated_at;
      `);

      stmt.run(
        record.stageId,
        record.relativePath,
        record.sourceExistsAtBase ? 1 : 0,
        record.baseContentHash,
        record.baseMtimeMs,
        record.baseSizeBytes,
        record.stagedContentHash,
        record.byteLength,
        record.encoding,
        record.changeType,
        record.isProtected ? 1 : 0,
        record.policyDecision,
        record.requiresManualReview ? 1 : 0,
        record.targetPath ?? null,
        record.conflictStatus,
        record.conflictReason ?? null,
        record.stagedStoragePath,
        record.createdAt,
        record.updatedAt,
      );
    } catch (err) {
      throw new StageError(
        StageErrorCode.PERSISTENCE_FAILED,
        `Failed to save staged file '${record.relativePath}': ${err instanceof Error ? err.message : String(err)}`,
        { stageId: record.stageId, path: record.relativePath },
      );
    }
  }

  public getStagedFile(stageId: string, relativePath: string): StagedFileRecord | null {
    try {
      const stmt = this.db.prepare('SELECT * FROM staged_files WHERE stage_id = ? AND relative_path = ?;');
      const row = stmt.get(stageId, relativePath) as unknown as StagedFileRow | undefined;
      if (!row) return null;
      return this.mapStagedFileRow(row);
    } catch (err) {
      throw new StageError(
        StageErrorCode.PERSISTENCE_FAILED,
        `Failed to query staged file '${relativePath}': ${err instanceof Error ? err.message : String(err)}`,
        { stageId, path: relativePath },
      );
    }
  }

  public listStagedFiles(stageId: string): StagedFileRecord[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM staged_files WHERE stage_id = ? ORDER BY relative_path ASC;');
      const rows = stmt.all(stageId) as unknown as StagedFileRow[];
      return rows.map((r) => this.mapStagedFileRow(r));
    } catch (err) {
      throw new StageError(
        StageErrorCode.PERSISTENCE_FAILED,
        `Failed to list staged files for stage '${stageId}': ${err instanceof Error ? err.message : String(err)}`,
        { stageId },
      );
    }
  }

  public removeStagedFile(stageId: string, relativePath: string): boolean {
    try {
      const stmt = this.db.prepare('DELETE FROM staged_files WHERE stage_id = ? AND relative_path = ?;');
      const res = stmt.run(stageId, relativePath);
      return Number(res.changes ?? 0) > 0;
    } catch (err) {
      throw new StageError(
        StageErrorCode.PERSISTENCE_FAILED,
        `Failed to remove staged file '${relativePath}': ${err instanceof Error ? err.message : String(err)}`,
        { stageId, path: relativePath },
      );
    }
  }

  public replaceStagedFiles(stageId: string, files: readonly StagedFileRecord[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM staged_files WHERE stage_id = ?;').run(stageId);
      for (const f of files) {
        this.saveStagedFile(f);
      }
    });
  }

  public saveCheckpoint(checkpoint: StageCheckpointRecord): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO stage_checkpoints (
          checkpoint_id, stage_id, task_id, description, snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?);
      `);

      stmt.run(
        checkpoint.checkpointId,
        checkpoint.stageId,
        checkpoint.taskId,
        checkpoint.description ?? null,
        JSON.stringify(checkpoint.files),
        checkpoint.createdAt,
      );
    } catch (err) {
      throw new StageError(
        StageErrorCode.PERSISTENCE_FAILED,
        `Failed to save checkpoint '${checkpoint.checkpointId}': ${err instanceof Error ? err.message : String(err)}`,
        { stageId: checkpoint.stageId, taskId: checkpoint.taskId },
      );
    }
  }

  public getCheckpoint(checkpointId: string): StageCheckpointRecord | null {
    try {
      const stmt = this.db.prepare('SELECT * FROM stage_checkpoints WHERE checkpoint_id = ?;');
      const row = stmt.get(checkpointId) as unknown as StageCheckpointRow | undefined;
      if (!row) return null;

      const parsedFiles = JSON.parse(row.snapshot_json) as StagedFileRecord[];
      return {
        checkpointId: row.checkpoint_id,
        stageId: row.stage_id,
        taskId: row.task_id,
        description: row.description ?? undefined,
        files: parsedFiles,
        createdAt: row.created_at,
      };
    } catch (err) {
      throw new StageError(
        StageErrorCode.PERSISTENCE_FAILED,
        `Failed to load checkpoint '${checkpointId}': ${err instanceof Error ? err.message : String(err)}`,
        { details: { checkpointId } },
      );
    }
  }

  public listCheckpoints(stageId: string): StageCheckpointRecord[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM stage_checkpoints WHERE stage_id = ? ORDER BY created_at DESC;');
      const rows = stmt.all(stageId) as unknown as StageCheckpointRow[];
      return rows.map((row) => ({
        checkpointId: row.checkpoint_id,
        stageId: row.stage_id,
        taskId: row.task_id,
        description: row.description ?? undefined,
        files: JSON.parse(row.snapshot_json) as StagedFileRecord[],
        createdAt: row.created_at,
      }));
    } catch (err) {
      throw new StageError(
        StageErrorCode.PERSISTENCE_FAILED,
        `Failed to list checkpoints for stage '${stageId}': ${err instanceof Error ? err.message : String(err)}`,
        { stageId },
      );
    }
  }

  public deleteStage(stageId: string): void {
    try {
      this.db.prepare('DELETE FROM stages WHERE stage_id = ?;').run(stageId);
    } catch (err) {
      throw new StageError(
        StageErrorCode.PERSISTENCE_FAILED,
        `Failed to delete stage '${stageId}': ${err instanceof Error ? err.message : String(err)}`,
        { stageId },
      );
    }
  }

  private mapStageRow(row: StageRow): StageRecord {
    let metadata: Record<string, unknown> | undefined;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        // Ignore corrupt metadata
      }
    }

    return {
      stageId: row.stage_id,
      taskId: row.task_id,
      workspaceIdentity: row.workspace_identity,
      canonicalWorkspacePath: row.canonical_workspace_path,
      status: row.status as StageStatus,
      checkpointId: row.checkpoint_id,
      stageVersion: row.stage_version,
      parentCheckpointId: row.parent_checkpoint_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata,
    };
  }

  private mapStagedFileRow(row: StagedFileRow): StagedFileRecord {
    return {
      stageId: row.stage_id,
      relativePath: row.relative_path,
      sourceExistsAtBase: row.source_exists_at_base === 1,
      baseContentHash: row.base_content_hash,
      baseMtimeMs: row.base_mtime_ms,
      baseSizeBytes: row.base_size_bytes,
      stagedContentHash: row.staged_content_hash,
      byteLength: row.byte_length,
      encoding: row.encoding as 'utf8' | 'binary',
      changeType: row.change_type as StageChangeType,
      isProtected: row.is_protected === 1,
      policyDecision: row.policy_decision as PolicyDecisionType,
      requiresManualReview: row.requires_manual_review === 1,
      targetPath: row.target_path ?? undefined,
      conflictStatus: row.conflict_status as StageConflictStatus,
      conflictReason: row.conflict_reason ?? undefined,
      stagedStoragePath: row.staged_storage_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
