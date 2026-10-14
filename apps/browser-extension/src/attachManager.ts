/**
 * @mediator/browser-extension — Attach / Detach Lifecycle Manager (Sprint S18)
 *
 * Requirements:
 * - Attaching requires explicit user action.
 * - Unsupported page fails safely with clear explanation.
 * - Detach stops active observation, clears transient extracted data, cleans up listeners.
 * - Tab navigation or switch invalidates prior conversation identity/state.
 * - Never claims false "Mediator connected" core state.
 */

import {
  type AttachState,
  type MinimalDocument,
  type ExtractedResponse,
} from './providerTypes.js';
import { type ProviderAdapter } from './providerAdapter.js';
import { type ProviderRegistry } from './providerRegistry.js';

export interface TabInfo {
  readonly tabId: number;
  readonly url: string;
}

export type ObserverCleanup = () => void;

export class AttachManager {
  private state: AttachState;
  private cleanups: ObserverCleanup[] = [];
  private activeAdapter: ProviderAdapter;

  constructor(
    private readonly providerAdapter: ProviderAdapter,
    private readonly registry?: ProviderRegistry,
  ) {
    this.activeAdapter = providerAdapter;
    this.state = {
      status: 'detached',
      providerId: null,
      tabId: null,
      url: null,
      conversationId: null,
      pageState: 'unsupported-page',
      lastExtractedAt: null,
      lastResponseSummary: null,
      activeDraft: null,
      isCoreConnected: false,
      statusMessage: 'Extension detached. Click Attach to observe a supported AI tab.',
    };
  }

  public getActiveAdapter(): ProviderAdapter {
    return this.activeAdapter;
  }

  public getState(): AttachState {
    return this.state;
  }

  /**
   * Action: Explicit User Attach
   */
  public attach(tab: TabInfo, doc: MinimalDocument): AttachState {
    // 1. Resolve matching adapter if registry is available
    const adapter = this.registry?.getAdapterForUrl(tab.url) ?? this.providerAdapter;
    this.activeAdapter = adapter;

    // 2. Check if provider supports this URL
    if (!adapter.isSupportedUrl(tab.url)) {
      this.state = {
        ...this.state,
        status: 'error',
        providerId: adapter.providerId,
        tabId: tab.tabId,
        url: tab.url,
        conversationId: null,
        pageState: 'unsupported-page',
        statusMessage: `Cannot attach: URL is not supported by ${adapter.name}.`,
        safePauseReason: 'Unsupported page URL',
      };
      return this.state;
    }

    // 3. Classify page state
    const classification = adapter.classifyPage(doc, tab.url);

    if (
      classification.state === 'login-or-auth-required' ||
      classification.state === 'conversation-identity-uncertain' ||
      classification.state === 'page-structure-unknown'
    ) {
      this.state = {
        status: 'paused',
        providerId: adapter.providerId,
        tabId: tab.tabId,
        url: tab.url,
        conversationId: classification.conversationId ?? null,
        pageState: classification.state,
        lastExtractedAt: null,
        lastResponseSummary: null,
        activeDraft: null,
        isCoreConnected: false,
        statusMessage: `Attached but safely paused: ${classification.reason}`,
        safePauseReason: classification.reason,
      };
      return this.state;
    }

    // Successfully attached and ready/active
    this.state = {
      status: 'attached',
      providerId: adapter.providerId,
      tabId: tab.tabId,
      url: tab.url,
      conversationId: classification.conversationId ?? null,
      pageState: classification.state,
      lastExtractedAt: null,
      lastResponseSummary: null,
      activeDraft: null,
      isCoreConnected: false,
      statusMessage: `Attached to ${adapter.name} (Conversation: ${classification.conversationId}). Extension shell active. Native host not connected.`,
    };

    return this.state;
  }

  /**
   * Action: Explicit User Detach
   */
  public detach(): AttachState {
    this.cleanupObservers();

    this.state = {
      status: 'detached',
      providerId: null,
      tabId: null,
      url: null,
      conversationId: null,
      pageState: 'unsupported-page',
      lastExtractedAt: null,
      lastResponseSummary: null,
      activeDraft: null,
      isCoreConnected: false,
      statusMessage: 'Extension detached by user. Active observation stopped.',
    };

    return this.state;
  }

  /**
   * Safe Navigation Handler:
   * Tab navigated or changed: invalidates prior conversation identity and stale response.
   */
  public handleNavigation(newUrl: string, doc: MinimalDocument): AttachState {
    if (this.state.status !== 'attached' && this.state.status !== 'paused') {
      return this.state;
    }

    this.cleanupObservers();

    if (!this.providerAdapter.isSupportedUrl(newUrl)) {
      this.state = {
        ...this.state,
        status: 'paused',
        url: newUrl,
        conversationId: null,
        pageState: 'unsupported-page',
        lastResponseSummary: null,
        statusMessage: 'Paused: Tab navigated away from supported provider URL.',
        safePauseReason: 'Navigation outside supported domain',
      };
      return this.state;
    }

    const classification = this.providerAdapter.classifyPage(doc, newUrl);
    const conversationChanged = classification.conversationId !== this.state.conversationId;

    this.state = {
      ...this.state,
      status: classification.canExtract ? 'attached' : 'paused',
      url: newUrl,
      conversationId: classification.conversationId ?? null,
      pageState: classification.state,
      // Invalidate stale responses and draft if conversation changed
      lastExtractedAt: conversationChanged ? null : this.state.lastExtractedAt,
      lastResponseSummary: conversationChanged ? null : this.state.lastResponseSummary,
      activeDraft: conversationChanged ? null : this.state.activeDraft,
      statusMessage: conversationChanged
        ? `Conversation changed to ${classification.conversationId}. Stale responses cleared.`
        : `Page updated: ${classification.state}.`,
      safePauseReason: classification.canExtract ? undefined : classification.reason,
    };

    return this.state;
  }

  /**
   * Record newly extracted response
   */
  public recordExtraction(extraction: ExtractedResponse): void {
    if (this.state.status !== 'attached') return;

    this.state = {
      ...this.state,
      lastExtractedAt: extraction.extractedAt,
      lastResponseSummary: extraction.rawText.slice(0, 100),
      pageState: 'response-complete',
    };
  }

  public registerObserverCleanup(cleanup: ObserverCleanup): void {
    this.cleanups.push(cleanup);
  }

  public cleanupObservers(): void {
    for (const c of this.cleanups) {
      try {
        c();
      } catch {
        // ignore cleanup error
      }
    }
    this.cleanups = [];
  }
}
