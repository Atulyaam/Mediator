/**
 * @mediator/browser-extension — Provider Adapter Interface (Sprint S18)
 *
 * Defines the contract that every provider implementation (Gemini, etc.)
 * must satisfy. Handles page classification, safe bounded response extraction,
 * and composer draft insertion.
 */

import { type Result, type MediatorError } from '@mediator/shared-contracts';
import { type CanonicalEnvelope } from '@mediator/protocol';
import {
  type PageClassificationResult,
  type ExtractionResult,
  type ExtractionLimits,
  type ExtractedResponse,
  type PreparedDraft,
  type DraftPreparationResult,
  type ConversationIdentity,
  type MinimalDocument,
  type MinimalElement,
} from './providerTypes.js';

export interface ProviderAdapter {
  readonly providerId: string;
  readonly name: string;

  /**
   * Identifies whether the current page URL matches the provider's scope.
   */
  isSupportedUrl(url: string): boolean;

  /**
   * Classifies current DOM state into supported/login/streaming/complete/uncertain states.
   */
  classifyPage(doc: MinimalDocument, url: string): PageClassificationResult;

  /**
   * Extracts the latest visible assistant response with bounds and code blocks.
   * Treats extracted text as untrusted.
   */
  extractResponse(doc: MinimalDocument, limits?: ExtractionLimits): ExtractionResult;

  /**
   * Locates the visible message input composer if present.
   */
  findComposer(doc: MinimalDocument): MinimalElement | null;

  /**
   * Inserts or pre-fills prepared draft for manual sending.
   * If composer cannot be safely modified, returns fallbackCopyText.
   */
  prepareDraftInComposer(doc: MinimalDocument, draft: PreparedDraft): DraftPreparationResult;

  // ─── Sprint S20 Same-Chat Adapter Methods ────────────────────────────────

  /**
   * Resolves unambiguous conversation identity from DOM attributes or URL.
   * Tracks tab, URL, conversation ID, latest message anchor, and branch selector.
   */
  getConversationIdentity?(doc: MinimalDocument, url: string, tabId?: number): ConversationIdentity | null;

  /**
   * Extracts and validates structured protocol envelope from completed assistant response.
   * Searches raw text and code blocks for delimited blocks or JSON envelopes.
   */
  extractProtocolEnvelope?(extracted: ExtractedResponse): Result<CanonicalEnvelope, MediatorError>;

  /**
   * Inserts prepared draft into composer element if supported.
   */
  insertReplyIfSupported?(doc: MinimalDocument, draft: PreparedDraft): boolean;

  /**
   * Submits prepared reply if supported (triggers submit button).
   * Note: This must only be invoked upon explicit user confirmation!
   */
  submitReplyIfSupported?(doc: MinimalDocument, draft: PreparedDraft): boolean;

  /**
   * Verifies that the submitted reply was accepted into the conversation DOM.
   * Confirms composer was cleared or user message added.
   */
  verifyReplyWasAccepted?(doc: MinimalDocument, draft: PreparedDraft): boolean;

  /**
   * Formats a prepared draft for safe manual clipboard copy when automatic submission pauses.
   */
  pauseForManualSend?(draft: PreparedDraft, reason: string): PreparedDraft;
}
