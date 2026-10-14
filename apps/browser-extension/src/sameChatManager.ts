/**
 * @mediator/browser-extension — First Provider Same-Chat Manager (Sprint S20)
 *
 * Implements authoritative same-chat continuity for Google Gemini:
 * - Tracks provider, tab, conversation ID/URL, latest message and branch identity.
 * - Extracts and parses protocol envelope bound to the session nonce.
 * - Priming message generation and ping/pong conformance testing.
 * - Draft preparation with explicit user confirmation before submission (no auto-send).
 * - Submission observation and duplicate submission prevention.
 * - Safe pause on: tab switch, conversation change, branch switch, edits,
 *   regeneration, auth/login wall, DOM drift, or uncertain identity.
 * - Never silently creates a new chat or sends to a different conversation.
 */

import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
  PROTOCOL_VERSION,
} from '@mediator/shared-contracts';
import {
  generateCryptoNonce,
  timingSafeEqualNonce,
  type CanonicalEnvelope,
} from '@mediator/protocol';
import {
  type ProviderAdapter,
} from './providerAdapter.js';
import {
  type SameChatState,
  type SameChatStatus,
  type SubmissionObservationState,
  type ConformanceStatus,
  type SameChatPauseReason,
  type ConversationIdentity,
  type PreparedDraft,
  type SubmissionResult,
  type ExtractedResponse,
  type MinimalDocument,
  MAX_PREPARED_DRAFT_BYTES,
} from './providerTypes.js';

export interface SameChatManagerOptions {
  readonly taskId: string;
  readonly sessionId: string;
  readonly sessionNonce?: string | undefined;
  readonly baseStateHash?: string | undefined;
}

export class SameChatManager {
  private attachedTabId: number | null = null;
  private attachedUrl: string | null = null;
  private attachedConversationId: string | null = null;
  private latestMessageId: string | null = null;
  private latestBranchId: string | null = null;

  private readonly taskId: string;
  private readonly sessionId: string;
  private readonly sessionNonce: string;
  private baseStateHash: string;
  private round: number = 1;
  private sequence: number = 1;

  private status: SameChatStatus = 'detached';
  private observationState: SubmissionObservationState = 'idle';
  private conformanceStatus: ConformanceStatus = 'untested';
  private pauseReason?: SameChatPauseReason | undefined;
  private pauseDetails?: string | undefined;

  private activeDraft: PreparedDraft | null = null;
  private lastSubmittedDraftId: string | null = null;
  private lastObservedResponse: ExtractedResponse | null = null;
  private lastExtractedEnvelope: CanonicalEnvelope | null = null;

  constructor(
    private readonly providerAdapter: ProviderAdapter,
    options: SameChatManagerOptions,
  ) {
    this.taskId = options.taskId;
    this.sessionId = options.sessionId;
    this.sessionNonce = options.sessionNonce ?? generateCryptoNonce();
    this.baseStateHash = options.baseStateHash ?? 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  }

  public getState(): SameChatState {
    const conversationIdentity: ConversationIdentity | null =
      this.attachedTabId !== null && this.attachedUrl !== null && this.attachedConversationId !== null
        ? {
            providerId: this.providerAdapter.providerId,
            tabId: this.attachedTabId,
            url: this.attachedUrl,
            conversationId: this.attachedConversationId,
            messageId: this.latestMessageId ?? undefined,
            branchId: this.latestBranchId ?? undefined,
          }
        : null;

    let statusMessage = `Status: ${this.status} (${this.observationState})`;
    if (this.pauseReason) {
      statusMessage = `Safely paused: ${this.pauseReason}${this.pauseDetails ? ` (${this.pauseDetails})` : ''}`;
    }

    return {
      status: this.status,
      observationState: this.observationState,
      conformanceStatus: this.conformanceStatus,
      conversationIdentity,
      activeNonce: this.sessionNonce,
      lastObservedResponse: this.lastObservedResponse,
      lastExtractedEnvelope: this.lastExtractedEnvelope,
      activeDraft: this.activeDraft,
      pauseReason: this.pauseReason,
      statusMessage,
    };
  }

  public getSessionNonce(): string {
    return this.sessionNonce;
  }

