/**
 * @mediator/stage-store — Patch Types & Contracts (S13)
 *
 * Defines deterministic, hash-aware patch structures that modify staged files only.
 */

import {
  type StageConflictStatus,
  type StagedFileRecord,
} from './stageTypes.js';

export type PatchOperation = 'create' | 'modify' | 'delete-proposed' | 'rename-proposed';

export interface SearchReplaceEdit {
  readonly search: string;
  readonly replace: string;
  /**
   * Whether to allow multiple occurrences.
   * If false or undefined, search string must match exactly once in the document.
   */
  readonly allowMultiple?: boolean | undefined;
}

export interface PatchPayload {
  /** Raw content for whole-file create or modify */
  readonly content?: string | Buffer | undefined;
  /** Structured search/replace edits for contextual modify */
  readonly edits?: readonly SearchReplaceEdit[] | undefined;
  /** Target relative path for rename-proposed */
  readonly targetPath?: string | undefined;
  /** Explicit encoding (defaults to utf8) */
  readonly encoding?: 'utf8' | 'binary' | undefined;
}

export interface PatchProposal {
  readonly patchId: string;
  readonly taskId: string;
  readonly stageId: string;
  readonly relativePath: string;
  readonly operation: PatchOperation;
  readonly payload: PatchPayload;
  /** Expected SHA-256 hash of the live base source file */
  readonly expectedBaseHash?: string | undefined;
  /** Expected SHA-256 hash of the currently staged file (prevents concurrent race conditions) */
  readonly expectedStageHash?: string | undefined;
  readonly correlationId?: string | undefined;
}

export interface PatchResult {
  readonly patchId: string;
  readonly taskId: string;
  readonly stageId: string;
  readonly relativePath: string;
  readonly operation: PatchOperation;
  readonly status: 'applied' | 'conflict' | 'rejected';
  readonly resultingHash: string;
  readonly byteLength: number;
  readonly isProtected: boolean;
  readonly requiresManualReview: boolean;
  readonly conflictStatus: StageConflictStatus;
  readonly conflictReason?: string | undefined;
  readonly record: StagedFileRecord;
}
