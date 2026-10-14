/**
 * @mediator/stage-store — Patch Conflict Detection Service (S13)
 *
 * Requirements:
 * - Detects live source modifications after task snapshot.
 * - Detects live source deletions after task start.
 * - Detects unexpected live files created where 'create' was proposed.
 * - Detects collisions for rename destination paths.
 * - Detects concurrent stage modifications via expectedStageHash.
 * - Invariant: Never auto-rebases or silently overwrites base hashes.
 */

import { type WorkspaceRootState } from '@mediator/workspace-boundary';
import { type StagedFileRecord } from './stageTypes.js';
import { type PatchProposal } from './patchTypes.js';
import { captureSourceSnapshot } from './stageSnapshot.js';

export interface PatchConflictCheckResult {
  readonly hasConflict: boolean;
  readonly conflictStatus: 'clean' | 'conflict' | 'stale';
  readonly reason?: string | undefined;
}

export class PatchConflictService {
  /**
   * Preflight conflict check before applying a patch proposal.
   */
  public checkProposalConflicts(
    workspace: WorkspaceRootState,
    proposal: PatchProposal,
    existingStagedRecord: StagedFileRecord | null,
    allStagedFiles: readonly StagedFileRecord[] = [],
  ): PatchConflictCheckResult {
    // 1. Live base snapshot inspection
    const snapshot = captureSourceSnapshot(workspace, proposal.relativePath);

    // 2. Base hash validation (if specified)
    if (proposal.expectedBaseHash !== undefined) {
      if (!snapshot.existsAtBase) {
        return {
          hasConflict: true,
          conflictStatus: 'conflict',
          reason: `live-deleted: source file '${proposal.relativePath}' was deleted from live workspace`,
        };
      }
      if (snapshot.contentHash !== proposal.expectedBaseHash) {
        return {
          hasConflict: true,
          conflictStatus: 'conflict',
          reason: `live-modified: source file '${proposal.relativePath}' hash (${snapshot.contentHash?.substring(0, 8)}...) differs from expected base hash (${proposal.expectedBaseHash.substring(0, 8)}...)`,
        };
      }
    }

    // 3. Staged hash validation (concurrency protection)
    if (proposal.expectedStageHash !== undefined) {
      if (!existingStagedRecord) {
        return {
          hasConflict: true,
          conflictStatus: 'stale',
          reason: `staged-record-missing: expected staged hash '${proposal.expectedStageHash.substring(0, 8)}...' but file is not yet staged`,
        };
      }
      if (existingStagedRecord.stagedContentHash !== proposal.expectedStageHash) {
        return {
          hasConflict: true,
          conflictStatus: 'stale',
          reason: `staged-content-changed: currently staged hash '${existingStagedRecord.stagedContentHash.substring(0, 8)}...' differs from expected staged hash '${proposal.expectedStageHash.substring(0, 8)}...'`,
        };
      }
    }

    // 4. Operation-specific checks
    switch (proposal.operation) {
      case 'create': {
        if (snapshot.existsAtBase) {
          return {
            hasConflict: true,
            conflictStatus: 'conflict',
            reason: `live-added: file '${proposal.relativePath}' already exists in live workspace, cannot propose create`,
          };
        }
        break;
      }

      case 'modify': {
        if (!snapshot.existsAtBase && !existingStagedRecord) {
          return {
            hasConflict: true,
            conflictStatus: 'conflict',
            reason: `live-deleted: source file '${proposal.relativePath}' does not exist to modify`,
          };
        }
        break;
      }

      case 'delete-proposed': {
        if (!snapshot.existsAtBase && !existingStagedRecord) {
          return {
            hasConflict: true,
            conflictStatus: 'conflict',
            reason: `live-deleted: source file '${proposal.relativePath}' does not exist to delete`,
          };
        }
        break;
      }

      case 'rename-proposed': {
        if (!snapshot.existsAtBase && !existingStagedRecord) {
          return {
            hasConflict: true,
            conflictStatus: 'conflict',
            reason: `live-deleted: source file '${proposal.relativePath}' does not exist to rename`,
          };
        }
        const targetPath = proposal.payload.targetPath;
        if (targetPath) {
          // Check if target already exists in live workspace
          const targetSnapshot = captureSourceSnapshot(workspace, targetPath);
          if (targetSnapshot.existsAtBase) {
            return {
              hasConflict: true,
              conflictStatus: 'conflict',
              reason: `rename-destination-exists: target destination '${targetPath}' already exists in live workspace`,
            };
          }
          // Check if target already exists in active stage
          const stagedCollision = allStagedFiles.find(
            (f) => f.relativePath === targetPath && f.changeType !== 'delete-proposed',
          );
          if (stagedCollision) {
            return {
              hasConflict: true,
              conflictStatus: 'conflict',
              reason: `rename-destination-collides-in-stage: target destination '${targetPath}' is already staged in this stage`,
            };
          }
        }
        break;
      }
    }

    return {
      hasConflict: false,
      conflictStatus: 'clean',
    };
  }
}
