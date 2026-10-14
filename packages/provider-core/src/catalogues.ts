/**
 * @mediator/provider-core — Authoritative Provider Catalogues (Sprint S29, S30, S31)
 *
 * Official metadata, validated model definitions, and capability specifications
 * for the four supported AI providers:
 * 1. OpenAI ChatGPT (`openai`)
 * 2. Google Gemini (`gemini`)
 * 3. Anthropic Claude (`claude`)
 * 4. DeepSeek (`deepseek`)
 *
 * Sourced directly from official developer documentation:
 * - OpenAI: https://platform.openai.com/docs
 * - Gemini: https://ai.google.dev/gemini-api/docs
 * - Claude: https://docs.anthropic.com/en/api
 * - DeepSeek: https://api-docs.deepseek.com
 */

import {
  type CanonicalProviderId,
  type ProviderMetadata,
  type ProviderModelConfig,
} from '@mediator/shared-contracts';

export const OPENAI_MODELS: readonly ProviderModelConfig[] = [
  {
    id: 'gpt-4o',
    displayName: 'GPT-4o (Omni)',
    contextWindowTokens: 128000,
    defaultMaxTokens: 4096,
    inputCostPerMillionUsd: 2.5,
    outputCostPerMillionUsd: 10.0,
    recommended: true,
  },
  {
    id: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    contextWindowTokens: 128000,
    defaultMaxTokens: 4096,
    inputCostPerMillionUsd: 0.15,
    outputCostPerMillionUsd: 0.6,
  },
  {
    id: 'o1',
    displayName: 'o1 (Reasoning)',
    contextWindowTokens: 200000,
    defaultMaxTokens: 8192,
    inputCostPerMillionUsd: 15.0,
    outputCostPerMillionUsd: 60.0,
  },
  {
    id: 'o3-mini',
    displayName: 'o3-mini (High Speed Reasoning)',
    contextWindowTokens: 200000,
    defaultMaxTokens: 8192,
    inputCostPerMillionUsd: 1.1,
    outputCostPerMillionUsd: 4.4,
  },
];

export const GEMINI_MODELS: readonly ProviderModelConfig[] = [
  {
    id: 'gemini-1.5-pro',
    displayName: 'Gemini 1.5 Pro',
    contextWindowTokens: 2000000,
    defaultMaxTokens: 8192,
    inputCostPerMillionUsd: 3.5,
    outputCostPerMillionUsd: 10.5,
    recommended: true,
  },
  {
    id: 'gemini-1.5-flash',
    displayName: 'Gemini 1.5 Flash',
    contextWindowTokens: 1000000,
    defaultMaxTokens: 8192,
    inputCostPerMillionUsd: 0.075,
    outputCostPerMillionUsd: 0.3,
  },
  {
    id: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    contextWindowTokens: 1000000,
    defaultMaxTokens: 8192,
    inputCostPerMillionUsd: 0.1,
    outputCostPerMillionUsd: 0.4,
  },
];

export const CLAUDE_MODELS: readonly ProviderModelConfig[] = [
  {
    id: 'claude-3-5-sonnet-20241022',
    displayName: 'Claude 3.5 Sonnet (Latest)',
    contextWindowTokens: 200000,
    defaultMaxTokens: 8192,
    inputCostPerMillionUsd: 3.0,
    outputCostPerMillionUsd: 15.0,
    recommended: true,
  },
  {
    id: 'claude-3-5-haiku-20241022',
    displayName: 'Claude 3.5 Haiku',
    contextWindowTokens: 200000,
    defaultMaxTokens: 8192,
    inputCostPerMillionUsd: 0.8,
    outputCostPerMillionUsd: 4.0,
  },
  {
    id: 'claude-3-opus-20240229',
    displayName: 'Claude 3 Opus',
    contextWindowTokens: 200000,
    defaultMaxTokens: 4096,
    inputCostPerMillionUsd: 15.0,
    outputCostPerMillionUsd: 75.0,
  },
];

export const DEEPSEEK_MODELS: readonly ProviderModelConfig[] = [
  {
    id: 'deepseek-chat',
    displayName: 'DeepSeek-V3 (Chat)',
    contextWindowTokens: 64000,
    defaultMaxTokens: 8192,
    inputCostPerMillionUsd: 0.27,
    outputCostPerMillionUsd: 1.1,
    recommended: true,
  },
  {
    id: 'deepseek-reasoner',
    displayName: 'DeepSeek-R1 (Reasoner)',
    contextWindowTokens: 64000,
    defaultMaxTokens: 8192,
    inputCostPerMillionUsd: 0.55,
    outputCostPerMillionUsd: 2.19,
  },
];

