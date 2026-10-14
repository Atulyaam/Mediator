/**
 * @mediator/stage-store — Stage Errors & Failure Codes (S12)
 *
 * Defines typed errors with stable failure codes across shadow staging operations.
 */

export const StageErrorCode = {
  STAGE_NOT_FOUND: 'STAGE_NOT_FOUND',
  STAGE_ALREADY_EXISTS: 'STAGE_ALREADY_EXISTS',
  TASK_MISMATCH: 'TASK_MISMATCH',
  STAGE_STATUS_INVALID: 'STAGE_STATUS_INVALID',
  UNSAFE_WORKSPACE_ROOT: 'UNSAFE_WORKSPACE_ROOT',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  PATH_OUTSIDE_ROOT: 'PATH_OUTSIDE_ROOT',
  PATH_EXCLUDED: 'PATH_EXCLUDED',
  SECRET_DETECTED: 'SECRET_DETECTED',
  OVERSIZED_INPUT: 'OVERSIZED_INPUT',
  STAGE_BASE_HASH_STALE: 'STAGE_BASE_HASH_STALE',
  STAGE_CONFLICT: 'STAGE_CONFLICT',
  CHECKPOINT_NOT_FOUND: 'CHECKPOINT_NOT_FOUND',
  CHECKPOINT_MISMATCH: 'CHECKPOINT_MISMATCH',
  STAGE_CORRUPTED: 'STAGE_CORRUPTED',
  PERSISTENCE_FAILED: 'PERSISTENCE_FAILED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  INVALID_PROPOSAL: 'INVALID_PROPOSAL',
  STORAGE_ACCESS_DENIED: 'STORAGE_ACCESS_DENIED',
} as const;

export type StageErrorCodeValue = (typeof StageErrorCode)[keyof typeof StageErrorCode];

export class StageError extends Error {
  public readonly code: StageErrorCodeValue;
  public readonly stageId?: string | undefined;
  public readonly taskId?: string | undefined;
  public readonly path?: string | undefined;
  public readonly details?: unknown;

  constructor(
    code: StageErrorCodeValue,
    message: string,
    options?: {
      stageId?: string | undefined;
      taskId?: string | undefined;
      path?: string | undefined;
      details?: unknown;
    },
  ) {
    super(`[${code}] ${message}`);
    this.name = 'StageError';
    this.code = code;
    this.stageId = options?.stageId;
    this.taskId = options?.taskId;
    this.path = options?.path;
    this.details = options?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
