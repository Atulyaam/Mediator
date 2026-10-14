# ADR-016 — First Provider Same-Chat Adapter (Google Gemini)

**Date:** 2026-10-11  
**Status:** ACCEPTED  
**Sprint:** S20  
**Deciders:** Mediator developer

## Context

Sprint S20 implements the first provider adapter (Google Gemini, `gemini.google.com`) enabling a full read-and-reply round trip without command execution.

Key architectural requirements and non-negotiables:
1. **Same-Chat Continuity Non-Negotiable:** A task loop and a chat conversation are different concepts. A new Mediator round must NOT create a new provider conversation. Every round must remain in the exact attached conversation. Never silently open a new chat to save context or clear errors.
2. **Conversation Identity & Anchoring:** The adapter must track provider (`google-gemini`), tab ID, conversation ID (extracted from `/app/<id>`), latest message anchor, and branch identity where available.
3. **Safe Pauses Over Guessing:** Any ambiguity (tab switch, navigation to another chat, branch divergence, message edits, regeneration, auth wall, DOM drift) must safely pause the loop instead of guessing or sending blindly.
4. **Priming & Conformance Testing:** When attaching, generate a cryptographically random session nonce (`generateCryptoNonce`) and send a priming message containing task rules, acceptance criteria, schema instructions, and a mandatory ping/pong conformance handshake before accepting real action proposals.
5. **Untrusted Data & Envelope Validation:** Assistant responses remain strictly untrusted data. Envelopes wrapped in `<<<MEDIATOR_PLAN>>>` or code blocks must pass schema validation, nonce matching, conversation ID matching, and canonical action enum verification.
6. **Explicit User Confirmation Gate (No Auto-Send):** Prepared message drafts require explicit user review and confirmation before submission. No message is ever auto-submitted upon draft preparation.
7. **Submission Observation & Uncertainty Handling:** After submission, observe the conversation DOM to verify acceptance (composer cleared, user query rendered). If acceptance cannot be verified, flag `submission-uncertain` and fall back to manual copy/send.
8. **Duplicate Submission Prevention:** Guard against duplicate sends by recording submitted draft IDs and rejecting repeated submissions.

## Decision

1. **Provider Adapter Expansion (`ProviderAdapter` & `GeminiProviderAdapter`):**
   - Implements `getConversationIdentity(doc, url, tabId)`: extracts unambiguous conversation ID, latest assistant message ID, and branch ID (`1/1`, etc.).
   - Implements `extractProtocolEnvelope(extractedResponse)`: parses `<<<MEDIATOR_PLAN>>>` tags, JSON code blocks, or markdown code fences, validating against `parseAndValidateEnvelope`.
   - Implements `insertReplyIfSupported`, `submitReplyIfSupported`, and `verifyReplyWasAccepted`.
   - Extends page classification with `branch-switched`, `regeneration-detected`, and `message-edited` states.

2. **Authoritative Same-Chat Manager (`SameChatManager`):**
   - Coordinates attached tab, URL, and conversation ID.
   - Enforces `checkContinuity()` on every extraction and submission attempt.
   - Manages state machine:
     - `status`: `detached`, `attached`, `paused`, `submitting`, `observing`, `error`.
     - `observationState`: `idle`, `draft-prepared`, `awaiting-user-confirmation`, `submitting`, `submission-observed`, `response-pending`, `response-complete`, `submission-uncertain`, `paused`, `failed`.
     - `conformanceStatus`: `untested`, `conformance-verified`, `conformance-failed`.
   - Priming: constructs structured priming draft and validates assistant's ping/pong echo response using constant-time `timingSafeEqualNonce`.
   - Submission: requires explicit `confirmAndSubmit(doc)` call. Guards against duplicate drafts with `SUBMISSION_DUPLICATE`.
   - Observation: verifies composer clearing and user message rendering. On failure, pauses with `submission-uncertain` and provides fallback copy text.

3. **Synthetic DOM Fixtures (`geminiFixtures.ts`):**
   - Added synthetic fixtures covering all S20 states:
     - Envelope in tags, code blocks, and markdown fences
     - Ping/pong conformance response
     - Branch switch / divergence
     - Active regeneration
     - Message edits
     - Interactive composer with click simulation
     - Verified acceptance vs uncertain submission

4. **Comprehensive Test Suite (`sameChatAdapter.test.ts`):**
   - 30 exhaustive unit and contract tests verifying:
     - Conversation identity extraction
     - Envelope parsing across 3 formats
     - JSON error handling and nonce mismatch rejection
     - Safe pause on tab switch, navigation, branch switch, regeneration, edits, login walls, and DOM drift
     - Priming generation and conformance verification
     - Explicit user confirmation gate and duplicate submission prevention
     - Submission observation and uncertain state fallback
     - Multi-round same-chat continuity across turns

## Consequences

### Positive
- Fully verified read-and-reply loop in the same conversation without opening new chats.
- Nonce binding and constant-time checks reject stale, replayed, or cross-chat proposals.
- Strict human confirmation gate guarantees no unconfirmed messages are sent to the AI.
- Submission observation prevents silent failures and duplicate re-sends.
- 100% test pass rate across 30 focused S20 tests and all prior suite tests.

### Neutral / Trade-offs
- Review-only mode remains strictly in effect. S20 enables browser-side conversation round trips, but does NOT enable command execution, project test runners, or live workspace mutations (Phase G / Sprint S21+).
