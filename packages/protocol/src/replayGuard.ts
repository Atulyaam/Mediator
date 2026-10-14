/**
 * @mediator/protocol — Replay Guard & Session Identity Tracker (S08)
 *
 * Requirements:
 * - Rejects:
 *   - Incorrect nonce or session ID (NONCE_MISMATCH, SESSION_MISMATCH)
 *   - Wrong task ID (TASK_MISMATCH)
 *   - Wrong provider or conversation identity (CONVERSATION_MISMATCH)
 *   - Unexpected message/branch identity when known (BRANCH_MISMATCH, MESSAGE_ID_MISMATCH)
 *   - Stale or unexpected round (ROUND_STALE)
 *   - Duplicate or out-of-order sequence (SEQUENCE_DUPLICATE, SEQUENCE_OUT_OF_ORDER)
 *   - Reused action IDs within their defined session scope (ACTION_ID_DUPLICATE)
 *   - Repeated packets that have already been consumed (PACKET_ALREADY_CONSUMED)
 *   - Stale base_state_hash (BASE_STATE_HASH_MISMATCH)
 *   - Identity-uncertain state due to browser prompt edits, branch switches, or regeneration (IDENTITY_UNCERTAIN)
 * - Guarantees that validation failures do NOT advance state.
 * - Nonce comparison is timing-safe and never leaks into error messages.
 */

import { createHash } from 'crypto';
import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
} from '@mediator/shared-contracts';
import { timingSafeEqualNonce } from './cryptoNonce.js';
import { type CanonicalEnvelope, normalizeSha256 } from './envelopeTypes.js';

export interface ActiveSessionContext {
  readonly taskId: string;
  readonly sessionId: string;
  readonly authoritativeNonce: string;
  readonly providerId: string;
  readonly conversationId: string;
  readonly branchId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly expectedRound: number;
  readonly expectedSequence: number;
  readonly expectedBaseStateHash: string;
}

export class ReplayGuard {
  private activeContext: ActiveSessionContext | null = null;
  private readonly consumedActionIds = new Set<string>();
  private readonly consumedPacketHashes = new Set<string>();
  private isPaused = false;
  private isIdentityUncertain = false;
  private uncertaintyReason: string | null = null;

  /**
   * Attach or rebind an authoritative local session.
   */
  public attachSession(context: ActiveSessionContext): void {
    this.activeContext = {
      ...context,
      expectedBaseStateHash: normalizeSha256(context.expectedBaseStateHash),
    };
    this.isPaused = false;
    this.isIdentityUncertain = false;
    this.uncertaintyReason = null;
    this.consumedActionIds.clear();
    this.consumedPacketHashes.clear();
  }

  /**
   * Current active context snapshot (without raw nonce exposed directly).
   */
  public getSessionSnapshot(): Omit<ActiveSessionContext, 'authoritativeNonce'> | null {
    if (!this.activeContext) return null;
    return {
      taskId: this.activeContext.taskId,
      sessionId: this.activeContext.sessionId,
      providerId: this.activeContext.providerId,
      conversationId: this.activeContext.conversationId,
      branchId: this.activeContext.branchId,
      messageId: this.activeContext.messageId,
      expectedRound: this.activeContext.expectedRound,
      expectedSequence: this.activeContext.expectedSequence,
      expectedBaseStateHash: this.activeContext.expectedBaseStateHash,
    };
  }

  public isAttached(): boolean {
    return this.activeContext !== null;
  }

  public isSessionPaused(): boolean {
    return this.isPaused;
  }

  public isSessionIdentityUncertain(): boolean {
    return this.isIdentityUncertain;
  }

  public getUncertaintyReason(): string | null {
    return this.uncertaintyReason;
  }

  /**
   * Update the expected base state hash after an authoritative local state change.
   */
  public updateExpectedBaseStateHash(newHash: string): void {
    if (this.activeContext) {
      this.activeContext = {
        ...this.activeContext,
        expectedBaseStateHash: normalizeSha256(newHash),
      };
    }
  }

  /**
   * Advance the expected round explicitly.
   */
  public advanceExpectedRound(newRound: number): void {
    if (this.activeContext && newRound > this.activeContext.expectedRound) {
      this.activeContext = {
        ...this.activeContext,
        expectedRound: newRound,
        expectedSequence: 0,
      };
    }
  }

  // ─── Browser Edits & Uncertain Identity ──────────────────────────────────

