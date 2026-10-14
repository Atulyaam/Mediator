# ADR-013 — MCP Handoff UX, Evidence Provenance & Request-Only Review Intake

**Date:** 2026-10-11  
**Status:** ACCEPTED  
**Sprint:** S17  
**Deciders:** Mediator developer

## Context

Sprint S17 establishes a safe, pull-based workflow for handing off tasks to IDE agents and ingesting their reports without treating the external agent as a trusted executor.

Key requirements and constraints:
1. **Pull-based/Manual Transfer:** Mediator does not automatically push instructions to external agents. Instructions are prepared as bounded prompts for manual user copying.
2. **Untrusted Agent Claims:** Reports ingested from IDE agents are untrusted content. Claims like `verified: true`, `approved: true`, or `testsPassed: true` must never automatically alter authoritative approval state or pass verification gates.
3. **Evidence Provenance Separation:** Clear architectural distinction between `agent-reported`, `user-verified`, `ide-diagnostic-observed`, and `executor-verified`. Agent reports are classified strictly as `agent-reported`.
4. **Request-Only Review Boundary:** MCP agents may request human review via `mediator.request_review`, but this endpoint is strictly request-only. Only the trusted local Mediator/IDE UI can resolve approvals.
5. **Payload-Hash Binding:** Any review request is bound to the exact payload hash and task scope. If the payload hash changes, the pending request becomes ineligible for approval.
6. **Discrepancy Detection:** Claimed changed files are cross-checked against authoritative Mediator staged diffs to highlight un-staged claims or un-reported changes.
7. **Security & Containment:** Zero shell execution, bounded prompt generation (16 KB), bounded report ingestion (64 KB), secret redaction, and audit logging.

## Decision

1. **Handoff Domain Model & State Lifecycle:**
   - Introduced `HandoffRecord` with states: `prepared`, `waiting-for-agent`, `report-received`, `review-required`, `cancelled`, `expired`, `rejected`.
   - Persisted in SQLite `handoffs` table (Migration 5) via `HandoffRepository`.
   - Authoritative state machine managed by `HandoffService` (`@mediator/stage-store`).

2. **Bounded Task-Specific Prompt Generation:**
   - `HandoffService.prepareHandoff` constructs prompts instructing the agent to:
     - Query `mediator.get_task_brief` and read-only MCP context.
     - Inspect staged diffs and respect workspace scope.
     - Report changed paths, observed verification commands, and blockers.
     - Never claim approval or file-apply permission.
   - Prompts are bounded (max 16 KB) and scrubbed of excluded files/secrets.

3. **Untrusted Report Ingestion & Discrepancy Detection:**
   - Ingested reports are validated against `AgentReportSchema` (Zod), enforcing bounded arrays, max 128 KB payload size, and canonical path containment.
   - Cross-checks claimed file changes against actual staged files in `StageStore`:
     - Highlights `claimed_path_not_staged` and `staged_path_not_claimed`.
     - Validates workspace containment and exclusion rules.
   - Generates an `EvidenceRecord` strictly classified as `EvidenceLevel.AGENT_REPORTED`.

4. **Evidence Provenance Gate:**
   - Preserves 4 distinct evidence levels: `agent-reported`, `user-verified`, `ide-diagnostic-observed`, `executor-verified`.
   - Self-attested agent reports cannot promote themselves to `executor-verified`.
   - Only human operators via trusted IDE UI or verifiable executor runs can elevate evidence.

5. **Request-Only MCP Review Intake:**
   - Added tool `mediator.request_review` to `@mediator/mcp-server`.
   - Tool only creates a `PendingReviewRequest` record (`ReviewRequestStatus.PENDING_REVIEW`) bound to `payloadHash` and `requestedScope`.
   - Callers cannot supply elevated roles or self-approve.
   - `ReviewIntakeService.resolveReviewRequest` strictly enforces caller identity (`caller.isTrustedUI === true`). Untrusted callers are rejected with `ACTION_DENIED`.

6. **IDE Extension Handoff Panel Controller:**
   - Implemented `HandoffPanelController` managing the pull-based UI state.
   - Provides controls for: Prepare Handoff, Copy Prompt, Mark Waiting, Ingest Report, Cancel Handoff, and Resolve Review Request.
   - Always reports `isConnectedToExternalAgent: false` to ensure transparency.

## Consequences

- Users can safely orchestrate IDE agents with structured context while maintaining human-in-the-loop oversight.
- Agent reports cannot bypass security policies, file write restrictions, or verification gates.
- Full auditability: all handoffs, copies, waiting transitions, reports, review requests, and human decisions are logged in SQLite.