  public getTaskId(): string {
    return this.taskId;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getRound(): number {
    return this.round;
  }

  public getSequence(): number {
    return this.sequence;
  }

  public advanceRound(): void {
    this.round++;
    this.sequence = 1;
  }

  public setBaseStateHash(hash: string): void {
    this.baseStateHash = hash;
  }

  // ─── Attach / Detach Lifecycle ───────────────────────────────────────────

  public attach(tabId: number, url: string, doc: MinimalDocument): SameChatState {
    if (!this.providerAdapter.isSupportedUrl(url)) {
      this.status = 'error';
      this.observationState = 'failed';
      this.pauseReason = 'unsupported-page';
      this.pauseDetails = `URL "${url}" is not supported by ${this.providerAdapter.name}`;
      return this.getState();
    }

    const classification = this.providerAdapter.classifyPage(doc, url);

    if (classification.state === 'login-or-auth-required') {
      this.pause('auth-required', 'Authentication or login required on provider page');
      return this.getState();
    }

    if (classification.state === 'page-structure-unknown') {
      this.pause('page-structure-unknown', classification.reason ?? 'DOM structure unknown');
      return this.getState();
    }

    const identity = this.providerAdapter.getConversationIdentity?.(doc, url, tabId);
    const convId = identity?.conversationId ?? classification.conversationId;

    if (!convId) {
      this.pause('page-structure-unknown', 'Cannot extract unambiguous conversation identity from page');
      return this.getState();
    }

    this.attachedTabId = tabId;
    this.attachedUrl = url;
    this.attachedConversationId = convId;
    this.latestMessageId = identity?.messageId ?? null;
    this.latestBranchId = identity?.branchId ?? null;

    this.status = 'attached';
    this.pauseReason = undefined;
    this.pauseDetails = undefined;

    if (classification.state === 'response-streaming') {
      this.observationState = 'response-pending';
    } else {
      this.observationState = 'idle';
    }

    return this.getState();
  }

  public detach(): SameChatState {
    this.status = 'detached';
    this.observationState = 'idle';
    this.attachedTabId = null;
    this.attachedUrl = null;
    this.attachedConversationId = null;
    this.latestMessageId = null;
    this.latestBranchId = null;
    this.activeDraft = null;
    this.pauseReason = undefined;
    this.pauseDetails = undefined;
    return this.getState();
  }

  // ─── Continuous Same-Chat Continuity Guard ───────────────────────────────

  public checkContinuity(
    tabId: number,
    url: string,
    doc: MinimalDocument,
  ): { ok: boolean; reason?: SameChatPauseReason } {
    if (this.status !== 'attached' && this.status !== 'observing' && this.status !== 'submitting') {
      return { ok: false, reason: this.pauseReason ?? 'user-paused' };
    }

    // 1. Tab Switch Guard
    if (this.attachedTabId !== null && tabId !== this.attachedTabId) {
      this.pause('tab-switched', `Active tab changed from ${this.attachedTabId} to ${tabId}`);
      return { ok: false, reason: 'tab-switched' };
    }

    // 2. Conversation Navigation Guard
    const identity = this.providerAdapter.getConversationIdentity?.(doc, url, tabId);
    const currentConvId = identity?.conversationId ?? null;

    if (
      this.attachedConversationId !== null &&
      currentConvId !== null &&
      currentConvId !== this.attachedConversationId
    ) {
      this.pause(
        'conversation-changed',
        `Navigated away from original conversation "${this.attachedConversationId}" to "${currentConvId}"`,
      );
      return { ok: false, reason: 'conversation-changed' };
    }

    // 3. Page Classification Checks
    const classification = this.providerAdapter.classifyPage(doc, url);

    if (classification.state === 'login-or-auth-required') {
      this.pause('auth-required', 'Auth wall detected');
      return { ok: false, reason: 'auth-required' };
    }

    if (classification.state === 'branch-switched') {
      this.pause('branch-switched', 'Conversation branch diverged');
      return { ok: false, reason: 'branch-switched' };
    }

    if (classification.state === 'regeneration-detected') {
      this.pause('regeneration-detected', 'Assistant response regenerated');
      return { ok: false, reason: 'regeneration-detected' };
    }

    if (classification.state === 'message-edited') {
      this.pause('message-edited', 'Message edit detected in conversation');
      return { ok: false, reason: 'message-edited' };
    }

    if (classification.state === 'page-structure-unknown') {
      this.pause('page-structure-unknown', 'Page DOM structure diverged from tested selectors');
      return { ok: false, reason: 'page-structure-unknown' };
    }

    // 4. Branch identity change check
    if (
      this.latestBranchId !== null &&
      identity?.branchId !== undefined &&
      identity.branchId !== this.latestBranchId
    ) {
      this.pause('branch-switched', `Branch ID changed from ${this.latestBranchId} to ${identity.branchId}`);
      return { ok: false, reason: 'branch-switched' };
    }

    // Update message / branch pointers
    if (identity?.messageId) this.latestMessageId = identity.messageId;
    if (identity?.branchId) this.latestBranchId = identity.branchId;

    return { ok: true };
  }

  // ─── Priming & Conformance Testing ───────────────────────────────────────

  public generatePrimingMessage(): PreparedDraft {
    const convId = this.attachedConversationId ?? 'unknown-conversation';
    const tabId = this.attachedTabId ?? 1;

    const primingText = [
      `<<<MEDIATOR_PRIMING>>>`,
      `Mediator Protocol v${PROTOCOL_VERSION} Session Priming`,
      `Task ID: ${this.taskId}`,
      `Session ID: ${this.sessionId}`,
      `Session Nonce: ${this.sessionNonce}`,
      `Expected Status Values: continue | await_user | proposed_complete`,
      `Canonical Actions: list_files, read_file, search_text, get_diagnostics, get_diff, request_more_context, propose_patch, request_recipe_run, request_dependency_change, request_network_access, request_delete, request_rename, ask_user, report_progress`,
      ``,
      `[MANDATORY CONFORMANCE HANDSHAKE]`,
      `Before proposing workspace actions, verify protocol conformance in your first response by wrapping your envelope in <<<MEDIATOR_PLAN>>> tags:`,
      `<<<MEDIATOR_PLAN>>>`,
      JSON.stringify(
        {
          protocol_version: PROTOCOL_VERSION,
          task_id: this.taskId,
          session_id: this.sessionId,
          nonce: this.sessionNonce,
          round: 1,
          sequence: 1,
          conversation: {
            provider: this.providerAdapter.providerId,
            conversation_id: convId,
            tab_id: tabId,
          },
          base_state_hash: this.baseStateHash,
          status: 'continue',
          actions: [
            {
              id: 'act_ping_1',
              type: 'get_task_brief',
              parameters: {},
            },
          ],
          content_blocks: [],
        },
        null,
        2,
      ),
      `<<<END_MEDIATOR_PLAN>>>`,
    ].join('\n');

    const draftId = `draft_priming_${Date.now().toString(36)}`;
    const draft: PreparedDraft = {
      draftId,
      text: primingText,
      targetConversationId: this.attachedConversationId ?? undefined,
      createdAt: Date.now(),
      byteLength: new TextEncoder().encode(primingText).length,
    };

    this.activeDraft = draft;
    this.observationState = 'draft-prepared';
    return draft;
  }

  public verifyPrimingConformance(envelope: CanonicalEnvelope): Result<boolean, MediatorError> {
    if (envelope.protocolVersion !== PROTOCOL_VERSION) {
      this.conformanceStatus = 'conformance-failed';
      this.pause('conformance-failed', `Mismatched protocol version: ${envelope.protocolVersion}`);
      return err(
        makeMediatorError(
          ErrorCode.PROTOCOL_VERSION_UNSUPPORTED,
          `Envelope protocol version "${envelope.protocolVersion}" does not match authoritative version "${PROTOCOL_VERSION}"`,
        ),
      );
    }

    if (envelope.taskId !== this.taskId) {
      this.conformanceStatus = 'conformance-failed';
      this.pause('conformance-failed', `Mismatched task ID: ${envelope.taskId}`);
      return err(
        makeMediatorError(
          ErrorCode.TASK_MISMATCH,
          `Envelope task ID "${envelope.taskId}" does not match active task "${this.taskId}"`,
        ),
      );
    }

    if (envelope.sessionId !== this.sessionId) {
      this.conformanceStatus = 'conformance-failed';
      this.pause('conformance-failed', `Mismatched session ID: ${envelope.sessionId}`);
      return err(
        makeMediatorError(
          ErrorCode.SESSION_MISMATCH,
          `Envelope session ID "${envelope.sessionId}" does not match active session "${this.sessionId}"`,
        ),
      );
    }

    // Constant-time nonce comparison
    if (!timingSafeEqualNonce(this.sessionNonce, envelope.nonce)) {
      this.conformanceStatus = 'conformance-failed';
      this.pause('conformance-failed', 'Nonce does not match authoritative session nonce');
      return err(
        makeMediatorError(
          ErrorCode.NONCE_MISMATCH,
          'Envelope nonce is invalid or mismatched',
        ),
      );
    }

    if (this.attachedConversationId && envelope.conversationId !== this.attachedConversationId) {
      this.conformanceStatus = 'conformance-failed';
      this.pause('conversation-changed', `Conversation ID mismatch: ${envelope.conversationId}`);
      return err(
        makeMediatorError(
          ErrorCode.CONVERSATION_MISMATCH,
          `Envelope conversation ID "${envelope.conversationId}" does not match attached conversation "${this.attachedConversationId}"`,
        ),
      );
    }

    this.conformanceStatus = 'conformance-verified';
    this.lastExtractedEnvelope = envelope;
    return ok(true);
  }

  // ─── Extract Completed Response ──────────────────────────────────────────

  public extractCompletedResponse(doc: MinimalDocument): Result<CanonicalEnvelope, MediatorError> {
    if (!this.attachedUrl || this.attachedTabId === null) {
      return err(
        makeMediatorError(
          ErrorCode.IPC_OPERATION_PROHIBITED,
          'Cannot extract response when extension is detached',
        ),
      );
    }

    const continuity = this.checkContinuity(this.attachedTabId, this.attachedUrl, doc);
    if (!continuity.ok) {
      return err(
        makeMediatorError(
          ErrorCode.IPC_OPERATION_PROHIBITED,
          `Continuity check failed: ${continuity.reason}`,
        ),
      );
    }

    const classification = this.providerAdapter.classifyPage(doc, this.attachedUrl);
    if (classification.state === 'response-streaming') {
      this.observationState = 'response-pending';
      return err(
        makeMediatorError(
          ErrorCode.RESPONSE_STREAMING,
          'Assistant response is actively streaming; incomplete text cannot be extracted',
        ),
      );
    }

    if (classification.state !== 'response-complete') {
      return err(
        makeMediatorError(
          ErrorCode.PAGE_STRUCTURE_UNKNOWN,
          `Assistant response is not complete (current state: ${classification.state})`,
        ),
      );
    }

    const extraction = this.providerAdapter.extractResponse(doc);
    if (!extraction.ok || !extraction.response) {
      return err(
        makeMediatorError(
          ErrorCode.SCHEMA_INVALID,
          extraction.error ?? 'Failed to extract assistant response from DOM',
        ),
      );
    }

    this.lastObservedResponse = extraction.response;

    if (!this.providerAdapter.extractProtocolEnvelope) {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_PAGE_UNSUPPORTED,
          'Provider adapter does not support extractProtocolEnvelope',
        ),
      );
    }