export const AUTHORITATIVE_PROVIDER_METADATA: Record<CanonicalProviderId, ProviderMetadata> = {
  openai: {
    providerId: 'openai',
    displayName: 'OpenAI ChatGPT',
    description: 'OpenAI official models (GPT-4o, o1, o3-mini) via official API or ChatGPT browser bridge.',
    officialWebsiteUrl: 'https://chatgpt.com',
    officialApiDocsUrl: 'https://platform.openai.com/docs',
    supportedModes: ['browser', 'api', 'manual'],
    capabilities: {
      supportsBrowserBridge: true,
      supportsOfficialApi: true,
      supportsManualHandoff: true,
      supportsStreaming: true,
      supportsCancellation: true,
      supportsModelSelection: true,
      supportsUsageTracking: true,
      supportsCostEstimation: true,
      supportsSystemPrompt: true,
      supportsImageInput: false,
    },
    availableModels: OPENAI_MODELS,
    defaultModelId: 'gpt-4o',
  },

  gemini: {
    providerId: 'gemini',
    displayName: 'Google Gemini',
    description: 'Google Gemini models (1.5 Pro, 1.5 Flash, 2.0 Flash) via official API or Gemini browser bridge.',
    officialWebsiteUrl: 'https://gemini.google.com',
    officialApiDocsUrl: 'https://ai.google.dev/gemini-api/docs',
    supportedModes: ['browser', 'api', 'manual'],
    capabilities: {
      supportsBrowserBridge: true,
      supportsOfficialApi: true,
      supportsManualHandoff: true,
      supportsStreaming: true,
      supportsCancellation: true,
      supportsModelSelection: true,
      supportsUsageTracking: true,
      supportsCostEstimation: true,
      supportsSystemPrompt: true,
      supportsImageInput: true,
    },
    availableModels: GEMINI_MODELS,
    defaultModelId: 'gemini-1.5-pro',
  },

  claude: {
    providerId: 'claude',
    displayName: 'Anthropic Claude',
    description: 'Anthropic Claude models (3.5 Sonnet, 3.5 Haiku, 3 Opus) via official Messages API or manual browser handoff.',
    officialWebsiteUrl: 'https://claude.ai',
    officialApiDocsUrl: 'https://docs.anthropic.com/en/api',
    supportedModes: ['api', 'manual', 'browser'],
    capabilities: {
      supportsBrowserBridge: false, // Browser bridge uses manual-only handoff for Claude (terms compliance)
      supportsOfficialApi: true,
      supportsManualHandoff: true,
      supportsStreaming: true,
      supportsCancellation: true,
      supportsModelSelection: true,
      supportsUsageTracking: true,
      supportsCostEstimation: true,
      supportsSystemPrompt: true,
      supportsImageInput: false,
    },
    availableModels: CLAUDE_MODELS,
    defaultModelId: 'claude-3-5-sonnet-20241022',
  },

  deepseek: {
    providerId: 'deepseek',
    displayName: 'DeepSeek',
    description: 'DeepSeek models (V3 Chat, R1 Reasoner) via official OpenAI-compatible API or manual browser handoff.',
    officialWebsiteUrl: 'https://chat.deepseek.com',
    officialApiDocsUrl: 'https://api-docs.deepseek.com',
    supportedModes: ['api', 'manual', 'browser'],
    capabilities: {
      supportsBrowserBridge: false, // Browser bridge uses manual-only handoff for DeepSeek
      supportsOfficialApi: true,
      supportsManualHandoff: true,
      supportsStreaming: true,
      supportsCancellation: true,
      supportsModelSelection: true,
      supportsUsageTracking: true,
      supportsCostEstimation: true,
      supportsSystemPrompt: true,
      supportsImageInput: false,
    },
    availableModels: DEEPSEEK_MODELS,
    defaultModelId: 'deepseek-chat',
  },
};

export function calculateEstimatedCost(
  providerId: CanonicalProviderId,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const meta = AUTHORITATIVE_PROVIDER_METADATA[providerId];
  if (!meta) return undefined;

  const model = meta.availableModels.find((m) => m.id === modelId);
  if (!model || model.inputCostPerMillionUsd === undefined || model.outputCostPerMillionUsd === undefined) {
    return undefined;
  }

  const inputCost = (inputTokens / 1_000_000) * model.inputCostPerMillionUsd;
  const outputCost = (outputTokens / 1_000_000) * model.outputCostPerMillionUsd;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}
