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
| S06 | `context-security` | Mandatory sensitive path exclusion | `PATH_EXCLUDED` (disposition `excluded`) | Target matches default exclusion glob (.env*, *.key, id_rsa, etc.); rejected before reading |
| S06 | `context-security` | Critical/high secret detected | `disposition: blocked` / `safeToSend: false` | Content contains recognizable secret pattern that cannot be safely sent |
| S06 | `context-security` | Content size budget exceeded | `OVERSIZED_INPUT` | File or total packet size exceeds configured budget limit |
| S06 | `context-security` | Malformed encoding / lone surrogates | `SCHEMA_INVALID` | Non-UTF-16 surrogate pairs detected; scanner fails closed |
| S06 | `context-security` | Unconfirmed root for context packet | `WORKSPACE_CONFIRMATION_REQUIRED`, `WORKSPACE_UNRESOLVED` | buildSafeContextPacket requires confirmed, resolved workspace root |
| S07 | `policy-engine` | Unknown action ID | `SCHEMA_INVALID` (`UNKNOWN_ACTION`) | Action ID not in canonical 16-action registry |
| S07 | `policy-engine` | Protected path auto-apply attempted | `PATH_PROTECTED` (`PROTECTED_PATH_CANNOT_AUTO_APPLY`) | Action touches protected path; requires explicit manual review/approval |
| S07 | `policy-engine` | Review-only mode execution attempted | `ACTION_DENIED` (`REVIEW_ONLY_MODE_BLOCKS_EXECUTION`) | Automated recipe execution disabled in Review-only mode (ADR-002) |
| S07 | `policy-engine` | Live workspace mutation attempted | `APPROVAL_REQUIRED` (`REVIEW_ONLY_MODE_BLOCKS_MUTATION`) | Live mutation requires manual user approval in Review-only mode |
| S07 | `policy-engine` | Arbitrary shell command injection | `SCHEMA_INVALID` (`ARBITRARY_COMMAND_DENIED`) | Shell command injection or raw command text detected in recipe parameters |
| S07 | `policy-engine` | Untrusted caller approval attempt | `ACTION_DENIED` (`CALLER_UNAUTHORIZED_FOR_APPROVAL`) | MCP/agent/browser tried to self-resolve approval; only trusted UI allowed |
| S07 | `policy-engine` | Policy tampering flag injected | `SCHEMA_INVALID` (`POLICY_TAMPERING_ATTEMPT`) | Caller tried to pass policyOverride, bypass, or grantAll flags |
| S07 | `policy-engine` | Missing executor capability | `CAPABILITY_UNAVAILABLE` (`CAPABILITY_MISSING`) | Executor has not passed canary verification; recipe run rejected |
| S08 | `protocol` | Nonce mismatch / spoofing attempt | `NONCE_MISMATCH` | Authoritative session nonce does not match candidate; candidate rejected in constant time |
| S08 | `protocol` | Task / Session / Provider identity drift | `TASK_MISMATCH`, `SESSION_MISMATCH`, `CONVERSATION_MISMATCH` | Proposal attributes mismatch active attached local session; rejected before policy |
| S08 | `protocol` | Stale round / duplicate sequence / out-of-order | `ROUND_STALE`, `SEQUENCE_DUPLICATE`, `SEQUENCE_OUT_OF_ORDER` | Non-monotonic proposal packet rejected; state remains unadvanced |
| S08 | `protocol` | Reused action ID | `ACTION_ID_DUPLICATE` | Action ID was already consumed in active session scope or repeated in envelope |
| S08 | `protocol` | Packet replay | `PACKET_ALREADY_CONSUMED` | Exact payload packet was already processed and committed |
| S08 | `protocol` | Stale base state hash | `BASE_STATE_HASH_MISMATCH` | Proposal base state hash does not match expected state hash |
| S08 | `protocol` | Conflicting completion signal | `CONFLICTING_COMPLETION_SIGNAL` | Action attempted to override completion (e.g. 'complete' action); canonical status required |
| S08 | `protocol` | Browser prompt edit / branch switch / regeneration | `IDENTITY_UNCERTAIN` | User altered conversation in browser; automatic processing paused until user reattaches |
| S09 | `content-transfer` | Byte length mismatch / truncation | `TRANSFER_INCOMPLETE` | Exact UTF-8 byte length of body block does not match manifest byteLength |
| S09 | `content-transfer` | Cryptographic checksum failure | `TRANSFER_HASH_MISMATCH` | Computed SHA-256 hash does not match declared manifest hash |
| S09 | `content-transfer` | Malformed / missing block framing | `TRANSFER_INCOMPLETE` | Missing closing delimiter tag (e.g. `<<<END_MEDIATOR_FILE>>>`) or corrupt boundaries |
| S09 | `content-transfer` | Missing referenced content block | `CONTENT_BLOCK_MISSING` | Proposal action references block ID that is not present in framed body payload |
| S09 | `content-transfer` | Cross-session chunk injection | `SESSION_MISMATCH` | Transport chunk session ID does not match active transfer session |
| S09 | `content-transfer` | Conflicting chunk tampering | `TAMPERING_DETECTED` | Duplicate chunk index delivered with conflicting content or checksum |
| S09 | `content-transfer` | Native Messaging / payload size cap | `OVERSIZED_INPUT` | Chunk > 256 KB, block > 2 MB, or total transfer > 10 MB exceeded transport bounds |
| S09 | `content-transfer` | Transfer timeout | `TRANSFER_INCOMPLETE` (`EXPIRED`) | Partial transfer exceeded timeout without all chunks received; buffers purged |
| S09 | `content-transfer` | Invalid request_more_context paths | `PATH_OUTSIDE_ROOT`, `PATH_PROTECTED` | Topic/path hints target escaping paths (`../`), absolute paths, or secret patterns |

