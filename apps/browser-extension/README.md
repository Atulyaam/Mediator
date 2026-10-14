# Mediator AI Bridge Browser Extension (Sprint S18)

Manifest V3 browser extension shell providing safe read-only DOM observation, page state classification, bounded assistant response extraction, and manual draft preparation for Google Gemini.

## Architectural Boundaries

- **Review-only & Local-first**: Operates strictly within local browser tab context.
- **Untrusted Source**: All browser AI content is treated as untrusted input.
- **Pull-based & Manual**: No autonomous message dispatch or same-chat execution loop in S18 (that belongs to S20).
- **Core Decoupled**: Native host IPC and core connectivity are not included in S18 (belongs to S19). The UI explicitly displays disconnected core status.

## Manifest V3 Permission Rationale

To ensure absolute containment and zero privilege creep, this extension requests the minimum necessary permissions:

| Permission | Scope | Rationale |
|---|---|---|
| `activeTab` | User-initiated tab access | Grants temporary access to the active tab only when the user explicitly clicks the extension action or Attach button. |
| `storage` | Local extension preferences | Stores transient local UI state and user preferences. Full conversation history is NEVER persisted. |
| `host_permissions` | `https://gemini.google.com/*` | Restricts content script injection and DOM observation exclusively to supported Gemini conversational pages. |

### Prohibited Capabilities (Verified Invariant)

- **NO nativeMessaging**: Native host integration is deferred to Sprint S19.
- **NO cookies / history / debugger**: Extension never reads session cookies, browsing history, or debugger hooks.
- **NO filesystem or shell access**: Manifest V3 extensions possess zero host filesystem or shell execution capabilities.
- **NO credentials or token harvesting**: Never collects user passwords, Google authentication tokens, or authorization cookies.
- **NO eval or remote code execution**: 100% locally bundled code adhering to CSP requirements.
