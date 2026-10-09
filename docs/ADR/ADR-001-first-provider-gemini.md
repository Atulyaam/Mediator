# ADR-001 — First Provider Selection: Google Gemini

**Date:** 2026-10-10  
**Status:** ACCEPTED  
**Sprint:** S00  
**Deciders:** Mediator developer

## Context

Mediator needs a first browser AI provider to prove the same-chat read/prepare/send loop. The provider must be:
- Accessible to the developer without additional account setup
- Stable enough for DOM extraction testing
- Covered by ToS that permits personal productivity automation

## Decision

**Selected provider: Google Gemini (gemini.google.com)**

## Rationale

1. The developer is actively using Gemini within Antigravity IDE — no new account setup required.
2. Gemini's web UI uses a standard DOM structure with `contenteditable` composer and `[data-message-author-role="model"]` response containers — extractable without private APIs.
3. Code blocks render in `<pre><code>` elements — raw text is accessible via `.innerText` before Markdown rendering.
4. Google's terms permit personal automation that does not bypass access controls or scrape at scale.
5. Rate-limit-aware design (manual send fallback) ensures compliance.

## Consequences

- The `packages/provider-adapters/provider-gemini` adapter is the first real implementation.
- DOM selectors must be version-tested and kept behind a feature-detection layer.
- Provider adapter kill switch required — a Gemini DOM change must not disable workspace safety features.
- Second provider (Claude, DeepSeek) added in S27, after the first full loop is stable.

## Alternatives considered

| Provider | Reason not selected first |
|---|---|
| Claude (claude.ai) | Works well, but developer not in active use during this session |
| DeepSeek | Less familiarity; added later |
| API mode | Different conversation mode; explicitly opt-in, not v1 default |
