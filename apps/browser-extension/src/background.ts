/**
 * @mediator/browser-extension — Background Service Worker (Sprint S18)
 *
 * Coordinates extension lifecycle, tab tracking, and message dispatch.
 * Does NOT connect to native host IPC (S19 scope).
 * Does NOT open network sockets or local HTTP ports.
 */

import { ProviderRegistry } from './providerRegistry.js';
import { AttachManager } from './attachManager.js';
import { DraftManager } from './draftManager.js';
import {
  type ChromeApi,
  type BackgroundMessage,
  type BackgroundResponse,
  type ContentScriptResponse,
  type ChromeTab,
} from './chromeTypes.js';
import { type MinimalDocument } from './providerTypes.js';

declare const chrome: ChromeApi | undefined;

const registry = new ProviderRegistry();
const adapter = registry.getAdapter('gemini')!;
const attachManager = new AttachManager(adapter, registry);
const draftManager = new DraftManager(adapter, attachManager);

const emptyDoc: MinimalDocument = {
  querySelector: (): null => null,
  querySelectorAll: (): [] => [],
};

if (typeof chrome !== 'undefined' && chrome?.runtime) {
  // Tab navigation tracking
  if (chrome.tabs?.onUpdated) {
    chrome.tabs.onUpdated.addListener(
      (tabId: number, changeInfo: { status?: string; url?: string }, _tab: ChromeTab): void => {
        const currentState = attachManager.getState();
        const url = changeInfo.url;
        if (currentState.status === 'attached' && currentState.tabId === tabId && url) {
          // Query tab for updated classification
          chrome?.tabs?.sendMessage(
            tabId,
            { type: 'CLASSIFY_PAGE' },
            (response?: ContentScriptResponse): void => {
              if (chrome?.runtime?.lastError || !response || !response.ok) {
                attachManager.handleNavigation(url, emptyDoc);
              }
            },
          );
        }
      },
    );
  }

  // Handle messages from popup
  if (chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(
      (
        rawMessage: unknown,
        _sender: unknown,
        sendResponse: (resp: BackgroundResponse) => void,
      ): boolean => {
        if (!rawMessage || typeof rawMessage !== 'object' || !('type' in rawMessage)) {
          sendResponse({ ok: false, error: 'Invalid message' });
          return false;
        }

        const message = rawMessage as BackgroundMessage;

        switch (message.type) {
          case 'GET_STATUS': {
            sendResponse({ ok: true, state: attachManager.getState() });
            break;
          }

          case 'ATTACH_TAB': {
            const { tabId, url } = message;
            // Send classify message to tab
            chrome?.tabs?.sendMessage(
              tabId,
              { type: 'CLASSIFY_PAGE' },
              (response?: ContentScriptResponse): void => {
                if (chrome?.runtime?.lastError || !response || !response.ok) {
                  sendResponse({
                    ok: false,
                    error: 'Failed to communicate with content script. Ensure page is supported and reloaded.',
                  });
                  return;
                }

                const attached = attachManager.attach({ tabId, url }, emptyDoc);
                sendResponse({ ok: true, state: attached });
              },
            );
            return true;
          }

          case 'DETACH_TAB': {
            const detached = attachManager.detach();
            draftManager.clearDraft();
            sendResponse({ ok: true, state: detached });
            break;
          }

          case 'PREPARE_DRAFT': {
            const result = draftManager.prepareDraft(message.input);
            sendResponse(result);
            break;
          }

          default: {
            sendResponse({ ok: false, error: 'Unknown message type' });
            break;
          }
        }

        return true;
      },
    );
  }
}

export { adapter, attachManager, draftManager };
