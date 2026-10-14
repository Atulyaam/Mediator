/**
 * @mediator/stage-store — Apply Errors (S14)
 *
 * Strongly-typed errors for approval resolution, preflight checks,
 * live workspace apply-back, and rollback operations.
 */

export const ApplyErrorCode = {
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_ALREADY_RESOLVED: 'APPROVAL_ALREADY_RESOLVED',
  APPROVAL_ALREADY_CONSUMED: 'APPROVAL_ALREADY_CONSUMED',
  APPROVAL_PAYLOAD_MISMATCH: 'APPROVAL_PAYLOAD_MISMATCH',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  CALLER_UNAUTHORIZED: 'CALLER_UNAUTHORIZED',
  APPLY_CONFLICT: 'APPLY_CONFLICT',
  APPLY_FAILED: 'APPLY_FAILED',
  ROLLBACK_FAILED: 'ROLLBACK_FAILED',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  UNSAFE_WORKSPACE: 'UNSAFE_WORKSPACE',
  STAGE_CONFLICT: 'STAGE_CONFLICT',
} as const;

export type ApplyErrorCode = (typeof ApplyErrorCode)[keyof typeof ApplyErrorCode];

export interface ApplyErrorContext {
  readonly approvalId?: string | undefined;
  readonly transactionId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly stageId?: string | undefined;
  readonly path?: string | undefined;
  readonly details?: unknown;
}

export class ApplyError extends Error {
  public readonly code: ApplyErrorCode;
  public readonly context?: ApplyErrorContext | undefined;

  constructor(code: ApplyErrorCode, message: string, context?: ApplyErrorContext) {
    super(`[${code}] ${message}`);
    this.name = 'ApplyError';
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
