# Mediator — Debugging Guide

**Sprint:** S00+  
**Maintained by:** Update after each sprint that adds a new failure boundary.

---

## 1. Module debugging contract

Every module must:
- Export typed errors with stable error codes (e.g., `PATH_OUTSIDE_ROOT`, `NONCE_MISMATCH`)
- Attach `taskId`, `sessionId`, `correlationId`, `actionId` to all cross-module events
- Log structured JSON events: `{ severity, module, correlationId, taskId, roundId, actionId, duration, result }`
- Never log: nonces, tokens, secrets, raw provider HTML, full conversation bodies
- Have unit tests at its public API boundary

---

## 2. Known failure boundaries (updated per sprint)

| Sprint | Module | Failure type | Error code | How to detect |
|---|---|---|---|---|
| S00 | — | Sandbox canary UNKNOWN | `SANDBOX_UNVERIFIED` | SANDBOX_CAPABILITIES.md all fields = unknown |
| S00 | — | Provider DOM extraction unverified | — | Extension not deployed; manual DevTools verification only |

---

## 3. Debug bundle

> Not yet implemented. Will be added in S25 (observability sprint).

A safe debug bundle will contain:
- Redacted configuration summary
- Version matrix (IDE, Node, provider, extension)
- Sanitized structured logs (no secrets, no raw page HTML)
- Failing test metadata and capability evidence
- Preview before export

---

## 4. Diagnostics view

> Not yet implemented. Will be added in S01 (IDE panel) and expanded in S25.

Will show: one row per module with status, version, last healthy check, active adapter, capability result, recent error code.

---

## 5. Common issues

| Issue | Likely cause | Fix |
|---|---|---|
| `CORE_NOT_RUNNING` | Mediator core process not started | Run `npx mediator start` or use IDE command palette |
| `NONCE_MISMATCH` | Stale or replayed protocol envelope | Re-attach the conversation; generate a new session nonce |
| `PATH_OUTSIDE_ROOT` | AI proposed a path traversal or outside-workspace path | Policy engine denied correctly; review the proposal |
| `SANDBOX_UNVERIFIED` | Executor capability has UNKNOWN fields | Automatic execution disabled; use Review-only or manual handoff |
| `CONVERSATION_CHANGED` | Tab switched, conversation regenerated, or branch changed | Re-attach and confirm conversation identity |
