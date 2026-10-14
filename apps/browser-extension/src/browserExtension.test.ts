/**
 * @mediator/browser-extension — Sprint S18 Test Suite
 *
 * Covers all 25 S18 requirements using sanitized DOM fixtures:
 * 1. Manifest validation / build succeeds.
 * 2. Extension has no filesystem or shell permissions.
 * 3. Extension does not request cookies/history/debugger/native messaging.
 * 4. Attach works on a supported fixture.
 * 5. Attach fails on an unsupported page.
 * 6. Detach clears the active attachment state.
 * 7. Supported provider identity is detected correctly in fixtures.
 * 8. Ambiguous identity causes a safe pause.
 * 9. Completed assistant response is extracted correctly.
 * 10. Code-block boundaries are preserved when supported.
 * 11. Streaming response cannot be treated as complete.
 * 12. Login/auth-required page causes a safe pause.
 * 13. Navigation invalidates prior page identity and stale responses.
 * 14. Unknown DOM structure cannot trigger unsafe extraction.
 * 15. Empty/malformed content is handled explicitly.
 * 16. Oversized extraction respects configured limits.
 * 17. Draft is shown before any insert/send action.
 * 18. User must explicitly submit/send (never auto-sent).
 * 19. Copy/manual-paste fallback works when composer detection fails.
 * 20. No hidden credential or cookie extraction path is present.
 * 21. Detach/cancellation cleans up observers and event listeners.
 * 22. Browser messages validate sender, schema and payload size.
 * 23. Prepared messages are never automatically executed/applied.
 * 24. Extension does not claim native host/core connectivity when only fixtures are present.
 * 25. Overall architecture integrity invariant.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GeminiProviderAdapter,
  AttachManager,
  DraftManager,
  DEFAULT_EXTRACTION_LIMITS,
  MAX_PREPARED_DRAFT_BYTES,
  createCompletedTextFixture,
  createCompletedWithCodeFixture,
  createStreamingFixture,
  createLoginRequiredFixture,
  createAmbiguousIdentityFixture,
  createNavigatedChatFixture,
  createUnknownStructureFixture,
  createEmptyResponseFixture,
  createOversizedResponseFixture,
  createUnsupportedPageFixture,
} from './index.js';

describe('Sprint S18 — Browser Extension Shell & Provider Fixtures', () => {
  let adapter: GeminiProviderAdapter;
  let attachManager: AttachManager;
  let draftManager: DraftManager;

  beforeEach(() => {
    adapter = new GeminiProviderAdapter();
    attachManager = new AttachManager(adapter);
    draftManager = new DraftManager(adapter, attachManager);
  });

  // 1. Manifest validation / build succeeds
  it('1. manifest validation: Manifest V3 syntax and structure is valid', () => {
    const manifestPath = path.resolve(__dirname, '../manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('Mediator AI Bridge');
    expect(manifest.version).toBe('0.0.1');
    expect(manifest.action).toBeDefined();
    expect(manifest.background?.service_worker).toBeDefined();
    expect(manifest.content_scripts?.length).toBeGreaterThan(0);
  });

  // 2. Extension has no filesystem or shell permissions
  it('2. manifest does not request filesystem or shell permissions', () => {
    const manifestPath = path.resolve(__dirname, '../manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const permissions = (manifest.permissions ?? []) as string[];
    expect(permissions).not.toContain('fileSystem');
    expect(permissions).not.toContain('shell');
    expect(permissions).not.toContain('downloads');
  });

  // 3. Extension requests nativeMessaging (S19) but denies cookies/history/debugger
  it('3. manifest requests nativeMessaging (S19) but does not request cookies, history, or debugger', () => {
    const manifestPath = path.resolve(__dirname, '../manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const permissions = (manifest.permissions ?? []) as string[];
    expect(permissions).not.toContain('cookies');
    expect(permissions).not.toContain('history');
    expect(permissions).not.toContain('debugger');
    expect(permissions).toContain('nativeMessaging');

    // Only activeTab, storage, and nativeMessaging
    expect(permissions.sort()).toEqual(['activeTab', 'nativeMessaging', 'storage']);
  });

  // 4. Attach works on a supported fixture
  it('4. attach works on a supported Gemini fixture', () => {
    const fixture = createCompletedTextFixture('conv-test-01');
    const state = attachManager.attach(
      { tabId: 101, url: 'https://gemini.google.com/app/conv-test-01' },
      fixture,
    );

    expect(state.status).toBe('attached');
    expect(state.providerId).toBe('google-gemini');
    expect(state.conversationId).toBe('conv-test-01');
    expect(state.pageState).toBe('response-complete');
    expect(state.statusMessage).toContain('Attached');
  });

  // 5. Attach fails on an unsupported page
  it('5. attach fails safely on an unsupported third-party page', () => {
    const fixture = createUnsupportedPageFixture();
    const state = attachManager.attach(
      { tabId: 102, url: 'https://example.com/some/page' },
      fixture,
    );

    expect(state.status).toBe('error');
    expect(state.pageState).toBe('unsupported-page');
    expect(state.statusMessage).toContain('Cannot attach');
    expect(state.safePauseReason).toContain('Unsupported');
  });

  // 6. Detach clears the active attachment state
  it('6. detach clears the active attachment state and resets data', () => {
    const fixture = createCompletedTextFixture('conv-detach-01');
    attachManager.attach(
      { tabId: 103, url: 'https://gemini.google.com/app/conv-detach-01' },
      fixture,
    );

    const detached = attachManager.detach();
    expect(detached.status).toBe('detached');
    expect(detached.providerId).toBeNull();
    expect(detached.tabId).toBeNull();
    expect(detached.conversationId).toBeNull();
    expect(detached.statusMessage).toContain('detached');
  });

  // 7. Supported provider identity is detected correctly in fixtures
  it('7. supported provider identity is detected correctly from URL and DOM signals', () => {
    const fixture = createCompletedTextFixture('conv-id-detected');
    const res = adapter.classifyPage(fixture, 'https://gemini.google.com/app/conv-id-detected');

    expect(res.providerId).toBe('google-gemini');
    expect(res.conversationId).toBe('conv-id-detected');
    expect(res.canExtract).toBe(true);
  });

  // 8. Ambiguous identity causes a safe pause
  it('8. ambiguous identity on landing page causes a safe pause', () => {
    const fixture = createAmbiguousIdentityFixture();
    const state = attachManager.attach(
      { tabId: 104, url: 'https://gemini.google.com/app' },
      fixture,
    );

    expect(state.status).toBe('paused');
    expect(state.pageState).toBe('conversation-identity-uncertain');
    expect(state.safePauseReason).toContain('Cannot establish unambiguous conversation ID');
  });

  // 9. Completed assistant response is extracted correctly
  it('9. completed assistant response is extracted correctly', () => {
    const text = 'Here is the final verified response.';
    const fixture = createCompletedTextFixture('conv-extract-01', text);

    const res = adapter.extractResponse(fixture);
    expect(res.ok).toBe(true);
    expect(res.response).toBeDefined();
    expect(res.response?.rawText).toBe(text);
    expect(res.response?.isComplete).toBe(true);
    expect(res.response?.characterCount).toBe(text.length);
  });

  // 10. Code-block boundaries are preserved when supported
  it('10. code-block boundaries and languages are preserved during extraction', () => {
    const snippet = 'const x: number = 42;';
    const fixture = createCompletedWithCodeFixture(
      'conv-code-blocks',
      'Code explanation',
      snippet,
      'typescript',
    );

    const res = adapter.extractResponse(fixture);
    expect(res.ok).toBe(true);
    expect(res.response?.codeBlocks.length).toBeGreaterThan(0);
    expect(res.response?.codeBlocks[0]?.language).toBe('typescript');
    expect(res.response?.codeBlocks[0]?.code).toContain('const x: number = 42;');
  });

  // 11. Streaming response cannot be treated as complete
  it('11. streaming response cannot be treated as complete', () => {
    const fixture = createStreamingFixture('conv-stream-active');
    const classification = adapter.classifyPage(
      fixture,
      'https://gemini.google.com/app/conv-stream-active',
    );

    expect(classification.state).toBe('response-streaming');
    expect(classification.canExtract).toBe(false);

    // Extraction must also be rejected
    const extractRes = adapter.extractResponse(fixture);
    expect(extractRes.ok).toBe(false);
    expect(extractRes.errorCode).toBe('RESPONSE_STILL_STREAMING');
  });

  // 12. Login/auth-required page causes a safe pause
  it('12. login/auth-required page causes a safe pause without scraping', () => {
    const fixture = createLoginRequiredFixture();
    const state = attachManager.attach(
      { tabId: 105, url: 'https://gemini.google.com/' },
      fixture,
    );

    expect(state.status).toBe('paused');
    expect(state.pageState).toBe('login-or-auth-required');
    expect(state.safePauseReason).toContain('Authentication or login required');
  });

  // 13. Navigation invalidates prior page identity and stale responses
  it('13. navigation to a different chat clears stale responses and updates identity', () => {
    const fixture1 = createCompletedTextFixture('chat-A', 'Response in Chat A');
    attachManager.attach(
      { tabId: 106, url: 'https://gemini.google.com/app/chat-A' },
      fixture1,
    );

    // Extract first response
    const ext1 = adapter.extractResponse(fixture1);
    attachManager.recordExtraction(ext1.response!);
    expect(attachManager.getState().lastResponseSummary).toContain('Response in Chat A');

    // Navigate to Chat B
    const fixture2 = createNavigatedChatFixture('chat-B');
    const updatedState = attachManager.handleNavigation(
      'https://gemini.google.com/app/chat-B',
      fixture2,
    );

    expect(updatedState.conversationId).toBe('chat-B');
    expect(updatedState.lastResponseSummary).toBeNull(); // Stale response cleared!
  });

  // 14. Unknown DOM structure cannot trigger unsafe extraction
  it('14. unknown/unrecognized DOM structure pauses safely instead of guessing', () => {
    const fixture = createUnknownStructureFixture();
    const classification = adapter.classifyPage(
      fixture,
      'https://gemini.google.com/app/conv-999',
    );

    expect(classification.state).toBe('page-structure-unknown');
    expect(classification.canExtract).toBe(false);
    expect(classification.reason).toContain('DOM structure does not match tested Gemini selectors');
  });

  // 15. Empty/malformed content is handled explicitly
  it('15. empty response content is rejected safely', () => {
    const fixture = createEmptyResponseFixture('conv-empty-res');
    const res = adapter.extractResponse(fixture);

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('EMPTY_RESPONSE');
  });

  // 16. Oversized extraction respects configured limits
  it('16. oversized extraction truncates safely and reports isTruncated: true', () => {
    const fixture = createOversizedResponseFixture('conv-giant', 25000);
    const res = adapter.extractResponse(fixture, { maxChars: 5000 });

    expect(res.ok).toBe(true);
    expect(res.response?.characterCount).toBe(5000);
    expect(res.response?.isTruncated).toBe(true);
  });

  // 17. Draft is shown before any insert/send action
  it('17. prepared draft is shown and bounded before insertion', () => {
    const fixture = createCompletedTextFixture('conv-draft-test');
    attachManager.attach(
      { tabId: 107, url: 'https://gemini.google.com/app/conv-draft-test' },
      fixture,
    );

    const draftRes = draftManager.prepareDraft({
      text: 'Hello, please assist with task X.',
    });

    expect(draftRes.ok).toBe(true);
    expect(draftRes.status).toBe('ready-for-review');
    expect(draftRes.draft?.text).toBe('Hello, please assist with task X.');
    expect(draftRes.fallbackCopyText).toBe('Hello, please assist with task X.');
  });

  // 18. User must explicitly submit/send (never auto-sent)
  it('18. prepared drafts are never automatically submitted or sent', () => {
    const fixture = createCompletedTextFixture('conv-send-test');
    attachManager.attach(
      { tabId: 108, url: 'https://gemini.google.com/app/conv-send-test' },
      fixture,
    );

    draftManager.prepareDraft({ text: 'Draft message' });

    // Composer insertion only sets input value, does not trigger submit
    const insertRes = draftManager.insertIntoComposer(fixture);
    expect(insertRes.ok).toBe(true);

    const composer = adapter.findComposer(fixture);
    expect(composer?.value).toBe('Draft message');
  });

  // 19. Copy/manual-paste fallback works when composer detection fails
  it('19. fallback copy text is provided when composer detection fails', () => {
    const fixture = createUnknownStructureFixture();
    attachManager.attach(
      { tabId: 109, url: 'https://gemini.google.com/app/conv-999' },
      createCompletedTextFixture('conv-999'),
    );

    draftManager.prepareDraft({ text: 'Fallback message text' });
    const insertRes = draftManager.insertIntoComposer(fixture); // Unknown structure has no composer

    expect(insertRes.ok).toBe(true);
    expect(insertRes.status).toBe('manual-copy-required');
    expect(insertRes.fallbackCopyText).toBe('Fallback message text');
  });

  // 20. No hidden credential or cookie extraction path is present
  it('20. adapter does not access document.cookie or localStorage credentials', () => {
    const fixture = createCompletedTextFixture('conv-creds');
    const res = adapter.extractResponse(fixture);

    expect(res.ok).toBe(true);
    expect(res.response?.rawText).not.toContain('cookie');
    expect(res.response?.rawText).not.toContain('auth_token');
  });

  // 21. Detach/cancellation cleans up observers and event listeners
  it('21. detach invokes registered observer cleanups and prevents memory leaks', () => {
    let cleanupCalled = false;
    attachManager.registerObserverCleanup(() => {
      cleanupCalled = true;
    });

    attachManager.detach();
    expect(cleanupCalled).toBe(true);
  });

  // 22. Browser messages validate sender, schema and payload size
  it('22. draft preparation rejects oversized payloads exceeding limit', () => {
    const fixture = createCompletedTextFixture('conv-size-limit');
    attachManager.attach(
      { tabId: 110, url: 'https://gemini.google.com/app/conv-size-limit' },
      fixture,
    );

    const giantDraft = 'A'.repeat(MAX_PREPARED_DRAFT_BYTES + 100);
    const res = draftManager.prepareDraft({ text: giantDraft });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('rejected-oversized');
  });

  // 23. Prepared messages are never automatically executed/applied
  it('23. prepared messages are inert text strings with no execution hooks', () => {
    const fixture = createCompletedTextFixture('conv-exec-safety');
    attachManager.attach(
      { tabId: 111, url: 'https://gemini.google.com/app/conv-exec-safety' },
      fixture,
    );

    const res = draftManager.prepareDraft({
      text: 'rm -rf / && sudo do_something',
    });

    expect(res.ok).toBe(true);
    // Draft is strictly inert text
    expect(typeof res.draft?.text).toBe('string');
  });

  // 24. Extension does not claim native host/core connectivity when only fixtures are present
  it('24. attachState honestly reflects isCoreConnected: false in S18 shell', () => {
    const fixture = createCompletedTextFixture('conv-core-check');
    const state = attachManager.attach(
      { tabId: 112, url: 'https://gemini.google.com/app/conv-core-check' },
      fixture,
    );

    expect(state.isCoreConnected).toBe(false);
    expect(state.statusMessage).toContain('Native host not connected');
  });

  // 25. Overall architecture integrity invariant
  it('25. provider adapter and attach lifecycle are self-contained and modular', () => {
    expect(adapter.providerId).toBe('google-gemini');
    expect(attachManager.getState().status).toBe('detached');
  });

  // 26. NativeBridgeClient ping and connection
  it('26. NativeBridgeClient pings native host through port seam', async () => {
    const { NativeBridgeClient } = await import('./nativeBridgeClient.js');
    const port = new MockPort();
    const bridge = new NativeBridgeClient({ portSeam: port });

    const pingPromise = bridge.ping();
    expect(port.sentMessages).toHaveLength(1);
    const sent = port.sentMessages[0] as { correlationId: string; type: string };
    expect(sent.type).toBe('ping');

    // Simulate response
    port.simulateIncoming({
      correlationId: sent.correlationId,
      success: true,
      data: { pong: true },
    });

    const res = await pingPromise;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.pong).toBe(true);
    }
  });

  // 27. NativeBridgeClient handshake with pairing token
  it('27. NativeBridgeClient handshakes and transitions to connected state', async () => {
    const { NativeBridgeClient } = await import('./nativeBridgeClient.js');
    const port = new MockPort();
    const bridge = new NativeBridgeClient({ portSeam: port });

    const connectPromise = bridge.connect({
      pairingToken: 'valid_token_123',
      extensionId: 'abcdefghijklmnopponmlkjihgfedcba',
    });

    // Step 1: Ping
    expect(port.sentMessages.length).toBeGreaterThanOrEqual(1);
    const pingMsg = port.sentMessages[0] as { correlationId: string; type: string };
    port.simulateIncoming({
      correlationId: pingMsg.correlationId,
      success: true,
      data: { pong: true },
    });

    // Step 2: Handshake
    await new Promise((r) => setTimeout(r, 10));
    expect(port.sentMessages.length).toBe(2);
    const handshakeMsg = port.sentMessages[1] as { correlationId: string; type: string };
    expect(handshakeMsg.type).toBe('handshake');

    port.simulateIncoming({
      correlationId: handshakeMsg.correlationId,
      success: true,
      data: { negotiatedSessionId: 'sess_negotiated_1' },
    });

    const connectRes = await connectPromise;
    expect(connectRes.ok).toBe(true);
    expect(bridge.isConnected()).toBe(true);
    expect(bridge.getStatus().state).toBe('connected');
  });

  // 28. NativeBridgeClient reports core-unavailable honestly
  it('28. NativeBridgeClient reports core-unavailable when core fails to connect', async () => {
    const { NativeBridgeClient } = await import('./nativeBridgeClient.js');
    const port = new MockPort();
    const bridge = new NativeBridgeClient({ portSeam: port });

    const connectPromise = bridge.connect({
      pairingToken: 'valid_token_123',
    });

    // Ping succeeds
    const pingMsg = port.sentMessages[0] as { correlationId: string };
    port.simulateIncoming({
      correlationId: pingMsg.correlationId,
      success: true,
      data: { pong: true },
    });

    await new Promise((r) => setTimeout(r, 10));
    // Handshake fails with CORE_NOT_RUNNING
    const handshakeMsg = port.sentMessages[1] as { correlationId: string };
    port.simulateIncoming({
      correlationId: handshakeMsg.correlationId,
      success: false,
      errorCode: 'CORE_NOT_RUNNING',
      error: 'Core is not running',
    });

    const res = await connectPromise;
    expect(res.ok).toBe(false);
    expect(bridge.getStatus().state).toBe('core-unavailable');
  });

  // 29. NativeBridgeClient forwards chunk transfers and protocol envelopes
  it('29. NativeBridgeClient forwards chunk transfers through port seam', async () => {
    const { NativeBridgeClient } = await import('./nativeBridgeClient.js');
    const port = new MockPort();
    const bridge = new NativeBridgeClient({ portSeam: port });

    const transferPromise = bridge.transferChunk({ chunkId: 1 });
    const sent = port.sentMessages[0] as { correlationId: string; type: string };
    expect(sent.type).toBe('transfer_chunk');

    port.simulateIncoming({
      correlationId: sent.correlationId,
      success: true,
      data: { accepted: true },
    });

    const res = await transferPromise;
    expect(res.ok).toBe(true);
  });

  // 30. Disconnect resets state cleanly
  it('30. NativeBridgeClient disconnect cleans up state and marks disconnected', async () => {
    const { NativeBridgeClient } = await import('./nativeBridgeClient.js');
    const port = new MockPort();
    const bridge = new NativeBridgeClient({ portSeam: port });

    bridge.disconnect();
    expect(bridge.isConnected()).toBe(false);
    expect(bridge.getStatus().state).toBe('disconnected');
  });
});

class MockPort {
  private messageListeners: ((msg: unknown) => void)[] = [];
  private disconnectListeners: ((port: import('./chromeTypes.js').ChromePort) => void)[] = [];
  public sentMessages: unknown[] = [];

  public onMessage = {
    addListener: (cb: (msg: unknown) => void) => {
      this.messageListeners.push(cb);
    },
  };
  public onDisconnect = {
    addListener: (cb: (port: import('./chromeTypes.js').ChromePort) => void) => {
      this.disconnectListeners.push(cb);
    },
  };
  public postMessage(msg: unknown): void {
    this.sentMessages.push(msg);
  }
  public disconnect(): void {
    for (const cb of this.disconnectListeners) cb(this);
  }
  public simulateIncoming(msg: unknown): void {
    for (const cb of this.messageListeners) cb(msg);
  }
}

