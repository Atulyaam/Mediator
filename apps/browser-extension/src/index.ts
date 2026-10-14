/**
 * @mediator/browser-extension
 *
 * Manifest V3 browser extension shell and provider adapter fixtures (Sprint S18).
 * Observes supported AI provider page states, enforces bounded extraction,
 * and enables safe manual draft preparation.
 */

export const BROWSER_EXTENSION_VERSION = '0.0.1';

export * from './providerTypes.js';
export * from './providerAdapter.js';
export * from './geminiProviderAdapter.js';
export * from './chatgptProviderAdapter.js';
export * from './claudeProviderAdapter.js';
export * from './deepseekProviderAdapter.js';
export * from './providerRegistry.js';
export * from './attachManager.js';
export * from './draftManager.js';
export * from './sameChatManager.js';
export * from './nativeBridgeClient.js';
export * from './fixtures/geminiFixtures.js';
export * from './fixtures/chatgptFixtures.js';
export * from './fixtures/deepseekFixtures.js';