  /**
   * User edited an earlier prompt in the browser.
   */
  public recordUserPromptEdit(reason = 'User edited prompt in browser'): void {
    this.isPaused = true;
    this.isIdentityUncertain = true;
    this.uncertaintyReason = reason;
  }

  /**
   * User switched conversation in the browser.
   */
  public recordConversationSwitch(newConversationId: string): void {
    this.isPaused = true;
    this.isIdentityUncertain = true;
    this.uncertaintyReason = `Switched to conversation '${newConversationId}'`;
  }

  /**
   * User regenerated an AI answer in the browser.
   */
  public recordRegenerate(reason = 'AI answer regenerated in browser'): void {
    this.isPaused = true;
    this.isIdentityUncertain = true;
    this.uncertaintyReason = reason;
  }

  /**
   * User changed branch in the browser.
   */
  public recordBranchSwitch(newBranchId: string): void {
    this.isPaused = true;
    this.isIdentityUncertain = true;
    this.uncertaintyReason = `Switched to branch '${newBranchId}'`;
  }

  /**
   * Reconcile identity after user reattachment/confirmation.
   */
  public reconcileIdentity(confirmedContext: ActiveSessionContext): void {
    this.attachSession(confirmedContext);
  }

  /**
   * Invalidate the current session (e.g. upon unrecoverable disconnect or restart).
   */
  public invalidateSession(reason = 'Session invalidated'): void {
    this.activeContext = null;
    this.isPaused = true;
    this.isIdentityUncertain = true;
    this.uncertaintyReason = reason;
    this.consumedActionIds.clear();
    this.consumedPacketHashes.clear();
  }

  // ─── Validation & State Advancement ──────────────────────────────────────

