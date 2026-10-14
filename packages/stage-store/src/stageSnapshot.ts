/**
 * @mediator/stage-store — Source Snapshot and Hashes (S12)
 *
 * Requirements:
 * - Reads source files strictly through S05 workspace containment APIs.
 * - Rechecks confirmed workspace root state before inspecting files.
 * - Enforces S06 secret exclusions before reading source contents.
 * - Computes SHA-256 content hashes and metadata for baseline change tracking.
 * - Accurately records whether the source file existed at the base state.
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import {
  type WorkspaceRootState,
  validateContainedPath,
  checkWorkspacePermittedForFileOps,
} from '@mediator/workspace-boundary';
import { checkPathExclusion, MANDATORY_EXCLUSIONS } from '@mediator/context-security';
import { StageError, StageErrorCode } from './stageErrors.js';

export interface SourceSnapshot {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly existsAtBase: boolean;
  readonly contentHash: string | null;
  readonly contentBuffer: Buffer | null;
  readonly mtimeMs: number | null;
  readonly sizeBytes: number | null;
}

export function computeSha256(content: string | Buffer): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function captureSourceSnapshot(
  workspace: WorkspaceRootState,
  relativePath: string,
): SourceSnapshot {
  // 1. Recheck confirmed workspace state
  const perm = checkWorkspacePermittedForFileOps(workspace);
  if (!perm.ok) {
    throw new StageError(
      StageErrorCode.UNSAFE_WORKSPACE_ROOT,
      `Workspace is not permitted for file operations: ${perm.error.message}`,
      { path: relativePath, details: perm.error },
    );
  }

  // 2. Validate path containment (S05)
  const containment = validateContainedPath(workspace, relativePath);
  if (!containment.ok) {
    throw new StageError(
      StageErrorCode.PATH_OUTSIDE_ROOT,
      `Path '${relativePath}' failed containment checks: ${containment.error.message}`,
      { path: relativePath, details: containment.error },
    );
  }

  const absolutePath = containment.value.resolvedPath;

  // 3. Apply S06 secret exclusions before reading
  const exclusion = checkPathExclusion(relativePath, MANDATORY_EXCLUSIONS);
  if (exclusion.excluded) {
    throw new StageError(
      StageErrorCode.PATH_EXCLUDED,
      `Path '${relativePath}' matches sensitive exclusion '${exclusion.ruleId ?? 'EXCLUDED_PATH'}'; reading denied`,
      { path: relativePath, details: exclusion },
    );
  }

  // 4. Inspect file presence
  if (!fs.existsSync(absolutePath)) {
    return {
      relativePath,
      absolutePath,
      existsAtBase: false,
      contentHash: null,
      contentBuffer: null,
      mtimeMs: null,
      sizeBytes: null,
    };
  }

  // 5. Read file metadata & content
  try {
    const stats = fs.statSync(absolutePath);
    if (!stats.isFile()) {
      throw new StageError(
        StageErrorCode.STAGE_STATUS_INVALID,
        `Path '${relativePath}' exists but is not a regular file`,
        { path: relativePath },
      );
    }

    const buffer = fs.readFileSync(absolutePath);
    const hash = computeSha256(buffer);

    return {
      relativePath,
      absolutePath,
      existsAtBase: true,
      contentHash: hash,
      contentBuffer: buffer,
      mtimeMs: Math.round(stats.mtimeMs),
      sizeBytes: stats.size,
    };
  } catch (err) {
    if (err instanceof StageError) throw err;
    throw new StageError(
      StageErrorCode.STAGE_CORRUPTED,
      `Failed to capture source snapshot for '${relativePath}': ${err instanceof Error ? err.message : String(err)}`,
      { path: relativePath },
    );
  }
}
