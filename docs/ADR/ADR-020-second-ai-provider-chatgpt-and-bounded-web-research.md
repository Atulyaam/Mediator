# ADR-020 — Second AI Provider (OpenAI ChatGPT) & Bounded Web Research

**Date:** 2026-10-11  
**Status:** ACCEPTED  
**Sprint:** S27  
**Deciders:** Mediator Architect

## Context

Sprint S20 established same-chat continuity and protocol envelope handling for Google Gemini (`gemini.google.com`). To prevent single-provider lock-in and enable developers to work with OpenAI ChatGPT within the same architectural safety invariants, Sprint S27 integrates a second browser AI provider and introduces an optional, bounded, secret-scanned web research module.

## Decisions

### 1. Second Provider Selection: OpenAI ChatGPT (`openai-chatgpt`)
- **Target domains:** `chatgpt.com` and `chat.openai.com`.
- **Identity observation:**
  - Extracts conversation IDs from canonical path patterns (`/c/<id>` or `/g/<gpt>/c/<id>`).
  - Landing pages (`/`) without explicit conversation IDs are classified as `conversation-identity-uncertain` or `page-structure-unknown` and pause safely.
  - Message anchors and branch turn pointers are tracked to detect edits and branch divergence.
- **Contract Conformance:** Implements the shared `ProviderAdapter` interface (`apps/browser-extension/src/chatgptProviderAdapter.ts`).
- **User Confirmation & Zero Auto-Send:** Composer pre-fill requires explicit user review. Submissions only occur when explicitly confirmed.
- **Duplicate Prevention:** Prevents re-submitting the same draft ID.

### 2. Provider Boundary Isolation (`ProviderRegistry`)
- **No Silent Switching:** If a session is bound to Provider A and the user switches tabs to Provider B, the session pauses with `tab-switched` or `conversation-changed`.
- **No Approval / Action Inheritance:** Pending approvals, in-flight action state, or staging scopes cannot be inherited across provider switches. Switching active providers requires active operations to be completed or invalidated.

### 3. Shared Conformance Test Suite (`providerConformance.test.ts`)
- The identical 12+ scenario matrix runs deterministically against both `GeminiProviderAdapter` and `ChatGPTProviderAdapter`:
  1. Envelope extraction & schema validation.
  2. Disallowed origin and tab isolation.
  3. Ambiguous conversation identity pausing.
  4. Auth wall detection.
  5. Duplicate submission prevention & uncertain delivery detection.
  6. Nonce mismatch failure closed.
  7. Manual copy fallback preservation.
  8. Size cap enforcement (16 KiB extraction, 8 KiB draft).
  9. Secret scanning & redaction across provider drafts.
  10. Streaming and active regeneration detection.
  11. Nonce ping/pong echo verification.
  12. Conversation navigation pausing.

### 4. Optional Bounded Web Research (`BoundedWebResearchService`)
- **Disabled by default:** `enabled: false`. Must be explicitly opted into.
- **Protocol:** Strict HTTPS only. Insecure HTTP, `file:`, `ftp:`, `javascript:`, and `data:` schemes are rejected fail-closed.
- **Credentials:** URLs with embedded username/password are rejected.
- **SSRF Defense:** Direct IP literals are forbidden. DNS resolution verifies that target addresses are not loopback (127.0.0.0/8), 0.0.0.0/8, RFC1918 private (10/8, 172.16/12, 192.168/16), link-local/cloud metadata (169.254.0.0/16), or IPv6 equivalents (::1, fe80::/10).
- **Hostname Allowlist:** Limited to approved documentation hostnames (`docs.python.org`, `developer.mozilla.org`, `nodejs.org`, `npmjs.com`, `github.com`, etc.).
- **Redirects:** Every redirect destination re-validates against all security and allowlist rules. Bounded to max 3 hops.
- **Resource Caps:** Bounded to 32 KiB response length and 5000ms timeout.
- **Untrusted Input Framing:** Script tags and active HTML stripped. Framed with clear boundary markers informing LLM that retrieved content is inert reference material and cannot issue instructions.
- **Secret Scanning:** Run through `scanContent` / `redactContent` before returning excerpts to the context engine.
- **Zero Command Execution:** Web research never runs downloaded scripts, packages, or installers.

## Consequences

- The Mediator browser extension now supports both Google Gemini and OpenAI ChatGPT through a single unified architecture.
- Both providers guarantee review-only safety under `NO-GO-AUTOEXEC`.
- Web research operates as a read-only, bounded assistant tool without expanding execution authority.
