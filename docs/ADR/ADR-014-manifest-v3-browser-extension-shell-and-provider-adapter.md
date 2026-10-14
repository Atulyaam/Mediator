# ADR-014 — Manifest V3 Browser Extension Shell and Provider Adapter

**Date:** 2026-10-11  
**Status:** ACCEPTED  
**Sprint:** S18  
**Deciders:** Mediator developer

## Context

Sprint S18 implements an isolated Manifest V3 browser extension shell capable of observing supported AI chat pages (starting with Google Gemini), detecting streaming and navigation states, preparing message drafts for manual sending, and providing an explicit user-driven attach/detach workflow.

Key architectural requirements and boundaries:
1. **Manifest V3 & Permission Minimization:** Request only `activeTab` and `storage`. Specifically, NO `nativeMessaging` (deferred to S19), NO `cookies`, NO `history`, NO `debugger`, NO filesystem access, and NO host shell execution.
2. **First-Provider Adapter:** Support Google Gemini (`https://gemini.google.com/*`) with a modular, provider-neutral adapter interface (`ProviderAdapter`).
3. **Decoupled from Core Host:** S18 does not connect to the native messaging host or localhost HTTP server. Extension honest UI explicitly displays "Disconnected" core status.
4. **DOM Safety & Safe Pauses:** Treat all web page content as untrusted data. Detect login walls, navigation/chat switches, streaming vs complete responses, and unknown DOM structures. Safely pause instead of guessing or scraping indiscriminately.
5. **Manual Draft Preparation:** Prepare bounded draft messages for user confirmation. Inserting into composer requires explicit user approval; fallback to manual copy is provided if composer is unavailable.
6. **Synthetic DOM Fixtures:** Validate all adapter states and extraction rules using sanitized synthetic DOM test fixtures rather than fragile live page scrapes or real user credentials.

## Decision

1. **Extension Architecture (`apps/browser-extension`):**
   - Manifest V3 manifest configured with:
     - Permissions: `["activeTab", "storage"]`
     - Host permissions: `["https://gemini.google.com/*"]`
     - Background service worker: `dist/background.js`
     - Popup UI: `popup.html` and `dist/popup.js`
     - Content script: `dist/contentScript.js` matched strictly to `https://gemini.google.com/*`
   - Pure browser bundle: zero Node.js native dependencies (`node:fs`, `node:child_process`, `sqlite3`, etc.).

2. **Provider Adapter Interface (`ProviderAdapter`):**
   - Defines standard contract for:
     - `classifyPage(doc, url)`: Identifies `supported-conversation`, `login-or-auth-required`, `conversation-identity-uncertain`, `page-structure-unknown`, `unsupported-page`.
     - `isResponseStreaming(doc)`: Inspects streaming indicators (e.g. `sparkle-animating`, `typing`, `busy`).
     - `extractResponse(doc, limits)`: Extracts bounded response text and code blocks with language annotations.
     - `prepareDraftInComposer(doc, draft)`: Detects contenteditable composer and inserts draft text, with fallback when ambiguous.

3. **Google Gemini Provider Adapter (`GeminiProviderAdapter`):**
   - Implements provider adapter for Gemini web UI (`https://gemini.google.com/app/*`).
   - Identifies conversation IDs from path or metadata.
   - Enforces configurable byte limits (default 32 KB) and code block counts (default 20).
   - Enforces streaming completion before extracting text.

4. **Attach / Detach Lifecycle Manager (`AttachManager`):**
   - User must explicitly click "Attach" to observe active tab.
   - Attaching to unsupported or login-required pages fails safely with actionable guidance.
   - Detach tears down observation and clears transient extracted state.
   - Tab switch or URL navigation transitions state to `paused` with clear `safePauseReason`.
   - Core connection state is honestly reported as `coreConnection: 'disconnected'`.

5. **Manual Draft Preparation Manager (`DraftManager`):**
   - Accepts bounded draft inputs (max 8 KB).
   - Validates draft against active attachment state.
   - Requires explicit user review before any composer insertion.
   - Provides clipboard copy fallback if composer structure is unknown.

6. **Comprehensive Synthetic DOM Fixtures:**
   - Implemented 10 realistic, sanitized mock DOM fixtures in `geminiFixtures.ts`:
     - Supported conversation with plain text response
     - Response with multiple syntax-highlighted code blocks
     - Active streaming response (`streaming: true`)
     - Login / authentication required page
     - Ambiguous conversation identity
     - Conversation navigation change
     - Unknown / mutated DOM structure
     - Empty response element
     - Oversized response exceeding configured limits
     - Unsupported third-party domain

## Consequences

- The browser extension shell safely observes and formats AI responses without broad permissions or security vulnerabilities.
- Production live same-chat loop and automated submission are deferred to S20.
- Native host IPC is deferred to S19; the extension currently operates in pure local fixture/popup mode.
- 25 dedicated fixture tests confirm all adapter and lifecycle contracts pass without needing live web browsers.
