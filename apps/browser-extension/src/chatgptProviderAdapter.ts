/**
 * @mediator/browser-extension — OpenAI ChatGPT Provider Adapter (Sprint S27)
 *
 * Implements the ProviderAdapter interface for OpenAI ChatGPT (chatgpt.com & chat.openai.com):
 * - Read-only DOM observation & bounded text extraction.
 * - Distinguishes streaming vs completed responses.
 * - Detects login, branch switch, message edits, regeneration, and uncertain identities.
 * - Pauses safely on unknown DOM structure rather than guessing.
 * - Parses and validates structured protocol envelope from text or code blocks.
 * - Same-chat draft insertion, confirmed submission, acceptance verification, and manual fallback.
 *
 * Security:
 * - ChatGPT browser DOM is an untrusted external data source.
 * - No credentials, cookies, or session tokens are collected or transmitted.
 * - Never auto-sends without explicit user confirmation.
 * - Never silently creates a new chat or switches provider identity.
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
import {
  type ProviderAdapter,
} from './providerAdapter.js';
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

export class ChatGPTProviderAdapter implements ProviderAdapter {
  public readonly providerId = 'openai-chatgpt';
  public readonly name = 'OpenAI ChatGPT';

  public isSupportedUrl(url: string): boolean {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return (
        parsed.hostname === 'chatgpt.com' ||
        parsed.hostname === 'chat.openai.com'
      );
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
        reason: `URL "${url}" does not match supported provider domains (chatgpt.com, chat.openai.com).`,
      };
    }

    // 1. Check for login / auth required
    const loginIndicator =
      doc.querySelector('a[href*="/auth/login"]') ??
      doc.querySelector('[data-testid="login-button"]') ??
      doc.querySelector('button[data-testid="auth-login-button"]') ??
      doc.querySelector('.auth-page') ??
      doc.querySelector('.login-required');

    if (loginIndicator) {
      return {
        state: 'login-or-auth-required',
        providerId: this.providerId,
        canExtract: false,
        reason: 'Authentication or login required before conversational observation is possible.',
      };
    }

    // 1b. Check for branch switch / branch divergence
    const branchSwitchedIndicator =
      doc.querySelector('[data-branch-diverged="true"]') ??
      doc.querySelector('.branch-switched');
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
      doc.querySelector('.edited-indicator');
    if (editedIndicator) {
      return {
        state: 'message-edited',
        providerId: this.providerId,
        canExtract: false,
        reason: 'User prompt or assistant turn has been edited. In-flight loop paused safely.',
      };
    }

    // 2. Extract conversation ID from URL or DOM
    const conversationId = this.extractConversationId(doc, url);
    if (!conversationId) {
      return {
        state: 'conversation-identity-uncertain',
        providerId: this.providerId,
        canExtract: false,
        reason: 'Cannot establish unambiguous conversation ID on landing or new chat page.',
      };
    }

    // 3. Check for streaming in progress
    const streamingIndicator =
      doc.querySelector('.result-streaming') ??
      doc.querySelector('button[data-testid="stop-button"]') ??
      doc.querySelector('button[aria-label="Stop streaming"]') ??
      doc.querySelector('[data-is-streaming="true"]') ??
      doc.querySelector('.cursor-blink');

    if (streamingIndicator) {
      return {
        state: 'response-streaming',
        providerId: this.providerId,
        conversationId,
        canExtract: false,
        reason: 'Assistant response is actively streaming; incomplete text cannot be extracted as authoritative.',
      };
    }

    // 4. Check for completed assistant response
    const responseElem =
      doc.querySelector('[data-message-author-role="assistant"]') ??
      doc.querySelector('.agent-turn') ??
      doc.querySelector('article[data-testid^="conversation-turn-"]') ??
      doc.querySelector('[data-testid="message-content"]') ??
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
      doc.querySelector('main') ??
      doc.querySelector('[data-testid="conversation-panel"]') ??
      doc.querySelector('.conversation-container') ??
      doc.querySelector('#prompt-textarea');

    if (!hasAnyRecognizedContainer) {
      return {
        state: 'page-structure-unknown',
        providerId: this.providerId,
        conversationId,
        canExtract: false,
        reason: 'DOM structure does not match tested ChatGPT selectors. Pausing safely.',
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

    // Locate assistant response container
    const responseElem =
      doc.querySelector('[data-message-author-role="assistant"]') ??
      doc.querySelector('.agent-turn') ??
      doc.querySelector('article[data-testid^="conversation-turn-"]') ??
      doc.querySelector('[data-testid="message-content"]') ??
      doc.querySelector('.response-complete');

    if (!responseElem) {
      return {
        ok: false,
        errorCode: 'RESPONSE_ELEMENT_NOT_FOUND',
        error: 'No assistant response element found in document.',
      };
    }

    // Check if still streaming
    const streamingCheck =
      responseElem.querySelector('.result-streaming') ??
      responseElem.querySelector('[data-is-streaming="true"]') ??
      doc.querySelector('button[data-testid="stop-button"]');
    if (streamingCheck) {
      return {
        ok: false,
        errorCode: 'RESPONSE_STILL_STREAMING',
        error: 'Cannot extract response while streaming indicator is active.',
      };
    }

    const rawFullText = responseElem.textContent ?? '';
    if (rawFullText.trim().length === 0) {
      return {
        ok: false,
        errorCode: 'EMPTY_RESPONSE',
        error: 'Assistant response element contains empty text.',
      };
    }

    // Extract code blocks
    const codeBlockElems = responseElem.querySelectorAll('pre code, .code-block, pre');
    const codeBlocks: ExtractedCodeBlock[] = [];

    for (let i = 0; i < Math.min(codeBlockElems.length, maxCodeBlocks); i++) {
      const el = codeBlockElems[i];
      if (!el) continue;
      const code = el.textContent ?? '';
      const codeChild = el.querySelector('code');
      const rawDataLang = el.getAttribute('data-language') ?? codeChild?.getAttribute('data-language');
      let language = rawDataLang ?? undefined;

      if (!language) {
        const classAttr = el.getAttribute('class') ?? codeChild?.getAttribute('class') ?? '';
        const langMatch = classAttr.match(/language-([a-zA-Z0-9_-]+)/);
        if (langMatch) {
          language = langMatch[1];
        }
      }

      codeBlocks.push({
        language,
        code,
      });
    }

    // Apply bounded length limits
    let rawText = rawFullText;
    let isTruncated = false;
    if (rawText.length > maxChars) {
      rawText = rawText.slice(0, maxChars);
      isTruncated = true;
    }

    return {
      ok: true,
      response: {
        rawText,
        codeBlocks,
        isComplete: true,
        characterCount: rawText.length,
        isTruncated,
        extractedAt: Date.now(),
      },
    };
  }

  public findComposer(doc: MinimalDocument): MinimalElement | null {
    return (
      doc.querySelector('#prompt-textarea') ??
      doc.querySelector('textarea[data-id="root"]') ??
      doc.querySelector('textarea[placeholder*="Ask" i]') ??
      doc.querySelector('textarea[placeholder*="Message" i]') ??
      doc.querySelector('div[contenteditable="true"]#prompt-textarea') ??
      doc.querySelector('.chat-input-textarea')
    );
  }

  public prepareDraftInComposer(doc: MinimalDocument, draft: PreparedDraft): DraftPreparationResult {
    const composer = this.findComposer(doc);

    if (!composer) {
      return {
        ok: true,
        status: 'manual-copy-required',
        draft,
        fallbackCopyText: draft.text,
        reason: 'Composer element not found. User can copy draft manually.',
      };
    }

    try {
      if ('value' in composer) {
        composer.value = draft.text;
        return {
          ok: true,
          status: 'inserted-in-composer',
          draft,
          fallbackCopyText: draft.text,
        };
      }

      return {
        ok: true,
        status: 'manual-copy-required',
        draft,
        fallbackCopyText: draft.text,
        reason: 'Composer requires manual paste due to rich contenteditable element.',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: true,
        status: 'manual-copy-required',
        draft,
        fallbackCopyText: draft.text,
        reason: `Failed to insert in composer (${msg}). Copy manually.`,
      };
    }
  }

  // ─── Same-Chat Protocol Methods ──────────────────────────────────────────

  public getConversationIdentity(
    doc: MinimalDocument,
    url: string,
    tabId = 1,
  ): ConversationIdentity | null {
    const conversationId = this.extractConversationId(doc, url);
    if (!conversationId) return null;

    const assistantElem =
      doc.querySelector('[data-message-author-role="assistant"]') ??
      doc.querySelector('.agent-turn') ??
      doc.querySelector('article[data-testid^="conversation-turn-"]') ??
      doc.querySelector('.response-complete');

    const messageId =
      assistantElem?.getAttribute('data-message-id') ??
      assistantElem?.getAttribute('id') ??
      undefined;

    const branchElem =
      doc.querySelector('[data-branch-id]') ??
      doc.querySelector('[data-branch]') ??
      doc.querySelector('.branch-indicator');

    const branchId =
      branchElem?.getAttribute('data-branch-id') ??
      branchElem?.getAttribute('data-branch') ??
      branchElem?.textContent?.trim() ??
      undefined;

    return {
      providerId: this.providerId,
      tabId,
      url,
      conversationId,
      messageId,
      branchId,
    };
  }

  public extractProtocolEnvelope(extracted: ExtractedResponse): Result<CanonicalEnvelope, MediatorError> {
    const rawText = extracted.rawText;
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

    // Fallback: look for JSON in code blocks
    if (!jsonString && extracted.codeBlocks.length > 0) {
      for (const block of extracted.codeBlocks) {
        const trimmed = block.code.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          jsonString = trimmed;
          break;
        }
      }
    }

    // Fallback 2: look for ```json fence in raw text
    if (!jsonString) {
      const fenceMatch = rawText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (fenceMatch && fenceMatch[1]) {
        jsonString = fenceMatch[1].trim();
      }
    }

    if (!jsonString) {
      return err(
        makeMediatorError(
          ErrorCode.CONTENT_BLOCK_MISSING,
          'No <<<MEDIATOR_PLAN>>> block or valid JSON envelope found in assistant response.',
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
          { detail: { rawJsonSnippet: jsonString.slice(0, 120) } },
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
      doc.querySelector('button[aria-label="Send prompt"]') ??
      doc.querySelector('button[data-testid="fruitjuice-send-button"]') ??
      doc.querySelector('button.send-button');

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

    // Composer cleared indicates submission was accepted
    if (composer && 'value' in composer && composer.value === '') {
      return true;
    }

    // Check if user turn appeared with prompt text
    const userMessageElems = doc.querySelectorAll(
      '[data-message-author-role="user"], .user-query, article[data-testid^="conversation-turn-"][data-author="user"]',
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
      // Format 1: /c/<uuid> (e.g., https://chatgpt.com/c/6701a2b3-4c5d-8e9f-0123-456789abcdef)
      const cMatch = parsed.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
      if (cMatch && cMatch[1]) {
        return cMatch[1];
      }

      // Format 2: /g/<gpt-id>/c/<uuid>
      const gptMatch = parsed.pathname.match(/\/g\/[^/]+\/c\/([a-zA-Z0-9_-]+)/);
      if (gptMatch && gptMatch[1]) {
        return gptMatch[1];
      }
    } catch {
      // Fall through to DOM inspection
    }

    // Fallback: check DOM container attribute
    const container =
      doc.querySelector('[data-conversation-id]') ??
      doc.querySelector('[data-chat-id]');

    const domId =
      container?.getAttribute('data-conversation-id') ??
      container?.getAttribute('data-chat-id');

    return domId && domId.trim().length > 0 ? domId.trim() : null;
  }
}
