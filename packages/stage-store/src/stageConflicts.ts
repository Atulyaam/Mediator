/**
 * @mediator/stage-store — Live-Source Conflict Detection (S12)
 *
 * Requirements:
 * - Detects modifications, deletions, or new file creations in the live workspace.
 * - Compares fresh source hashes against captured base hashes.
 * - Marks staged files as 'conflict' or 'stale' when live changes occur.
 * - Invariant: Never auto-rebases, never silently updates base hashes, never discards conflicts.
 * - Safely marks uninspectable files as conflict instead of assuming clean status.
 */

import * as fs from 'node:fs';
import {
  type WorkspaceRootState,
  validateContainedPath,
  checkWorkspacePermittedForFileOps,
} from '@mediator/workspace-boundary';
import { type StagedFileRecord, type StageConflictStatus } from './stageTypes.js';
import { computeSha256 } from './stageSnapshot.js';

export interface ConflictCheckResult {
  readonly relativePath: string;
  readonly conflictStatus: StageConflictStatus;
  readonly conflictReason?: string | undefined;
  readonly currentLiveHash?: string | null | undefined;
  readonly baseContentHash: string | null;
}

export function detectLiveConflict(
  workspace: WorkspaceRootState,
  stagedFile: StagedFileRecord,
): ConflictCheckResult {
  const { relativePath, sourceExistsAtBase, baseContentHash } = stagedFile;

  // 1. Verify workspace is confirmed
  const perm = checkWorkspacePermittedForFileOps(workspace);
  if (!perm.ok) {
    return {
      relativePath,
      conflictStatus: 'conflict',
      conflictReason: `Workspace root is not confirmed or permitted: ${perm.error.message}`,
      baseContentHash,
    };
  }

  // 2. Validate path containment (S05)
  const containment = validateContainedPath(workspace, relativePath);
  if (!containment.ok) {
    return {
      relativePath,
      conflictStatus: 'conflict',
      conflictReason: `Path '${relativePath}' failed containment checks: ${containment.error.message}`,
      baseContentHash,
    };
  }

  const physicalPath = containment.value.resolvedPath;

  try {
    const liveExists = fs.existsSync(physicalPath);

    // Case 1: File existed at base
    if (sourceExistsAtBase) {
      if (!liveExists) {
        return {
          relativePath,
          conflictStatus: 'conflict',
          conflictReason: 'Original source file was deleted from live workspace after staging',
          currentLiveHash: null,
          baseContentHash,
        };
      }

      const liveBuffer = fs.readFileSync(physicalPath);
      const currentLiveHash = computeSha256(liveBuffer);

      if (currentLiveHash !== baseContentHash) {
        return {
          relativePath,
          conflictStatus: 'conflict',
          conflictReason: `Live file was modified after staging (base: ${baseContentHash?.substring(0, 8)}..., live: ${currentLiveHash.substring(0, 8)}...)`,
          currentLiveHash,
          baseContentHash,
        };
      }

      return {
        relativePath,
        conflictStatus: 'clean',
        currentLiveHash,
        baseContentHash,
      };
    }

    // Case 2: File did NOT exist at base (staged as 'add')
    if (!sourceExistsAtBase) {
      if (liveExists) {
        const liveBuffer = fs.readFileSync(physicalPath);
        const currentLiveHash = computeSha256(liveBuffer);
        return {
          relativePath,
          conflictStatus: 'conflict',
          conflictReason: 'A file now exists at target path in live workspace, conflicting with staged addition',
          currentLiveHash,
          baseContentHash,
        };
      }

      return {
        relativePath,
        conflictStatus: 'clean',
        currentLiveHash: null,
        baseContentHash,
      };
    }

    return {
      relativePath,
      conflictStatus: 'clean',
      baseContentHash,
    };
  } catch (err) {
    return {
      relativePath,
      conflictStatus: 'conflict',
      conflictReason: `Cannot safely inspect live file: ${err instanceof Error ? err.message : String(err)}`,
      baseContentHash,
    };
  }
}
