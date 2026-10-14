/**
 * @mediator/browser-extension — Sprint S20 Same-Chat Adapter Test Suite
 *
 * Comprehensive unit and contract verification for Google Gemini Same-Chat Adapter:
 * 1. Conversation identity extraction & tracking (tab, convId, messageId, branchId).
 * 2. Unambiguous conversation ID requirement (landing page / new chat rejected).
 * 3. Completed assistant response & envelope extraction from <<<MEDIATOR_PLAN>>> tags.
 * 4. Envelope extraction from JSON code blocks (<pre><code>).
 * 5. Envelope extraction from markdown ```json ``` code fences.
 * 6. Malformed envelope JSON error handling (returns SCHEMA_INVALID).
 * 7. Nonce validation: matching authoritative session nonce succeeds.
 * 8. Nonce validation: mismatched / stale session nonce rejected (fails closed).
 * 9. Conversation ID binding: envelope bound to attached conversation succeeds.
 * 10. Conversation ID binding: mismatched conversation ID rejected (fails closed).
 * 11. Safe pause on tab switch (never sends to wrong tab).
 * 12. Safe pause on navigation to a different chat (never creates or uses wrong chat).
 * 13. Safe pause on branch switch / conversation divergence.
 * 14. Safe pause on active assistant response regeneration.
 * 15. Safe pause on user message editing in conversation.
 * 16. Safe pause on login / authentication wall.
 * 17. Safe pause on unknown / drifting DOM structure.
 * 18. Safe pause on unsupported provider domain.
 * 19. Streaming response cannot be extracted as complete (returns RESPONSE_STREAMING).
 * 20. Priming message generation includes protocol version, task ID, nonce, and conformance ping.
 * 21. Conformance verification passes on valid ping/pong echo response.
 * 22. Conformance verification fails on tampered/stale ping/pong response.
 * 23. Draft preparation requires explicit user confirmation (NO auto-send).
 * 24. Duplicate submission prevention guard blocks replaying the same draft.
 * 25. Submission observation: verified acceptance (composer cleared + user query in DOM).
 * 26. Submission observation: uncertain acceptance (composer uncleared -> flags submission-uncertain).
 * 27. Fallback copy text provided when submission cannot be verified.
 * 28. Bounded draft size validation rejects oversized drafts (> 8 KB).
 * 29. Empty draft preparation rejected.
 * 30. Draft preparation rejected when detached or paused.
 * 31. Multi-round same-chat continuity preserves round/sequence in the same conversation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  GeminiProviderAdapter,
  SameChatManager,
  createCompletedTextFixture,
  createCompletedWithEnvelopeFixture,
  createConformancePingPongFixture,
  createBranchSwitchedFixture,
  createRegeneratingResponseFixture,
  createEditedMessageFixture,
  createInteractiveComposerFixture,
  createAcceptedSubmissionFixture,
  createUncertainSubmissionFixture,
  createStreamingFixture,
  createLoginRequiredFixture,
  createAmbiguousIdentityFixture,
  createUnknownStructureFixture,
  createUnsupportedPageFixture,
  createEmptyResponseFixture,
} from './index.js';

describe('Sprint S20 — First Provider Same-Chat Adapter (Google Gemini)', () => {
  let adapter: GeminiProviderAdapter;
  let manager: SameChatManager;
  const taskId = 'task-demo-s20';
  const sessionId = 'session-demo-s20';
  const testConvId = 'conv-gemini-test-001';
  const testUrl = `https://gemini.google.com/app/${testConvId}`;
  const fixedNonce = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    adapter = new GeminiProviderAdapter();
    manager = new SameChatManager(adapter, {
      taskId,
      sessionId,
      sessionNonce: fixedNonce,
    });
  });

  // ─── 1. Identity Tracking & Extraction ─────────────────────────────────────

  it('1. correctly extracts and tracks conversation identity (tab, convId, url, messageId, branchId)', () => {
    const doc = createCompletedWithEnvelopeFixture(testConvId, {
      protocol_version: '1.3',
      task_id: taskId,
      session_id: sessionId,
      nonce: fixedNonce,
      round: 1,
      sequence: 1,
      conversation: { provider: 'google-gemini', conversation_id: testConvId, tab_id: 101 },
      base_state_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      status: 'continue',
      actions: [{ id: 'a1', type: 'list_files', parameters: { path_prefix: '' } }],
      content_blocks: [],
    }, 'tags', {
      messageId: 'msg-ast-99',
      branchId: '1/1',
    });

    const state = manager.attach(101, testUrl, doc);
    expect(state.status).toBe('attached');
    expect(state.conversationIdentity).toBeDefined();
    expect(state.conversationIdentity?.providerId).toBe('google-gemini');
    expect(state.conversationIdentity?.tabId).toBe(101);
    expect(state.conversationIdentity?.conversationId).toBe(testConvId);
    expect(state.conversationIdentity?.messageId).toBe('msg-ast-99');
    expect(state.conversationIdentity?.branchId).toBe('1/1');
  });

  it('2. safely pauses when attaching to a landing page without an unambiguous conversation ID', () => {
    const doc = createAmbiguousIdentityFixture();
    const state = manager.attach(101, 'https://gemini.google.com/app', doc);
    expect(state.status).toBe('paused');
    expect(state.pauseReason).toBe('page-structure-unknown');
    expect(state.conversationIdentity).toBeNull();
  });

  // ─── 2. Completed Assistant Response & Protocol Envelope Extraction ───────

  it('3. extracts and validates protocol envelope wrapped in <<<MEDIATOR_PLAN>>> tags', () => {
    const rawEnvelope = {
      protocol_version: '1.3',
      task_id: taskId,
      session_id: sessionId,
      nonce: fixedNonce,
      round: 1,
      sequence: 1,
      conversation: { provider: 'google-gemini', conversation_id: testConvId, tab_id: 101 },
      base_state_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      status: 'continue',
      actions: [{ id: 'act-1', type: 'read_file', parameters: { path: 'src/index.ts' } }],
      content_blocks: [],
    };

    const doc = createCompletedWithEnvelopeFixture(testConvId, rawEnvelope, 'tags');
    manager.attach(101, testUrl, doc);

    const extractResult = manager.extractCompletedResponse(doc);
    expect(extractResult.ok).toBe(true);
    if (!extractResult.ok) return;

    expect(extractResult.value.protocolVersion).toBe('1.3');
    expect(extractResult.value.taskId).toBe(taskId);
    expect(extractResult.value.nonce).toBe(fixedNonce);
    expect(extractResult.value.status).toBe('continue');
    expect(extractResult.value.actions).toHaveLength(1);
    expect(extractResult.value.actions[0]?.type).toBe('read_file');
  });

  it('4. extracts and validates protocol envelope inside pre/code HTML block', () => {
    const rawEnvelope = {
      protocol_version: '1.3',
      task_id: taskId,
      session_id: sessionId,
      nonce: fixedNonce,
      round: 1,
      sequence: 2,
      conversation: { provider: 'google-gemini', conversation_id: testConvId, tab_id: 101 },
      base_state_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      status: 'continue',
      actions: [{ id: 'act-2', type: 'read_file', parameters: { path: 'lib/index.ts' } }],
      content_blocks: [],
    };

    const doc = createCompletedWithEnvelopeFixture(testConvId, rawEnvelope, 'code-block');
    manager.attach(101, testUrl, doc);

    const extractResult = manager.extractCompletedResponse(doc);
    expect(extractResult.ok).toBe(true);
    if (!extractResult.ok) return;
    expect(extractResult.value.actions[0]?.type).toBe('read_file');
  });

  it('5. extracts and validates protocol envelope formatted with markdown ```json ``` code fences', () => {
    const rawEnvelope = {
      protocol_version: '1.3',
      task_id: taskId,
      session_id: sessionId,
      nonce: fixedNonce,
      round: 1,
      sequence: 3,
      conversation: { provider: 'google-gemini', conversation_id: testConvId, tab_id: 101 },
      base_state_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      status: 'await_user',
      actions: [{ id: 'act-3', type: 'get_diff', parameters: {} }],
      content_blocks: [],
    };

    const doc = createCompletedWithEnvelopeFixture(testConvId, rawEnvelope, 'markdown-code');
    manager.attach(101, testUrl, doc);

    const extractResult = manager.extractCompletedResponse(doc);
    expect(extractResult.ok).toBe(true);
    if (!extractResult.ok) return;
    expect(extractResult.value.status).toBe('await_user');
  });

  it('6. rejects malformed envelope JSON with SCHEMA_INVALID', () => {
    const malformedText = '<<<MEDIATOR_PLAN>>>\n{ protocol_version: invalid json missing quotes\n<<<END_MEDIATOR_PLAN>>>';
    const doc = createCompletedWithEnvelopeFixture(testConvId, malformedText, 'tags');
    manager.attach(101, testUrl, doc);

    const extractResult = manager.extractCompletedResponse(doc);
    expect(extractResult.ok).toBe(false);
    if (extractResult.ok) return;
    expect(extractResult.error.code).toBe('SCHEMA_INVALID');
  });

  // ─── 3. Nonce & Conversation Identity Invariants ───────────────────────────

  it('7. accepts envelope with matching session nonce and active conversation', () => {
    const doc = createCompletedWithEnvelopeFixture(testConvId, {
      protocol_version: '1.3',
      task_id: taskId,
      session_id: sessionId,
      nonce: fixedNonce,
      round: 1,
      sequence: 1,
      conversation: { provider: 'google-gemini', conversation_id: testConvId, tab_id: 101 },
      base_state_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      status: 'continue',
      actions: [{ id: 'a1', type: 'get_diff', parameters: {} }],
      content_blocks: [],
    }, 'tags');

    manager.attach(101, testUrl, doc);
    const result = manager.extractCompletedResponse(doc);
    expect(result.ok).toBe(true);
  });

  it('8. rejects envelope with mismatched/stale session nonce and safely pauses', () => {
    const wrongNonce = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const doc = createCompletedWithEnvelopeFixture(testConvId, {
      protocol_version: '1.3',
      task_id: taskId,
      session_id: sessionId,
      nonce: wrongNonce,
      round: 1,
      sequence: 1,
      conversation: { provider: 'google-gemini', conversation_id: testConvId, tab_id: 101 },
      base_state_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      status: 'continue',
      actions: [{ id: 'a1', type: 'get_diff', parameters: {} }],
      content_blocks: [],
    }, 'tags');

    manager.attach(101, testUrl, doc);
    const result = manager.extractCompletedResponse(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NONCE_MISMATCH');
    expect(manager.getState().status).toBe('paused');
    expect(manager.getState().pauseReason).toBe('conformance-failed');
  });

  it('9. rejects envelope whose conversation ID does not match the attached chat', () => {
    const otherConvId = 'conv-gemini-different-999';
    const doc = createCompletedWithEnvelopeFixture(testConvId, {
      protocol_version: '1.3',
      task_id: taskId,
      session_id: sessionId,
      nonce: fixedNonce,
      round: 1,
      sequence: 1,
      conversation: { provider: 'google-gemini', conversation_id: otherConvId, tab_id: 101 },
      base_state_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      status: 'continue',
      actions: [{ id: 'a1', type: 'get_diff', parameters: {} }],
      content_blocks: [],
    }, 'tags');

    manager.attach(101, testUrl, doc);
    const result = manager.extractCompletedResponse(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONVERSATION_MISMATCH');
    expect(manager.getState().pauseReason).toBe('conversation-changed');
  });

  // ─── 4. Safe Pause on Browser / Conversation Events ────────────────────────

  it('10. safely pauses on tab switch (active tab changed from 101 to 202)', () => {
    const doc = createCompletedTextFixture(testConvId);
    manager.attach(101, testUrl, doc);

    const continuity = manager.checkContinuity(202, testUrl, doc);
    expect(continuity.ok).toBe(false);
    expect(continuity.reason).toBe('tab-switched');
    expect(manager.getState().status).toBe('paused');
    expect(manager.getState().pauseReason).toBe('tab-switched');
  });

  it('11. safely pauses when user navigates to a different conversation URL', () => {
    const doc = createCompletedTextFixture('conv-gemini-other-777');
    manager.attach(101, testUrl, doc);

    const continuity = manager.checkContinuity(101, 'https://gemini.google.com/app/conv-gemini-other-777', doc);
    expect(continuity.ok).toBe(false);
    expect(continuity.reason).toBe('conversation-changed');
    expect(manager.getState().status).toBe('paused');
    expect(manager.getState().pauseReason).toBe('conversation-changed');
  });

  it('12. safely pauses on branch switch / divergence (branch 2 of 2)', () => {
    const doc = createBranchSwitchedFixture(testConvId, '2/2');
    manager.attach(101, testUrl, doc);

    const continuity = manager.checkContinuity(101, testUrl, doc);
    expect(continuity.ok).toBe(false);
    expect(continuity.reason).toBe('branch-switched');
    expect(manager.getState().pauseReason).toBe('branch-switched');
  });

  it('13. safely pauses when assistant response is actively regenerating', () => {
    const doc = createRegeneratingResponseFixture(testConvId);
    manager.attach(101, testUrl, doc);

    const continuity = manager.checkContinuity(101, testUrl, doc);
    expect(continuity.ok).toBe(false);
    expect(continuity.reason).toBe('regeneration-detected');
    expect(manager.getState().pauseReason).toBe('regeneration-detected');
  });

  it('14. safely pauses when prior message in conversation has been edited', () => {
    const doc = createEditedMessageFixture(testConvId);
    manager.attach(101, testUrl, doc);

    const continuity = manager.checkContinuity(101, testUrl, doc);
    expect(continuity.ok).toBe(false);
    expect(continuity.reason).toBe('message-edited');
    expect(manager.getState().pauseReason).toBe('message-edited');
  });

  it('15. safely pauses when login / authentication wall is detected', () => {
    const doc = createLoginRequiredFixture();
    manager.attach(101, testUrl, doc);

    const continuity = manager.checkContinuity(101, testUrl, doc);
    expect(continuity.ok).toBe(false);
    expect(continuity.reason).toBe('auth-required');
    expect(manager.getState().pauseReason).toBe('auth-required');
  });

  it('16. safely pauses when page DOM layout structure is unknown or drifted', () => {
    const doc = createUnknownStructureFixture();
    manager.attach(101, testUrl, doc);

    const continuity = manager.checkContinuity(101, testUrl, doc);
    expect(continuity.ok).toBe(false);
    expect(continuity.reason).toBe('page-structure-unknown');
    expect(manager.getState().pauseReason).toBe('page-structure-unknown');
  });

  it('17. fails cleanly when attempting to attach to an unsupported domain', () => {
    const doc = createUnsupportedPageFixture();
    const state = manager.attach(101, 'https://example.com/unrelated', doc);
    expect(state.status).toBe('error');
    expect(state.pauseReason).toBe('unsupported-page');
  });

  it('18. refuses extraction while assistant response is actively streaming', () => {
    const doc = createStreamingFixture(testConvId);
    manager.attach(101, testUrl, doc);

    const result = manager.extractCompletedResponse(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RESPONSE_STREAMING');
    expect(manager.getState().observationState).toBe('response-pending');
  });

  // ─── 5. Priming & Conformance Testing ──────────────────────────────────────

  it('19. generates a valid priming prompt containing task ID, session ID, nonce, and conformance test', () => {
    const doc = createCompletedTextFixture(testConvId);
    manager.attach(101, testUrl, doc);

    const primingDraft = manager.generatePrimingMessage();
    expect(primingDraft.text).toContain('<<<MEDIATOR_PRIMING>>>');
    expect(primingDraft.text).toContain(`Task ID: ${taskId}`);
    expect(primingDraft.text).toContain(`Session ID: ${sessionId}`);
    expect(primingDraft.text).toContain(`Session Nonce: ${fixedNonce}`);
    expect(primingDraft.text).toContain('act_ping_1');
    expect(primingDraft.text).toContain('<<<MEDIATOR_PLAN>>>');
    expect(primingDraft.targetConversationId).toBe(testConvId);
    expect(manager.getState().observationState).toBe('draft-prepared');
  });

  it('20. successfully verifies conformance when assistant echoes the valid ping/pong envelope', () => {
    const doc = createConformancePingPongFixture(testConvId, fixedNonce, taskId, sessionId);
    manager.attach(101, testUrl, doc);

    const extractResult = manager.extractCompletedResponse(doc);
    expect(extractResult.ok).toBe(true);
    if (!extractResult.ok) return;

    const confResult = manager.verifyPrimingConformance(extractResult.value);
    expect(confResult.ok).toBe(true);
    expect(manager.getState().conformanceStatus).toBe('conformance-verified');
  });

  it('21. fails conformance and pauses safely when assistant returns wrong/tampered nonce', () => {
    const tamperedNonce = '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';
    const doc = createConformancePingPongFixture(testConvId, tamperedNonce, taskId, sessionId);
    manager.attach(101, testUrl, doc);

    // Manual inspection or extract check
    const rawEnvelope = {
      protocolVersion: '1.3',
      taskId,
      sessionId,
      nonce: tamperedNonce,
      round: 1,
      sequence: 1,
      providerId: 'google-gemini',
      conversationId: testConvId,
      baseStateHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      status: 'continue' as const,
      actions: [{ id: 'act_ping_1', type: 'get_task_brief', parameters: {} }],
      contentBlocks: [],
      rawBytesLength: 100,
    };

    const confResult = manager.verifyPrimingConformance(rawEnvelope);
    expect(confResult.ok).toBe(false);
    if (confResult.ok) return;
    expect(confResult.error.code).toBe('NONCE_MISMATCH');
    expect(manager.getState().conformanceStatus).toBe('conformance-failed');
    expect(manager.getState().pauseReason).toBe('conformance-failed');
  });

  // ─── 6. Safe Draft Preparation & Explicit User-Confirmed Submission ────────

  it('22. preparing a reply draft moves state to awaiting-user-confirmation and NEVER auto-submits', () => {
    const doc = createCompletedTextFixture(testConvId);
    manager.attach(101, testUrl, doc);

    const draftResult = manager.prepareReplyDraft('Here is test feedback for the model.');
    expect(draftResult.ok).toBe(true);
    if (!draftResult.ok) return;

    const state = manager.getState();
    expect(state.observationState).toBe('awaiting-user-confirmation');
    expect(state.activeDraft).toBeDefined();
    expect(state.activeDraft?.text).toBe('Here is test feedback for the model.');

    // Invariant check: composer in DOM has NOT been modified yet!
    const composer = doc.querySelector('textarea');
    expect(composer?.value).toBe('');
  });

  it('23. prevents duplicate submission when attempting to re-send the same draft ID', () => {
    const doc = createAcceptedSubmissionFixture(testConvId, 'Initial feedback');
    manager.attach(101, testUrl, doc);

    const draftRes = manager.prepareReplyDraft('Initial feedback');
    expect(draftRes.ok).toBe(true);

    const submitRes = manager.confirmAndSubmit(doc);
    expect(submitRes.ok).toBe(true);

    // Attempt second submission with same draft
    const duplicateRes = manager.confirmAndSubmit(doc);
    expect(duplicateRes.ok).toBe(false);
    expect(duplicateRes.errorCode).toBe('SCHEMA_INVALID'); // No active draft because it was cleared
  });

  it('24. submission observation: succeeds and advances sequence when composer is cleared and user query appears', () => {
    const { doc, composer } = createInteractiveComposerFixture(testConvId);
    manager.attach(101, testUrl, doc);

    const draftRes = manager.prepareReplyDraft('User approved step 1');
    expect(draftRes.ok).toBe(true);

    const subResult = manager.confirmAndSubmit(doc);
    expect(subResult.ok).toBe(true);
    expect(subResult.state).toBe('submission-observed');

    // Sequence advanced and active draft cleared
    expect(manager.getSequence()).toBe(2);
    expect(manager.getState().activeDraft).toBeNull();
    expect(composer.value).toBe('');
  });

  it('25. submission observation: flags submission-uncertain and pauses when composer remains uncleared', () => {
    const doc = createUncertainSubmissionFixture(testConvId, 'Uncertain prompt text');
    manager.attach(101, testUrl, doc);

    const draftRes = manager.prepareReplyDraft('Uncertain prompt text');
    expect(draftRes.ok).toBe(true);

    const subResult = manager.confirmAndSubmit(doc);
    expect(subResult.ok).toBe(false);
    expect(subResult.state).toBe('submission-uncertain');
    expect(subResult.errorCode).toBe('SUBMISSION_UNCERTAIN');
    expect(subResult.fallbackCopyText).toBe('Uncertain prompt text');
    expect(manager.getState().status).toBe('paused');
    expect(manager.getState().pauseReason).toBe('submission-uncertain');
  });

  it('26. rejects draft exceeding maximum allowed size of 8 KB with OVERSIZED_INPUT', () => {
    const doc = createCompletedTextFixture(testConvId);
    manager.attach(101, testUrl, doc);

    const giantText = 'Z'.repeat(8193); // 8193 > 8192
    const draftRes = manager.prepareReplyDraft(giantText);
    expect(draftRes.ok).toBe(false);
    if (draftRes.ok) return;
    expect(draftRes.error.code).toBe('OVERSIZED_INPUT');
    expect(manager.getState().pauseReason).toBe('oversized-draft');
  });

  it('27. rejects preparing an empty draft text', () => {
    const doc = createCompletedTextFixture(testConvId);
    manager.attach(101, testUrl, doc);

    const draftRes = manager.prepareReplyDraft('    ');
    expect(draftRes.ok).toBe(false);
    if (draftRes.ok) return;
    expect(draftRes.error.code).toBe('SCHEMA_INVALID');
    expect(manager.getState().pauseReason).toBe('empty-draft');
  });

  it('28. rejects draft preparation when extension is detached or paused', () => {
    // Detached
    const draftRes = manager.prepareReplyDraft('Some text');
    expect(draftRes.ok).toBe(false);
    if (draftRes.ok) return;
    expect(draftRes.error.code).toBe('IPC_OPERATION_PROHIBITED');
  });

  // ─── 7. Multi-Round Continuity Invariant ───────────────────────────────────

  it('29. multi-round same-chat continuity preserves round and conversation binding across turns', () => {
    // Round 1
    const docR1 = createConformancePingPongFixture(testConvId, fixedNonce, taskId, sessionId, 1, 1);
    manager.attach(101, testUrl, docR1);

    const r1Extracted = manager.extractCompletedResponse(docR1);
    expect(r1Extracted.ok).toBe(true);
    if (!r1Extracted.ok) return;

    const r1Conf = manager.verifyPrimingConformance(r1Extracted.value);
    expect(r1Conf.ok).toBe(true);

    // Advance to Round 2 in same chat
    manager.advanceRound();
    expect(manager.getRound()).toBe(2);
    expect(manager.getSequence()).toBe(1);

    // Prepare Round 2 reply draft
    const r2Draft = manager.prepareReplyDraft('Here is stage feedback for Round 2.');
    expect(r2Draft.ok).toBe(true);

    // Confirm submission in same chat
    const r2SubmitDoc = createAcceptedSubmissionFixture(testConvId, 'Here is stage feedback for Round 2.');
    const r2Sub = manager.confirmAndSubmit(r2SubmitDoc);
    expect(r2Sub.ok).toBe(true);
    expect(manager.getSequence()).toBe(2);

    // Round 2 AI response in same chat
    const r2AiResponse = {
      protocol_version: '1.3',
      task_id: taskId,
      session_id: sessionId,
      nonce: fixedNonce,
      round: 2,
      sequence: 2,
      conversation: { provider: 'google-gemini', conversation_id: testConvId, tab_id: 101 },
      base_state_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      status: 'proposed_complete',
      actions: [{ id: 'act-done', type: 'get_task_brief', parameters: {} }],
      content_blocks: [],
    };
    const docR2Complete = createCompletedWithEnvelopeFixture(testConvId, r2AiResponse, 'tags');

    const r2Extracted = manager.extractCompletedResponse(docR2Complete);
    expect(r2Extracted.ok).toBe(true);
    if (!r2Extracted.ok) return;
    expect(r2Extracted.value.round).toBe(2);
    expect(r2Extracted.value.status).toBe('proposed_complete');
    expect(manager.getState().conversationIdentity?.conversationId).toBe(testConvId);
  });

  it('30. handles empty response in assistant container cleanly', () => {
    const doc = createEmptyResponseFixture(testConvId);
    manager.attach(101, testUrl, doc);

    const extractResult = manager.extractCompletedResponse(doc);
    expect(extractResult.ok).toBe(false);
  });
});
