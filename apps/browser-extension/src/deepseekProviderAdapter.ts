/**
 * @mediator/browser-extension — DeepSeek Provider Adapter (Sprint S31–S34)
 *
 * Implements the ProviderAdapter interface for DeepSeek (`chat.deepseek.com`):
 * - Validates official DeepSeek origin (https://chat.deepseek.com).
 * - Extracts conversation identity from canonical path `/a/chat/s/<id>` or `/chat/<id>` or DOM.
 * - Read-only DOM observation & bounded text extraction.
 * - Same-chat draft insertion, confirmed submission, acceptance verification, and safe fallback.
 * - Extracts structured protocol envelopes (`<<<MEDIATOR_PLAN>>>` and markdown fences).
 * - Fully automated bridge without manual copy/paste.
 */

import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  err,
} from '@mediator/shared-contracts';
import {
  parseAndValidateEnvelope,
  type CanonicalEnvelope,
} from '@mediator/protocol';
import { type ProviderAdapter } from './providerAdapter.js';
import {
  type PageClassificationResult,
  type ExtractionResult,
  type ExtractionLimits,
  type ExtractedCodeBlock,
  type ExtractedResponse,
  type PreparedDraft,
  type DraftPreparationResult,
  type ConversationIdentity,
  type MinimalDocument,
  type MinimalElement,
  DEFAULT_EXTRACTION_LIMITS,
} from './providerTypes.js';

export class DeepSeekProviderAdapter implements ProviderAdapter {
  public readonly providerId = 'deepseek';
  public readonly name = 'DeepSeek';

