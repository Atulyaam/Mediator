/**
 * @mediator/provider-core
 *
 * Unified Four-Provider Architecture for Mediator:
 * - OpenAI ChatGPT (`openai`)
 * - Google Gemini (`gemini`)
 * - Anthropic Claude (`claude`)
 * - DeepSeek (`deepseek`)
 *
 * Supports Mode A (Browser Session Bridge) and Mode B (Official API Connection).
 */

export * from './catalogues.js';
export * from './credentialStore.js';
export * from './apiAdapterContract.js';
export * from './canonicalRegistry.js';
export * from './claudeApiAdapter.js';
export * from './deepseekApiAdapter.js';
export * from './openaiApiAdapter.js';
export * from './geminiApiAdapter.js';
