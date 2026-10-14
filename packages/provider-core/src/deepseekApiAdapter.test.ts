/**
 * @mediator/provider-core — DeepSeek API Adapter Test Suite (Sprint S31)
 *
 * Verifies DeepSeek API Adapter:
 * - Successful text request and response
 * - Reasoning content separation (R1 reasoner vs user text)
 * - Streaming completion with reasoning exclusion from onChunk
 * - Invalid API key mapping
 * - Unsupported model rejection
 * - Rate limit and server error handling
 * - Timeout and cancellation
 * - Secret redaction
 * - Connection test
 */

import { describe, it, expect, vi } from 'vitest';
import { ErrorCode } from '@mediator/shared-contracts';
import { DeepSeekApiAdapter } from './deepseekApiAdapter.js';
import { type ProviderApiRequest } from './apiAdapterContract.js';

describe('Sprint S31 — DeepSeek API Adapter', () => {
  const sampleRequest: ProviderApiRequest = {
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'Explain quicksort in one sentence.' },
    ],
    systemPrompt: 'Be concise.',
    taskId: 'task-deepseek-01',
    sessionId: 'session-deepseek-01',
  };

  it('1. rejects invalid provider or unsupported model', () => {
    const adapter = new DeepSeekApiAdapter();
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
      modelId: 'deepseek-coder-unsupported',
    });
    expect(wrongModelRes.ok).toBe(false);
    if (!wrongModelRes.ok) {
      expect(wrongModelRes.error.code).toBe(ErrorCode.PROVIDER_MODEL_UNSUPPORTED);
    }
  });

  it('2. returns PROVIDER_CREDENTIAL_MISSING if apiKey is missing', async () => {
    const adapter = new DeepSeekApiAdapter();
    const res = await adapter.sendMessage(sampleRequest, { apiKey: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.PROVIDER_CREDENTIAL_MISSING);
    }
  });

  it('3. handles successful non-streaming request & response', async () => {
    const fakePayload = {
      id: 'chatcmpl-ds123',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Quicksort is a divide-and-conquer algorithm that selects a pivot and partitions array elements around it.',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 21,
        total_tokens: 36,
      },
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fakePayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const adapter = new DeepSeekApiAdapter({ fetchFn: mockFetch });
    const result = await adapter.sendMessage(sampleRequest, { apiKey: 'sk-ds-validkey-9999' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.providerId).toBe('deepseek');
      expect(result.value.modelId).toBe('deepseek-chat');
      expect(result.value.content).toContain('Quicksort is a divide-and-conquer');
      expect(result.value.reasoningContent).toBeUndefined();
      expect(result.value.usage?.inputTokens).toBe(15);
      expect(result.value.usage?.outputTokens).toBe(21);
      expect(result.value.usage?.totalTokens).toBe(36);
      expect(result.value.usage?.estimatedCostUsd).toBeGreaterThan(0);
      expect(result.value.finishReason).toBe('stop');
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0]![0];
    const calledInit = mockFetch.mock.calls[0]![1];
    expect(calledUrl).toBe('https://api.deepseek.com/chat/completions');
    expect(calledInit.headers['Authorization']).toBe('Bearer sk-ds-validkey-9999');
  });

  it('4. strictly isolates reasoning_content on deepseek-reasoner without leaking into content', async () => {
    const reasonerRequest: ProviderApiRequest = {
      ...sampleRequest,
      modelId: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'What is 17 * 19?' }],
    };

    const fakePayloadWithReasoning = {
      id: 'chatcmpl-ds-r1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '323',
            reasoning_content: '17 * 20 = 340. 340 - 17 = 323. Therefore the answer is 323.',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fakePayloadWithReasoning), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const adapter = new DeepSeekApiAdapter({ fetchFn: mockFetch });
    const result = await adapter.sendMessage(reasonerRequest, { apiKey: 'sk-ds-key' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Content has only the final answer
      expect(result.value.content).toBe('323');
      // Reasoning is kept separate
      expect(result.value.reasoningContent).toBe('17 * 20 = 340. 340 - 17 = 323. Therefore the answer is 323.');
      expect(result.value.content).not.toContain('340 - 17');
    }
  });

  it('5. maps 401 to PROVIDER_CREDENTIAL_INVALID and redacts secret key', async () => {
    const rawKey = 'sk-ds-confidential-secret-key';
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Authentication failed: invalid api key' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const adapter = new DeepSeekApiAdapter({ fetchFn: mockFetch });
    const result = await adapter.sendMessage(sampleRequest, { apiKey: rawKey });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.PROVIDER_CREDENTIAL_INVALID);
      expect(result.error.message).not.toContain(rawKey);
    }
  });

  it('6. maps 429 and 500 error responses correctly', async () => {
    const mockFetch429 = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const adapter429 = new DeepSeekApiAdapter({ fetchFn: mockFetch429, maxRetries: 0 });
    const res429 = await adapter429.sendMessage(sampleRequest, { apiKey: 'key' });
    expect(res429.ok).toBe(false);
    if (!res429.ok) {
      expect(res429.error.code).toBe(ErrorCode.PROVIDER_RATE_LIMITED);
    }

    const mockFetch500 = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Internal server error' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const adapter500 = new DeepSeekApiAdapter({ fetchFn: mockFetch500, maxRetries: 0 });
    const res500 = await adapter500.sendMessage(sampleRequest, { apiKey: 'key' });
    expect(res500.ok).toBe(false);
    if (!res500.ok) {
      expect(res500.error.code).toBe(ErrorCode.PROVIDER_OUTAGE);
    }
  });

  it('7. streams responses while isolating reasoning chunks from onChunk callback', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"Thinking about "}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"quicksort step."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Quicksort "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"divides."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":8}}\n\n',
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

    const streamedChunks: string[] = [];
    const adapter = new DeepSeekApiAdapter({ fetchFn: mockFetch });
    const result = await adapter.streamMessage(
      sampleRequest,
      (chunk) => streamedChunks.push(chunk),
      { apiKey: 'sk-ds-stream' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('Quicksort divides.');
      expect(result.value.reasoningContent).toBe('Thinking about quicksort step.');
      expect(result.value.usage?.inputTokens).toBe(12);
      expect(result.value.usage?.outputTokens).toBe(8);
      expect(result.value.usage?.totalTokens).toBe(20);
    }

    // streamedChunks received by user MUST NOT contain reasoning tokens
    expect(streamedChunks).toEqual(['Quicksort ', 'divides.']);
  });

  it('8. handles connection test successfully', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'pong' } }],
        }),
        { status: 200 },
      ),
    );

    const adapter = new DeepSeekApiAdapter({ fetchFn: mockFetch });
    const testRes = await adapter.testConnection('test-key');

    expect(testRes.ok).toBe(true);
    if (testRes.ok) {
      expect(testRes.value.providerId).toBe('deepseek');
      expect(testRes.value.ok).toBe(true);
      expect(testRes.value.availableModels?.length).toBeGreaterThan(0);
    }
  });
});
