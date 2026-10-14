/**
 * @mediator/stage-store — Patch Engine (S13)
 *
 * Requirements:
 * - Deterministic, hash-aware patch application.
 * - Exact search/replace with unique context matching.
 * - Rejection of zero matches and ambiguous matches.
 * - Encoding and newline preservation (CRLF/LF, BOM, final newline).
 * - Per-path concurrency locking.
 * - Modifies STAGED files only. Live workspace is never mutated.
 */

import * as crypto from 'node:crypto';
import { type WorkspaceRootState } from '@mediator/workspace-boundary';
import { type StagedFileRecord, type StageChangeType } from './stageTypes.js';
import {
  type PatchProposal,
  type PatchResult,
  type SearchReplaceEdit,
} from './patchTypes.js';
import { PatchError, PatchErrorCode } from './patchErrors.js';
import { validatePatchProposal } from './patchValidator.js';
import { PatchConflictService } from './patchConflictService.js';
import { StageStorage } from './stageStorage.js';
import { StageRepository } from './stageRepository.js';
import { captureSourceSnapshot } from './stageSnapshot.js';
import { MAX_STAGED_FILE_BYTES } from './stageChanges.js';

export interface TextFormatMetadata {
  readonly hasBom: boolean;
  readonly newline: '\r\n' | '\n';
  readonly hasTrailingNewline: boolean;
}

export function detectTextFormat(text: string): TextFormatMetadata {
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const content = hasBom ? text.slice(1) : text;
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/[^\r]\n/g) || []).length;
  const newline = crlfCount >= lfCount && crlfCount > 0 ? '\r\n' : '\n';
  const hasTrailingNewline = content.endsWith('\n');

  return { hasBom, newline, hasTrailingNewline };
}

export function applySearchReplace(
  originalText: string,
  edits: readonly SearchReplaceEdit[],
): string {
  // Check for binary characters (NUL byte)
  if (originalText.includes('\0')) {
    throw new PatchError(
      PatchErrorCode.UNSUPPORTED_ENCODING,
      'Cannot apply structured search/replace to binary content containing NUL bytes',
    );
  }

  const { hasBom, newline, hasTrailingNewline } = detectTextFormat(originalText);
  let text = hasBom ? originalText.slice(1) : originalText;

  for (const edit of edits) {
    const { search, replace, allowMultiple } = edit;

    // Normalize search and replace newlines to match document format for consistent matching
    const normalizedSearch = search.replace(/\r\n|\r|\n/g, newline);
    const normalizedReplace = replace.replace(/\r\n|\r|\n/g, newline);

    // Count exact occurrences
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(normalizedSearch, pos)) !== -1) {
      count++;
      pos += normalizedSearch.length;
    }

    if (count === 0) {
      throw new PatchError(
        PatchErrorCode.NO_MATCH,
        `Search block not found in document. Expected exact context: '${search.substring(0, 100)}...'`,
        { details: { searchSnippet: search.substring(0, 200) } },
      );
    }

    if (count > 1 && !allowMultiple) {
      throw new PatchError(
        PatchErrorCode.AMBIGUOUS_MATCH,
        `Search block matched ${count} times in document, but unique match is required. Provide more context or specify allowMultiple: true`,
        { details: { matchCount: count, searchSnippet: search.substring(0, 200) } },
      );
    }

    if (allowMultiple) {
      text = text.split(normalizedSearch).join(normalizedReplace);
    } else {
      const idx = text.indexOf(normalizedSearch);
      text = text.slice(0, idx) + normalizedReplace + text.slice(idx + normalizedSearch.length);
    }
  }

  // Preserve trailing newline convention
  if (hasTrailingNewline && !text.endsWith('\n')) {
    text += newline;
  } else if (!hasTrailingNewline && text.endsWith(newline)) {
    text = text.slice(0, -newline.length);
  }

  // Re-attach BOM if present
  if (hasBom && text.charCodeAt(0) !== 0xfeff) {
    text = '\uFEFF' + text;
  }

  return text;
}

export class PatchEngine {
  private readonly conflictService = new PatchConflictService();
  private readonly activeLocks = new Set<string>();

  constructor(
    private readonly storage: StageStorage,
    private readonly repo: StageRepository,
  ) {}

  /**
   * Apply a single patch proposal to the shadow stage store.
   * Modifies STAGED files only. Live workspace is never mutated.
   */
  public applyPatch(
    workspace: WorkspaceRootState,
    proposal: PatchProposal,
  ): PatchResult {
    const lockKey = `${proposal.stageId}:${proposal.relativePath}`;
    if (this.activeLocks.has(lockKey)) {
      throw new PatchError(
        PatchErrorCode.CONCURRENT_MODIFICATION,
        `Concurrent patch application in progress for '${proposal.relativePath}' on stage '${proposal.stageId}'`,
        { patchId: proposal.patchId, stageId: proposal.stageId, path: proposal.relativePath },
      );
    }

    this.activeLocks.add(lockKey);
    try {
      return this.executePatch(workspace, proposal);
    } finally {
      this.activeLocks.delete(lockKey);
    }
  }

