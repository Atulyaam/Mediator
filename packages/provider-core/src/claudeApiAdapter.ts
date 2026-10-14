/**
 * @mediator/provider-core — Anthropic Claude API Adapter (Sprint S30)
 *
 * Implements Mode B (Official API Connection) for Anthropic Claude.
 * - Uses official Anthropic Messages API: https://api.anthropic.com/v1/messages
 * - Auth: x-api-key header, anthropic-version: 2023-06-01
 * - Preserves strict session isolation (never claims API continues browser chat).
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
  CLAUDE_MODELS,
  calculateEstimatedCost,
} from './catalogues.js';

export interface ClaudeApiAdapterOptions {
  readonly fetchFn?: typeof fetch | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
}

interface ClaudeUsagePayload {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

interface ClaudeContentBlockPayload {
  readonly type?: string;
  readonly text?: string;
}

interface ClaudeMessagePayload {
  readonly id?: string;
  readonly type?: string;
  readonly role?: string;
  readonly content?: readonly ClaudeContentBlockPayload[];
  readonly stop_reason?: string;
  readonly usage?: ClaudeUsagePayload;
}

interface ClaudeErrorPayload {
  readonly error?: {
    readonly message?: string;
  };
}

const OFFICIAL_ANTHROPIC_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_PAYLOAD_CHARS = 500_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;

export class ClaudeApiAdapter implements AIProviderApiAdapter {
  readonly providerId: CanonicalProviderId = 'claude';
  readonly metadata: ProviderMetadata = AUTHORITATIVE_PROVIDER_METADATA.claude;

  private readonly _fetch: typeof fetch;
  private readonly _defaultTimeoutMs: number;
  private readonly _maxRetries: number;

  constructor(options?: ClaudeApiAdapterOptions) {
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
    if (request.providerId !== 'claude') {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_UNKNOWN,
          `Expected providerId 'claude', received '${request.providerId}'`,
          request,
        ),
      );
    }

    const isSupportedModel = CLAUDE_MODELS.some((m) => m.id === request.modelId);
    if (!isSupportedModel) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_MODEL_UNSUPPORTED,
          `Unsupported Claude model '${request.modelId}'. Supported: ${CLAUDE_MODELS.map((m) => m.id).join(', ')}`,
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
          'Anthropic Claude API key is missing. Configure an API key in settings.',
          request,
        ),
      );
    }

    const { systemPrompt, anthropicMessages } = this._formatMessages(request);
    const bodyPayload: Record<string, unknown> = {
      model: request.modelId,
      max_tokens: request.maxTokens ?? 8192,
      messages: anthropicMessages,
    };
    if (systemPrompt) {
      bodyPayload.system = systemPrompt;
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
              'Claude API request cancelled by caller signal.',
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
        const response = await this._fetch(OFFICIAL_ANTHROPIC_MESSAGES_ENDPOINT, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify(bodyPayload),
          signal: abortCtrl.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errRes = await this._handleErrorResponse(response, request);
          if (
            (response.status === 429 || response.status === 529 || response.status >= 500) &&
            attempt <= maxRetries
          ) {
            const delay = this._parseRetryDelay(response, attempt);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          return errRes;
        }

        const data = (await response.json()) as ClaudeMessagePayload;
        return this._parseClaudeResponse(data, request);
      } catch (error: unknown) {
        clearTimeout(timeoutId);
        const errName = error instanceof Error ? error.name : '';
        const errMsg = error instanceof Error ? error.message : String(error);

        if (errName === 'AbortError' || abortCtrl.signal.aborted) {
          if (isTimedOut) {
            return err(
              this._makeError(
                ErrorCode.PROVIDER_TIMEOUT,
                `Claude API request timed out after ${timeoutMs}ms.`,
                request,
              ),
            );
          }
          return err(
            this._makeError(
              ErrorCode.PROVIDER_CANCELLED,
              'Claude API request cancelled.',
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
            `Claude API network error: ${errMsg}`,
            request,
          ),
        );
      }
    }

    return err(
      this._makeError(
        ErrorCode.PROVIDER_OUTAGE,
        'Claude API retries exhausted.',
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
          'Anthropic Claude API key is missing.',
          request,
        ),
      );
    }

    const { systemPrompt, anthropicMessages } = this._formatMessages(request);
    const bodyPayload: Record<string, unknown> = {
      model: request.modelId,
      max_tokens: request.maxTokens ?? 8192,
      messages: anthropicMessages,
      stream: true,
    };
    if (systemPrompt) bodyPayload.system = systemPrompt;
    if (request.temperature !== undefined) bodyPayload.temperature = request.temperature;

    const timeoutMs = options?.timeoutMs ?? this._defaultTimeoutMs;
    const abortCtrl = new AbortController();
    let isTimedOut = false;

    if (options?.signal) {
      if (options.signal.aborted) {
        return err(
          this._makeError(
            ErrorCode.PROVIDER_CANCELLED,
            'Claude API request cancelled by caller signal.',
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
      const response = await this._fetch(OFFICIAL_ANTHROPIC_MESSAGES_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
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
            'Claude API streaming response body is missing.',
            request,
          ),
        );
      }

      let accumulatedContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason = 'end_turn';

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
              const eventType = eventData.type;

              if (eventType === 'message_start') {
                const messageObj = eventData.message as { usage?: ClaudeUsagePayload } | undefined;
                if (typeof messageObj?.usage?.input_tokens === 'number') {
                  inputTokens = messageObj.usage.input_tokens;
                }
              } else if (eventType === 'content_block_delta') {
                const deltaObj = eventData.delta as { type?: string; text?: string } | undefined;
                if (typeof deltaObj?.text === 'string') {
                  accumulatedContent += deltaObj.text;
                  onChunk(deltaObj.text);
                }
              } else if (eventType === 'message_delta') {
                const deltaObj = eventData.delta as { stop_reason?: string } | undefined;
                if (typeof deltaObj?.stop_reason === 'string') {
                  stopReason = deltaObj.stop_reason;
                }
                const usageObj = eventData.usage as { output_tokens?: number } | undefined;
                if (typeof usageObj?.output_tokens === 'number') {
                  outputTokens = usageObj.output_tokens;
                }
              } else if (eventType === 'error') {
                const errObj = eventData.error as { message?: string } | undefined;
                return err(
                  this._makeError(
                    ErrorCode.PROVIDER_MALFORMED_RESPONSE,
                    `Claude streaming error: ${errObj?.message ?? 'unknown stream error'}`,
                    request,
                  ),
                );
              }
            } catch {
              // Ignore non-json data line
            }
          }
        }
      }

      const totalTokens = inputTokens + outputTokens;
      const estimatedCostUsd = calculateEstimatedCost(
        'claude',
        request.modelId,
        inputTokens,
        outputTokens,
      );

      const usage: ProviderUsageMetadata | undefined =
        totalTokens > 0
          ? {
              inputTokens,
              outputTokens,
              totalTokens,
              estimatedCostUsd,
            }
          : undefined;

      return ok({
        providerId: 'claude',
        modelId: request.modelId,
        content: accumulatedContent,
        usage,
        finishReason: stopReason,
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
              `Claude streaming request timed out after ${timeoutMs}ms.`,
              request,
            ),
          );
        }
        return err(
          this._makeError(
            ErrorCode.PROVIDER_CANCELLED,
            'Claude streaming request cancelled.',
            request,
          ),
        );
      }

      return err(
        this._makeError(
          ErrorCode.PROVIDER_OUTAGE,
          `Claude streaming error: ${errMsg}`,
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
          'Cannot test Claude connection: missing API key.',
        ),
      );
    }

    const startTime = Date.now();
    try {
      const response = await this._fetch(OFFICIAL_ANTHROPIC_MESSAGES_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
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
              'Claude API key verification failed: unauthorized (HTTP 401/403).',
            ),
          );
        }
        if (response.status === 429) {
          return err(
            this._makeError(
              ErrorCode.PROVIDER_RATE_LIMITED,
              'Claude API rate limit reached during test.',
            ),
          );
        }
        return err(
          this._makeError(
            ErrorCode.PROVIDER_API_UNAVAILABLE,
            `Claude test connection failed with HTTP ${response.status}`,
          ),
        );
      }

      return ok({
        ok: true,
        providerId: 'claude',
        latencyMs,
        message: `Connected to Anthropic Claude successfully (${latencyMs}ms).`,
        availableModels: CLAUDE_MODELS.map((m) => m.id),
      });
    } catch (err_: unknown) {
      const latencyMs = Date.now() - startTime;
      const msg = err_ instanceof Error ? err_.message : String(err_);
      return err(
        this._makeError(
          ErrorCode.PROVIDER_OUTAGE,
          `Claude connection test network failure (${latencyMs}ms): ${msg}`,
        ),
      );
    }
  }

  private _formatMessages(request: ProviderApiRequest): {
    systemPrompt?: string | undefined;
    anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    const systemParts: string[] = [];
    if (request.systemPrompt) {
      systemParts.push(request.systemPrompt);
    }

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemParts.push(msg.content);
      } else {
        messages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    // Anthropic requires messages to start with a user message
    if (messages.length === 0 || messages[0]!.role !== 'user') {
      messages.unshift({ role: 'user', content: 'Begin session.' });
    }

    const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
    return { systemPrompt, anthropicMessages: messages };
  }

  private async _handleErrorResponse(
    response: Response,
    request: ProviderApiRequest,
  ): Promise<Result<never, MediatorError>> {
    let rawError = '';
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text) as ClaudeErrorPayload;
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
          `Anthropic Claude authentication failed (HTTP ${response.status}). Check configured API key.`,
          request,
        ),
      );
    }

    if (response.status === 404) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_MODEL_UNSUPPORTED,
          `Claude model or endpoint not found: ${safeMessage}`,
          request,
        ),
      );
    }

    if (response.status === 429) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_RATE_LIMITED,
          `Claude API rate limit reached: ${safeMessage}`,
          request,
        ),
      );
    }

    if (response.status === 529 || response.status >= 500) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_OUTAGE,
          `Claude service outage or overloaded (HTTP ${response.status}): ${safeMessage}`,
          request,
        ),
      );
    }

    return err(
      this._makeError(
        ErrorCode.PROVIDER_API_UNAVAILABLE,
        `Claude API error (HTTP ${response.status}): ${safeMessage}`,
        request,
      ),
    );
  }

  private _parseClaudeResponse(
    data: ClaudeMessagePayload,
    request: ProviderApiRequest,
  ): Result<ProviderApiResponse, MediatorError> {
    const content = data?.content;
    if (!content || content.length === 0) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_MALFORMED_RESPONSE,
          'Claude response missing or has malformed content array.',
          request,
        ),
      );
    }

    const textBlocks: string[] = [];
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textBlocks.push(block.text);
      }
    }

    const fullText = textBlocks.join('');

    const inputTokens = typeof data.usage?.input_tokens === 'number' ? data.usage.input_tokens : 0;
    const outputTokens = typeof data.usage?.output_tokens === 'number' ? data.usage.output_tokens : 0;
    const totalTokens = inputTokens + outputTokens;

    const estimatedCostUsd = calculateEstimatedCost(
      'claude',
      request.modelId,
      inputTokens,
      outputTokens,
    );

    const usage: ProviderUsageMetadata | undefined =
      totalTokens > 0
        ? {
            inputTokens,
            outputTokens,
            totalTokens,
            estimatedCostUsd,
          }
        : undefined;

    return ok({
      providerId: 'claude',
      modelId: request.modelId,
      content: fullText,
      usage,
      finishReason: data.stop_reason ?? 'end_turn',
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
