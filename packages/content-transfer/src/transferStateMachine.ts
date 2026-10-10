/**
 * @mediator/content-transfer — Transfer State Machine (S09)
 *
 * States:
 *   RECEIVING → VALIDATING → COMPLETE
 *   Terminal failure: REJECTED, EXPIRED, CANCELLED
 *
 * Critical Invariants:
 * - Incomplete transfers cannot become valid proposals.
 * - Completed transfers cannot be altered.
 * - Single-session binding: chunks from different sessions cannot mix.
 * - Failed transfers cannot be resumed without clean reattachment.
 * - Zero transfer data reaches staging before COMPLETE state is reached.
 */

import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
} from '@mediator/shared-contracts';
import {
  TransferState,
  type TransferStateValue,
} from './transferTypes.js';

export class TransferStateMachine {
  private state: TransferStateValue = TransferState.RECEIVING;
  public readonly transferId: string;
  public readonly sessionId: string;
  public readonly taskId: string;
  public readonly createdAt: number;
  public readonly timeoutMs: number;
  private failureReason?: string | undefined;

  constructor(transferId: string, sessionId: string, taskId: string, timeoutMs = 30_000) {
    this.transferId = transferId;
    this.sessionId = sessionId;
    this.taskId = taskId;
    this.createdAt = Date.now();
    this.timeoutMs = timeoutMs;
  }

  public getState(): TransferStateValue {
    // Automatic timeout check
    if (
      (this.state === TransferState.RECEIVING || this.state === TransferState.VALIDATING) &&
      Date.now() - this.createdAt > this.timeoutMs
    ) {
      this.state = TransferState.EXPIRED;
      this.failureReason = `Transfer timed out after ${this.timeoutMs} ms`;
    }
    return this.state;
  }

  public getFailureReason(): string | undefined {
    return this.failureReason;
  }

  public isComplete(): boolean {
    return this.getState() === TransferState.COMPLETE;
  }

  public isTerminal(): boolean {
    const s = this.getState();
    return s === TransferState.COMPLETE || s === TransferState.REJECTED || s === TransferState.EXPIRED || s === TransferState.CANCELLED;
  }

  public transitionToValidating(): Result<true, MediatorError> {
    const current = this.getState();
    if (current !== TransferState.RECEIVING) {
      return err(
        makeMediatorError(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Cannot transition to VALIDATING from state '${current}'`,
          { sessionId: this.sessionId, taskId: this.taskId },
        ),
      );
    }
    this.state = TransferState.VALIDATING;
    return ok(true);
  }

  public transitionToComplete(): Result<true, MediatorError> {
    const current = this.getState();
    if (current !== TransferState.VALIDATING) {
      return err(
        makeMediatorError(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Cannot transition to COMPLETE from state '${current}' (must be VALIDATING)`,
          { sessionId: this.sessionId, taskId: this.taskId },
        ),
      );
    }
    this.state = TransferState.COMPLETE;
    return ok(true);
  }

  public transitionToRejected(reason: string): void {
    if (!this.isTerminal()) {
      this.state = TransferState.REJECTED;
      this.failureReason = reason;
    }
  }

  public transitionToExpired(reason?: string): void {
    if (!this.isTerminal()) {
      this.state = TransferState.EXPIRED;
      this.failureReason = reason ?? 'Transfer expired';
    }
  }

  public transitionToCancelled(reason?: string): void {
    if (!this.isTerminal()) {
      this.state = TransferState.CANCELLED;
      this.failureReason = reason ?? 'Transfer cancelled';
    }
  }
}