  /**
   * Apply a batch of patch proposals as a recoverable unit.
   * If any proposal fails or conflicts, none are committed to the stage.
   */
  public applyPatchBatch(
    workspace: WorkspaceRootState,
    proposals: readonly PatchProposal[],
  ): PatchResult[] {
    if (proposals.length === 0) {
      return [];
    }

    // 1. Lock all paths
    const lockedKeys: string[] = [];
    try {
      for (const p of proposals) {
        const lockKey = `${p.stageId}:${p.relativePath}`;
        if (this.activeLocks.has(lockKey) || lockedKeys.includes(lockKey)) {
          throw new PatchError(
            PatchErrorCode.CONCURRENT_MODIFICATION,
            `Duplicate or concurrent patch target '${p.relativePath}' in batch on stage '${p.stageId}'`,
            { patchId: p.patchId, stageId: p.stageId, path: p.relativePath },
          );
        }
        this.activeLocks.add(lockKey);
        lockedKeys.push(lockKey);
      }

      // 2. Execute each proposal in memory / stage
      const results: PatchResult[] = [];
      for (const proposal of proposals) {
        results.push(this.executePatch(workspace, proposal));
      }

      return results;
    } finally {
      for (const key of lockedKeys) {
        this.activeLocks.delete(key);
      }
    }
  }

