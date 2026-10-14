/**
 * @mediator/provider-core — OpenAI ChatGPT API Adapter (Sprint S32)
 *
 * Implements Mode B (Official API Connection) for OpenAI ChatGPT.
 * - Uses official OpenAI Chat Completions API: https://api.openai.com/v1/chat/completions
 * - Auth: Authorization: Bearer <key>
 * - Models: gpt-4o, gpt-4o-mini, o1, o3-mini
 * - Normalized error mapping, bounded retries, timeout, cancellation, usage metrics.
 * - Zero secret logging. Strictly typed (zero any).
 */

import {
  type CanonicalProviderId,
  type ProviderMetadata,
  type ProviderUsageMetadata,
  type Result,
  type MediatorError,
  type ErrorCodeValue,
  ErrorCode,
  makeMediatorError,
  ok,
  err,
} from '@mediator/shared-contracts';
import {
  type AIProviderApiAdapter,
  type ProviderApiRequest,
  type ProviderApiResponse,
  type ProviderRequestOptions,
  type ConnectionTestResult,
} from './apiAdapterContract.js';
import {
  AUTHORITATIVE_PROVIDER_METADATA,
  OPENAI_MODELS,
  calculateEstimatedCost,
} from './catalogues.js';

export interface OpenAiApiAdapterOptions {
  readonly fetchFn?: typeof fetch | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
}

interface OpenAiUsagePayload {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

interface OpenAiChoicePayload {
  readonly index?: number;
  readonly message?: {
    readonly role?: string;
    readonly content?: string;
  };
  readonly finish_reason?: string;
}

interface OpenAiResponsePayload {
  readonly id?: string;
  readonly choices?: readonly OpenAiChoicePayload[];
  readonly usage?: OpenAiUsagePayload;
}

interface OpenAiErrorPayload {
  readonly error?: {
    readonly message?: string;
  };
}

const OFFICIAL_OPENAI_COMPLETIONS_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MAX_PAYLOAD_CHARS = 500_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;

export class OpenAiApiAdapter implements AIProviderApiAdapter {
  readonly providerId: CanonicalProviderId = 'openai';
  readonly metadata: ProviderMetadata = AUTHORITATIVE_PROVIDER_METADATA.openai;

  private readonly _fetch: typeof fetch;
  private readonly _defaultTimeoutMs: number;
  private readonly _maxRetries: number;

  constructor(options?: OpenAiApiAdapterOptions) {
    this._fetch = options?.fetchFn ?? globalThis.fetch;
    this._defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  private _makeError(code: ErrorCodeValue, message: string, request?: ProviderApiRequest): MediatorError {
    return makeMediatorError(code, message, {
      taskId: request?.taskId,
      sessionId: request?.sessionId,
    });
  }

  validateRequest(request: ProviderApiRequest): Result<void, MediatorError> {
    if (request.providerId !== 'openai') {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_UNKNOWN,
          `Expected providerId 'openai', received '${request.providerId}'`,
          request,
        ),
      );
    }

