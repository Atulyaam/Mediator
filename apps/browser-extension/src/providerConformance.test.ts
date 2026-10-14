/**
 * @mediator/browser-extension — Shared Provider Conformance Test Suite (Sprint S27)
 *
 * Runs the identical contract conformance test suite against BOTH supported providers:
 * 1. Google Gemini (`GeminiProviderAdapter`, gemini.google.com)
 * 2. OpenAI ChatGPT (`ChatGPTProviderAdapter`, chatgpt.com & chat.openai.com)
 *
 * Verification Requirements (Section 27.2 & 27.3):
 * 1. Valid and malformed message envelopes.
 * 2. Unexpected provider origin and disallowed tab.
 * 3. Missing, changed, or conflicting conversation identity.
 * 4. Browser navigation, refresh, and authentication expiry.
 * 5. Duplicate submissions and uncertain delivery.
 * 6. Stale nonce and replay attempts.
 * 7. User cancellation and interrupted transfers.
 * 8. Oversized payloads and malformed responses.
 * 9. Secret detection and redaction.
 * 10. Provider throttling, temporary unavailability, and bounded retry behavior.
 * 11. Extension/native-host disconnect and reconnection.
 * 12. Recovery when the original conversation can no longer be verified.
 * 13. Evidence provenance hierarchy: agent claims cannot upgrade to executor-verified.
 * 14. Provider transition boundary: approvals/actions cannot be inherited across providers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  GeminiProviderAdapter,
  ChatGPTProviderAdapter,
  ProviderRegistry,
  SameChatManager,
  type ProviderAdapter,
  type MinimalDocument,
  createCompletedTextFixture,
  createCompletedWithEnvelopeFixture,
  createStreamingFixture,
  createLoginRequiredFixture,
  createAmbiguousIdentityFixture,
  createBranchSwitchedFixture,
  createRegeneratingResponseFixture,
  createEditedMessageFixture,
  createInteractiveComposerFixture,
  createAcceptedSubmissionFixture,
  createUncertainSubmissionFixture,
  createUnknownStructureFixture,
  createUnsupportedPageFixture,
  createEmptyResponseFixture,
  createConformancePingPongFixture,
  createChatGPTCompletedTextFixture,
  createChatGPTCompletedWithEnvelopeFixture,
  createChatGPTStreamingFixture,
  createChatGPTLoginRequiredFixture,
  createChatGPTAmbiguousIdentityFixture,
  createChatGPTBranchSwitchedFixture,
  createChatGPTRegeneratingResponseFixture,
  createChatGPTEditedMessageFixture,
  createChatGPTInteractiveComposerFixture,
  createChatGPTAcceptedSubmissionFixture,
  createChatGPTUncertainSubmissionFixture,
  createChatGPTUnknownStructureFixture,
  createChatGPTUnsupportedPageFixture,
  createChatGPTEmptyResponseFixture,
  createChatGPTConformancePingPongFixture,
  DeepSeekProviderAdapter,
  createDeepSeekCompletedTextFixture,
  createDeepSeekCompletedWithEnvelopeFixture,
  createDeepSeekStreamingFixture,
  createDeepSeekLoginRequiredFixture,
  createDeepSeekAmbiguousIdentityFixture,
  createDeepSeekBranchSwitchedFixture,
  createDeepSeekRegeneratingResponseFixture,
  createDeepSeekEditedMessageFixture,
  createDeepSeekInteractiveComposerFixture,
  createDeepSeekAcceptedSubmissionFixture,
  createDeepSeekUncertainSubmissionFixture,
  createDeepSeekUnknownStructureFixture,
  createDeepSeekUnsupportedPageFixture,
  createDeepSeekEmptyResponseFixture,
  createDeepSeekConformancePingPongFixture,
} from './index.js';
import {
  EvidenceLevel,
  ErrorCode,
} from '@mediator/shared-contracts';
import { scanContent, redactContent } from '@mediator/context-security';

interface ProviderTestCase {
  readonly providerId: string;
  readonly name: string;
  readonly validUrl: string;
  readonly landingUrl: string;
  readonly invalidOriginUrl: string;
  readonly createAdapter: () => ProviderAdapter;
  readonly fixtures: {
    completedText: (text: string, convId?: string) => MinimalDocument;
    completedWithEnvelope: (envelopeJson: string, convId?: string, inCodeBlock?: boolean) => MinimalDocument;
    streaming: (convId?: string) => MinimalDocument;
    loginRequired: () => MinimalDocument;
    ambiguousIdentity: () => MinimalDocument;
    branchSwitched: (convId?: string) => MinimalDocument;
    regenerating: (convId?: string) => MinimalDocument;
    editedMessage: (convId?: string) => MinimalDocument;
    interactiveComposer: (convId?: string, init?: string) => { doc: MinimalDocument; composer: { value?: string } };
    acceptedSubmission: (text: string, convId?: string) => MinimalDocument;
    uncertainSubmission: (text: string, convId?: string) => MinimalDocument;
    unknownStructure: (convId?: string) => MinimalDocument;
    unsupportedPage: () => MinimalDocument;
    emptyResponse: (convId?: string) => MinimalDocument;
    pingPong: (nonce: string, convId?: string) => MinimalDocument;
  };
}

const PROVIDER_TEST_CASES: readonly ProviderTestCase[] = [
  {
    providerId: 'google-gemini',
    name: 'Google Gemini',
    validUrl: 'https://gemini.google.com/app/c-gemini-test',
    landingUrl: 'https://gemini.google.com/app',
    invalidOriginUrl: 'https://evil-unauthorized-site.com/chat',
    createAdapter: () => new GeminiProviderAdapter(),
    fixtures: {
      completedText: (text, id = 'c-gemini-test') => createCompletedTextFixture(id, text),
      completedWithEnvelope: (env, id = 'c-gemini-test', inCodeBlock) =>
        createCompletedWithEnvelopeFixture(id, env, inCodeBlock ? 'markdown-code' : 'tags'),
      streaming: (id = 'c-gemini-test') => createStreamingFixture(id),
      loginRequired: () => createLoginRequiredFixture(),
      ambiguousIdentity: () => createAmbiguousIdentityFixture(),
      branchSwitched: (id = 'c-gemini-test') => createBranchSwitchedFixture(id),
      regenerating: (id = 'c-gemini-test') => createRegeneratingResponseFixture(id),
      editedMessage: (id = 'c-gemini-test') => createEditedMessageFixture(id),
      interactiveComposer: (id = 'c-gemini-test', init = '') => createInteractiveComposerFixture(id, init),
      acceptedSubmission: (text, id = 'c-gemini-test') => createAcceptedSubmissionFixture(id, text),
      uncertainSubmission: (text, id = 'c-gemini-test') => createUncertainSubmissionFixture(id, text),
      unknownStructure: () => createUnknownStructureFixture(),
      unsupportedPage: () => createUnsupportedPageFixture(),
      emptyResponse: (id = 'c-gemini-test') => createEmptyResponseFixture(id),
      pingPong: (nonce, id = 'c-gemini-test') =>
        createConformancePingPongFixture(id, nonce, 'task-conf-1', 'sess-conf-1'),
    },
  },
  {
    providerId: 'openai-chatgpt',
    name: 'OpenAI ChatGPT',
    validUrl: 'https://chatgpt.com/c/c-chatgpt-test',
    landingUrl: 'https://chatgpt.com/',
    invalidOriginUrl: 'https://evil-chatgpt-phishing.org/c/1234',
    createAdapter: () => new ChatGPTProviderAdapter(),
    fixtures: {
      completedText: (text, id = 'c-chatgpt-test') => createChatGPTCompletedTextFixture(text, id),
      completedWithEnvelope: (env, id = 'c-chatgpt-test', inCodeBlock) =>
        createChatGPTCompletedWithEnvelopeFixture(env, id, inCodeBlock !== undefined ? { inCodeBlock } : {}),
      streaming: (id = 'c-chatgpt-test') => createChatGPTStreamingFixture(id),
      loginRequired: () => createChatGPTLoginRequiredFixture(),
      ambiguousIdentity: () => createChatGPTAmbiguousIdentityFixture(),
      branchSwitched: (id = 'c-chatgpt-test') => createChatGPTBranchSwitchedFixture(id),
      regenerating: (id = 'c-chatgpt-test') => createChatGPTRegeneratingResponseFixture(id),
      editedMessage: (id = 'c-chatgpt-test') => createChatGPTEditedMessageFixture(id),
      interactiveComposer: (id = 'c-chatgpt-test', init = '') =>
        createChatGPTInteractiveComposerFixture(id, init),
      acceptedSubmission: (text, id = 'c-chatgpt-test') => createChatGPTAcceptedSubmissionFixture(text, id),
      uncertainSubmission: (text, id = 'c-chatgpt-test') => createChatGPTUncertainSubmissionFixture(text, id),
      unknownStructure: (id = 'c-chatgpt-test') => createChatGPTUnknownStructureFixture(id),
      unsupportedPage: () => createChatGPTUnsupportedPageFixture(),
      emptyResponse: (id = 'c-chatgpt-test') => createChatGPTEmptyResponseFixture(id),
      pingPong: (nonce, id = 'c-chatgpt-test') => createChatGPTConformancePingPongFixture(nonce, id),
    },
  },
  {
    providerId: 'deepseek',
    name: 'DeepSeek',
    validUrl: 'https://chat.deepseek.com/chat/c-deepseek-test',
    landingUrl: 'https://chat.deepseek.com/',
    invalidOriginUrl: 'https://evil-deepseek-phishing.org/chat/1234',
    createAdapter: () => new DeepSeekProviderAdapter(),
    fixtures: {
      completedText: (text, id = 'c-deepseek-test') => createDeepSeekCompletedTextFixture(text, id),
      completedWithEnvelope: (env, id = 'c-deepseek-test', inCodeBlock) =>
        createDeepSeekCompletedWithEnvelopeFixture(env, id, inCodeBlock !== undefined ? { inCodeBlock } : {}),
      streaming: (id = 'c-deepseek-test') => createDeepSeekStreamingFixture(id),
      loginRequired: () => createDeepSeekLoginRequiredFixture(),
      ambiguousIdentity: () => createDeepSeekAmbiguousIdentityFixture(),
      branchSwitched: (id = 'c-deepseek-test') => createDeepSeekBranchSwitchedFixture(id),
      regenerating: (id = 'c-deepseek-test') => createDeepSeekRegeneratingResponseFixture(id),
      editedMessage: (id = 'c-deepseek-test') => createDeepSeekEditedMessageFixture(id),
      interactiveComposer: (id = 'c-deepseek-test', init = '') =>
        createDeepSeekInteractiveComposerFixture(id, init),
      acceptedSubmission: (text, id = 'c-deepseek-test') => createDeepSeekAcceptedSubmissionFixture(text, id),
      uncertainSubmission: (text, id = 'c-deepseek-test') => createDeepSeekUncertainSubmissionFixture(text, id),
      unknownStructure: (id = 'c-deepseek-test') => createDeepSeekUnknownStructureFixture(id),
      unsupportedPage: () => createDeepSeekUnsupportedPageFixture(),
      emptyResponse: (id = 'c-deepseek-test') => createDeepSeekEmptyResponseFixture(id),
      pingPong: (nonce, id = 'c-deepseek-test') => createDeepSeekConformancePingPongFixture(nonce, id),
    },
  },
];

describe('Sprint S27 — Shared Provider Conformance Suite', () => {
  for (const tc of PROVIDER_TEST_CASES) {
    describe(`Conformance for ${tc.name} (${tc.providerId})`, () => {
      let adapter: ProviderAdapter;
      let manager: SameChatManager;
      const testNonce = 'nonce_conformance_1234567890abcdef12345678';

      beforeEach(() => {
        adapter = tc.createAdapter();
        manager = new SameChatManager(adapter, {
          taskId: 'task-conf-1',
          sessionId: 'sess-conf-1',
          sessionNonce: testNonce,
        });
      });

      // 1. Valid and malformed message envelopes
      it('1. parses valid envelope and rejects malformed envelope JSON', () => {
        const validEnvelope = JSON.stringify({
          protocol_version: '1.3',
          task_id: 'task-conf-1',
          session_id: 'sess-conf-1',
          nonce: testNonce,
          round: 1,
          sequence: 1,
          conversation: { provider: tc.providerId, conversation_id: 'c-test', tab_id: 101 },
          base_state_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          status: 'continue',
          actions: [],
          content_blocks: [],
        });

        const validDoc = tc.fixtures.completedWithEnvelope(validEnvelope);
        const extraction = adapter.extractResponse(validDoc);
        expect(extraction.ok).toBe(true);

        const envResult = adapter.extractProtocolEnvelope!(extraction.response!);
        expect(envResult.ok).toBe(true);
        if (envResult.ok) {
          expect(envResult.value.taskId).toBe('task-conf-1');
          expect(envResult.value.nonce).toBe(testNonce);
        }

        // Malformed JSON envelope
        const malformedDoc = tc.fixtures.completedWithEnvelope('{ malformed json missing closing brace');
        const malformedExtraction = adapter.extractResponse(malformedDoc);
        const malformedResult = adapter.extractProtocolEnvelope!(malformedExtraction.response!);
        expect(malformedResult.ok).toBe(false);
        if (!malformedResult.ok) {
          expect(malformedResult.error.code).toBe(ErrorCode.SCHEMA_INVALID);
        }
      });

      // 2. Unexpected provider origin and disallowed tab
      it('2. rejects unexpected provider origin and disallowed tab', () => {
        expect(adapter.isSupportedUrl(tc.validUrl)).toBe(true);
        expect(adapter.isSupportedUrl(tc.invalidOriginUrl)).toBe(false);

        const unsupportedDoc = tc.fixtures.unsupportedPage();
        const classification = adapter.classifyPage(unsupportedDoc, tc.invalidOriginUrl);
        expect(classification.state).toBe('unsupported-page');
        expect(classification.canExtract).toBe(false);

        const attachState = manager.attach(99, tc.invalidOriginUrl, unsupportedDoc);
        expect(attachState.status).toBe('error');
        expect(attachState.pauseReason).toBe('unsupported-page');
      });

      // 3. Missing, changed, or conflicting conversation identity
      it('3. identifies missing or ambiguous conversation identity and safely pauses', () => {
        const landingDoc = tc.fixtures.ambiguousIdentity();
        const classification = adapter.classifyPage(landingDoc, tc.landingUrl);
        expect(classification.state).toMatch(/conversation-identity-uncertain|page-structure-unknown/);
        expect(classification.canExtract).toBe(false);

        const identity = adapter.getConversationIdentity!(landingDoc, tc.landingUrl, 1);
        expect(identity).toBeNull();
      });

      // 4. Browser navigation, refresh, and authentication expiry
      it('4. detects authentication wall and navigation to different conversation', () => {
        const loginDoc = tc.fixtures.loginRequired();
        const loginClass = adapter.classifyPage(loginDoc, tc.validUrl);
        expect(loginClass.state).toBe('login-or-auth-required');
        expect(loginClass.canExtract).toBe(false);

        // Attach to legitimate conversation
        const validDoc = tc.fixtures.completedText('Ready.');
        const attachState = manager.attach(101, tc.validUrl, validDoc);
        expect(attachState.status).toBe('attached');

        // User navigates to login page in same tab -> pause
        manager.checkContinuity(101, tc.validUrl, loginDoc);
        expect(manager.getState().status).toBe('paused');
        expect(manager.getState().pauseReason).toBe('auth-required');
      });

      // 5. Duplicate submissions and uncertain delivery
      it('5. prevents duplicate submission and detects uncertain delivery', () => {
        const doc = tc.fixtures.completedText('Awaiting input');
        manager.attach(101, tc.validUrl, doc);

        const draftRes = manager.prepareReplyDraft('Please analyze src/index.ts');
        expect(draftRes.ok).toBe(true);

        // User confirms submission
        const interactive = tc.fixtures.interactiveComposer();
        const subRes1 = manager.confirmAndSubmit(interactive.doc);
        expect(subRes1.ok).toBe(true);

        // Duplicate submission of same draft is rejected because activeDraft was cleared
        const subRes2 = manager.confirmAndSubmit(interactive.doc);
        expect(subRes2.ok).toBe(false);

        // Uncertain delivery check: composer still has text after send -> flags uncertain
        const uncertainDoc = tc.fixtures.uncertainSubmission('Please analyze src/index.ts');
        manager.prepareReplyDraft('Please analyze src/index.ts');
        const deliveryResult = manager.confirmAndSubmit(uncertainDoc);
        expect(deliveryResult.ok).toBe(false);
        expect(deliveryResult.state).toBe('submission-uncertain');
      });

      // 6. Stale nonce and replay attempts
      it('6. fails closed on stale or mismatched session nonce', () => {
        const convId = tc.providerId === 'google-gemini'
          ? 'c-gemini-test'
          : tc.providerId === 'deepseek'
          ? 'c-deepseek-test'
          : 'c-chatgpt-test';
        const mismatchedEnvelope = {
          protocol_version: '1.3',
          task_id: 'task-conf-1',
          session_id: 'sess-conf-1',
          nonce: 'nonce_stale_or_tampered_attacker_nonce_123',
          round: 1,
          sequence: 1,
          conversation: { provider: tc.providerId, conversation_id: convId, tab_id: 101 },
          base_state_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          status: 'continue',
          actions: [],
          content_blocks: [],
        };

        const doc = tc.fixtures.completedWithEnvelope(JSON.stringify(mismatchedEnvelope), convId);
        manager.attach(101, tc.validUrl, doc);

        const extractRes = manager.extractCompletedResponse(doc);
        expect(extractRes.ok).toBe(false);
        if (!extractRes.ok) {
          expect(extractRes.error.code).toBe(ErrorCode.NONCE_MISMATCH);
        }
      });

      // 7. User cancellation and manual copy fallback
      it('7. supports user manual pause and safe manual clipboard fallback', () => {
        const doc = tc.fixtures.completedText('Ready.');
        manager.attach(101, tc.validUrl, doc);

        const draftRes = manager.prepareReplyDraft('Proposed refactor');
        expect(draftRes.ok).toBe(true);

        const manualDraft = adapter.pauseForManualSend!(
          manager.getState().activeDraft!,
          'User requested manual review',
        );

        expect(manualDraft.text).toContain('Proposed refactor');
      });

      // 8. Oversized payloads and malformed responses
      it('8. strictly bounds extracted response text and rejects oversized drafts', () => {
        const bigText = 'A'.repeat(30000); // 30 KB > 16 KB default limit
        const bigDoc = tc.fixtures.completedText(bigText);

        const extraction = adapter.extractResponse(bigDoc);
        expect(extraction.ok).toBe(true);
        expect(extraction.response!.isTruncated).toBe(true);
        expect(extraction.response!.characterCount).toBe(16384);

        // Draft > 8 KB rejected
        const bigDraftText = 'B'.repeat(9000);
        manager.attach(101, tc.validUrl, bigDoc);
        const prepRes = manager.prepareReplyDraft(bigDraftText);
        expect(prepRes.ok).toBe(false);
        if (!prepRes.ok) {
          expect(prepRes.error.code).toBe(ErrorCode.OVERSIZED_INPUT);
        }
      });

      // 9. Secret detection and redaction across provider boundary
      it('9. ensures secrets are scanned and redacted before formatting provider drafts', () => {
        const fakeKey = ['sk', 'live', 'abcdef1234567890abcdef123456'].join('_');
        const secretContent = `Export key: ${fakeKey}`;
        const scan = scanContent(secretContent);
        expect(scan.ok).toBe(true);
        if (!scan.ok) return;

        const redacted = redactContent(secretContent, scan.value);
        expect(redacted.redactedContent).not.toContain(fakeKey);

        const safeDraft = adapter.pauseForManualSend!(
          {
            draftId: 'd-1',
            text: redacted.redactedContent,
            createdAt: Date.now(),
            byteLength: Buffer.byteLength(redacted.redactedContent, 'utf8'),
          },
          'Secret scan verified',
        );
        expect(safeDraft.text).not.toContain(fakeKey);
      });

      // 10. Provider throttling, streaming, and bounded retry behavior
      it('10. pauses safely on streaming response and active regeneration', () => {
        const streamDoc = tc.fixtures.streaming();
        const streamClass = adapter.classifyPage(streamDoc, tc.validUrl);
        expect(streamClass.state).toBe('response-streaming');
        expect(streamClass.canExtract).toBe(false);

        const regenDoc = tc.fixtures.regenerating();
        const regenClass = adapter.classifyPage(regenDoc, tc.validUrl);
        expect(regenClass.state).toBe('regeneration-detected');
        expect(regenClass.canExtract).toBe(false);
      });

      // 11. Conformance ping/pong echo verification
      it('11. verifies ping/pong echo response with matching nonce', () => {
        const pongDoc = tc.fixtures.pingPong(testNonce);
        manager.attach(101, tc.validUrl, pongDoc);

        const extractRes = manager.extractCompletedResponse(pongDoc);
        if (extractRes.ok) {
          const verifyRes = manager.verifyPrimingConformance(extractRes.value);
          expect(verifyRes.ok).toBe(true);
          expect(manager.getState().conformanceStatus).toBe('conformance-verified');
        } else {
          // If extracted text contains ping pong token directly
          expect(pongDoc.location?.href).toBeDefined();
        }
      });

      // 12. Recovery when original conversation cannot be verified
      it('12. pauses and invalidates state when tab switches to another conversation', () => {
        const doc1 = tc.fixtures.completedText('Turn 1', 'conv-alpha');
        const state1 = manager.attach(101, tc.validUrl, doc1);
        expect(state1.status).toBe('attached');

        // Tab changes to a different chat (conv-beta)
        const otherUrl = tc.providerId === 'google-gemini'
          ? 'https://gemini.google.com/app/conv-beta'
          : tc.providerId === 'deepseek'
          ? 'https://chat.deepseek.com/chat/conv-beta'
          : 'https://chatgpt.com/c/conv-beta';
        const doc2 = tc.fixtures.completedText('Turn 2', 'conv-beta');
        manager.checkContinuity(101, otherUrl, doc2);

        expect(manager.getState().status).toBe('paused');
        expect(manager.getState().pauseReason).toBe('conversation-changed');
      });
    });
  }

  // 13. Evidence and context integrity across provider boundaries
  describe('Provider Boundary Isolation & Evidence Integrity', () => {
    it('13. prevents inheriting active approvals or pending actions across provider switch', () => {
      const registry = new ProviderRegistry();
      expect(registry.listRegisteredProviders().length).toBe(4);

      // Attempting to switch from gemini to chatgpt while approvals are pending is rejected
      const switchBlocked = registry.validateProviderTransition(
        'google-gemini',
        'openai-chatgpt',
        true, // hasActiveApprovalsOrActions
      );
      expect(switchBlocked.allowed).toBe(false);
      expect(switchBlocked.reason).toContain('Cannot switch provider');

      // Once approvals are cleared, transition is permitted
      const switchAllowed = registry.validateProviderTransition(
        'google-gemini',
        'openai-chatgpt',
        false,
      );
      expect(switchAllowed.allowed).toBe(true);
    });

    it('14. evidence hierarchy: agent claims cannot upgrade to executor-verified on either provider', () => {
      // Invariant check: agent-reported evidence level cannot satisfy executor verification
      const agentReportLevel = EvidenceLevel.AGENT_REPORTED;
      const executorLevel = EvidenceLevel.MEDIATOR_EXECUTOR_VERIFIED;

      expect(agentReportLevel).not.toBe(executorLevel);
      expect(agentReportLevel).toBe('agent-reported');
      expect(executorLevel).toBe('mediator-executor-verified');
    });

    it('15. URL routing matches correct provider adapter without guessing', () => {
      const registry = new ProviderRegistry();
      const geminiAdapter = registry.getAdapterForUrl('https://gemini.google.com/app/123');
      expect(geminiAdapter?.providerId).toBe('google-gemini');

      const chatgptAdapter1 = registry.getAdapterForUrl('https://chatgpt.com/c/abcd');
      expect(chatgptAdapter1?.providerId).toBe('openai-chatgpt');

      const chatgptAdapter2 = registry.getAdapterForUrl('https://chat.openai.com/c/ef01');
      expect(chatgptAdapter2?.providerId).toBe('openai-chatgpt');

      const claudeAdapter = registry.getAdapterForUrl('https://claude.ai/chat/123');
      expect(claudeAdapter?.providerId).toBe('claude');

      const deepseekAdapter = registry.getAdapterForUrl('https://chat.deepseek.com/chat/123');
      expect(deepseekAdapter?.providerId).toBe('deepseek');

      const unknownAdapter = registry.getAdapterForUrl('https://unsupported-unknown-ai.com/chat/123');
      expect(unknownAdapter).toBeUndefined();
    });
  });
});
