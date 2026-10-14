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
  SecureCredentialStore,
  AUTHORITATIVE_PROVIDER_METADATA,
  UnifiedProviderRegistry,
} from './index.js';

describe('Sprint S29 — Unified Four-Provider Architecture', () => {
  describe('29.2 Canonical Provider IDs and Connection Identifiers', () => {
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
          mode: 'api',
          accountOrSessionId: 'session-xyz',
        }),
      ).toBe('claude:api:session-xyz');
    });

    it('parses valid connection IDs and normalizes aliases', () => {
      const res1 = parseConnectionId('gemini:browser');
      expect(res1.ok).toBe(true);
      if (res1.ok) {
        expect(res1.value).toEqual({ provider: 'gemini', mode: 'browser' });
      }

      const res2 = parseConnectionId('google-gemini:api:sess-1');
      expect(res2.ok).toBe(true);
      if (res2.ok) {
        expect(res2.value).toEqual({
          provider: 'gemini',
          mode: 'api',
          accountOrSessionId: 'sess-1',
        });
      }

      const res3 = parseConnectionId('deepseek:manual');
      expect(res3.ok).toBe(true);
      if (res3.ok) {
        expect(res3.value).toEqual({ provider: 'deepseek', mode: 'manual' });
      }
    });

    it('rejects unknown provider in connection ID fail-closed', () => {
      const res = parseConnectionId('unsupported-llm:api');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PROVIDER_UNKNOWN);
      }
    });

    it('rejects unsupported mode in connection ID fail-closed', () => {
      const res = parseConnectionId('openai:unsupported-mode');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PROVIDER_MODE_UNSUPPORTED);
      }
    });

    it('rejects malformed connection IDs', () => {
      expect(parseConnectionId('').ok).toBe(false);
      expect(parseConnectionId('singleword').ok).toBe(false);
      expect(parseConnectionId('too:many:parts:here').ok).toBe(false);
    });
  });

  describe('29.4 Official Metadata and Model Catalogues', () => {
    it('provides complete metadata for all four providers', () => {
      for (const id of CANONICAL_PROVIDER_IDS) {
        const meta = AUTHORITATIVE_PROVIDER_METADATA[id];
        expect(meta).toBeDefined();
        expect(meta.providerId).toBe(id);
        expect(meta.displayName.length).toBeGreaterThan(0);
        expect(meta.officialWebsiteUrl).toMatch(/^https:\/\//);
        expect(meta.officialApiDocsUrl).toMatch(/^https:\/\//);
        expect(meta.availableModels.length).toBeGreaterThan(0);
        expect(meta.defaultModelId).toBeDefined();

        const defaultModel = meta.availableModels.find((m) => m.id === meta.defaultModelId);
        expect(defaultModel).toBeDefined();
        expect(defaultModel?.recommended).toBe(true);
      }
    });

    it('models have valid context window and pricing metadata', () => {
      const gpt4o = AUTHORITATIVE_PROVIDER_METADATA.openai.availableModels.find((m) => m.id === 'gpt-4o');
      expect(gpt4o?.contextWindowTokens).toBe(128000);
      expect(gpt4o?.inputCostPerMillionUsd).toBe(2.5);

      const sonnet = AUTHORITATIVE_PROVIDER_METADATA.claude.availableModels.find(
        (m) => m.id === 'claude-3-5-sonnet-20241022',
      );
      expect(sonnet?.contextWindowTokens).toBe(200000);

      const r1 = AUTHORITATIVE_PROVIDER_METADATA.deepseek.availableModels.find(
        (m) => m.id === 'deepseek-reasoner',
      );
      expect(r1?.displayName).toContain('Reasoner');
    });
  });

  describe('30.3 & S29 Secure Credential Storage', () => {
    let store: SecureCredentialStore;

    beforeEach(() => {
      store = new SecureCredentialStore({ inMemory: true, masterSecret: 'test-secret' });
    });

    it('encrypts and stores credentials without exposing raw secrets', async () => {
      const setRes = await store.setCredential('openai', 'sk-proj-testkey1234567890abcdef');
      expect(setRes.ok).toBe(true);
      if (setRes.ok) {
        expect(setRes.value.providerId).toBe('openai');
        expect(setRes.value.lastFour).toBe('cdef');
        expect(setRes.value.keyHash.length).toBe(12);
        // Ensure raw key is not in metadata
        expect((setRes.value as any).rawKey).toBeUndefined();
        expect((setRes.value as any).apiKey).toBeUndefined();
      }

      // Check has credential
      expect(await store.hasCredential('openai')).toBe(true);
      expect(await store.hasCredential('gemini')).toBe(false);

      // Decrypt internal
      const decRes = await store.getDecryptedCredential('openai');
      expect(decRes.ok).toBe(true);
      if (decRes.ok) {
        expect(decRes.value).toBe('sk-proj-testkey1234567890abcdef');
      }
    });

    it('rejects short or empty keys fail-closed', async () => {
      const res = await store.setCredential('claude', 'short');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PROVIDER_CREDENTIAL_INVALID);
      }
    });

    it('rejects unknown provider in credential storage', async () => {
      const res = await store.setCredential('invalid' as any, 'valid-long-secret-key-12345');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PROVIDER_UNKNOWN);
      }
    });

    it('replaces credentials cleanly and updates timestamp', async () => {
      await store.setCredential('deepseek', 'sk-deepseek-initial-key-1111');
      const meta1 = await store.getMetadata('deepseek');
      expect(meta1?.lastFour).toBe('1111');

      await store.setCredential('deepseek', 'sk-deepseek-replacement-key-2222');
      const meta2 = await store.getMetadata('deepseek');
      expect(meta2?.lastFour).toBe('2222');
      expect(meta2?.updatedAt).toBeGreaterThanOrEqual(meta1!.updatedAt);

      const decRes = await store.getDecryptedCredential('deepseek');
      expect(decRes.ok).toBe(true);
      if (decRes.ok) {
        expect(decRes.value).toBe('sk-deepseek-replacement-key-2222');
      }
    });

    it('deletes credentials explicitly', async () => {
      await store.setCredential('gemini', 'AIzaSyTestKey12345678901234567890');
      expect(await store.hasCredential('gemini')).toBe(true);

      const delRes = await store.removeCredential('gemini');
      expect(delRes.ok).toBe(true);
      expect(await store.hasCredential('gemini')).toBe(false);

      const getRes = await store.getDecryptedCredential('gemini');
      expect(getRes.ok).toBe(false);
      if (!getRes.ok) {
        expect(getRes.error.code).toBe(ErrorCode.PROVIDER_CREDENTIAL_MISSING);
      }
    });
  });

  describe('29.3 & 29.5 Unified Provider Registry', () => {
    let registry: UnifiedProviderRegistry;
    let store: SecureCredentialStore;

    beforeEach(() => {
      store = new SecureCredentialStore({ inMemory: true });
      registry = new UnifiedProviderRegistry({
        defaultProvider: 'gemini',
        defaultMode: 'browser',
        credentialStore: store,
      });
    });

    it('initializes with default provider and lists all four providers', () => {
      expect(registry.getActiveProviderId()).toBe('gemini');
      expect(registry.getActiveMode()).toBe('browser');

      const all = registry.listAllProviders();
      expect(all.map((p) => p.providerId)).toEqual(['openai', 'gemini', 'claude', 'deepseek']);
    });

    it('allows valid provider and mode selection', () => {
      const res = registry.selectProvider('openai', 'api');
      expect(res.ok).toBe(true);
      expect(registry.getActiveProviderId()).toBe('openai');
      expect(registry.getActiveMode()).toBe('api');
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
      // Claude does not support automated browser bridge (manual handoff and API only)
      const res = registry.selectProvider('claude', 'unsupported-mode');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PROVIDER_MODE_UNSUPPORTED);
      }
    });

    it('blocks provider switching when approvals or actions are pending', () => {
      const blockedRes = registry.selectProvider('claude', 'api', true);
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
      // Initially, API mode with no key is user-action-required or not-configured
      registry.selectProvider('openai', 'api');
      let summaries = await registry.getProviderStatusSummary();
      const openaiSummary = summaries.find((s) => s.providerId === 'openai');

      expect(openaiSummary?.status).toBe('user-action-required');
      expect(openaiSummary?.hasCredential).toBe(false);

      // Now configure credential
      await store.setCredential('openai', 'sk-test-fakekey1234567890');
      summaries = await registry.getProviderStatusSummary();
      const updatedOpenai = summaries.find((s) => s.providerId === 'openai');
      expect(updatedOpenai?.hasCredential).toBe(true);
      expect(updatedOpenai?.keyLastFour).toBe('...7890');
    });

    it('tracks connection errors and clears them on successful connection', async () => {
      registry.setConnectionStatus('deepseek', 'auth-failed', 'Invalid API key provided.');
      let summaries = await registry.getProviderStatusSummary();
      let ds = summaries.find((s) => s.providerId === 'deepseek');
      expect(ds?.status).toBe('auth-failed');
      expect(ds?.lastError).toBe('Invalid API key provided.');

      // Mark connected clears error
      registry.setConnectionStatus('deepseek', 'connected');
      summaries = await registry.getProviderStatusSummary();
      ds = summaries.find((s) => s.providerId === 'deepseek');
      expect(ds?.status).toBe('connected');
      expect(ds?.lastError).toBeUndefined();
    });
  });
});
