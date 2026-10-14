/**

* @mediator/browser-extension — Content Script (Sprint S18)
 *
 * Runs inside supported AI provider page (e.g. https://gemini.google.com/*).
 * Observes page state, extracts responses within limits, and prepares message drafts.
 *
 * Security:
 * - Read-only DOM inspection.
 * - Does not scrape credentials, cookies, or unrelated user tabs.
 * - No eval or remote script injection.
 */

import { GeminiProviderAdapter } from './geminiProviderAdapter.js';
import { type MinimalDocument, type MinimalElement } from './providerTypes.js';
import { type ChromeApi, type ContentScriptMessage, type ContentScriptResponse } from './chromeTypes.js';

declare const chrome: ChromeApi | undefined;

const adapter = new GeminiProviderAdapter();

// Browser DOM adapter wrapper
function getDocumentWrapper(): MinimalDocument {
  return {
    location: { href: window.location.href },
    querySelector: (selector: string): MinimalElement | null => {
      const el = document.querySelector(selector);
      return el ? (el as unknown as MinimalElement) : null;
    },
    querySelectorAll: (selector: string): MinimalElement[] => {
      const els = Array.from(document.querySelectorAll(selector));
      return els as unknown as MinimalElement[];
    },
  };
}

// Listen for messages from background/popup
if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(
    (
      rawMessage: unknown,
      _sender: unknown,
      sendResponse: (resp: ContentScriptResponse) => void,
    ): boolean => {
      if (!rawMessage || typeof rawMessage !== 'object' || !('type' in rawMessage)) {
        sendResponse({ ok: false, error: 'Invalid message payload' });
        return false;
      }

      const message = rawMessage as ContentScriptMessage;
      const doc = getDocumentWrapper();

      switch (message.type) {
        case 'CLASSIFY_PAGE': {
          const classification = adapter.classifyPage(doc, window.location.href);
          sendResponse({ ok: true, classification });
          break;
        }

        case 'EXTRACT_RESPONSE': {
          const result = adapter.extractResponse(doc, message.limits);
          sendResponse(result);
          break;
        }

        case 'PREPARE_DRAFT': {
          const result = adapter.prepareDraftInComposer(doc, message.draft);
          sendResponse(result);
          break;
        }

        default: {
          sendResponse({ ok: false, error: 'Unknown message type' });
          break;
        }
      }

      return true; // async sendResponse
    },
  );
}
