/**
 * @mediator/stage-store — Patch Proposal Validation (S13)
 *
 * Enforces S05 workspace containment, S06 sensitive path exclusions,
 * raw secret scanning, input size limits, and S07 protected path classification.
 */

import {
  type WorkspaceRootState,
  validateContainedPath,
} from '@mediator/workspace-boundary';
import {
  checkPathExclusion,
  MANDATORY_EXCLUSIONS,
  scanContent,
  shouldBlockContent,
} from '@mediator/context-security';
import { isProtectedPath, type PolicyDecisionType } from '@mediator/policy-engine';
import { type PatchProposal, type PatchOperation } from './patchTypes.js';
import { PatchError, PatchErrorCode } from './patchErrors.js';
import { MAX_STAGED_FILE_BYTES, validateRelativePathString } from './stageChanges.js';

export interface ValidatedPatchProposal {
  readonly patchId: string;
  readonly taskId: string;
  readonly stageId: string;
  readonly relativePath: string;
  readonly operation: PatchOperation;
  readonly targetPath?: string | undefined;
  readonly isProtected: boolean;
  readonly policyDecision: PolicyDecisionType;
  readonly requiresManualReview: boolean;
  readonly encoding: 'utf8' | 'binary';
}

export function validatePatchProposal(
  workspace: WorkspaceRootState,
  proposal: PatchProposal,
): ValidatedPatchProposal {
  const { patchId, taskId, stageId, relativePath, operation, payload } = proposal;

  if (!patchId || typeof patchId !== 'string') {
    throw new PatchError(PatchErrorCode.INVALID_OPERATION, 'patchId must be a non-empty string', { patchId });
  }
  if (!taskId || typeof taskId !== 'string') {
    throw new PatchError(PatchErrorCode.INVALID_OPERATION, 'taskId must be a non-empty string', { taskId });
  }
  if (!stageId || typeof stageId !== 'string') {
    throw new PatchError(PatchErrorCode.INVALID_OPERATION, 'stageId must be a non-empty string', { stageId });
  }

  // 1. Check oversized content if provided
  if (payload.content !== undefined) {
    const byteLen = Buffer.isBuffer(payload.content)
      ? payload.content.byteLength
      : Buffer.byteLength(String(payload.content), 'utf8');

    if (byteLen > MAX_STAGED_FILE_BYTES) {
      throw new PatchError(
        PatchErrorCode.OVERSIZED_INPUT,
        `Patch content exceeds maximum allowed size of ${MAX_STAGED_FILE_BYTES} bytes`,
        { patchId, taskId, stageId, path: relativePath },
      );
    }
  }

  // 2. Path format validation
  let normalizedRelative: string;
  try {
    normalizedRelative = validateRelativePathString(relativePath, 'relativePath');
  } catch (err) {
    throw new PatchError(
      PatchErrorCode.INVALID_PATH,
      err instanceof Error ? err.message : String(err),
      { patchId, taskId, stageId, path: relativePath },
    );
  }

  // 3. Workspace containment
  const containment = validateContainedPath(workspace, normalizedRelative);
  if (!containment.ok) {
    throw new PatchError(
      PatchErrorCode.INVALID_PATH,
      `Path '${relativePath}' is outside workspace root: ${containment.error.message}`,
      { patchId, taskId, stageId, path: relativePath, details: containment.error },
    );
  }

  // 4. S06 Path Exclusion
  const exclusion = checkPathExclusion(normalizedRelative, MANDATORY_EXCLUSIONS);
  if (exclusion.excluded) {
    throw new PatchError(
      PatchErrorCode.PATH_EXCLUDED,
      `Access to '${normalizedRelative}' is excluded by security rule '${exclusion.ruleId ?? 'mandatory'}': ${exclusion.reason ?? 'sensitive file'}`,
      { patchId, taskId, stageId, path: normalizedRelative },
    );
  }

  // 5. Validate targetPath if rename-proposed
  let normalizedTarget: string | undefined;
  if (operation === 'rename-proposed') {
    if (!payload.targetPath || typeof payload.targetPath !== 'string') {
      throw new PatchError(
        PatchErrorCode.INVALID_OPERATION,
        "rename-proposed requires a non-empty 'targetPath' in payload",
        { patchId, taskId, stageId, path: normalizedRelative },
      );
    }
    try {
      normalizedTarget = validateRelativePathString(payload.targetPath, 'targetPath');
    } catch (err) {
      throw new PatchError(
        PatchErrorCode.INVALID_PATH,
        err instanceof Error ? err.message : String(err),
        { patchId, taskId, stageId, path: payload.targetPath },
      );
    }

    const targetContainment = validateContainedPath(workspace, normalizedTarget);
    if (!targetContainment.ok) {
      throw new PatchError(
        PatchErrorCode.INVALID_PATH,
        `Rename target path '${normalizedTarget}' is outside workspace root: ${targetContainment.error.message}`,
        { patchId, taskId, stageId, path: normalizedTarget },
      );
    }

    const targetExclusion = checkPathExclusion(normalizedTarget, MANDATORY_EXCLUSIONS);
    if (targetExclusion.excluded) {
      throw new PatchError(
        PatchErrorCode.PATH_EXCLUDED,
        `Rename target path '${normalizedTarget}' is excluded by security rule: ${targetExclusion.reason}`,
        { patchId, taskId, stageId, path: normalizedTarget },
      );
    }
  }

  // 6. Secret scanning on payload content and replacement edits
  if (payload.content !== undefined) {
    const rawStr = typeof payload.content === 'string'
      ? payload.content
      : payload.content.toString('utf8');

    const scan = scanContent(rawStr);
    if (scan.ok && shouldBlockContent(scan.value)) {
      throw new PatchError(
        PatchErrorCode.SECRET_DETECTED,
        `Secret detected in patch content for '${normalizedRelative}': rule '${scan.value.findings[0]?.ruleId}'`,
        { patchId, taskId, stageId, path: normalizedRelative, details: scan.value.findings },
      );
    }
  }

  if (payload.edits !== undefined && payload.edits.length > 0) {
    for (const edit of payload.edits) {
      if (!edit.search) {
        throw new PatchError(
          PatchErrorCode.INVALID_OPERATION,
          "Search string in SearchReplaceEdit must not be empty",
          { patchId, taskId, stageId, path: normalizedRelative },
        );
      }
      const scan = scanContent(edit.replace);
      if (scan.ok && shouldBlockContent(scan.value)) {
        throw new PatchError(
          PatchErrorCode.SECRET_DETECTED,
          `Secret detected in replacement text for '${normalizedRelative}': rule '${scan.value.findings[0]?.ruleId}'`,
          { patchId, taskId, stageId, path: normalizedRelative, details: scan.value.findings },
        );
      }
    }
  }

  // 6. Protected path check
  const isProtected = isProtectedPath(normalizedRelative).isProtected ||
    (normalizedTarget ? isProtectedPath(normalizedTarget).isProtected : false);

  const isDestructive = operation === 'delete-proposed' || operation === 'rename-proposed';
  const requiresManualReview = Boolean(isProtected || isDestructive);

  const policyDecision: PolicyDecisionType = requiresManualReview
    ? 'REQUIRE_APPROVAL'
    : 'ALLOW';

  const encoding = payload.encoding ?? 'utf8';

  return {
    patchId,
    taskId,
    stageId,
    relativePath: normalizedRelative,
    operation,
    targetPath: normalizedTarget,
    isProtected,
    policyDecision,
    requiresManualReview,
    encoding,
  };
}
