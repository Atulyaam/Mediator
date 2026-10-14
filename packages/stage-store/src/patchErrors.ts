/**
 * @mediator/stage-store — Patch Errors (S13)
 *
 * Strongly-typed errors for patch validation, search/replace parsing,
 * conflict detection, and staging operations.
 */

export const PatchErrorCode = {
  NO_MATCH: 'NO_MATCH',
  AMBIGUOUS_MATCH: 'AMBIGUOUS_MATCH',
  STALE_BASE_HASH: 'STALE_BASE_HASH',
  STALE_STAGE_HASH: 'STALE_STAGE_HASH',
  LIVE_CONFLICT: 'LIVE_CONFLICT',
  INVALID_PATH: 'INVALID_PATH',
  SECRET_DETECTED: 'SECRET_DETECTED',
  PATH_EXCLUDED: 'PATH_EXCLUDED',
  OVERSIZED_INPUT: 'OVERSIZED_INPUT',
  UNSUPPORTED_ENCODING: 'UNSUPPORTED_ENCODING',
  INVALID_OPERATION: 'INVALID_OPERATION',
  CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
  STAGE_NOT_FOUND: 'STAGE_NOT_FOUND',
  RENAME_COLLISION: 'RENAME_COLLISION',
} as const;

export type PatchErrorCode = (typeof PatchErrorCode)[keyof typeof PatchErrorCode];

export interface PatchErrorContext {
  readonly patchId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly stageId?: string | undefined;
  readonly path?: string | undefined;
  readonly details?: unknown;
}

export class PatchError extends Error {
  public readonly code: PatchErrorCode;
  public readonly context?: PatchErrorContext | undefined;

  constructor(code: PatchErrorCode, message: string, context?: PatchErrorContext) {
    super(`[${code}] ${message}`);
    this.name = 'PatchError';
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
