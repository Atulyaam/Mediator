/**
 * @mediator/browser-extension — Google Gemini Provider Adapter (Sprint S18 + S20)
 *
 * Implements the ProviderAdapter interface for Google Gemini:
 * - Read-only DOM observation & bounded text extraction.
 * - Distinguishes streaming vs completed responses.
 * - Detects login, branch switch, message edits, regeneration, and uncertain identities.
 * - Pauses safely on unknown DOM structure rather than guessing.
 * - Parses and validates structured protocol envelope from text or code blocks.
 * - Same-chat draft insertion, confirmed submission, acceptance verification, and manual fallback.
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

export class GeminiProviderAdapter implements ProviderAdapter {
  public readonly providerId = 'google-gemini';
  public readonly name = 'Google Gemini';

  public isSupportedUrl(url: string): boolean {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.hostname === 'gemini.google.com';
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
        reason: `URL "${url}" does not match supported provider domain gemini.google.com`,
      };
    }

    // 1. Check for login / auth required
    const loginIndicator =
      doc.querySelector('a[href*="accounts.google.com"]') ??
      doc.querySelector('[data-action="sign-in"]') ??
      doc.querySelector('.login-required') ??
      doc.querySelector('.auth-wall');

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
      doc.querySelector('.branch-switched') ??
      doc.querySelector('[data-branch-diverged="true"]');
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
      doc.querySelector('.response-streaming') ??
      doc.querySelector('[data-is-streaming="true"]') ??
      doc.querySelector('.cursor-blink') ??
      doc.querySelector('.generating-indicator');

    if (streamingIndicator) {
      return {
        state: 'response-streaming',
        providerId: this.providerId,
        conversationId,
        canExtract: false,
        reason: 'Assistant response is actively streaming; incomplete text cannot be extracted as authoritative.',
      };
    }

    // 4. Check for completed response
    const responseElem =
      doc.querySelector('.model-response-text') ??
      doc.querySelector('.message-content-assistant') ??
      doc.querySelector('[data-message-author="assistant"]') ??
      doc.querySelector('.response-complete');

    if (responseElem) {
      return {
        state: 'response-complete',
        providerId: this.providerId,
        conversationId,
        canExtract: true,
      };
    }

    // 5. Check if page is empty loading state
    const loadingElem = doc.querySelector('.chat-loading') ?? doc.querySelector('.spinner');
    if (loadingElem) {
      return {
        state: 'loading',
        providerId: this.providerId,
        conversationId,
        canExtract: false,
        reason: 'Page or chat content is loading.',
      };
    }

    // 6. If on a conversation URL but no recognized structures exist
    const hasAnyRecognizedContainer =
      doc.querySelector('.conversation-container') ??
      doc.querySelector('.chat-window') ??
      doc.querySelector('[data-conversation-root]');

    if (!hasAnyRecognizedContainer) {
      return {
        state: 'page-structure-unknown',
        providerId: this.providerId,
        conversationId,
        canExtract: false,
        reason: 'DOM structure does not match tested Gemini selectors. Pausing safely.',
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

    // Locate response container
    const responseElem =
      doc.querySelector('.model-response-text') ??
      doc.querySelector('.message-content-assistant') ??
      doc.querySelector('[data-message-author="assistant"]') ??
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
      responseElem.querySelector('.response-streaming') ??
      responseElem.querySelector('[data-is-streaming="true"]');
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
      doc.querySelector('rich-textarea textarea') ??
      doc.querySelector('div[contenteditable="true"]') ??
      doc.querySelector('textarea[aria-label*="prompt" i]') ??
      doc.querySelector('textarea[placeholder*="Ask" i]') ??
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

  // ─── Sprint S20 Same-Chat Methods ────────────────────────────────────────

  public getConversationIdentity(
    doc: MinimalDocument,
    url: string,
    tabId = 1,
  ): ConversationIdentity | null {
    const conversationId = this.extractConversationId(doc, url);
    if (!conversationId) return null;

    const assistantElem =
      doc.querySelector('.model-response-text') ??
      doc.querySelector('.message-content-assistant') ??
      doc.querySelector('[data-message-author="assistant"]') ??
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

    if (!jsonString) {
      for (const block of extracted.codeBlocks) {
        const blockCode = block.code.trim();
        if (blockCode.includes(planStartTag)) {
          const s = blockCode.indexOf(planStartTag);
          const e = blockCode.indexOf(planEndTag, s + planStartTag.length);
          jsonString = e !== -1
            ? blockCode.slice(s + planStartTag.length, e).trim()
            : blockCode.slice(s + planStartTag.length).trim();
          break;
        }
        if (
          (block.language === 'json' || block.language === 'mediator-plan' || !block.language) &&
          blockCode.startsWith('{') &&
          blockCode.includes('protocol_version')
        ) {
          jsonString = blockCode;
          break;
        }
      }
    }

    if (!jsonString) {
      const codeBlockMatch = rawText.match(/```(?:json|mediator-plan)?\s*(\{[\s\S]*?\})\s*```/);
      if (codeBlockMatch && codeBlockMatch[1]) {
        jsonString = codeBlockMatch[1].trim();
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
          ErrorCode.SCHEMA_INVALID,
          'No protocol envelope found in assistant response',
        ),
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(jsonString);
    } catch (parseErr) {
      return err(
        makeMediatorError(
          ErrorCode.SCHEMA_INVALID,
          `Failed to parse protocol envelope JSON: ${String(parseErr)}`,
        ),
      );
    }

    return parseAndValidateEnvelope(parsedJson);
  }

  public insertReplyIfSupported(doc: MinimalDocument, draft: PreparedDraft): boolean {
    const composer = this.findComposer(doc);
    if (!composer) return false;

    if ('value' in composer) {
      composer.value = draft.text;
      return true;
    }

    return false;
  }

  public submitReplyIfSupported(doc: MinimalDocument, _draft: PreparedDraft): boolean {
    const sendBtn =
      doc.querySelector('button[aria-label*="Send" i]') ??
      doc.querySelector('button.send-button') ??
      doc.querySelector('[data-action="send"]') ??
      doc.querySelector('button[type="submit"]');

    if (!sendBtn) return false;

    if (typeof sendBtn.click === 'function') {
      sendBtn.click();
      return true;
    }
    if (typeof sendBtn.onclick === 'function') {
      sendBtn.onclick();
      return true;
    }

    return true;
  }

  public verifyReplyWasAccepted(doc: MinimalDocument, draft: PreparedDraft): boolean {
    const composer = this.findComposer(doc);
    const composerCleared = composer ? (composer.value === '' || composer.value === undefined) : false;

    const userMsg =
      doc.querySelector('.user-message') ??
      doc.querySelector('[data-message-author="user"]') ??
      doc.querySelector('.user-query');

    const hasUserMsg = Boolean(
      userMsg &&
      (userMsg.textContent?.includes(draft.text.trim()) ||
        (draft.text.length > 20 && userMsg.textContent?.includes(draft.text.slice(0, 20)))),
    );

    const isStreaming = Boolean(
      doc.querySelector('.response-streaming') ??
      doc.querySelector('[data-is-streaming="true"]') ??
      doc.querySelector('.generating-indicator'),
    );

    if (hasUserMsg) return true;
    if (composerCleared && isStreaming) return true;
    if (composer && composer.value === draft.text && !hasUserMsg) return false;

    return false;
  }

  public pauseForManualSend(draft: PreparedDraft, _reason: string): PreparedDraft {
    return draft;
  }

  private extractConversationId(doc: MinimalDocument, url: string): string | null {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/(app|c)\/([a-zA-Z0-9_-]+)/);
      if (match && match[2]) {
        return match[2];
      }
    } catch {
      // fallback to DOM
    }

    const domAttr = doc.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id');
    if (domAttr && domAttr.trim().length > 0) {
      return domAttr.trim();
    }

    return null;
  }
}
