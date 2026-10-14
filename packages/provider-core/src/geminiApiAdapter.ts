/**
 * @mediator/provider-core — Google Gemini API Adapter (Sprint S32)
 *
 * Implements Mode B (Official API Connection) for Google Gemini.
 * - Uses official Google Gemini REST API: https://generativelanguage.googleapis.com/v1beta/models/{modelId}:generateContent
 * - Auth: Header x-goog-api-key: <key>
 * - Models: gemini-1.5-pro, gemini-1.5-flash, gemini-2.0-flash
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
  GEMINI_MODELS,
  calculateEstimatedCost,
} from './catalogues.js';

export interface GeminiApiAdapterOptions {
  readonly fetchFn?: typeof fetch | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
}

interface GeminiPartPayload {
  readonly text?: string;
}

interface GeminiContentPayload {
  readonly role?: string;
  readonly parts?: readonly GeminiPartPayload[];
}

interface GeminiCandidatePayload {
  readonly content?: GeminiContentPayload;
  readonly finishReason?: string;
}

interface GeminiUsagePayload {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly totalTokenCount?: number;
}

interface GeminiResponsePayload {
  readonly candidates?: readonly GeminiCandidatePayload[];
  readonly usageMetadata?: GeminiUsagePayload;
}

interface GeminiErrorPayload {
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly status?: string;
  };
}

const OFFICIAL_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_PAYLOAD_CHARS = 500_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;

export class GeminiApiAdapter implements AIProviderApiAdapter {
  readonly providerId: CanonicalProviderId = 'gemini';
  readonly metadata: ProviderMetadata = AUTHORITATIVE_PROVIDER_METADATA.gemini;

  private readonly _fetch: typeof fetch;
  private readonly _defaultTimeoutMs: number;
  private readonly _maxRetries: number;

  constructor(options?: GeminiApiAdapterOptions) {
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
    if (request.providerId !== 'gemini') {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_UNKNOWN,
          `Expected providerId 'gemini', received '${request.providerId}'`,
          request,
        ),
      );
    }

    const isSupportedModel = GEMINI_MODELS.some((m) => m.id === request.modelId);
    if (!isSupportedModel) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_MODEL_UNSUPPORTED,
          `Unsupported Gemini model '${request.modelId}'. Supported: ${GEMINI_MODELS.map((m) => m.id).join(', ')}`,
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
          'Google Gemini API key is missing. Configure an API key in settings.',
          request,
        ),
      );
    }

    const endpoint = `${OFFICIAL_GEMINI_BASE_URL}/${encodeURIComponent(request.modelId)}:generateContent`;
    const bodyPayload = this._buildGeminiPayload(request);

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
              'Gemini API request cancelled by caller signal.',
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
        const response = await this._fetch(endpoint, {
          method: 'POST',
          headers: {
            'x-goog-api-key': apiKey,
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

        const data = (await response.json()) as GeminiResponsePayload;
        return this._parseGeminiResponse(data, request);
      } catch (error: unknown) {
        clearTimeout(timeoutId);
        const errName = error instanceof Error ? error.name : '';
        const errMsg = error instanceof Error ? error.message : String(error);

        if (errName === 'AbortError' || abortCtrl.signal.aborted) {
          if (isTimedOut) {
            return err(
              this._makeError(
                ErrorCode.PROVIDER_TIMEOUT,
                `Gemini API request timed out after ${timeoutMs}ms.`,
                request,
              ),
            );
          }
          return err(
            this._makeError(
              ErrorCode.PROVIDER_CANCELLED,
              'Gemini API request cancelled.',
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
            `Gemini API network error: ${errMsg}`,
            request,
          ),
        );
      }
    }

    return err(
      this._makeError(
        ErrorCode.PROVIDER_OUTAGE,
        'Gemini API retries exhausted.',
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
          'Google Gemini API key is missing.',
          request,
        ),
      );
    }

    const endpoint = `${OFFICIAL_GEMINI_BASE_URL}/${encodeURIComponent(request.modelId)}:streamGenerateContent?alt=sse`;
    const bodyPayload = this._buildGeminiPayload(request);

    const timeoutMs = options?.timeoutMs ?? this._defaultTimeoutMs;
    const abortCtrl = new AbortController();
    let isTimedOut = false;

    if (options?.signal) {
      if (options.signal.aborted) {
        return err(
          this._makeError(
            ErrorCode.PROVIDER_CANCELLED,
            'Gemini API request cancelled by caller signal.',
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
      const response = await this._fetch(endpoint, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
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
            'Gemini API streaming response body is missing.',
            request,
          ),
        );
      }

      let accumulatedContent = '';
      let finishReason: string | undefined = undefined;
      let promptTokens = 0;
      let candidatesTokens = 0;

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
              const eventData = JSON.parse(dataStr) as GeminiResponsePayload;
              const candidate = eventData.candidates?.[0];
              if (candidate?.content?.parts) {
                for (const part of candidate.content.parts) {
                  if (typeof part.text === 'string') {
                    accumulatedContent += part.text;
                    onChunk(part.text);
                  }
                }
                if (candidate.finishReason) {
                  finishReason = candidate.finishReason;
                }
              }

              if (eventData.usageMetadata) {
                promptTokens = eventData.usageMetadata.promptTokenCount ?? promptTokens;
                candidatesTokens = eventData.usageMetadata.candidatesTokenCount ?? candidatesTokens;
              }
            } catch {
              // Ignore unparseable line
            }
          }
        }
      }

      const totalTokens = promptTokens + candidatesTokens;
      const estimatedCostUsd = calculateEstimatedCost(
        'gemini',
        request.modelId,
        promptTokens,
        candidatesTokens,
      );

      const usage: ProviderUsageMetadata | undefined =
        totalTokens > 0
          ? {
              inputTokens: promptTokens,
              outputTokens: candidatesTokens,
              totalTokens,
              estimatedCostUsd,
            }
          : undefined;

      return ok({
        providerId: 'gemini',
        modelId: request.modelId,
        content: accumulatedContent,
        usage,
        finishReason: finishReason ?? 'STOP',
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
              `Gemini streaming request timed out after ${timeoutMs}ms.`,
              request,
            ),
          );
        }
        return err(
          this._makeError(
            ErrorCode.PROVIDER_CANCELLED,
            'Gemini streaming request cancelled.',
            request,
          ),
        );
      }

      return err(
        this._makeError(
          ErrorCode.PROVIDER_OUTAGE,
          `Gemini streaming error: ${errMsg}`,
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
          'Cannot test Gemini connection: missing API key.',
        ),
      );
    }

    const startTime = Date.now();
    try {
      const endpoint = `${OFFICIAL_GEMINI_BASE_URL}/gemini-1.5-flash:generateContent`;
      const response = await this._fetch(endpoint, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        if (response.status === 400 || response.status === 401 || response.status === 403) {
          return err(
            this._makeError(
              ErrorCode.PROVIDER_CREDENTIAL_INVALID,
              'Gemini API key verification failed: unauthorized or invalid key.',
            ),
          );
        }
        if (response.status === 429) {
          return err(
            this._makeError(
              ErrorCode.PROVIDER_RATE_LIMITED,
              'Gemini API rate limit reached during test.',
            ),
          );
        }
        return err(
          this._makeError(
            ErrorCode.PROVIDER_API_UNAVAILABLE,
            `Gemini test connection failed with HTTP ${response.status}`,
          ),
        );
      }

      return ok({
        ok: true,
        providerId: 'gemini',
        latencyMs,
        message: `Connected to Google Gemini successfully (${latencyMs}ms).`,
        availableModels: GEMINI_MODELS.map((m) => m.id),
      });
    } catch (err_: unknown) {
      const latencyMs = Date.now() - startTime;
      const errMsg = err_ instanceof Error ? err_.message : String(err_);
      return err(
        this._makeError(
          ErrorCode.PROVIDER_OUTAGE,
          `Gemini connection test network failure (${latencyMs}ms): ${errMsg}`,
        ),
      );
    }
  }

  private _buildGeminiPayload(request: ProviderApiRequest): Record<string, unknown> {
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    for (const msg of request.messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      contents.push({
        role,
        parts: [{ text: msg.content }],
      });
    }

    const payload: Record<string, unknown> = { contents };

    if (request.systemPrompt) {
      payload.systemInstruction = {
        parts: [{ text: request.systemPrompt }],
      };
    }

    const generationConfig: Record<string, unknown> = {};
    if (request.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = request.maxTokens;
    }
    if (request.temperature !== undefined) {
      generationConfig.temperature = request.temperature;
    }

    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
    }

    return payload;
  }

  private async _handleErrorResponse(
    response: Response,
    request: ProviderApiRequest,
  ): Promise<Result<never, MediatorError>> {
    let rawError = '';
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text) as GeminiErrorPayload;
        rawError = json?.error?.message ?? JSON.stringify(json);
      } catch {
        rawError = text;
      }
    } catch {
      rawError = `HTTP ${response.status}`;
    }

    const safeMessage = rawError.slice(0, 300);

    if (
      response.status === 400 &&
      (safeMessage.toLowerCase().includes('api_key') || safeMessage.toLowerCase().includes('api key'))
    ) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_CREDENTIAL_INVALID,
          `Google Gemini API key invalid. Check configured API key.`,
          request,
        ),
      );
    }

    if (response.status === 401 || response.status === 403) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_CREDENTIAL_INVALID,
          `Google Gemini authentication failed (HTTP ${response.status}). Check configured API key.`,
          request,
        ),
      );
    }

    if (response.status === 404) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_MODEL_UNSUPPORTED,
          `Gemini model or endpoint not found: ${safeMessage}`,
          request,
        ),
      );
    }

    if (response.status === 429) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_RATE_LIMITED,
          `Gemini API rate limit reached: ${safeMessage}`,
          request,
        ),
      );
    }

    if (response.status >= 500) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_OUTAGE,
          `Gemini service outage (HTTP ${response.status}): ${safeMessage}`,
          request,
        ),
      );
    }

    return err(
      this._makeError(
        ErrorCode.PROVIDER_API_UNAVAILABLE,
        `Gemini API error (HTTP ${response.status}): ${safeMessage}`,
        request,
      ),
    );
  }

  private _parseGeminiResponse(
    data: GeminiResponsePayload,
    request: ProviderApiRequest,
  ): Result<ProviderApiResponse, MediatorError> {
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (!parts || parts.length === 0) {
      return err(
        this._makeError(
          ErrorCode.PROVIDER_MALFORMED_RESPONSE,
          'Gemini response missing candidates or content parts.',
          request,
        ),
      );
    }

    const textParts: string[] = [];
    for (const p of parts) {
      if (typeof p.text === 'string') {
        textParts.push(p.text);
      }
    }

    const fullText = textParts.join('');

    const promptTokens = typeof data.usageMetadata?.promptTokenCount === 'number'
      ? data.usageMetadata.promptTokenCount
      : 0;
    const candidatesTokens = typeof data.usageMetadata?.candidatesTokenCount === 'number'
      ? data.usageMetadata.candidatesTokenCount
      : 0;
    const totalTokens = promptTokens + candidatesTokens;

    const estimatedCostUsd = calculateEstimatedCost(
      'gemini',
      request.modelId,
      promptTokens,
      candidatesTokens,
    );

    const usage: ProviderUsageMetadata | undefined =
      totalTokens > 0
        ? {
            inputTokens: promptTokens,
            outputTokens: candidatesTokens,
            totalTokens,
            estimatedCostUsd,
          }
        : undefined;

    return ok({
      providerId: 'gemini',
      modelId: request.modelId,
      content: fullText,
      usage,
      finishReason: candidate.finishReason ?? 'STOP',
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
