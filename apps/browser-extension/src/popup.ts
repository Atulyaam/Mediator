/**
 * @mediator/browser-extension — Popup UI Script (Sprint S18)
 *
 * Provides visual controls for:
 * - Attach to active tab
 * - Detach from active tab
 * - Page state & conversation status display
 * - Safe pause reason notice
 * - Prepare message draft & manual copy fallback
 * - Clear honest core connection status (Disconnected)
 */

import {
  type ChromeApi,
  type BackgroundResponse,
  type ChromeTab,
} from './chromeTypes.js';
import { type AttachState } from './providerTypes.js';

declare const chrome: ChromeApi | undefined;

document.addEventListener('DOMContentLoaded', (): void => {
  const statusEl = document.getElementById('status-text');
  const providerEl = document.getElementById('provider-name');
  const convEl = document.getElementById('conversation-id');
  const providerSelect = document.getElementById('provider-select') as HTMLSelectElement | null;
  const modeText = document.getElementById('mode-text');
  const pauseReasonEl = document.getElementById('pause-reason');
  const btnAttach = document.getElementById('btn-attach');
  const btnDetach = document.getElementById('btn-detach');
  const btnPrepareDraft = document.getElementById('btn-prepare-draft');
  const draftArea = document.getElementById('draft-area') as HTMLTextAreaElement | null;
  const draftStatusEl = document.getElementById('draft-status');

  function updateModeIndicator(providerId: string | null): void {
    if (!modeText) return;
    if (providerId === 'claude' || providerId === 'deepseek') {
      modeText.textContent = 'Manual Handoff (Mode A)';
    } else {
      modeText.textContent = 'Browser Bridge (Mode A)';
    }
  }

  providerSelect?.addEventListener('change', (): void => {
    updateModeIndicator(providerSelect?.value ?? null);
  });

  function renderState(state: AttachState | undefined): void {
    if (!state) return;
    if (statusEl) statusEl.textContent = state.status.toUpperCase();
    if (providerEl) providerEl.textContent = state.providerId ?? 'None';
    if (convEl) convEl.textContent = state.conversationId ?? 'None';
    if (state.providerId && providerSelect) {
      if (state.providerId.includes('gemini')) providerSelect.value = 'gemini';
      else if (state.providerId.includes('openai') || state.providerId.includes('chatgpt')) providerSelect.value = 'openai';
      else if (state.providerId.includes('claude')) providerSelect.value = 'claude';
      else if (state.providerId.includes('deepseek')) providerSelect.value = 'deepseek';
      updateModeIndicator(providerSelect.value);
    }

    if (pauseReasonEl) {
      if (state.safePauseReason) {
        pauseReasonEl.textContent = `Paused: ${state.safePauseReason}`;
        pauseReasonEl.style.display = 'block';
      } else {
        pauseReasonEl.style.display = 'none';
      }
    }

    if (btnAttach) btnAttach.style.display = state.status === 'attached' ? 'none' : 'inline-block';
    if (btnDetach) btnDetach.style.display = state.status === 'attached' ? 'inline-block' : 'none';
  }

  // Fetch initial status from background
  if (typeof chrome !== 'undefined' && chrome?.runtime) {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp?: BackgroundResponse): void => {
      if (resp && resp.ok && 'state' in resp && resp.state) {
        renderState(resp.state);
      }
    });

    btnAttach?.addEventListener('click', (): void => {
      chrome?.tabs?.query({ active: true, currentWindow: true }, (tabs: ChromeTab[]): void => {
        const activeTab = tabs[0];
        if (!activeTab || typeof activeTab.id !== 'number' || !activeTab.url) return;
        chrome?.runtime?.sendMessage(
          { type: 'ATTACH_TAB', tabId: activeTab.id, url: activeTab.url },
          (resp?: BackgroundResponse): void => {
            if (resp && resp.ok && 'state' in resp && resp.state) renderState(resp.state);
          },
        );
      });
    });

    btnDetach?.addEventListener('click', (): void => {
      chrome?.runtime?.sendMessage({ type: 'DETACH_TAB' }, (resp?: BackgroundResponse): void => {
        if (resp && resp.ok && 'state' in resp && resp.state) renderState(resp.state);
      });
    });

    btnPrepareDraft?.addEventListener('click', (): void => {
      const text = draftArea?.value ?? '';
      if (!text.trim()) {
        if (draftStatusEl) draftStatusEl.textContent = 'Please enter draft text.';
        return;
      }
      chrome?.runtime?.sendMessage(
        { type: 'PREPARE_DRAFT', input: { text } },
        (resp?: BackgroundResponse): void => {
          if (resp && resp.ok && 'status' in resp) {
            const draftResult = resp;
            if (draftStatusEl) {
              draftStatusEl.textContent = `Draft prepared (${draftResult.status}). Review before manual sending.`;
            }
          } else {
            const reason = resp && 'reason' in resp && typeof resp.reason === 'string'
              ? resp.reason
              : 'Unknown';
            if (draftStatusEl) draftStatusEl.textContent = `Rejected: ${reason}`;
          }
        },
      );
    });
  }
});
