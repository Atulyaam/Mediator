import { describe, it, expect, beforeEach } from 'vitest';
import {
  CANONICAL_PROVIDER_IDS,
  PROVIDER_MODES,
  serializeConnectionId,
  parseConnectionId,
  normalizeProviderId,
  isCanonicalProviderId,
  ErrorCode,
} from '@mediator/shared-contracts';
import {
  AUTHORITATIVE_PROVIDER_METADATA,
  UnifiedProviderRegistry,
} from './index.js';

describe('Unified Provider Architecture', () => {
  describe('Canonical Provider IDs and Connection Identifiers', () => {
    it('defines exactly the four authoritative provider IDs', () => {
      expect(CANONICAL_PROVIDER_IDS).toEqual(['openai', 'gemini', 'claude', 'deepseek']);
      expect(PROVIDER_MODES).toEqual(['browser', 'api', 'manual']);
    });

    it('validates canonical provider IDs', () => {
      expect(isCanonicalProviderId('openai')).toBe(true);
      expect(isCanonicalProviderId('gemini')).toBe(true);
      expect(isCanonicalProviderId('claude')).toBe(true);
      expect(isCanonicalProviderId('deepseek')).toBe(true);
      expect(isCanonicalProviderId('unknown-provider')).toBe(false);
    });

    it('normalizes legacy and alias provider names correctly', () => {
      expect(normalizeProviderId('google-gemini')).toBe('gemini');
      expect(normalizeProviderId('openai-chatgpt')).toBe('openai');
      expect(normalizeProviderId('chatgpt')).toBe('openai');
      expect(normalizeProviderId('anthropic')).toBe('claude');
      expect(normalizeProviderId('claude')).toBe('claude');
      expect(normalizeProviderId('deepseek')).toBe('deepseek');
      expect(normalizeProviderId('invalid')).toBeUndefined();
    });

    it('serializes connection IDs accurately', () => {
      expect(serializeConnectionId({ provider: 'openai', mode: 'browser' })).toBe('openai:browser');
      expect(
        serializeConnectionId({
          provider: 'claude',
          mode: 'manual',
          accountOrSessionId: 'session-xyz',
        }),
      ).toBe('claude:manual:session-xyz');
    });

    it('parses valid connection IDs and normalizes aliases', () => {
      const res1 = parseConnectionId('gemini:browser');
      expect(res1.ok).toBe(true);
      if (res1.ok) {
        expect(res1.value).toEqual({ provider: 'gemini', mode: 'browser' });
      }

      const res2 = parseConnectionId('google-gemini:manual:sess-1');
      expect(res2.ok).toBe(true);
      if (res2.ok) {
        expect(res2.value).toEqual({
          provider: 'gemini',
          mode: 'manual',
          accountOrSessionId: 'sess-1',
        });
      }
    });

    it('rejects invalid connection strings fail-closed', () => {
      expect(parseConnectionId('').ok).toBe(false);
      expect(parseConnectionId('invalid-string-no-colons').ok).toBe(false);
      expect(parseConnectionId('fake:browser').ok).toBe(false);
    });
  });

  describe('Unified Provider Registry', () => {
    let registry: UnifiedProviderRegistry;

    beforeEach(() => {
      registry = new UnifiedProviderRegistry({
        defaultProvider: 'gemini',
        defaultMode: 'browser',
      });
    });

    it('initializes with default provider and lists all four providers', () => {
      expect(registry.getActiveProviderId()).toBe('gemini');
      expect(registry.getActiveMode()).toBe('browser');

      const all = registry.listAllProviders();
      expect(all.map((p) => p.providerId)).toEqual(['openai', 'gemini', 'claude', 'deepseek']);
    });

    it('allows valid provider and mode selection', () => {
      const res = registry.selectProvider('openai', 'browser');
      expect(res.ok).toBe(true);
      expect(registry.getActiveProviderId()).toBe('openai');
      expect(registry.getActiveMode()).toBe('browser');
    });

    it('rejects unknown provider selection fail-closed', () => {
      const res = registry.selectProvider('nonexistent', 'browser');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PROVIDER_UNKNOWN);
      }
      // Active provider unchanged
      expect(registry.getActiveProviderId()).toBe('gemini');
    });

    it('rejects unsupported mode for a provider', () => {
      const res = registry.selectProvider('claude', 'unsupported-mode');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PROVIDER_MODE_UNSUPPORTED);
      }
    });

    it('blocks provider switching when approvals or actions are pending', () => {
      const blockedRes = registry.selectProvider('claude', 'manual', true);
      expect(blockedRes.ok).toBe(false);
      if (!blockedRes.ok) {
        expect(blockedRes.error.code).toBe(ErrorCode.PROVIDER_SWITCH_NOT_ALLOWED);
        expect(blockedRes.error.message).toContain('active operations or approvals are pending');
      }
      expect(registry.getActiveProviderId()).toBe('gemini');
    });

    it('validates model selection against provider catalogue', () => {
      const validRes = registry.selectModel('openai', 'o3-mini');
      expect(validRes.ok).toBe(true);
      expect(registry.getSelectedModel('openai')).toBe('o3-mini');

      const invalidRes = registry.selectModel('openai', 'gpt-invented-model');
      expect(invalidRes.ok).toBe(false);
      if (!invalidRes.ok) {
        expect(invalidRes.error.code).toBe(ErrorCode.PROVIDER_MODEL_UNSUPPORTED);
      }
    });

    it('produces honest status summaries without misleading green indicators', async () => {
      registry.selectProvider('openai', 'browser');
      let summaries = await registry.getProviderStatusSummary();
      let openaiSummary = summaries.find((s) => s.providerId === 'openai');

      expect(openaiSummary?.status).toBe('not-configured');
      expect(openaiSummary?.displayName).toBe('OpenAI ChatGPT');
      expect(openaiSummary?.activeMode).toBe('browser');

      registry.setConnectionStatus('openai', 'connected');
      summaries = await registry.getProviderStatusSummary();
      openaiSummary = summaries.find((s) => s.providerId === 'openai');
      expect(openaiSummary?.status).toBe('connected');
    });

    it('tracks connection errors and clears them on successful connection', async () => {
      registry.setConnectionStatus('deepseek', 'auth-failed', 'Session disconnected.');
      let summaries = await registry.getProviderStatusSummary();
      let ds = summaries.find((s) => s.providerId === 'deepseek');
      expect(ds?.status).toBe('auth-failed');
      expect(ds?.lastError).toBe('Session disconnected.');

      // Mark connected clears error
      registry.setConnectionStatus('deepseek', 'connected');
      summaries = await registry.getProviderStatusSummary();
      ds = summaries.find((s) => s.providerId === 'deepseek');
      expect(ds?.status).toBe('connected');
      expect(ds?.lastError).toBeUndefined();
    });
  });
});
