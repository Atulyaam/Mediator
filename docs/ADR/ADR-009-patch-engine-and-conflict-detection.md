# ADR-009 — Staged Patch Engine & Hash-Aware Conflict Detection

**Date:** 2026-10-11  
**Status:** ACCEPTED  
**Sprint:** S13  
**Deciders:** Mediator developer

## Context

Sprint S13 requires a deterministic, hash-aware patch processing mechanism that modifies **staged files only**. AI-proposed changes must be reproducible, unambiguous, and safe to inspect before any change touches the live workspace.

Key challenges include:
1. Fuzzy or ambiguous patch application can corrupt source code.
2. Silent auto-rebasing can overwrite intervening user edits.
3. Patch application might leak secrets or escape workspace containment.
4. Concurrency races could cause contradictory patch operations to clobber each other.

## Decision

1. **Exact-Match Structured Search/Replace:**
   - Patches use exact search/replace with single unique match assertion by default.
   - Zero matches (`PATCH_ZERO_MATCHES`) and ambiguous multiple matches (`PATCH_AMBIGUOUS_MATCH`) fail closed.
   - Whole-file replacement is supported for newly created or fully proposed files.

2. **Shadow Staging Isolation Only:**
   - Every patch operation modifies files exclusively within Mediator's task-scoped app-data shadow staging store.
   - Zero live workspace mutation occurs during patch validation, preview, conflict checks, or staging rollback.

3. **Encoding & Line-Ending Preservation:**
   - Automatically detects and preserves CRLF vs. LF, UTF-8 BOM, and final trailing newlines without silent conversions.

4. **Fail-Closed Conflict Detection:**
   - Checks both base content hashes and current live filesystem state.
   - Detects live file modifications (`live-modified`), deletions (`live-deleted`), unexpected live file creations (`live-added`), and rename collisions (`rename-destination-exists`).
   - Conflicts are durable and visible; the engine never silently rebases or overwrites user changes.

5. **Atomic Multi-File Batches & Concurrency Locks:**
   - Batch patches are validated and applied to a staging rollback savepoint; if any patch in a batch fails, the entire batch rolls back to its prior staged state.
   - Per-path concurrency locking prevents race conditions between parallel patch requests.

## Consequences

- AI cannot silently overwrite code with approximate matching.
- Live project files remain 100% bit-for-bit identical across all S13 operations.
- Destructive operations (`delete-proposed`, `rename-proposed`) remain staged proposals and require explicit user manual review in the approval flow (S14).
