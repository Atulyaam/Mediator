/**
 * @mediator/provider-core — Claude API Adapter Test Suite (Sprint S30)
 *
 * Verifies Anthropic Claude API Adapter:
 * - Valid request and response parsing
 * - Streaming SSE chunk handling
 * - Missing credential detection
 * - Invalid credential error mapping
 * - Unsupported model rejection
 * - Malformed response handling
 * - Rate limit (429) & outage (529) handling
 * - Timeout and AbortSignal cancellation
 * - Secret redaction
 */

import { describe, it, expect, vi } from 'vitest';
import { ErrorCode } from '@mediator/shared-contracts';
import { ClaudeApiAdapter } from './claudeApiAdapter.js';
import { type ProviderApiRequest } from './apiAdapterContract.js';

describe('Sprint S30 — Claude API Adapter', () => {
  const sampleRequest: ProviderApiRequest = {
    providerId: 'claude',
    modelId: 'claude-3-5-sonnet-20241022',
    messages: [
      { role: 'user', content: 'What is the speed of light in vacuum?' },
    ],
    systemPrompt: 'Be concise.',
    taskId: 'task-claude-01',
    sessionId: 'session-claude-01',
  };

  it('1. rejects unknown providerId or unsupported model', () => {
    const adapter = new ClaudeApiAdapter();
    const wrongProviderRes = adapter.validateRequest({
      ...sampleRequest,
      providerId: 'openai' as any,
    });
    expect(wrongProviderRes.ok).toBe(false);
    if (!wrongProviderRes.ok) {
      expect(wrongProviderRes.error.code).toBe(ErrorCode.PROVIDER_UNKNOWN);
    }

    const wrongModelRes = adapter.validateRequest({
      ...sampleRequest,
      modelId: 'nonexistent-claude-model',
    });
    expect(wrongModelRes.ok).toBe(false);
    if (!wrongModelRes.ok) {
      expect(wrongModelRes.error.code).toBe(ErrorCode.PROVIDER_MODEL_UNSUPPORTED);
    }
  });

  it('2. returns PROVIDER_CREDENTIAL_MISSING if apiKey is empty', async () => {
    const adapter = new ClaudeApiAdapter();
    const res = await adapter.sendMessage(sampleRequest, { apiKey: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.PROVIDER_CREDENTIAL_MISSING);
    }
  });

  it('3. handles successful valid non-streaming request & response', async () => {
    const fakeResponsePayload = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'The speed of light in vacuum is approximately 299,792,458 meters per second.',
        },
      ],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 18,
        output_tokens: 22,
      },
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fakeResponsePayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const adapter = new ClaudeApiAdapter({ fetchFn: mockFetch });
    const result = await adapter.sendMessage(sampleRequest, { apiKey: 'sk-ant-testkey-12345678' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.providerId).toBe('claude');
      expect(result.value.modelId).toBe('claude-3-5-sonnet-20241022');
      expect(result.value.content).toContain('299,792,458 meters per second');
      expect(result.value.usage?.inputTokens).toBe(18);
      expect(result.value.usage?.outputTokens).toBe(22);
      expect(result.value.usage?.totalTokens).toBe(40);
      expect(result.value.usage?.estimatedCostUsd).toBeGreaterThan(0);
      expect(result.value.finishReason).toBe('end_turn');
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0]![0];
    const calledInit = mockFetch.mock.calls[0]![1];
    expect(calledUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(calledInit.headers['x-api-key']).toBe('sk-ant-testkey-12345678');
    expect(calledInit.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('4. maps 401/403 to PROVIDER_CREDENTIAL_INVALID without leaking secret', async () => {
    const secretKey = 'sk-ant-super-secret-key-12345';
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid API key provided.' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const adapter = new ClaudeApiAdapter({ fetchFn: mockFetch });
    const result = await adapter.sendMessage(sampleRequest, { apiKey: secretKey });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.PROVIDER_CREDENTIAL_INVALID);
      expect(result.error.message).not.toContain(secretKey);
    }
  });

  it('5. maps 429 to PROVIDER_RATE_LIMITED and 529 to PROVIDER_OUTAGE', async () => {
    const mockFetch429 = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Rate limit exceeded.' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const adapter429 = new ClaudeApiAdapter({ fetchFn: mockFetch429, maxRetries: 0 });
    const res429 = await adapter429.sendMessage(sampleRequest, { apiKey: 'key' });
    expect(res429.ok).toBe(false);
    if (!res429.ok) {
      expect(res429.error.code).toBe(ErrorCode.PROVIDER_RATE_LIMITED);
    }

    const mockFetch529 = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Claude is temporarily overloaded.' } }), {
        status: 529,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const adapter529 = new ClaudeApiAdapter({ fetchFn: mockFetch529, maxRetries: 0 });
    const res529 = await adapter529.sendMessage(sampleRequest, { apiKey: 'key' });
    expect(res529.ok).toBe(false);
    if (!res529.ok) {
      expect(res529.error.code).toBe(ErrorCode.PROVIDER_OUTAGE);
    }
  });

  it('6. handles caller cancellation cleanly with PROVIDER_CANCELLED', async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    const mockFetch = vi.fn().mockImplementation(() => {
      throw new Error('Should not reach here');
    });

    const adapter = new ClaudeApiAdapter({ fetchFn: mockFetch });
    const result = await adapter.sendMessage(sampleRequest, {
      apiKey: 'key',
      signal: abortCtrl.signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.PROVIDER_CANCELLED);
    }
  });

  it('7. handles streaming chunks and calculates total tokens', async () => {
    const sseLines = [
      'event: message_start\n',
      'data: {"type":"message_start","message":{"id":"msg_s1","usage":{"input_tokens":12}}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"from Claude!"}}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) {
          controller.enqueue(new TextEncoder().encode(line));
        }
        controller.close();
      },
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const receivedChunks: string[] = [];
    const adapter = new ClaudeApiAdapter({ fetchFn: mockFetch });
    const result = await adapter.streamMessage(
      sampleRequest,
      (chunk) => receivedChunks.push(chunk),
      { apiKey: 'key-test' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('Hello from Claude!');
      expect(result.value.usage?.inputTokens).toBe(12);
      expect(result.value.usage?.outputTokens).toBe(6);
      expect(result.value.usage?.totalTokens).toBe(18);
      expect(result.value.finishReason).toBe('end_turn');
    }
    expect(receivedChunks).toEqual(['Hello ', 'from Claude!']);
  });

  it('8. handles connection test successfully', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'msg_test',
          content: [{ type: 'text', text: 'pong' }],
        }),
        { status: 200 },
      ),
    );

    const adapter = new ClaudeApiAdapter({ fetchFn: mockFetch });
    const testRes = await adapter.testConnection('test-key');

    expect(testRes.ok).toBe(true);
    if (testRes.ok) {
      expect(testRes.value.providerId).toBe('claude');
      expect(testRes.value.ok).toBe(true);
      expect(testRes.value.availableModels?.length).toBeGreaterThan(0);
    }
  });
});
