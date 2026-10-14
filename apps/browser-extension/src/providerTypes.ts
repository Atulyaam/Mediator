/**
 * @mediator/browser-extension — Provider Types & Message Contracts (Sprint S18)
 *
 * Defines provider adapter interfaces, page states, extraction limits,
 * prepared draft workflows, and explicit attach/detach lifecycle states.
 *
 * Security:
 * - Browser AI is an untrusted data source.
 * - No credentials, cookies, tokens, or native shell commands.
 * - Bounded extractions with strict length limits.
 */

export type PageState =
  | 'unsupported-page'
  | 'login-or-auth-required'
  | 'loading'
  | 'response-streaming'
  | 'response-complete'
  | 'conversation-identity-uncertain'
  | 'page-structure-unknown'
  | 'branch-switched'
  | 'regeneration-detected'
  | 'message-edited'
  | 'provider-error';

export interface ExtractionLimits {
  readonly maxChars?: number;
  readonly maxCodeBlocks?: number;
}

export const DEFAULT_EXTRACTION_LIMITS: Required<ExtractionLimits> = {
  maxChars: 16384, // 16 KB
  maxCodeBlocks: 10,
};

export const MAX_PREPARED_DRAFT_BYTES = 8192; // 8 KB

export interface ExtractedCodeBlock {
  readonly language?: string | undefined;
  readonly code: string;
}

export interface ExtractedResponse {
  readonly rawText: string;
  readonly codeBlocks: readonly ExtractedCodeBlock[];
  readonly isComplete: boolean;
  readonly characterCount: number;
  readonly isTruncated: boolean;
  readonly extractedAt: number;
}

export interface ExtractionResult {
  readonly ok: boolean;
  readonly response?: ExtractedResponse | undefined;
  readonly error?: string | undefined;
  readonly errorCode?: string | undefined;
}

export interface PageClassificationResult {
  readonly state: PageState;
  readonly providerId?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly reason?: string | undefined;
  readonly canExtract: boolean;
}

export interface PreparedDraft {
  readonly draftId: string;
  readonly text: string;
  readonly targetConversationId?: string | undefined;
  readonly createdAt: number;
  readonly byteLength: number;
}

export type DraftStatus =
  | 'ready-for-review'
  | 'inserted-in-composer'
  | 'manual-copy-required'
  | 'composer-not-found'
  | 'rejected-oversized'
  | 'rejected-uncertain-state';

export interface DraftPreparationResult {
  readonly ok: boolean;
  readonly status: DraftStatus;
  readonly draft?: PreparedDraft | undefined;
  readonly fallbackCopyText?: string | undefined;
  readonly reason?: string | undefined;
}

export type AttachStatus = 'detached' | 'attached' | 'paused' | 'error';

export interface AttachState {
  readonly status: AttachStatus;
  readonly providerId: string | null;
  readonly tabId: number | null;
  readonly url: string | null;
  readonly conversationId: string | null;
  readonly pageState: PageState;
  readonly lastExtractedAt: number | null;
  readonly lastResponseSummary: string | null;
  readonly activeDraft: PreparedDraft | null;
  readonly isCoreConnected: boolean;
  readonly statusMessage: string;
  readonly safePauseReason?: string | undefined;
  readonly latestMessageId?: string | null | undefined;
  readonly branchId?: string | null | undefined;
}

// ─── Sprint S20 Same-Chat Adapter Contracts ────────────────────────────────

export interface ConversationIdentity {
  readonly providerId: string;
  readonly tabId: number;
  readonly url: string;
  readonly conversationId: string;
  readonly messageId?: string | undefined;
  readonly branchId?: string | undefined;
}

export type SubmissionObservationState =
  | 'idle'
  | 'draft-prepared'
  | 'awaiting-user-confirmation'
  | 'submitting'
  | 'submission-observed'
  | 'response-pending'
  | 'response-complete'
  | 'submission-uncertain'
  | 'paused'
  | 'failed';

export type ConformanceStatus =
  | 'untested'
  | 'conformance-verified'
  | 'conformance-failed';

export type SameChatStatus =
  | 'detached'
  | 'attached'
  | 'paused'
  | 'submitting'
  | 'observing'
  | 'error';

export type SameChatPauseReason =
  | 'tab-switched'
  | 'conversation-changed'
  | 'branch-switched'
  | 'message-edited'
  | 'regeneration-detected'
  | 'auth-required'
  | 'page-structure-unknown'
  | 'response-streaming'
  | 'submission-uncertain'
  | 'duplicate-submission-prevented'
  | 'oversized-draft'
  | 'empty-draft'
  | 'unsupported-page'
  | 'user-paused'
  | 'conformance-failed';

export interface SubmissionResult {
  readonly ok: boolean;
  readonly state: SubmissionObservationState;
  readonly draftId?: string | undefined;
  readonly fallbackCopyText?: string | undefined;
  readonly reason?: string | undefined;
  readonly errorCode?: string | undefined;
}

export interface PrimingConfig {
  readonly taskId: string;
  readonly sessionId: string;
  readonly sessionNonce: string;
  readonly providerId: string;
  readonly conversationId: string;
  readonly tabId: number;
  readonly baseStateHash: string;
  readonly round?: number | undefined;
  readonly sequence?: number | undefined;
}

export interface SameChatState {
  readonly status: SameChatStatus;
  readonly observationState: SubmissionObservationState;
  readonly conformanceStatus: ConformanceStatus;
  readonly conversationIdentity: ConversationIdentity | null;
  readonly activeNonce: string | null;
  readonly lastObservedResponse: ExtractedResponse | null;
  readonly lastExtractedEnvelope: unknown;
  readonly activeDraft: PreparedDraft | null;
  readonly pauseReason?: SameChatPauseReason | undefined;
  readonly statusMessage: string;
}

// ─── Minimal DOM Abstraction (works in Browser DOM and Unit Test Doubles) ────

export interface MinimalElement {
  readonly tagName: string;
  readonly textContent: string | null;
  readonly innerHTML?: string | undefined;
  value?: string;
  onclick?: (() => void) | undefined;
  click?(): void;
  getAttribute(name: string): string | null;
  querySelector(selector: string): MinimalElement | null;
  querySelectorAll(selector: string): MinimalElement[];
}

export interface MinimalDocument {
  readonly location?: { href: string } | undefined;
  querySelector(selector: string): MinimalElement | null;
  querySelectorAll(selector: string): MinimalElement[];
}
