/**
 * @mediator/browser-extension — Anthropic Claude Provider Adapter (Sprint S30)
 *
 * Implements the ProviderAdapter interface for Claude (`claude.ai`):
 * - Validates official Claude origin (https://claude.ai).
 * - Extracts conversation identity from canonical path `/chat/<id>`.
 * - Read-only DOM observation & bounded text extraction.
 * - Compliant manual handoff: provides formatted copy-ready draft fallback
 *   to avoid brittle or unpermitted direct DOM simulation.
 * - Extracts structured protocol envelopes (`<<<MEDIATOR_PLAN>>>` and markdown fences).
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

export class ClaudeProviderAdapter implements ProviderAdapter {
  public readonly providerId = 'claude';
  public readonly name = 'Anthropic Claude';

  public isSupportedUrl(url: string): boolean {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.hostname === 'claude.ai';
    } catch {
      return false;
    }
  }

  public classifyPage(doc: MinimalDocument, url: string): PageClassificationResult {
    if (!this.isSupportedUrl(url)) {
      return { state: 'unsupported-page', canExtract: false, reason: 'URL is not on claude.ai' };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { state: 'unsupported-page', canExtract: false, reason: 'Invalid URL format' };
    }

    // Auth Wall Check
    if (parsed.pathname === '/login' || doc.querySelector('a[href*="/login"], [data-testid="login-button"]')) {
      return { state: 'login-or-auth-required', canExtract: false, reason: 'Login required on Claude' };
    }

    // Conversation Identity Check
    const match = parsed.pathname.match(/\/chat\/([a-zA-Z0-9_-]+)/);
    if (!match || !match[1]) {
      if (parsed.pathname === '/' || parsed.pathname === '/chats' || parsed.pathname === '/new') {
        return {
          state: 'conversation-identity-uncertain',
          canExtract: false,
          reason: 'On Claude landing page. Select or start a conversation first.',
        };
      }
      return {
        state: 'page-structure-unknown',
        canExtract: false,
        reason: 'Cannot determine Claude conversation ID from URL path',
      };
    }

    const convId = match[1];

    // Streaming Check
    const streamingEl = doc.querySelector('.cursor-blink, [data-testid="streaming-indicator"], .typing-indicator');
    if (streamingEl) {
      return {
        state: 'response-streaming',
        providerId: this.providerId,
        conversationId: convId,
        canExtract: false,
        reason: 'Claude response is currently streaming',
      };
    }

    // Has rendered messages
    const messageEls = doc.querySelectorAll('.font-claude-message, [data-testid="chat-message"], .message-content');
    if (messageEls.length === 0) {
      return {
        state: 'conversation-identity-uncertain',
        providerId: this.providerId,
        conversationId: convId,
        canExtract: false,
        reason: 'No completed messages found in Claude conversation',
      };
    }

    return {
      state: 'response-complete',
      providerId: this.providerId,
      conversationId: convId,
      canExtract: true,
    };
  }

  public extractResponse(doc: MinimalDocument, limits?: ExtractionLimits): ExtractionResult {
    const maxChars = limits?.maxChars ?? DEFAULT_EXTRACTION_LIMITS.maxChars;
    const maxCodeBlocks = limits?.maxCodeBlocks ?? DEFAULT_EXTRACTION_LIMITS.maxCodeBlocks;

    const messageEls = doc.querySelectorAll('.font-claude-message, [data-testid="chat-message"], .message-content');
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
      doc.querySelector('div[contenteditable="true"][data-placeholder], textarea[placeholder*="Reply"], fieldset div[contenteditable="true"]') ??
      doc.querySelector('textarea, div[contenteditable="true"]')
    );
  }

  public prepareDraftInComposer(doc: MinimalDocument, draft: PreparedDraft): DraftPreparationResult {
    const composer = this.findComposer(doc);
    if (!composer) {
      return {
        ok: true,
        status: 'manual-copy-required',
        fallbackCopyText: draft.text,
        reason: 'Composer element not found. Use manual copy to paste into Claude.',
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

    // For rich contenteditable, provide safe manual copy fallback to comply with Claude terms
    return {
      ok: true,
      status: 'manual-copy-required',
      fallbackCopyText: draft.text,
      reason: 'Draft prepared. Copy and paste into Claude conversation.',
    };
  }

  public getConversationIdentity(
    _doc: MinimalDocument,
    url: string,
    tabId = 0,
  ): ConversationIdentity | null {
    if (!this.isSupportedUrl(url)) return null;
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/chat\/([a-zA-Z0-9_-]+)/);
      if (!match || !match[1]) return null;

      return {
        providerId: this.providerId,
        tabId,
        url,
        conversationId: match[1],
      };
    } catch {
      return null;
    }
  }

  public extractProtocolEnvelope(
    extracted: ExtractedResponse,
  ): Result<CanonicalEnvelope, MediatorError> {
    const { rawText, codeBlocks } = extracted;

    const envelopeMatch = rawText.match(/<<<MEDIATOR_PLAN>>>([\s\S]*?)<<<END_MEDIATOR_PLAN>>>/);
    if (envelopeMatch && envelopeMatch[1]) {
      return parseAndValidateEnvelope(envelopeMatch[1].trim());
    }

    for (const block of codeBlocks) {
      if (block.code.includes('"protocolVersion"') || block.code.includes('<<<MEDIATOR_PLAN>>>')) {
        const clean = block.code
          .replace(/<<<MEDIATOR_PLAN>>>/g, '')
          .replace(/<<<END_MEDIATOR_PLAN>>>/g, '')
          .trim();
        const res = parseAndValidateEnvelope(clean);
        if (res.ok) return res;
      }
    }

    return err(
      makeMediatorError(
        ErrorCode.CONTENT_BLOCK_MISSING,
        'No valid Mediator protocol envelope found in Claude response.',
      ),
    );
  }
}
