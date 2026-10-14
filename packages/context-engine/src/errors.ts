/**
 * @mediator/context-engine — Typed Errors & Diagnostics (S11)
 *
 * Requirements:
 * - Module-level failure codes for structured observability.
 * - Captures origin of errors: scanning, containment, exclusion, ranking/budget,
 *   persistence, protocol, or recovery.
 * - Never includes raw secrets or unfiltered whole files in error messages.
 */

import { ErrorCode, type ErrorCodeValue } from '@mediator/shared-contracts';

export const ContextEngineErrorCode = {
  PROJECT_MAP_SCAN_FAILED: 'PROJECT_MAP_SCAN_FAILED',
  UNSAFE_WORKSPACE_ROOT: 'UNSAFE_WORKSPACE_ROOT',
  CONTEXT_EXCLUSION_DENIED: 'CONTEXT_EXCLUSION_DENIED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  PERSISTENCE_FAILED: 'PERSISTENCE_FAILED',
  PROTOCOL_VALIDATION_FAILED: 'PROTOCOL_VALIDATION_FAILED',
  SUMMARY_RECOVERY_FAILED: 'SUMMARY_RECOVERY_FAILED',
  RULE_VALIDATION_FAILED: 'RULE_VALIDATION_FAILED',
  FILE_UNAVAILABLE: 'FILE_UNAVAILABLE',
  INVALID_SUMMARY_PAYLOAD: 'INVALID_SUMMARY_PAYLOAD',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  MEMORY_CLEAR_CONFIRMATION_REQUIRED: 'MEMORY_CLEAR_CONFIRMATION_REQUIRED',
} as const;

export type ContextEngineErrorCodeValue =
  (typeof ContextEngineErrorCode)[keyof typeof ContextEngineErrorCode];

export interface ContextEngineErrorContext {
  readonly taskId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly actionId?: string | undefined;
  readonly detail?: Record<string, unknown> | undefined;
}

export class ContextEngineError extends Error {
  public readonly code: ContextEngineErrorCodeValue;
  public readonly taskId?: string | undefined;
  public readonly sessionId?: string | undefined;
  public readonly correlationId?: string | undefined;
  public readonly actionId?: string | undefined;
  public readonly detail?: Record<string, unknown> | undefined;

  constructor(
    code: ContextEngineErrorCodeValue,
    message: string,
    context?: ContextEngineErrorContext,
  ) {
    super(message);
    this.name = 'ContextEngineError';
    this.code = code;
    this.taskId = context?.taskId;
    this.sessionId = context?.sessionId;
    this.correlationId = context?.correlationId;
    this.actionId = context?.actionId;
    this.detail = context?.detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public toMediatorErrorCode(): ErrorCodeValue {
    switch (this.code) {
      case ContextEngineErrorCode.UNSAFE_WORKSPACE_ROOT:
        return ErrorCode.WORKSPACE_ROOT_UNCONFIRMED;
      case ContextEngineErrorCode.CONTEXT_EXCLUSION_DENIED:
        return ErrorCode.PATH_DENIED;
      case ContextEngineErrorCode.BUDGET_EXCEEDED:
        return ErrorCode.OVERSIZED_INPUT;
      case ContextEngineErrorCode.PERSISTENCE_FAILED:
        return ErrorCode.INTERNAL_ERROR;
      case ContextEngineErrorCode.PROTOCOL_VALIDATION_FAILED:
        return ErrorCode.SCHEMA_INVALID;
      case ContextEngineErrorCode.SUMMARY_RECOVERY_FAILED:
        return ErrorCode.INTERNAL_ERROR;
      case ContextEngineErrorCode.RULE_VALIDATION_FAILED:
        return ErrorCode.ACTION_DENIED;
      case ContextEngineErrorCode.FILE_UNAVAILABLE:
        return ErrorCode.PATH_DENIED;
      case ContextEngineErrorCode.INVALID_SUMMARY_PAYLOAD:
        return ErrorCode.SCHEMA_INVALID;
      case ContextEngineErrorCode.TASK_NOT_FOUND:
        return ErrorCode.TASK_MISMATCH;
      case ContextEngineErrorCode.MEMORY_CLEAR_CONFIRMATION_REQUIRED:
        return ErrorCode.ACTION_DENIED;
      case ContextEngineErrorCode.PROJECT_MAP_SCAN_FAILED:
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }
}

export function makeContextEngineError(
  code: ContextEngineErrorCodeValue,
  message: string,
  context?: ContextEngineErrorContext,
): ContextEngineError {
  return new ContextEngineError(code, message, context);
}