  /**
   * Compute a deterministic hash of the envelope content to guard against packet replay.
   */
  public computePacketHash(envelope: CanonicalEnvelope): string {
    const raw = `${envelope.taskId}:${envelope.sessionId}:${envelope.round}:${envelope.sequence}:${envelope.baseStateHash}:${JSON.stringify(envelope.actions)}`;
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  /**
   * Pure validation of incoming envelope against the active session state.
   * Performs NO state mutation.
   */
  public validateEnvelope(envelope: CanonicalEnvelope): Result<true, MediatorError> {
    if (!this.activeContext) {
      return err(
        makeMediatorError(
          ErrorCode.SESSION_MISMATCH,
          'No active session attached. Attachment and priming required before processing envelopes.',
        ),
      );
    }

    if (this.isIdentityUncertain || this.isPaused) {
      return err(
        makeMediatorError(
          ErrorCode.IDENTITY_UNCERTAIN,
          `Session is identity-uncertain or paused (${this.uncertaintyReason ?? 'manual pause'}). Reattachment required.`,
        ),
      );
    }

    // 1. Task ID check
    if (envelope.taskId !== this.activeContext.taskId) {
      return err(
        makeMediatorError(
          ErrorCode.TASK_MISMATCH,
          `Task ID mismatch: expected '${this.activeContext.taskId}', received '${envelope.taskId}'`,
        ),
      );
    }

    // 2. Session ID check
    if (envelope.sessionId !== this.activeContext.sessionId) {
      return err(
        makeMediatorError(
          ErrorCode.SESSION_MISMATCH,
          `Session ID mismatch: expected '${this.activeContext.sessionId}', received '${envelope.sessionId}'`,
        ),
      );
    }

    // 3. Provider ID check
    if (envelope.providerId !== this.activeContext.providerId) {
      return err(
        makeMediatorError(
          ErrorCode.CONVERSATION_MISMATCH,
          `Provider mismatch: expected '${this.activeContext.providerId}', received '${envelope.providerId}'`,
        ),
      );
    }

    // 4. Conversation ID check
    if (envelope.conversationId !== this.activeContext.conversationId) {
      return err(
        makeMediatorError(
          ErrorCode.CONVERSATION_MISMATCH,
          `Conversation ID mismatch: expected '${this.activeContext.conversationId}', received '${envelope.conversationId}'`,
        ),
      );
    }

    // 5. Branch ID check (if expected)
    if (
      this.activeContext.branchId &&
      envelope.messageOrBranchId &&
      this.activeContext.branchId !== envelope.messageOrBranchId
    ) {
      return err(
        makeMediatorError(
          ErrorCode.BRANCH_MISMATCH,
          `Branch/Message mismatch: expected '${this.activeContext.branchId}', received '${envelope.messageOrBranchId}'`,
        ),
      );
    }

    // 6. Cryptographic Nonce check (constant-time, no nonce leakage in message)
    if (!timingSafeEqualNonce(this.activeContext.authoritativeNonce, envelope.nonce)) {
      return err(
        makeMediatorError(
          ErrorCode.NONCE_MISMATCH,
          'Nonce mismatch: candidate nonce does not match authoritative session nonce.',
        ),
      );
    }

    // 7. Base State Hash check
    if (normalizeSha256(envelope.baseStateHash) !== normalizeSha256(this.activeContext.expectedBaseStateHash)) {
      return err(
        makeMediatorError(
          ErrorCode.BASE_STATE_HASH_MISMATCH,
          `Stale or mismatched base_state_hash: expected '${this.activeContext.expectedBaseStateHash}', received '${envelope.baseStateHash}'`,
        ),
      );
    }

    // 8. Round check
    if (envelope.round < this.activeContext.expectedRound) {
      return err(
        makeMediatorError(
          ErrorCode.ROUND_STALE,
          `Stale round ${envelope.round}. Expected at least ${this.activeContext.expectedRound}.`,
        ),
      );
    }

    // 9. Sequence check
    if (envelope.sequence < this.activeContext.expectedSequence) {
      return err(
        makeMediatorError(
          ErrorCode.SEQUENCE_DUPLICATE,
          `Duplicate sequence ${envelope.sequence}. Expected ${this.activeContext.expectedSequence}.`,
        ),
      );
    }
    if (envelope.sequence > this.activeContext.expectedSequence) {
      return err(
        makeMediatorError(
          ErrorCode.SEQUENCE_OUT_OF_ORDER,
          `Out-of-order sequence ${envelope.sequence}. Expected ${this.activeContext.expectedSequence}.`,
        ),
      );
    }

    // 10. Packet replay check
    const packetHash = this.computePacketHash(envelope);
    if (this.consumedPacketHashes.has(packetHash)) {
      return err(
        makeMediatorError(
          ErrorCode.PACKET_ALREADY_CONSUMED,
          'Envelope packet has already been consumed.',
        ),
      );
    }

    // 11. Action ID uniqueness check
    const seenInThisEnvelope = new Set<string>();
    for (const action of envelope.actions) {
      if (seenInThisEnvelope.has(action.id)) {
        return err(
          makeMediatorError(
            ErrorCode.ACTION_ID_DUPLICATE,
            `Duplicate action ID '${action.id}' detected within the same envelope.`,
          ),
        );
      }
      seenInThisEnvelope.add(action.id);

      if (this.consumedActionIds.has(action.id)) {
        return err(
          makeMediatorError(
            ErrorCode.ACTION_ID_DUPLICATE,
            `Action ID '${action.id}' has already been consumed in this session.`,
          ),
        );
      }
    }

    return ok(true);
  }

  /**
   * Commit envelope consumption: advances sequence, updates round, and consumes action IDs.
   * MUST only be called after validateEnvelope succeeds.
   */
  public consumeEnvelope(envelope: CanonicalEnvelope): void {
    if (!this.activeContext) return;

    // Advance sequence number
    const nextSequence = envelope.sequence + 1;
    const nextRound = Math.max(this.activeContext.expectedRound, envelope.round);

    this.activeContext = {
      ...this.activeContext,
      expectedRound: nextRound,
      expectedSequence: nextSequence,
    };

    // Consume packet hash
    const packetHash = this.computePacketHash(envelope);
    this.consumedPacketHashes.add(packetHash);

    // Consume all action IDs
    for (const action of envelope.actions) {
      this.consumedActionIds.add(action.id);
    }
  }

  /**
   * Atomic validate-and-consume:
   * Validates the envelope, and if and ONLY if valid, advances the state.
   * If validation fails, zero state mutation occurs.
   */
  public validateAndConsume(envelope: CanonicalEnvelope): Result<CanonicalEnvelope, MediatorError> {
    const check = this.validateEnvelope(envelope);
    if (!check.ok) {
      return err(check.error);
    }

    this.consumeEnvelope(envelope);
    return ok(envelope);
  }

  /**
   * Seed previously consumed action IDs and packet hashes (e.g. upon persistent crash recovery).
   */
  public seedConsumedState(actionIds: Iterable<string>, packetHashes?: Iterable<string>): void {
    for (const id of actionIds) {
      this.consumedActionIds.add(id);
    }
    if (packetHashes) {
      for (const h of packetHashes) {
        this.consumedPacketHashes.add(h);
      }
    }
  }
}
