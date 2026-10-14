/**
 * @mediator/browser-extension — Provider Registry & Continuity Authority (Sprint S27, S29)
 *
 * Requirements:
 * - Registers and manages all four supported AI provider adapters (Gemini, ChatGPT, Claude, DeepSeek).
 * - Matches current tab URL to appropriate provider adapter.
 * - Prevents silent provider switching: if a session is attached to Provider A
 *   and tab changes to Provider B, forces a safe pause.
 * - Prevents inheriting approvals, pending operations, or state across provider boundaries.
 * - Requires explicit user action to switch active provider.
 */

import { normalizeProviderId } from '@mediator/shared-contracts';
import { type ProviderAdapter } from './providerAdapter.js';
import { GeminiProviderAdapter } from './geminiProviderAdapter.js';
import { ChatGPTProviderAdapter } from './chatgptProviderAdapter.js';
import { ClaudeProviderAdapter } from './claudeProviderAdapter.js';
import { DeepSeekProviderAdapter } from './deepseekProviderAdapter.js';

export interface ProviderSwitchValidationResult {
  readonly allowed: boolean;
  readonly reason?: string | undefined;
}

export class ProviderRegistry {
  private readonly adapters: Map<string, ProviderAdapter> = new Map();

  constructor(customAdapters?: readonly ProviderAdapter[]) {
    if (customAdapters && customAdapters.length > 0) {
      for (const adapter of customAdapters) {
        this.adapters.set(adapter.providerId, adapter);
      }
    } else {
      // All four supported providers in Mediator
      const gemini = new GeminiProviderAdapter();
      const chatgpt = new ChatGPTProviderAdapter();
      const claude = new ClaudeProviderAdapter();
      const deepseek = new DeepSeekProviderAdapter();

      this.adapters.set(gemini.providerId, gemini);
      this.adapters.set('gemini', gemini);

      this.adapters.set(chatgpt.providerId, chatgpt);
      this.adapters.set('openai', chatgpt);

      this.adapters.set(claude.providerId, claude);
      this.adapters.set('anthropic', claude);

      this.adapters.set(deepseek.providerId, deepseek);
    }
  }

  public getAdapter(providerId: string): ProviderAdapter | undefined {
    if (!providerId) return undefined;
    const direct = this.adapters.get(providerId);
    if (direct) return direct;

    const normalized = normalizeProviderId(providerId);
    if (normalized) {
      return this.adapters.get(normalized);
    }
    return undefined;
  }

  public getAdapterForUrl(url: string): ProviderAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.isSupportedUrl(url)) {
        return adapter;
      }
    }
    return undefined;
  }

  public listRegisteredProviders(): readonly { readonly providerId: string; readonly name: string }[] {
    const seen = new Set<string>();
    const list: { providerId: string; name: string }[] = [];

    // Return unique canonical entries
    for (const [key, adapter] of this.adapters.entries()) {
      const canonical = normalizeProviderId(key) ?? adapter.providerId;
      if (!seen.has(canonical)) {
        seen.add(canonical);
        list.push({
          providerId: canonical,
          name: adapter.name,
        });
      }
    }
    return list;
  }

  /**
   * Validates whether a provider transition is permitted.
   * INVARIANT: Never silently switch providers or inherit existing approvals/state.
   */
  public validateProviderTransition(
    currentProviderId: string | null,
    targetProviderId: string,
    hasActiveApprovalsOrActions: boolean,
  ): ProviderSwitchValidationResult {
    const targetAdapter = this.getAdapter(targetProviderId);
    if (!targetAdapter) {
      return {
        allowed: false,
        reason: `Target provider "${targetProviderId}" is not registered.`,
      };
    }

    const currentNormalized = currentProviderId ? (normalizeProviderId(currentProviderId) ?? currentProviderId) : null;
    const targetNormalized = normalizeProviderId(targetProviderId) ?? targetProviderId;

    if (currentNormalized && currentNormalized !== targetNormalized) {
      if (hasActiveApprovalsOrActions) {
        return {
          allowed: false,
          reason: `Cannot switch provider from "${currentProviderId}" to "${targetProviderId}" while active operations or approvals are pending. Invalidate or complete pending operations first.`,
        };
      }
    }

    return { allowed: true };
  }
}
