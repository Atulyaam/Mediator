/**
 * @mediator/stage-store — Proposed File Change Records & Validation (S12)
 *
 * Requirements:
 * - Validates proposals against S05 workspace containment.
 * - Enforces S06 sensitive path exclusions and secret scanning.
 * - Rejects path traversal, Windows reserved devices, and alternate data streams.
 * - Classifies protected paths (S07) and tags manual review requirements.
 * - Enforces maximum file size caps (2 MB default).
 */

import * as path from 'node:path';
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
import { StageError, StageErrorCode } from './stageErrors.js';
import { type StageFileProposal } from './stageTypes.js';

export const MAX_STAGED_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export function validateRelativePathString(rawPath: string, fieldName = 'relativePath'): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new StageError(
      StageErrorCode.INVALID_PROPOSAL,
      `${fieldName} must be a non-empty string`,
    );
  }

  // Reject backslash or forward slash leading
  if (rawPath.startsWith('/') || rawPath.startsWith('\\')) {
    throw new StageError(
      StageErrorCode.PATH_OUTSIDE_ROOT,
      `${fieldName} cannot start with a path separator: '${rawPath}'`,
      { path: rawPath },
    );
  }

  // Reject absolute paths
  if (path.isAbsolute(rawPath) || /^[a-zA-Z]:/.test(rawPath)) {
    throw new StageError(
      StageErrorCode.PATH_OUTSIDE_ROOT,
      `${fieldName} cannot be an absolute path: '${rawPath}'`,
      { path: rawPath },
    );
  }

  // Normalize separators to forward slash
  const normalized = rawPath.replace(/\\/g, '/');

  // Check traversal
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new StageError(
        StageErrorCode.PATH_TRAVERSAL,
        `${fieldName} cannot contain '..' traversal: '${rawPath}'`,
        { path: rawPath },
      );
    }
    // Reserved device names
    const baseName = (seg.split('.')[0] ?? '').toLowerCase();
    if (RESERVED_DEVICE_NAMES.has(baseName)) {
      throw new StageError(
        StageErrorCode.PATH_TRAVERSAL,
        `${fieldName} contains Windows reserved device name '${seg}': '${rawPath}'`,
        { path: rawPath },
      );
    }
    // Alternate Data Streams (colons)
    if (seg.includes(':')) {
      throw new StageError(
        StageErrorCode.PATH_TRAVERSAL,
        `${fieldName} cannot contain colons or Alternate Data Streams: '${rawPath}'`,
        { path: rawPath },
      );
    }
  }

  return normalized;
}

export interface ValidatedProposalResult {
  readonly relativePath: string;
  readonly targetPath?: string | undefined;
  readonly isProtected: boolean;
  readonly policyDecision: PolicyDecisionType;
  readonly requiresManualReview: boolean;
  readonly buffer: Buffer | null;
  readonly byteLength: number;
  readonly encoding: 'utf8' | 'binary';
}

export function validateProposal(
  workspace: WorkspaceRootState,
  proposal: StageFileProposal,
): ValidatedProposalResult {
  // 1. Validate relative path string
  const relativePath = validateRelativePathString(proposal.relativePath, 'relativePath');

  // 2. Validate S05 workspace containment
  const containment = validateContainedPath(workspace, relativePath);
  if (!containment.ok) {
    throw new StageError(
      StageErrorCode.PATH_OUTSIDE_ROOT,
      `Path '${relativePath}' failed workspace containment: ${containment.error.message}`,
      { path: relativePath, details: containment.error },
    );
  }

  // 3. S06 secret exclusion
  const exclusion = checkPathExclusion(relativePath, MANDATORY_EXCLUSIONS);
  if (exclusion.excluded) {
    throw new StageError(
      StageErrorCode.PATH_EXCLUDED,
      `Path '${relativePath}' is excluded by secret security rule: '${exclusion.ruleId ?? 'EXCLUDED_PATH'}'`,
      { path: relativePath, details: exclusion },
    );
  }

  // 4. Validate targetPath if rename-proposed
  let targetPath: string | undefined;
  if (proposal.changeType === 'rename-proposed') {
    if (!proposal.targetPath) {
      throw new StageError(
        StageErrorCode.INVALID_PROPOSAL,
        "rename-proposed requires 'targetPath'",
        { path: relativePath },
      );
    }
    targetPath = validateRelativePathString(proposal.targetPath, 'targetPath');
    const targetContainment = validateContainedPath(workspace, targetPath);
    if (!targetContainment.ok) {
      throw new StageError(
        StageErrorCode.PATH_OUTSIDE_ROOT,
        `Target path '${targetPath}' failed workspace containment: ${targetContainment.error.message}`,
        { path: targetPath, details: targetContainment.error },
      );
    }
  }

  // 5. Check content size and secret scanning
  let buffer: Buffer | null = null;
  let byteLength = 0;
  const encoding = proposal.encoding ?? 'utf8';

  if (proposal.content !== undefined && proposal.content !== null) {
    buffer = typeof proposal.content === 'string'
      ? Buffer.from(proposal.content, 'utf8')
      : proposal.content;

    byteLength = buffer.byteLength;

    if (byteLength > MAX_STAGED_FILE_BYTES) {
      throw new StageError(
        StageErrorCode.OVERSIZED_INPUT,
        `Staged file content (${byteLength} bytes) exceeds limit of ${MAX_STAGED_FILE_BYTES} bytes`,
        { path: relativePath, details: { byteLength, limit: MAX_STAGED_FILE_BYTES } },
      );
    }

    // Secret scan if utf8
    if (encoding === 'utf8') {
      const contentStr = buffer.toString('utf8');
      const scanRes = scanContent(contentStr);
      if (scanRes.ok && shouldBlockContent(scanRes.value)) {
        const findingRule = scanRes.value.findings[0]?.ruleId ?? 'SECRET_DETECTED';
        throw new StageError(
          StageErrorCode.SECRET_DETECTED,
          `Staged file content contains unsendable secret pattern: ${findingRule}`,
          { path: relativePath },
        );
      }
    }
  } else if (proposal.changeType === 'add' || proposal.changeType === 'modify') {
    // Empty content is allowed (creating/truncating to empty file)
    buffer = Buffer.alloc(0);
    byteLength = 0;
  }

  // 6. Check protected path (S07)
  const protectedCheck = isProtectedPath(relativePath);
  const isProtected = protectedCheck.isProtected;

  // 7. Policy decision & manual review requirement
  const requiresManualReview =
    isProtected ||
    proposal.changeType === 'delete-proposed' ||
    proposal.changeType === 'rename-proposed';

  const policyDecision: PolicyDecisionType = requiresManualReview
    ? 'REQUIRE_APPROVAL'
    : 'ALLOW';

  return {
    relativePath,
    targetPath,
    isProtected,
    policyDecision,
    requiresManualReview,
    buffer,
    byteLength,
    encoding,
  };
}
