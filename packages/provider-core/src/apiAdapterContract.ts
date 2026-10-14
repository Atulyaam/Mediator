/**
 * @mediator/provider-core — Official API Adapter Contract (Sprint S29)
 *
 * Defines the shared, typed contract for Mode B (Official API Connection) adapters.
 *
 * Requirements:
 * - Clear distinction from Mode A (Browser Session Bridge).
 * - Normalized request, response, and error structures.
 * - Explicit streaming, cancellation, timeout, and usage tracking support.
 * - Fixed base URLs; prevents arbitrary URL redirection.
 * - Zero logging of raw secrets or authorization headers.
 */

import {
  type CanonicalProviderId,
  type ProviderMetadata,
  type ProviderUsageMetadata,
  type Result,
  type MediatorError,
} from '@mediator/shared-contracts';

export interface ProviderApiMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ProviderApiRequest {
  readonly providerId: CanonicalProviderId;
  readonly modelId: string;
  readonly messages: readonly ProviderApiMessage[];
  readonly systemPrompt?: string | undefined;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly taskId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly correlationId?: string | undefined;
}

export interface ProviderApiResponse {
  readonly providerId: CanonicalProviderId;
  readonly modelId: string;
  readonly content: string;
  readonly reasoningContent?: string | undefined;
  readonly usage?: ProviderUsageMetadata | undefined;
  readonly finishReason?: string | undefined;
  readonly completedAt: number;
}

export interface ProviderRequestOptions {
  readonly apiKey?: string | undefined; // Passed from credential store at runtime
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly maxRetries?: number | undefined;
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly providerId: CanonicalProviderId;
  readonly latencyMs: number;
  readonly message: string;
  readonly availableModels?: readonly string[] | undefined;
}

export interface AIProviderApiAdapter {
  readonly providerId: CanonicalProviderId;
  readonly metadata: ProviderMetadata;

  validateRequest(request: ProviderApiRequest): Result<void, MediatorError>;

  sendMessage(
    request: ProviderApiRequest,
    options?: ProviderRequestOptions,
  ): Promise<Result<ProviderApiResponse, MediatorError>>;

  streamMessage(
    request: ProviderApiRequest,
    onChunk: (textChunk: string) => void,
    options?: ProviderRequestOptions,
  ): Promise<Result<ProviderApiResponse, MediatorError>>;

  testConnection(apiKey: string): Promise<Result<ConnectionTestResult, MediatorError>>;
}