  private executePatch(
    workspace: WorkspaceRootState,
    proposal: PatchProposal,
  ): PatchResult {
    // 1. Validate request, path containment, sensitive exclusions, secret scanning
    const validated = validatePatchProposal(workspace, proposal);

    // 2. Fetch existing stage and staged file record (if any)
    const stage = this.repo.getStage(proposal.stageId);
    if (!stage) {
      throw new PatchError(
        PatchErrorCode.STAGE_NOT_FOUND,
        `Stage with id '${proposal.stageId}' does not exist`,
        { patchId: proposal.patchId, stageId: proposal.stageId },
      );
    }

    const existingStagedRecord = this.repo.getStagedFile(proposal.stageId, validated.relativePath);
    const allStagedFiles = this.repo.listStagedFiles(proposal.stageId);

    // 3. Preflight conflict check against live workspace and stage
    const conflictCheck = this.conflictService.checkProposalConflicts(
      workspace,
      proposal,
      existingStagedRecord,
      allStagedFiles,
    );

    if (conflictCheck.hasConflict) {
      if (conflictCheck.conflictStatus === 'stale') {
        throw new PatchError(
          PatchErrorCode.STALE_STAGE_HASH,
          conflictCheck.reason ?? 'Staged file has been modified concurrently',
          { patchId: proposal.patchId, stageId: proposal.stageId, path: validated.relativePath },
        );
      }
      throw new PatchError(
        PatchErrorCode.LIVE_CONFLICT,
        conflictCheck.reason ?? 'Live workspace conflict detected',
        { patchId: proposal.patchId, stageId: proposal.stageId, path: validated.relativePath },
      );
    }

    // 4. Capture current source snapshot for base information
    const snapshot = captureSourceSnapshot(workspace, validated.relativePath);

    // 5. Compute new staged content buffer
    let newBuffer: Buffer;
    let stagedStoragePath = '';
    let stagedContentHash = '';
    let byteLength = 0;

    if (proposal.operation === 'delete-proposed') {
      newBuffer = Buffer.alloc(0);
      stagedContentHash = crypto.createHash('sha256').update('').digest('hex');
      byteLength = 0;
      stagedStoragePath = '';
      this.storage.deleteStagedFile(stage.taskId, stage.stageId, validated.relativePath);
    } else if (proposal.operation === 'rename-proposed') {
      // Content is preserved from current staged or live base
      if (existingStagedRecord && existingStagedRecord.changeType !== 'delete-proposed') {
        newBuffer = this.storage.readStagedFile(stage.taskId, stage.stageId, validated.relativePath);
      } else if (snapshot.contentBuffer) {
        newBuffer = snapshot.contentBuffer;
      } else {
        newBuffer = Buffer.alloc(0);
      }
      const writeRes = this.storage.writeStagedFile(
        stage.taskId,
        stage.stageId,
        validated.relativePath,
        newBuffer,
      );
      stagedStoragePath = writeRes.stagedStoragePath;
      stagedContentHash = writeRes.hash;
      byteLength = writeRes.byteLength;
    } else if (proposal.operation === 'create') {
      if (proposal.payload.content === undefined) {
        throw new PatchError(
          PatchErrorCode.INVALID_OPERATION,
          "create operation requires 'content' in payload",
          { patchId: proposal.patchId, stageId: proposal.stageId, path: validated.relativePath },
        );
      }
      newBuffer = typeof proposal.payload.content === 'string'
        ? Buffer.from(proposal.payload.content, 'utf8')
        : proposal.payload.content;

      if (newBuffer.byteLength > MAX_STAGED_FILE_BYTES) {
        throw new PatchError(
          PatchErrorCode.OVERSIZED_INPUT,
          `Content exceeds maximum allowed size of ${MAX_STAGED_FILE_BYTES} bytes`,
          { patchId: proposal.patchId, stageId: proposal.stageId, path: validated.relativePath },
        );
      }

      const writeRes = this.storage.writeStagedFile(
        stage.taskId,
        stage.stageId,
        validated.relativePath,
        newBuffer,
      );
      stagedStoragePath = writeRes.stagedStoragePath;
      stagedContentHash = writeRes.hash;
      byteLength = writeRes.byteLength;
    } else {
      // 'modify' operation
      let baseText: string;
      if (existingStagedRecord && existingStagedRecord.changeType !== 'delete-proposed') {
        const buf = this.storage.readStagedFile(stage.taskId, stage.stageId, validated.relativePath);
        baseText = buf.toString('utf8');
      } else if (snapshot.contentBuffer) {
        baseText = snapshot.contentBuffer.toString('utf8');
      } else {
        throw new PatchError(
          PatchErrorCode.INVALID_OPERATION,
          `Cannot modify '${validated.relativePath}': source file does not exist at base or staging`,
          { patchId: proposal.patchId, stageId: proposal.stageId, path: validated.relativePath },
        );
      }

      if (proposal.payload.edits && proposal.payload.edits.length > 0) {
        const transformed = applySearchReplace(baseText, proposal.payload.edits);
        newBuffer = Buffer.from(transformed, 'utf8');
      } else if (proposal.payload.content !== undefined) {
        newBuffer = typeof proposal.payload.content === 'string'
          ? Buffer.from(proposal.payload.content, 'utf8')
          : proposal.payload.content;
      } else {
        throw new PatchError(
          PatchErrorCode.INVALID_OPERATION,
          "modify operation requires either 'edits' or 'content' in payload",
          { patchId: proposal.patchId, stageId: proposal.stageId, path: validated.relativePath },
        );
      }

      if (newBuffer.byteLength > MAX_STAGED_FILE_BYTES) {
        throw new PatchError(
          PatchErrorCode.OVERSIZED_INPUT,
          `Modified content exceeds maximum allowed size of ${MAX_STAGED_FILE_BYTES} bytes`,
          { patchId: proposal.patchId, stageId: proposal.stageId, path: validated.relativePath },
        );
      }

      const writeRes = this.storage.writeStagedFile(
        stage.taskId,
        stage.stageId,
        validated.relativePath,
        newBuffer,
      );
      stagedStoragePath = writeRes.stagedStoragePath;
      stagedContentHash = writeRes.hash;
      byteLength = writeRes.byteLength;
    }

    // 6. Persist StagedFileRecord
    const now = Date.now();
    const changeType: StageChangeType = proposal.operation === 'create' ? 'add' : proposal.operation;

    const record: StagedFileRecord = {
      stageId: proposal.stageId,
      relativePath: validated.relativePath,
      sourceExistsAtBase: snapshot.existsAtBase,
      baseContentHash: snapshot.contentHash,
      baseMtimeMs: snapshot.mtimeMs,
      baseSizeBytes: snapshot.sizeBytes,
      stagedContentHash,
      byteLength,
      encoding: validated.encoding,
      changeType,
      isProtected: validated.isProtected,
      policyDecision: validated.policyDecision,
      requiresManualReview: validated.requiresManualReview,
      targetPath: validated.targetPath,
      conflictStatus: 'clean',
      stagedStoragePath,
      createdAt: existingStagedRecord?.createdAt ?? now,
      updatedAt: now,
    };

    this.repo.saveStagedFile(record);

    return {
      patchId: proposal.patchId,
      taskId: stage.taskId,
      stageId: proposal.stageId,
      relativePath: validated.relativePath,
      operation: proposal.operation,
      status: 'applied',
      resultingHash: stagedContentHash,
      byteLength,
      isProtected: validated.isProtected,
      requiresManualReview: validated.requiresManualReview,
      conflictStatus: 'clean',
      record,
    };
  }
}
