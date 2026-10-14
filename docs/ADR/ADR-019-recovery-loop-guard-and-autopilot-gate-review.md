# ADR-019: Startup Recovery, Loop Guard Observability, Context Compaction & Limited Autopilot Gate Review

## Status
Accepted (S25: PASS, S26: DEFERRED under NO-GO-AUTOEXEC)

## Context
Following Sprints S21–S24, Mediator operates in an Assisted, Review-Only workflow with evidence authority, strictly governed by the authoritative S00 decision: `NO-GO-AUTOEXEC` (ADR-002, ADR-017, ADR-018).

Sprints S25 and S26 address system robustness and gate review:
1. **S25 Recovery & Robustness:** Crashes, native-host disconnects, IDE restarts, stale state, and long-running tasks must not compromise state integrity. In particular, any action whose completion status is uncertain must never be blindly replayed on startup. Budgets and loop counters must persist across restarts. Context state must be compacted across accepted rounds without dropping uncertainty, blockers, or evidence provenance.
2. **S25 Observability:** System diagnostics require structured correlation tracking and user-controlled, secret-scanned, size-capped debug bundles.
3. **S26 Limited Autopilot Gate Review:** Re-evaluate prerequisite capabilities against S00, S21, S22, S23, S24, and S25. Three mandatory capabilities remain unknown (`process.childProcessesConfined`, `network.networkDefaultDeny`, `limits.capturesRealExitCode`). Under the active `NO-GO-AUTOEXEC` invariant, Autopilot must remain disabled and S26 marked `DEFERRED` (Outcome B).

## Decision

### 1. Authoritative Startup Reconciliation & No-Replay Invariant (S25)
- `OrchestratorRecoveryService` performs startup and reconnect reconciliation over task/session state, staged hashes, approvals, conversation identity, and capability evidence freshness.
- **Never Replay Unknown Actions:** Any action whose completion cannot be independently proven is marked `unknown`/`recovery-required` in the authoritative action ledger. Commands, recipes, browser messages, and patches are never relaunched on startup.
- **Safe Resume Validation:** `validateSafeResume()` strictly enforces that all unknown actions are acknowledged, stage and source are clean of conflicts, approvals are fresh and unconsumed, and the active browser conversation ID matches.

### 2. Persistent Loop Guard & Task Budgets (S25)
- `WorkflowBudgetGuard` counters (rounds, transitions, actions, input bytes, task duration, repeated errors) are exported and imported across restarts, preventing budget evasion via restart.
- Task duration is capped (default 30 minutes), and repeated identical errors (>= 3) trip the workflow loop guard fail-closed.
- AI messages, browser input, and environment variables cannot raise or override budget limits.

### 3. Incremental Context Compaction & Indicators (S25)
- `ContextCompactor` generates compact state summaries containing goals, acceptance criteria, changed files, decisions, and blockers.
- Compaction strictly preserves uncertainty, pending approvals, and security blockers.
- Redaction runs over compacted summaries before persistence.
- Privacy-preserving context indicators track packet bytes, estimated tokens, omitted items, and repetition ratios without leaking raw files or sending off-device telemetry.

### 4. Redacted Debug Bundle & Correlation Timeline (S25)
- `DebugBundleService` produces bounded local JSON archives (max 512 KiB) containing task summaries, timeline events, and capability status.
- Automated secret scanning guarantees zero leaked tokens.
- Bundles strictly require explicit user authorization before export, refusing export fail-closed if redaction verification fails.
- `CorrelationTimelineService` tracks cross-boundary transitions with correlation IDs and sanitized metadata.

### 5. Limited Autopilot Gate Review: Outcome B (DEFERRED) (S26)
- `AutopilotGateEvaluator` evaluates prerequisite capabilities against S00, S21, S22, S23, S24, and S25.
- Because the mandatory S00 decision remains `NO-GO-AUTOEXEC` and three host sandbox capabilities remain unknown, `AutopilotGateEvaluator.evaluatePrerequisites()` returns `status: 'deferred'`, `eligible: false`.
- **Zero Command Runners:** No automated runner or execution loop is instantiated or permitted.
- **Zero Auto-Apply:** Shadow staging remains strictly isolated; patches are never automatically applied back to the live workspace without manual approval.
- **User Opt-in Insufficient:** User preferences cannot bypass capability gates (`AUTOPILOT_DEFERRED`).
- **Descriptive Low-Risk Profile Contract:** `CANONICAL_AUTOPILOT_LOW_RISK_PROFILE` defines descriptive constraints (text diffs <= 4 KiB, non-protected paths, no deletes/renames, no scripts), strictly configured with `active: false`.
- **Fail-Closed Revocation:** Any capability loss, secret detection, stage conflict, or budget overrun triggers immediate eligibility revocation.

## Consequences

### Positive
- Crash and restart recovery is predictable and never causes duplicate or dangerous action execution.
- Budget accounting cannot be reset or bypassed by restarting the core or IDE.
- Context compaction prevents token bloat while guaranteeing that security blockers and unknown actions remain visible.
- Autopilot eligibility is truthfully gated by real capability evidence; no false claims of automation are made.

### Negative / Trade-offs
- Manual user reconciliation is required whenever an in-flight action's outcome is unknown.
- Autopilot remains deferred until host child-process confinement, host network default-deny, and exit-code capture are independently proven.
