# ADR-010 — Trusted Approval Binding & Transactional Live Apply-Back

**Date:** 2026-10-11  
**Status:** ACCEPTED  
**Sprint:** S14  
**Deciders:** Mediator developer

## Context

Sprint S14 requires an IDE diff and review panel, a trusted local approval mechanism, and controlled, recoverable live workspace apply-back.

Key security requirements include:
1. Approvals must be strictly bound to the exact payload hash, target paths, operations, and base hashes.
2. Only the trusted local UI can resolve approval requests; untrusted AI or MCP actors cannot self-approve.
3. Default approval TTL of 120 seconds.
4. Single-use consumption: replaying or reusing approvals must be impossible.
5. Live mutations must be journaled in SQLite and backed up prior to writing.
6. Post-apply rollback must never overwrite intervening user edits made after Mediator's write.

## Decision

1. **Payload Hash Binding & 120s Expiry:**
   - Approvals bind cryptographically to a canonical SHA-256 payload hash summarizing all target paths, operations, expected base hashes, and staged content hashes.
   - Default expiration is 120,000 ms (120 seconds). Stale, modified, or replayed approvals fail closed with typed `ApplyError` codes.

2. **Trusted UI Caller Enforcement:**
   - Only caller identities with `isTrustedUI: true` (e.g. IDE UI / CLI confirmation) can resolve an approval.
   - MCP tools, browser extensions, and AI agents are restricted to review or request roles only.

3. **Transactional Apply-Back & Journaling:**
   - Preflight verifies clean conflict-free status and matches all live hashes immediately before writing.
   - Backups of live files are saved to `%APPDATA%\Mediator\backups\<transactionId>\`.
   - New files are written to safe same-volume temporary files (`.tmp.<random>`) and atomically renamed.
   - Every mutation is recorded in SQLite tables `apply_transactions` and `apply_transaction_items`.

4. **Guaranteed User Preservation on Rollback:**
   - Rollback checks the current hash of each live file.
   - If a live file hash differs from the post-apply hash recorded by Mediator (indicating the user or an external process edited the file), rollback refuses to overwrite the file and transitions the item to `recovery_required`.
   - Staged rollback (reverting staged shadow files) is cleanly separated from live apply rollback (reverting workspace files).

5. **Review-Only Command Execution Maintained:**
   - Apply-back is strictly limited to filesystem content modification; no shell commands or arbitrary recipes are authorized or executed.

## Consequences

- Complete auditability and durable crash recovery across IDE and application restarts.
- User data is protected against accidental overwrites during both apply and rollback.
- Automatic or AI-initiated execution remains disabled.
