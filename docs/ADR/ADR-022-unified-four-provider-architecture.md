# ADR-022 — Unified Four-Provider Architecture (OpenAI, Gemini, Claude, DeepSeek)

**Date:** 2026-10-12  
**Status:** ACCEPTED  
**Sprint:** S29–S32  
**Deciders:** Mediator Multi-Provider Integration Program

## Context

Mediator completed its initial S00–S28 foundation under the authoritative decision `NO-GO-AUTOEXEC` (Review-Only V1, with Autopilot deferred fail-closed under S26 Outcome B). The initial implementation supported Google Gemini and OpenAI ChatGPT via browser extension bridges (Mode A).

To expand developer flexibility while strictly maintaining safety invariants, Sprints S29, S30, S31, and S32 create a unified, four-provider integration program supporting:
1. **OpenAI ChatGPT** (`openai`)
2. **Google Gemini** (`gemini`)
3. **Anthropic Claude** (`claude`)
4. **DeepSeek** (`deepseek`)

## Decisions

### 1. Canonical Provider IDs and Identifiers (S29.2)
- Fixed canonical provider IDs: `'openai' | 'gemini' | 'claude' | 'deepseek'`.
- Provider IDs are validated fail-closed at all IPC and API boundaries (`isCanonicalProviderId`).
- Arbitrary URL generation or user-provided provider ID URL concatenation is prohibited.

### 2. Two Distinct Integration Modes (Non-Negotiable Architecture)
- **Mode A — Browser Session Bridge:**
  - Attaches to explicitly selected browser tabs (`chatgpt.com`, `gemini.google.com`, `claude.ai`, `chat.deepseek.com`).
  - Strict origin validation, DOM classification, conversation identity tracking.
  - Requires explicit user confirmation before message transmission.
  - Falls back to manual-copy/manual-paste (`manual`) when automated interaction is unpermitted or ambiguous.
  - Never transmits API credentials to or through browser pages.
- **Mode B — Official Developer API:**
  - Interacts exclusively with official provider developer endpoints:
    - OpenAI: `https://api.openai.com/v1/chat/completions`
    - Gemini: `https://generativelanguage.googleapis.com/v1beta/models/{modelId}:generateContent`
    - Claude: `https://api.anthropic.com/v1/messages`
    - DeepSeek: `https://api.deepseek.com/chat/completions`
  - Fixed base URLs prevent arbitrary URL redirections.
  - Separate, isolated API session state; never claims API continues browser website chat.
  - Requires explicit user opt-in and credential configuration.
  - Bounded retries (max 2 retries on 429/500/529 with exponential backoff and `retry-after` header handling).
  - Explicit timeouts and caller cancellation via `AbortSignal`.
  - Never automatically falls back between Mode A and Mode B.

### 3. Secure Credential Storage (S29.1, S30.3)
- API credentials are stored encrypted at rest using **AES-256-GCM** with **PBKDF2-HMAC-SHA256** key derivation (100,000 iterations).
- Machine- and user-specific key derivation ensures local security.
- Standard storage path: `%LOCALAPPDATA%\Mediator\security\credentials.enc`.
- The store returns only `CredentialMetadata` (`keyHash` and `lastFour`). Raw secrets are never exposed in UI cards, settings, debug bundles, or logs.

### 4. Claude Integration (S30)
- Implements Anthropic Messages API (`anthropic-version: 2023-06-01`, `x-api-key`).
- Supported models: `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `claude-3-opus-20240229`.
- Top-level `system` prompt extraction from unified messages.
- Full SSE streaming support (`content_block_delta` text extraction and token usage accumulation).
- Browser bridge operates in manual handoff mode for strict terms compliance.

### 5. DeepSeek Integration (S31)
- Implements DeepSeek Chat Completions API with Bearer token authentication.
- Supported models: `deepseek-chat` (DeepSeek-V3) and `deepseek-reasoner` (DeepSeek-R1).
- **Strict Reasoning Isolation:** For `deepseek-reasoner`, `reasoning_content` is extracted into `reasoningContent` and strictly excluded from user-facing `content` and streaming `onChunk` events.
- Browser bridge operates in manual handoff mode.

### 6. Provider Switching & Approval Invalidation (S29.3, S32.3)
- Provider switching requires explicit user action.
- Switching active provider is strictly blocked when pending approvals or uncommitted actions exist (`PROVIDER_SWITCH_NOT_ALLOWED`).
- Stale responses originating from previously active providers are rejected (`PROVIDER_SESSION_MISMATCH`).

### 7. End-to-End Hardening & 20-Scenario Common Test Matrix (S32.4)
- Deterministic 20-scenario suite (`packages/provider-core/src/commonProviderMatrix.test.ts`) verifies contracts across all four providers.
- Coverage includes: valid requests, malformed responses, credential errors, model verification, timeouts, rate limits, outages, streaming termination, cancellation, oversized payloads, secret redaction, provider switching, session isolation, approval invalidation, native host disconnection, manual handoff, credential replacement, recovery, audit log integrity, bounded retries, and mode separation.

## Consequences

- All four providers are unified under a single architecture (`@mediator/provider-core`).
- Review-Only V1 and `NO-GO-AUTOEXEC` remain 100% authoritative.
- Zero local command execution or shell fallbacks.
- Developer experience is transparent: users can see exact provider capabilities, configured models, masked credentials, and real connection health.