### Content-Block Framing & Bounded Transfer Invariants (S09)

- **Separation of Framing from Staging:** Parsing, chunk reassembly, and integrity validation occur strictly in memory buffers before any proposal or content reaches the staging store.
- **Zero Normalization Invariant:** Raw file body content is never trimmed, whitespace-normalized, or silently repaired prior to byte length and SHA-256 checksum validation.
- **Native Messaging Transport Margin:** Internal chunk sizes are bounded to 256 KB, well below the Chromium 1 MB IPC limit, with strict per-chunk and whole-payload checksumming.
- **Fail-Closed State Machine:** Incomplete or corrupted transfers transition to terminal `REJECTED`, `EXPIRED`, or `CANCELLED` states and are permanently purged without side effects.
- **Context Request Safeguards:** All `request_more_context` hints re-traverse path containment (S04/S05) and mandatory secret exclusions (S06) before processing.

### Protocol Envelope & Replay Guard Invariants (S08)

- **Untrusted Nonce Invariant:** A valid cryptographic nonce binds the envelope to the active session and prevents replays, but does NOT authorize action execution. Every action must still pass the S07 policy evaluator.
- **Constant-Time Comparison:** Nonces are compared using `timingSafeEqual` to eliminate timing side-channel attacks. Nonces are never leaked in ordinary logs, debug bundles, or error messages.
- **Fail-Closed State Invariance:** Validation failures NEVER advance expected sequences, update rounds, or consume action IDs. Replays cannot bypass validation through failure side-effects.
- **Browser Drift Defense:** Any prompt edit, branch switch, conversation switch, or answer regeneration in the browser marks the session identity-uncertain and pauses processing. Safe reattachment is required.
- **Zero Conflicting Completion Signals:** Task completion is expressed solely via canonical envelope status (`continue`, `await_user`, `complete` / `proposed_complete`). Separate complete actions are rejected.

### Policy Engine & Action Registry Invariants (S07)

- **Pure Evaluation Boundary:** `evaluateAction(request, context, policyConfig)` has zero side effects and returns deterministic decisions (`ALLOW`, `DENY`, `REQUIRE_APPROVAL`, `UNSUPPORTED`).
- **Canonical 16 Actions Only:** Exactly 16 action IDs are supported. Unknown actions, unexpected fields, or missing parameters fail closed.
- **Protected-Path Review Gating:** Manifests, lockfiles, CI/CD workflows, Git hooks, scripts, and security configs can be staged but NEVER auto-applied to live files.
- **Strict Approval Separation:** Request creation is separate from resolution. Only authenticated user UI flows (IDE UI / CLI confirmation) can approve requests. Agents and MCP tools can never approve their own requests.
- **Zero Evidence Escalation:** Unverified agent claims remain `agent-reported` and can never satisfy automated verification gates.
- **Review-Only V1 Mode (ADR-002):** Automatic execution and unapproved live mutations are hard-denied by default.

### Windows-Specific Path Security Limitations (S05)

- **Reparse Point Inspection:** Deep Win32 tag inspection (`IO_REPARSE_TAG_MOUNT_POINT` vs cloud placeholders) requires native Win32 APIs not in standard Node.js. Node's `realpathSync.native` resolves junctions/symlinks; where physical resolution delta cannot prove containment, the path is rejected or classified as `unknown`.
- **Short Names (8.3):** Resolved to canonical long names via `realpathSync.native`. Escapes via short-name aliases are rejected by canonical prefix defense.
- **Elevation for Symlink Creation:** Creating symlinks on Windows without Developer Mode requires administrative privileges. Test suite uses mock adapter to guarantee deterministic testing across all environments.

### Secret Detection Limitations & Safeguards (S06)

- **Pattern Matching Limits:** Scanner detects known high-signal patterns (keys, tokens, auth headers, connection strings). It cannot detect custom-formatted, obfuscated, or low-entropy secrets. This is a defense-in-depth layer, NOT a universal secret-detection guarantee.
- **Fail-Closed Policy:** Truncated scans, timeout, lone surrogate pairs, or oversized input immediately block the affected content.
- **Zero Raw Secret Emission:** Matched secret substrings are never stored in `ScanFinding`, `RedactionRecord`, error objects, logs, or previews. Downstream outputs are verified using synthetic fixtures.
- **Pre-Read Exclusion:** Excluded sensitive paths (`.env*`, `*.pem`, `id_rsa`, `.ssh/**`, `.aws/**`, etc.) are blocked before file content is read from disk.
- **User Ignore Rules:** `.mediatorignore` can add context exclusions but can never bypass mandatory security exclusions or S04/S05 workspace boundary controls.


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