    const isSupportedModel = OPENAI_MODELS.some((m) => m.id === request.modelId);
    if (!isSupportedModel) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_MODEL_UNSUPPORTED,
          `Unsupported OpenAI model '${request.modelId}'. Supported: ${OPENAI_MODELS.map((m) => m.id).join(', ')}`,
          request,
        ),
      );
    }

    if (!request.messages || request.messages.length === 0) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_REQUEST_INVALID,
          'Messages array cannot be empty.',
          request,
        ),
      );
    }

    let totalChars = 0;
    for (const msg of request.messages) {
      if (!msg.content || typeof msg.content !== 'string') {
        return err(
          this._makeError(
            ErrorCode.PROVIDER_REQUEST_INVALID,
            'Message content must be a non-empty string.',
            request,
          ),
        );
      }
      totalChars += msg.content.length;
    }

    if (totalChars > MAX_PAYLOAD_CHARS) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_OVERSIZED_RESPONSE,
          `Request payload (${totalChars} chars) exceeds safety limit of ${MAX_PAYLOAD_CHARS} chars.`,
          request,
        ),
      );
    }

    return ok(undefined);
  }

  async sendMessage(
    request: ProviderApiRequest,
    options?: ProviderRequestOptions,
  ): Promise<Result<ProviderApiResponse, MediatorError>> {
    const validRes = this.validateRequest(request);
    if (!validRes.ok) return validRes;

    const apiKey = options?.apiKey;
    if (!apiKey || apiKey.trim().length === 0) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_CREDENTIAL_MISSING,
          'OpenAI API key is missing. Configure an API key in settings.',
          request,
        ),
      );
    }

    const formattedMessages = this._formatMessages(request);
    const bodyPayload: Record<string, unknown> = {
      model: request.modelId,
      messages: formattedMessages,
    };
    if (request.maxTokens !== undefined) {
      bodyPayload.max_tokens = request.maxTokens;
    }
    if (request.temperature !== undefined) {
      bodyPayload.temperature = request.temperature;
    }

    const maxRetries = options?.maxRetries ?? this._maxRetries;
    const timeoutMs = options?.timeoutMs ?? this._defaultTimeoutMs;

    let attempt = 0;
    while (attempt <= maxRetries) {
      attempt++;
      const abortCtrl = new AbortController();
      let isTimedOut = false;

      if (options?.signal) {
        if (options.signal.aborted) {
          return err(
            this._makeError(
              ErrorCode.PROVIDER_CANCELLED,
              'OpenAI API request cancelled by caller signal.',
              request,
            ),
          );
        }
        options.signal.addEventListener('abort', () => abortCtrl.abort(), { once: true });
      }

      const timeoutId = setTimeout(() => {
        isTimedOut = true;
        abortCtrl.abort();
      }, timeoutMs);

      try {
        const response = await this._fetch(OFFICIAL_OPENAI_COMPLETIONS_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(bodyPayload),
          signal: abortCtrl.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errRes = await this._handleErrorResponse(response, request);
          if (
            (response.status === 429 || response.status >= 500) &&
            attempt <= maxRetries
          ) {
            const delay = this._parseRetryDelay(response, attempt);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          return errRes;
        }

        const data = (await response.json()) as OpenAiResponsePayload;
        return this._parseOpenAiResponse(data, request);
      } catch (error: unknown) {
        clearTimeout(timeoutId);
        const errName = error instanceof Error ? error.name : '';
        const errMsg = error instanceof Error ? error.message : String(error);

        if (errName === 'AbortError' || abortCtrl.signal.aborted) {
          if (isTimedOut) {
            return err(
              this._makeError(
                ErrorCode.PROVIDER_TIMEOUT,
                `OpenAI API request timed out after ${timeoutMs}ms.`,
                request,
              ),
            );
          }
          return err(
            this._makeError(
              ErrorCode.PROVIDER_CANCELLED,
              'OpenAI API request cancelled.',
              request,
            ),
          );
        }

        if (attempt <= maxRetries) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }

        return err(
          this._makeError(
            ErrorCode.PROVIDER_OUTAGE,
            `OpenAI API network error: ${errMsg}`,
            request,
          ),
        );
      }
    }

    return err(
      this._makeError(
        ErrorCode.PROVIDER_OUTAGE,
        'OpenAI API retries exhausted.',
        request,
      ),
    );
  }

  async streamMessage(
    request: ProviderApiRequest,
    onChunk: (textChunk: string) => void,
    options?: ProviderRequestOptions,
  ): Promise<Result<ProviderApiResponse, MediatorError>> {
    const validRes = this.validateRequest(request);
    if (!validRes.ok) return validRes;

    const apiKey = options?.apiKey;
    if (!apiKey || apiKey.trim().length === 0) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_CREDENTIAL_MISSING,
          'OpenAI API key is missing.',
          request,
        ),
      );
    }

    const formattedMessages = this._formatMessages(request);
    const bodyPayload: Record<string, unknown> = {
      model: request.modelId,
      messages: formattedMessages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.maxTokens !== undefined) bodyPayload.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) bodyPayload.temperature = request.temperature;

    const timeoutMs = options?.timeoutMs ?? this._defaultTimeoutMs;
    const abortCtrl = new AbortController();
    let isTimedOut = false;

    if (options?.signal) {
      if (options.signal.aborted) {
        return err(
          this._makeError(
            ErrorCode.PROVIDER_CANCELLED,
            'OpenAI API request cancelled by caller signal.',
            request,
          ),
        );
      }
      options.signal.addEventListener('abort', () => abortCtrl.abort(), { once: true });
    }

    const timeoutId = setTimeout(() => {
      isTimedOut = true;
      abortCtrl.abort();
    }, timeoutMs);

    try {
      const response = await this._fetch(OFFICIAL_OPENAI_COMPLETIONS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyPayload),
        signal: abortCtrl.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return this._handleErrorResponse(response, request);
      }

      if (!response.body) {
        return err(
          this._makeError(
            ErrorCode.PROVIDER_MALFORMED_RESPONSE,
            'OpenAI API streaming response body is missing.',
            request,
          ),
        );
      }

      let accumulatedContent = '';
      let finishReason: string | undefined = undefined;
      let promptTokens = 0;
      let completionTokens = 0;

      const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const decoder = new TextDecoder();
      let buffer = '';
      let isStreaming = true;

      while (isStreaming) {
        const chunk = await reader.read();
        if (chunk.done || !chunk.value) {
          isStreaming = false;
          break;
        }

        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const eventData = JSON.parse(dataStr) as Record<string, unknown>;
              const choices = eventData.choices as ReadonlyArray<{
                delta?: { content?: string };
                finish_reason?: string;
              }> | undefined;

              const choice = choices?.[0];
              if (choice) {
                if (typeof choice.delta?.content === 'string') {
                  const textChunk = choice.delta.content;
                  accumulatedContent += textChunk;
                  onChunk(textChunk);
                }
                if (typeof choice.finish_reason === 'string') {
                  finishReason = choice.finish_reason;
                }
              }

              const usageObj = eventData.usage as OpenAiUsagePayload | undefined;
              if (usageObj) {
                if (typeof usageObj.prompt_tokens === 'number') promptTokens = usageObj.prompt_tokens;
                if (typeof usageObj.completion_tokens === 'number') completionTokens = usageObj.completion_tokens;
              }
            } catch {
              // Ignore unparseable line
            }
          }
        }
      }

      const totalTokens = promptTokens + completionTokens;
      const estimatedCostUsd = calculateEstimatedCost(
        'openai',
        request.modelId,
        promptTokens,
        completionTokens,
      );

      const usage: ProviderUsageMetadata | undefined =
        totalTokens > 0
          ? {
              inputTokens: promptTokens,
              outputTokens: completionTokens,
              totalTokens,
              estimatedCostUsd,
            }
          : undefined;

      return ok({
        providerId: 'openai',
        modelId: request.modelId,
        content: accumulatedContent,
        usage,
        finishReason: finishReason ?? 'stop',
        completedAt: Date.now(),
      });
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      const errName = error instanceof Error ? error.name : '';
      const errMsg = error instanceof Error ? error.message : String(error);

      if (errName === 'AbortError' || abortCtrl.signal.aborted) {
        if (isTimedOut) {
          return err(
            this._makeError(
              ErrorCode.PROVIDER_TIMEOUT,
              `OpenAI streaming request timed out after ${timeoutMs}ms.`,
              request,
            ),
          );
        }
        return err(
          this._makeError(
            ErrorCode.PROVIDER_CANCELLED,
            'OpenAI streaming request cancelled.',
            request,
          ),
        );
      }

      return err(
        this._makeError(
          ErrorCode.PROVIDER_OUTAGE,
          `OpenAI streaming error: ${errMsg}`,
          request,
        ),
      );
    }
  }

  async testConnection(apiKey: string): Promise<Result<ConnectionTestResult, MediatorError>> {
    if (!apiKey || apiKey.trim().length === 0) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_CREDENTIAL_MISSING,
          'Cannot test OpenAI connection: missing API key.',
        ),
      );
    }

    const startTime = Date.now();
    try {
      const response = await this._fetch(OFFICIAL_OPENAI_COMPLETIONS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return err(
            this._makeError(
              ErrorCode.PROVIDER_CREDENTIAL_INVALID,
              'OpenAI API key verification failed: unauthorized (HTTP 401/403).',
            ),
          );
        }
        if (response.status === 429) {
          return err(
            this._makeError(
              ErrorCode.PROVIDER_RATE_LIMITED,
              'OpenAI API rate limit reached during test.',
            ),
          );
        }
        return err(
          this._makeError(
            ErrorCode.PROVIDER_API_UNAVAILABLE,
            `OpenAI test connection failed with HTTP ${response.status}`,
          ),
        );
      }

      return ok({
        ok: true,
        providerId: 'openai',
        latencyMs,
        message: `Connected to OpenAI ChatGPT successfully (${latencyMs}ms).`,
        availableModels: OPENAI_MODELS.map((m) => m.id),
      });
    } catch (err_: unknown) {
      const latencyMs = Date.now() - startTime;
      const msg = err_ instanceof Error ? err_.message : String(err_);
      return err(
        this._makeError(
          ErrorCode.PROVIDER_OUTAGE,
          `OpenAI connection test network failure (${latencyMs}ms): ${msg}`,
        ),
      );
    }
  }

  private _formatMessages(request: ProviderApiRequest): Array<{ role: string; content: string }> {
    const formatted: Array<{ role: string; content: string }> = [];

    if (request.systemPrompt) {
      formatted.push({ role: 'system', content: request.systemPrompt });
    }

    for (const msg of request.messages) {
      formatted.push({ role: msg.role, content: msg.content });
    }

    return formatted;
  }

  private async _handleErrorResponse(
    response: Response,
    request: ProviderApiRequest,
  ): Promise<Result<never, MediatorError>> {
    let rawError = '';
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text) as OpenAiErrorPayload;
        rawError = json?.error?.message ?? JSON.stringify(json);
      } catch {
        rawError = text;
      }
    } catch {
      rawError = `HTTP ${response.status}`;
    }

    const safeMessage = rawError.slice(0, 300);

    if (response.status === 401 || response.status === 403) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_CREDENTIAL_INVALID,
          `OpenAI authentication failed (HTTP ${response.status}). Check configured API key.`,
          request,
        ),
      );
    }

    if (response.status === 400 || response.status === 404) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_MODEL_UNSUPPORTED,
          `OpenAI model or request unsupported: ${safeMessage}`,
          request,
        ),
      );
    }

    if (response.status === 429) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_RATE_LIMITED,
          `OpenAI API rate limit reached: ${safeMessage}`,
          request,
        ),
      );
    }

    if (response.status >= 500) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_OUTAGE,
          `OpenAI service outage (HTTP ${response.status}): ${safeMessage}`,
          request,
        ),
      );
    }

    return err(
      this._makeError(
        ErrorCode.PROVIDER_API_UNAVAILABLE,
        `OpenAI API error (HTTP ${response.status}): ${safeMessage}`,
        request,
      ),
    );
  }

  private _parseOpenAiResponse(
    data: OpenAiResponsePayload,
    request: ProviderApiRequest,
  ): Result<ProviderApiResponse, MediatorError> {
    const choice = data?.choices?.[0];
    if (!choice || !choice.message || typeof choice.message.content !== 'string') {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_MALFORMED_RESPONSE,
          'OpenAI response missing or malformed choices array.',
          request,
        ),
      );
    }

    const content = choice.message.content;
    const promptTokens = typeof data.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : 0;
    const completionTokens = typeof data.usage?.completion_tokens === 'number' ? data.usage.completion_tokens : 0;
    const totalTokens = promptTokens + completionTokens;

    const estimatedCostUsd = calculateEstimatedCost(
      'openai',
      request.modelId,
      promptTokens,
      completionTokens,
    );

    const usage: ProviderUsageMetadata | undefined =
      totalTokens > 0
        ? {
            inputTokens: promptTokens,
            outputTokens: completionTokens,
            totalTokens,
            estimatedCostUsd,
          }
        : undefined;

    return ok({
      providerId: 'openai',
      modelId: request.modelId,
      content,
      usage,
      finishReason: choice.finish_reason ?? 'stop',
      completedAt: Date.now(),
    });
  }

  private _parseRetryDelay(response: Response, attempt: number): number {
    const retryHeader = response.headers?.get('retry-after');
    if (retryHeader) {
      const sec = parseFloat(retryHeader);
      if (!isNaN(sec) && sec > 0) {
        return Math.min(sec * 1000, 5000);
      }
    }
    return Math.min(500 * Math.pow(2, attempt - 1), 3000);
  }
}
