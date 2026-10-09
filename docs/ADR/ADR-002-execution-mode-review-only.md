# ADR-002 — Execution Mode: Review-only for V1

**Date:** 2026-10-10  
**Status:** ACCEPTED  
**Sprint:** S00  
**Deciders:** Mediator developer

## Context

Sprint 0 requires an explicit GO/NO-GO decision for automatic command execution before building the system. The options are:
- **GO-IDE:** IDE-native sandbox is programmatically invocable with stage-root isolation and verified exit codes
- **GO-WSL2:** Opt-in WSL2 dedicated distro passes all security canaries
- **NO-GO-AUTOEXEC:** No verified execution path exists; ship as Review-only

## Decision

**V1 launches as Review-only mode. Automatic command execution is disabled.**

## Rationale

1. No documented programmatic API was found for Mediator (as a third-party process) to invoke the Antigravity terminal sandbox with a custom stage root and capture verified exit codes.
2. The master plan explicitly states: "A Windows-native runner based only on a restricted token plus Job Object is NOT sufficient for filesystem isolation."
3. WSL2 executor is not opted in by the user at this time.
4. Review-only mode is explicitly called out as a valid, honest product outcome in the master plan.
5. Building on an unverified execution assumption is the primary risk the sprint plan was designed to prevent.

## What Review-only V1 delivers

- ✅ Same-chat protocol extraction (Gemini provider adapter)
- ✅ Protocol envelope validation and nonce/replay protection
- ✅ Shadow staging store — changes go to app-data, never live workspace
- ✅ File-by-file diff panel in the IDE extension
- ✅ User approval flow — approve, deny, rollback
- ✅ Manual IDE-agent handoff (pull-based MCP, copy prompt)
- ✅ Same-chat result return (sanitized summary)
- ✅ Full audit log, typed error codes, correlation IDs
- ❌ Automatic recipe execution

## Consequences

- `executor-ide-native` and `executor-wsl2` remain as stubs in S00-S21.
- S21 (executor capability schema) and S22 (implement approved executor) are deferred.
- If the user later opts in to WSL2, S21-S22-S23 are revisited with a fresh canary.
- The IDE-agent handoff path (S17) is the primary way to get command results in V1.
- All tests in the sprint plan that reference "verified execution" become manual or agent-reported until an executor is approved.

## Review trigger

This decision should be revisited if:
- A documented Antigravity CLI/SDK API for programmatic sandbox invocation with custom stage roots becomes available.
- The user opts in to WSL2 and runs the canary.
- A future Windows AppContainer/lowbox executor design is proven with adversarial tests.