  public isSupportedUrl(url: string): boolean {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.hostname === 'chat.deepseek.com';
    } catch {
      return false;
    }
  }

  public classifyPage(doc: MinimalDocument, url: string): PageClassificationResult {
    if (!this.isSupportedUrl(url)) {
      return {
        state: 'unsupported-page',
        providerId: this.providerId,
        canExtract: false,
        reason: 'URL is not on chat.deepseek.com',
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        state: 'unsupported-page',
        providerId: this.providerId,
        canExtract: false,
        reason: 'Invalid URL format',
      };
    }

    // 1. Auth Wall Check
    const loginIndicator =
      parsed.pathname === '/sign_in' ||
      Boolean(
        doc.querySelector('a[href*="/sign_in"]') ??
        doc.querySelector('[data-testid="login-button"]') ??
        doc.querySelector('button[data-testid="login-button"]') ??
        doc.querySelector('.login-required'),
      );
    if (loginIndicator) {
      return {
        state: 'login-or-auth-required',
        providerId: this.providerId,
        canExtract: false,
        reason: 'Sign-in required on DeepSeek',
      };
    }

    // 1b. Check for branch switch / branch divergence
    const branchSwitchedIndicator =
      doc.querySelector('[data-branch-diverged="true"]') ??
      doc.querySelector('.branch-switched') ??
      doc.querySelector('.ds-branch-switched');
    if (branchSwitchedIndicator) {
      return {
        state: 'branch-switched',
        providerId: this.providerId,
        canExtract: false,
        reason: 'Conversation branch divergence detected. Pausing safely to maintain continuity.',
      };
    }

    // 1c. Check for active regeneration
    const regeneratingIndicator =
      doc.querySelector('[data-is-regenerating="true"]') ??
      doc.querySelector('.ds-regenerating') ??
      doc.querySelector('.regeneration-indicator');
    if (regeneratingIndicator) {
      return {
        state: 'regeneration-detected',
        providerId: this.providerId,
        canExtract: false,
        reason: 'Assistant response is actively regenerating. Prior state is invalidated.',
      };
    }

    // 1d. Check for message edited
    const editedIndicator =
      doc.querySelector('[data-message-edited="true"]') ??
      doc.querySelector('.ds-message-edited') ??
      doc.querySelector('.edited-indicator');
    if (editedIndicator) {
      return {
        state: 'message-edited',
        providerId: this.providerId,
        canExtract: false,
        reason: 'User prompt or assistant turn has been edited. In-flight loop paused safely.',
      };
    }

    // 2. Conversation Identity Check
    const conversationId = this.extractConversationId(doc, url);
    if (!conversationId) {
      return {
        state: 'conversation-identity-uncertain',
        providerId: this.providerId,
        canExtract: false,
        reason: 'Cannot establish unambiguous conversation ID on landing or new chat page.',
      };
    }

    // 3. Streaming Check
    const streamingEl =
      doc.querySelector('.ds-loading') ??
      doc.querySelector('[data-testid="generating"]') ??
      doc.querySelector('.streaming-indicator') ??
      doc.querySelector('button[aria-label="Stop generating"]');
    if (streamingEl) {
      return {
        state: 'response-streaming',
        providerId: this.providerId,
        conversationId,
        canExtract: false,
        reason: 'DeepSeek response is currently streaming',
      };
    }

    // 4. Check for completed assistant response
    const responseElem =
      doc.querySelector('.ds-message-item') ??
      doc.querySelector('.chat-message') ??
      doc.querySelector('[data-role="assistant"]') ??
      doc.querySelector('.response-complete');

    if (responseElem) {
      return {
        state: 'response-complete',
        providerId: this.providerId,
        conversationId,
        canExtract: true,
      };
    }

    // 5. Check if page is loading
    const loadingElem =
      doc.querySelector('.chat-loading') ??
      doc.querySelector('.spinner') ??
      doc.querySelector('[data-testid="loading-indicator"]');
    if (loadingElem) {
      return {
        state: 'loading',
        providerId: this.providerId,
        conversationId,
        canExtract: false,
        reason: 'Page or chat content is loading.',
      };
    }

    // 6. Check for recognized container structure
    const hasAnyRecognizedContainer =
      doc.querySelector('.chat-container') ??
      doc.querySelector('textarea#chat-input') ??
      doc.querySelector('.ds-message-item') ??
      doc.querySelector('[data-conversation-id]');

    if (!hasAnyRecognizedContainer) {
      return {
        state: 'page-structure-unknown',
        providerId: this.providerId,
        conversationId,
        canExtract: false,
        reason: 'DOM structure does not match tested DeepSeek selectors. Pausing safely.',
      };
    }

    // Default to loading/idle if recognized container exists but no responses yet
    return {
      state: 'loading',
      providerId: this.providerId,
      conversationId,
      canExtract: false,
      reason: 'No completed assistant response found in conversation container.',
    };
  }

  public extractResponse(doc: MinimalDocument, limits?: ExtractionLimits): ExtractionResult {
    const maxChars = limits?.maxChars ?? DEFAULT_EXTRACTION_LIMITS.maxChars;
    const maxCodeBlocks = limits?.maxCodeBlocks ?? DEFAULT_EXTRACTION_LIMITS.maxCodeBlocks;

    const messageEls = doc.querySelectorAll('.ds-message-item, .chat-message, [data-role="assistant"]');
    if (messageEls.length === 0) {
      return { ok: false, error: 'No messages found to extract' };
    }

    const lastMsg = messageEls[messageEls.length - 1];
    if (!lastMsg) {
      return { ok: false, error: 'Failed to access last message' };
    }

    const rawText = (lastMsg.textContent ?? '').trim();
    if (!rawText) {
      return { ok: false, error: 'Last message content is empty' };
    }

    const isTruncated = rawText.length > maxChars;
    const boundedText = isTruncated ? rawText.slice(0, maxChars) : rawText;

    const codeBlocks: ExtractedCodeBlock[] = [];
    const codeEls = lastMsg.querySelectorAll('pre code, .code-block code');
    for (const codeEl of codeEls.slice(0, maxCodeBlocks)) {
      const code = (codeEl.textContent ?? '').trim();
      if (code) {
        const className = codeEl.getAttribute('class') ?? '';
        const langMatch = className.match(/language-([a-zA-Z0-9_-]+)/);
        codeBlocks.push({
          language: langMatch ? langMatch[1] : undefined,
          code,
        });
      }
    }

    const response: ExtractedResponse = {
      rawText: boundedText,
      codeBlocks,
      isComplete: true,
      characterCount: boundedText.length,
      isTruncated,
      extractedAt: Date.now(),
    };

    return { ok: true, response };
  }

  public findComposer(doc: MinimalDocument): MinimalElement | null {
    return (
      doc.querySelector('textarea#chat-input, textarea[placeholder*="DeepSeek"], div[contenteditable="true"]') ??
      doc.querySelector('textarea')
    );
  }

  public prepareDraftInComposer(doc: MinimalDocument, draft: PreparedDraft): DraftPreparationResult {
    const composer = this.findComposer(doc);
    if (!composer) {
      return {
        ok: true,
        status: 'manual-copy-required',
        fallbackCopyText: draft.text,
        reason: 'Composer element not found. Use manual copy to paste into DeepSeek.',
      };
    }

    if (composer.tagName.toLowerCase() === 'textarea') {
      composer.value = draft.text;
      return {
        ok: true,
        status: 'inserted-in-composer',
        draft,
      };
    }

    return {
      ok: true,
      status: 'manual-copy-required',
      fallbackCopyText: draft.text,
      reason: 'Draft prepared. Copy and paste into DeepSeek conversation.',
    };
  }

  public getConversationIdentity(
    doc: MinimalDocument,
    url: string,
    tabId = 0,
  ): ConversationIdentity | null {
    if (!this.isSupportedUrl(url)) return null;
    const conversationId = this.extractConversationId(doc, url);
    if (!conversationId) return null;

    const lastMsg = doc.querySelector('.ds-message-item:last-child, .chat-message:last-child');
    const messageId = lastMsg?.getAttribute('data-message-id') ?? undefined;
    const branchId = doc.querySelector('[data-branch-id]')?.getAttribute('data-branch-id') ?? undefined;

    return {
      providerId: this.providerId,
      tabId,
      url,
      conversationId,
      messageId,
      branchId,
    };
  }

  public extractProtocolEnvelope(
    extracted: ExtractedResponse,
  ): Result<CanonicalEnvelope, MediatorError> {
    const { rawText, codeBlocks } = extracted;
    const planStartTag = '<<<MEDIATOR_PLAN>>>';
    const planEndTag = '<<<END_MEDIATOR_PLAN>>>';

    let jsonString: string | null = null;

    const planStartIdx = rawText.indexOf(planStartTag);
    if (planStartIdx !== -1) {
      const planEndIdx = rawText.indexOf(planEndTag, planStartIdx + planStartTag.length);
      if (planEndIdx !== -1) {
        jsonString = rawText.slice(planStartIdx + planStartTag.length, planEndIdx).trim();
      } else {
        jsonString = rawText.slice(planStartIdx + planStartTag.length).trim();
      }
    }

    if (!jsonString && codeBlocks.length > 0) {
      for (const block of codeBlocks) {
        const trimmed = block.code.trim();
        if (trimmed.includes(planStartTag)) {
          const s = trimmed.indexOf(planStartTag);
          const e = trimmed.indexOf(planEndTag, s + planStartTag.length);
          jsonString = e !== -1
            ? trimmed.slice(s + planStartTag.length, e).trim()
            : trimmed.slice(s + planStartTag.length).trim();
          break;
        }
        if (
          (trimmed.startsWith('{') && trimmed.endsWith('}')) &&
          (trimmed.includes('protocol_version') || trimmed.includes('protocolVersion'))
        ) {
          jsonString = trimmed;
          break;
        }
      }
    }

    if (!jsonString) {
      const fenceMatch = rawText.match(/```(?:json|mediator-plan)?\s*(\{[\s\S]*?\})\s*```/);
      if (fenceMatch && fenceMatch[1]) {
        jsonString = fenceMatch[1].trim();
      }
    }

    if (!jsonString && rawText.includes('protocol_version')) {
      const firstBrace = rawText.indexOf('{');
      const lastBrace = rawText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        jsonString = rawText.slice(firstBrace, lastBrace + 1).trim();
      }
    }

    if (!jsonString) {
      return err(
        makeMediatorError(
          ErrorCode.CONTENT_BLOCK_MISSING,
          'No valid Mediator protocol envelope found in DeepSeek response.',
        ),
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(jsonString);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return err(
        makeMediatorError(
          ErrorCode.SCHEMA_INVALID,
          `Failed to parse protocol envelope JSON: ${msg}`,
        ),
      );
    }

    return parseAndValidateEnvelope(parsedJson);
  }

  public insertReplyIfSupported(doc: MinimalDocument, draft: PreparedDraft): boolean {
    const composer = this.findComposer(doc);
    if (!composer) return false;

    try {
      if ('value' in composer) {
        composer.value = draft.text;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  public submitReplyIfSupported(doc: MinimalDocument, _draft: PreparedDraft): boolean {
    const sendButton =
      doc.querySelector('button[data-testid="send-button"]') ??
      doc.querySelector('button.ds-send-btn') ??
      doc.querySelector('button[aria-label*="Send message" i]') ??
      doc.querySelector('button[aria-label*="Send" i]') ??
      doc.querySelector('button[type="submit"]');

    if (!sendButton) return false;

    try {
      if (typeof sendButton.click === 'function') {
        sendButton.click();
        return true;
      }
      if (typeof sendButton.onclick === 'function') {
        sendButton.onclick();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  public verifyReplyWasAccepted(doc: MinimalDocument, draft: PreparedDraft): boolean {
    const composer = this.findComposer(doc);

    // If composer was cleared, submission was accepted
    if (composer && 'value' in composer && composer.value === '') {
      return true;
    }

    // Check if user turn appeared with prompt text
    const userMessageElems = doc.querySelectorAll(
      '.ds-user-message, [data-role="user"], .user-query',
    );
    for (const el of userMessageElems) {
      const text = el.textContent ?? '';
      if (draft.text.length > 0 && text.includes(draft.text.slice(0, 32))) {
        return true;
      }
    }

    return false;
  }

  public pauseForManualSend(draft: PreparedDraft, reason: string): PreparedDraft {
    const header = `[MEDIATOR PAUSED — MANUAL SEND REQUIRED: ${reason}]\n\n`;
    return {
      ...draft,
      text: header + draft.text,
      byteLength: Buffer.byteLength(header + draft.text, 'utf8'),
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private extractConversationId(doc: MinimalDocument, url: string): string | null {
    if (!url) return null;

    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/(?:a\/chat\/s|chat)\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        return match[1];
      }
    } catch {
      // Fall through to DOM inspection
    }

    const container =
      doc.querySelector('[data-conversation-id]') ??
      doc.querySelector('[data-chat-id]');

    const domId =
      container?.getAttribute('data-conversation-id') ??
      container?.getAttribute('data-chat-id');

    return domId && domId.trim().length > 0 ? domId.trim() : null;
  }
}
