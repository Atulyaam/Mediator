/**
 * @mediator/stage-store — Staged State Checkpoints & Restoration (S12)
 *
 * Requirements:
 * - Captures consistent snapshot of stage metadata and staged file contents.
 * - Restores only Mediator-managed staged content; original workspace is NEVER modified.
 * - Rejects corrupted, missing, mismatched or cross-task checkpoints.
 * - Verifies restored staged file hashes before marking rollback successful.
 */

import * as crypto from 'node:crypto';
import { type StagedFileRecord, type StageCheckpointRecord } from './stageTypes.js';
import { type StageStorage } from './stageStorage.js';
import { computeSha256 } from './stageSnapshot.js';
import { StageError, StageErrorCode } from './stageErrors.js';

export function createCheckpoint(
  stageId: string,
  taskId: string,
  files: readonly StagedFileRecord[],
  storage: StageStorage,
  description?: string | undefined,
): StageCheckpointRecord {
  const checkpointId = `chk_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  // 1. Copy files in storage
  storage.copyFilesToCheckpoint(taskId, stageId, checkpointId);

  // 2. Build checkpoint record
  const record: StageCheckpointRecord = {
    checkpointId,
    stageId,
    taskId,
    description,
    files: [...files],
    createdAt: Date.now(),
  };

  return record;
}

export function restoreCheckpoint(
  checkpoint: StageCheckpointRecord,
  stageId: string,
  taskId: string,
  storage: StageStorage,
): readonly StagedFileRecord[] {
  // 1. Validate task and stage binding
  if (checkpoint.stageId !== stageId) {
    throw new StageError(
      StageErrorCode.CHECKPOINT_MISMATCH,
      `Checkpoint '${checkpoint.checkpointId}' belongs to stage '${checkpoint.stageId}', not active stage '${stageId}'`,
      { stageId, taskId, details: { checkpointId: checkpoint.checkpointId } },
    );
  }

  if (checkpoint.taskId !== taskId) {
    throw new StageError(
      StageErrorCode.TASK_MISMATCH,
      `Checkpoint '${checkpoint.checkpointId}' belongs to task '${checkpoint.taskId}', not active task '${taskId}'`,
      { stageId, taskId, details: { checkpointId: checkpoint.checkpointId } },
    );
  }

  // 2. Restore storage files
  storage.restoreFilesFromCheckpoint(taskId, stageId, checkpoint.checkpointId);

  // 3. Verify restored files match checkpoint snapshot hashes
  for (const file of checkpoint.files) {
    // Files that are delete-proposed don't exist on disk in staging
    if (file.changeType === 'delete-proposed') {
      continue;
    }

    try {
      const restoredBuffer = storage.readStagedFile(taskId, stageId, file.relativePath);
      const computedHash = computeSha256(restoredBuffer);
      if (computedHash !== file.stagedContentHash) {
        throw new StageError(
          StageErrorCode.STAGE_CORRUPTED,
          `Hash verification failed after restoring '${file.relativePath}' from checkpoint (expected ${file.stagedContentHash.substring(0, 8)}..., got ${computedHash.substring(0, 8)}...)`,
          { stageId, taskId, path: file.relativePath },
        );
      }
    } catch (err) {
      if (err instanceof StageError) throw err;
      throw new StageError(
        StageErrorCode.STAGE_CORRUPTED,
        `Failed to verify restored file '${file.relativePath}': ${err instanceof Error ? err.message : String(err)}`,
        { stageId, taskId, path: file.relativePath },
      );
    }
  }

  return checkpoint.files;
}
