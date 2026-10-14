/**
 * @mediator/persistence — Typed Persistence Errors (S10)
 */

import {
  ErrorCode,
  type ErrorCodeValue,
  makeMediatorError,
  type MediatorError,
} from '@mediator/shared-contracts';

export const PersistenceErrorCode = {
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  DATABASE_CORRUPT: 'DATABASE_CORRUPT',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',
  CONSTRAINT_VIOLATION: 'CONSTRAINT_VIOLATION',
  RECORD_NOT_FOUND: 'RECORD_NOT_FOUND',
  AUDIT_INTEGRITY_COMPROMISED: 'AUDIT_INTEGRITY_COMPROMISED',
  AUDIT_CHAIN_BROKEN: 'AUDIT_CHAIN_BROKEN',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
  SERIALIZATION_FAILED: 'SERIALIZATION_FAILED',
  MUTATION_DENIED: 'MUTATION_DENIED',
} as const;

export type PersistenceErrorCodeValue =
  (typeof PersistenceErrorCode)[keyof typeof PersistenceErrorCode];

export class PersistenceError extends Error {
  public readonly code: PersistenceErrorCodeValue;
  public readonly detail?: Record<string, unknown> | undefined;

  constructor(
    code: PersistenceErrorCodeValue,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'PersistenceError';
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, PersistenceError.prototype);
  }

  public toMediatorError(taskId?: string, correlationId?: string): MediatorError {
    let sharedCode: ErrorCodeValue = ErrorCode.INTERNAL_ERROR;
    if (
      this.code === PersistenceErrorCode.AUDIT_INTEGRITY_COMPROMISED ||
      this.code === PersistenceErrorCode.AUDIT_CHAIN_BROKEN
    ) {
      sharedCode = ErrorCode.TAMPERING_DETECTED;
    } else if (this.code === PersistenceErrorCode.RECORD_NOT_FOUND) {
      sharedCode = ErrorCode.INTERNAL_ERROR;
    }

    return makeMediatorError(sharedCode, this.message, {
      ...(taskId ? { taskId } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
    });
  }
}