    const envelopeRes = this.providerAdapter.extractProtocolEnvelope(extraction.response);
    if (!envelopeRes.ok) {
      return err(envelopeRes.error);
    }

    const envelope = envelopeRes.value;

    // Check same-chat conversation binding
    if (this.attachedConversationId && envelope.conversationId !== this.attachedConversationId) {
      this.pause(
        'conversation-changed',
        `Envelope conversation "${envelope.conversationId}" does not match attached "${this.attachedConversationId}"`,
      );
      return err(
        makeMediatorError(
          ErrorCode.CONVERSATION_MISMATCH,
          `Envelope conversation ID "${envelope.conversationId}" does not match attached conversation "${this.attachedConversationId}"`,
        ),
      );
    }

    // Check nonce match
    if (!timingSafeEqualNonce(this.sessionNonce, envelope.nonce)) {
      this.pause('conformance-failed', 'Received envelope with mismatched session nonce');
      return err(
        makeMediatorError(
          ErrorCode.NONCE_MISMATCH,
          'Envelope nonce does not match authoritative active session nonce',
        ),
      );
    }

    this.lastExtractedEnvelope = envelope;
    this.observationState = 'response-complete';
    return ok(envelope);
  }

  // ─── Safe Draft Preparation & Explicit User-Confirmed Submission ─────────

  public prepareReplyDraft(text: string): Result<PreparedDraft, MediatorError> {
    if (this.status !== 'attached' && this.status !== 'observing') {
      return err(
        makeMediatorError(
          ErrorCode.IPC_OPERATION_PROHIBITED,
          `Cannot prepare reply draft when extension status is "${this.status}"`,
        ),
      );
    }

    const byteLength = new TextEncoder().encode(text).length;
    if (byteLength > MAX_PREPARED_DRAFT_BYTES) {
      this.pause('oversized-draft', `Draft size ${byteLength} exceeds limit of ${MAX_PREPARED_DRAFT_BYTES} bytes`);
      return err(
        makeMediatorError(
          ErrorCode.OVERSIZED_INPUT,
          `Prepared draft exceeds limit of ${MAX_PREPARED_DRAFT_BYTES} bytes (actual: ${byteLength} bytes)`,
        ),
      );
    }

    if (text.trim().length === 0) {
      this.pause('empty-draft', 'Prepared draft text is empty');
      return err(
        makeMediatorError(
          ErrorCode.SCHEMA_INVALID,
          'Prepared draft text cannot be empty',
        ),
      );
    }

    const draftId = `draft_${Math.random().toString(36).slice(2, 10)}`;
    const draft: PreparedDraft = {
      draftId,
      text,
      targetConversationId: this.attachedConversationId ?? undefined,
      createdAt: Date.now(),
      byteLength,
    };

    this.activeDraft = draft;
    // Explicit user confirmation gate: NEVER automatically submitted!
    this.observationState = 'awaiting-user-confirmation';
    return ok(draft);
  }

  public confirmAndSubmit(doc: MinimalDocument): SubmissionResult {
    if (!this.activeDraft) {
      return {
        ok: false,
        state: 'failed',
        errorCode: 'SCHEMA_INVALID',
        reason: 'No prepared draft is waiting for user confirmation',
      };
    }

    const draft = this.activeDraft;

    // 1. Duplicate Submission Prevention Guard
    if (this.lastSubmittedDraftId && this.lastSubmittedDraftId === draft.draftId) {
      this.pause('duplicate-submission-prevented', `Draft "${draft.draftId}" has already been submitted`);
      return {
        ok: false,
        state: 'failed',
        errorCode: 'SUBMISSION_DUPLICATE',
        reason: `Draft "${draft.draftId}" was already submitted. Preventing duplicate submission.`,
        fallbackCopyText: draft.text,
      };
    }

    // 2. Continuity check
    if (this.attachedTabId !== null && this.attachedUrl !== null) {
      const continuity = this.checkContinuity(this.attachedTabId, this.attachedUrl, doc);
      if (!continuity.ok) {
        return {
          ok: false,
          state: 'paused',
          reason: `Continuity check failed prior to submission: ${continuity.reason}`,
          fallbackCopyText: draft.text,
        };
      }
    }

    // 3. Insert into composer
    if (this.providerAdapter.insertReplyIfSupported) {
      this.providerAdapter.insertReplyIfSupported(doc, draft);
    }

    // 4. Trigger submit button
    this.observationState = 'submitting';

    const submitTriggered = this.providerAdapter.submitReplyIfSupported
      ? this.providerAdapter.submitReplyIfSupported(doc, draft)
      : false;

    if (!submitTriggered) {
      this.observationState = 'submission-uncertain';
      this.pause('submission-uncertain', 'Composer submit button could not be triggered automatically');
      return {
        ok: false,
        state: 'submission-uncertain',
        draftId: draft.draftId,
        fallbackCopyText: draft.text,
        reason: 'Submit button could not be triggered. Please send manually using fallback copy text.',
      };
    }

    // 5. Submission Observation
    const accepted = this.providerAdapter.verifyReplyWasAccepted
      ? this.providerAdapter.verifyReplyWasAccepted(doc, draft)
      : false;

    if (!accepted) {
      this.observationState = 'submission-uncertain';
      this.pause(
        'submission-uncertain',
        'Composer text did not clear or user message was not rendered in conversation DOM',
      );
      return {
        ok: false,
        state: 'submission-uncertain',
        draftId: draft.draftId,
        fallbackCopyText: draft.text,
        errorCode: 'SUBMISSION_UNCERTAIN',
        reason: 'Submission acceptance could not be verified in the DOM. Halting loop to prevent re-submissions.',
      };
    }

    // Successfully verified accepted into the same conversation
    this.observationState = 'submission-observed';
    this.lastSubmittedDraftId = draft.draftId;
    this.activeDraft = null;
    this.sequence++;
    this.observationState = 'response-pending';

    return {
      ok: true,
      state: 'submission-observed',
      draftId: draft.draftId,
    };
  }

  // ─── Safe Pause & Resume ─────────────────────────────────────────────────

  public pause(reason: SameChatPauseReason, details?: string): SameChatState {
    this.status = 'paused';
    this.observationState = 'paused';
    this.pauseReason = reason;
    this.pauseDetails = details;
    return this.getState();
  }

  public resume(): SameChatState {
    if (this.status === 'paused') {
      this.status = 'attached';
      this.observationState = 'idle';
      this.pauseReason = undefined;
      this.pauseDetails = undefined;
    }
    return this.getState();
  }
}
