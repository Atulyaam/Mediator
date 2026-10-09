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
| S04 | `workspace-boundary` | Unconfirmed or unresolved root | `WORKSPACE_CONFIRMATION_REQUIRED`, `WORKSPACE_UNRESOLVED` | User must confirm canonical path via CLI or IDE modal |
| S04 | `workspace-boundary` | Mismatched IDE vs CLI root | `WORKSPACE_MISMATCH` | Clear disagreeing option; do not silently guess root |
| S05 | `workspace-boundary` | Traversal or escaping link | `PATH_TRAVERSAL`, `PATH_SYMLINK_ESCAPE`, `PATH_OUTSIDE_ROOT` | Target resolves outside canonical root; check symlink/junction targets |
| S05 | `workspace-boundary` | Reserved device or ADS | `PATH_RESERVED_DEVICE`, `PATH_ALTERNATE_DATA_STREAM`, `PATH_MALFORMED` | Illegal Windows syntax, ADS colons, or CON/NUL/COM/LPT device names |
| S05 | `workspace-boundary` | TOCTOU path race | `PATH_DENIED`, `PATH_SYMLINK_ESCAPE` | Target changed identity or was swapped between validation and use |

### Windows-Specific Path Security Limitations (S05)

- **Reparse Point Inspection:** Deep Win32 tag inspection (`IO_REPARSE_TAG_MOUNT_POINT` vs cloud placeholders) requires native Win32 APIs not in standard Node.js. Node's `realpathSync.native` resolves junctions/symlinks; where physical resolution delta cannot prove containment, the path is rejected or classified as `unknown`.
- **Short Names (8.3):** Resolved to canonical long names via `realpathSync.native`. Escapes via short-name aliases are rejected by canonical prefix defense.
- **Elevation for Symlink Creation:** Creating symlinks on Windows without Developer Mode requires administrative privileges. Test suite uses mock adapter to guarantee deterministic testing across all environments.


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
