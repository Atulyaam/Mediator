# ADR-018: Fixed Recipe Registry, Static Dependency Readiness & Assisted End-to-End Loop with Evidence Authority

## Status
Accepted

## Context
Following Sprint S21 and S22, the Mediator project operating model remains strictly bound by the authoritative S00 decision: `NO-GO-AUTOEXEC` (Review-only V1). Under this invariant, host child-process confinement, host network default-deny, and exit-code verification are not proven safe for automated command execution.

Sprints S23 and S24 require:
1. S23: A fixed, versioned, and hash-pinned recipe registry to define approved project checks (`project.test`, `project.lint`, `project.typecheck`, `project.build`, `project.single_test`, `git.status`, `git.diff`) without allowing AI to invent arbitrary commands, run shell operators, inject environment overrides, or execute package manager scripts (`npm install`).
2. S23: Strict separation of dependency provisioning and metadata inspection from command execution.
3. S24: An Assisted end-to-end orchestration loop coordinating browser response extraction, protocol envelope validation, secret scanning, S07 policy review, S12 shadow staging, S14 trusted approval, S22 Review-only verification, evidence provenance hierarchy, and same-chat continuity.
4. S24: Zero Autopilot, zero background retries, zero wrong-chat feedback, zero elevation of agent-reported claims, and bounded loop guards.

## Decision

### 1. Fixed Recipe Registry & Deterministic Hash Pinning (S23)
- Authoritative typed recipe definitions are maintained in `@mediator/recipe-registry` for exactly 7 fixed IDs:
  - `project.test`: Run test suite
  - `project.lint`: Run linter
  - `project.typecheck`: Typecheck project
  - `project.build`: Build project
  - `project.single_test`: Run single test file
  - `git.status`: Safe read-only status check
  - `git.diff`: Safe read-only stage diff inspection
- Every recipe definition is canonically serialized (keys sorted recursively) and hashed via SHA-256 over all security-relevant fields (`recipeId`, `version`, `category`, `executable`, `allowedArgs`, `workingDirectoryPolicy`, `scopePolicy`, `allowedEnvVars`, `resourceLimits`, `requiredCapabilities`, `approvalLevel`, `risk`, `manualOnly`).
- Any tampering, field mutation, or hash mismatch fails closed with `RECIPE_TAMPERED`.
- In requests, arbitrary shell characters (`;&|`$><`), path traversal (`..`), outside-root paths, and unapproved flags are rejected with `RECIPE_ARGUMENTS_INVALID` or `RECIPE_PATH_OUTSIDE_ROOT`.

### 2. Static Dependency Inspection & Synthetic Isolation (S23)
- Dependency inspection (`DependencyInspector`) performs bounded reads of `package.json` and lockfiles.
- Zero package manager scripts, zero network requests, and zero lifecycle hooks are executed.
- If dependencies are missing or uninstalled, the readiness state reports `dependencies-unavailable` and blocks manual recipe suggestions without attempting `npm install`.
- Synthetic `.env.test` generation uses safe, isolated constants and is verified via secret scanning to guarantee zero copied host secrets or API keys.

### 3. Review-Only Verification Under NO-GO (S23 & S24)
- Under `NO-GO-AUTOEXEC`, command runner instantiation is forbidden.
- Validated recipes yield `SuggestedManualRecipe` with copyable CLI strings explicitly labeled:
  `MANUAL EXECUTION ONLY — NOT RUN OR VERIFIED BY MEDIATOR`.
- The IDE panel renders these instructions with a copy button and distinct warning banner.

### 4. Assisted End-to-End Orchestration & Typed State Machine (S24)
- `WorkflowOrchestrator` implements an explicit 19-state transition graph (`idle` -> `response-received` -> `protocol-validating` -> `policy-review` -> `staging` -> `diff-ready` -> `awaiting-approval` -> `manual-handoff-ready` -> `awaiting-manual-result` -> `result-received` -> `feedback-ready` -> `awaiting-send-confirmation` -> `completed` / `paused` / `failed` / `recovery-required`).
- Every transition validates source state, correlation ID, and budget limits.
- Bounded guards enforce caps on AI rounds (default 5), state transitions (default 30), feedback size (default 8 KiB), and detect repeated state-hash loops.

### 5. Evidence Authority Hierarchy (S24)
- Four strictly separated provenance tiers:
  1. `executor-verified`: Assigned only when a trusted execution runner executed and observed the check. (Under NO-GO, this count is strictly 0).
  2. `ide-diagnostic-observed`: Observed compiler/linter diagnostics in the IDE.
  3. `user-verified`: Human explicitly confirmed in trusted UI after manual verification.
  4. `agent-reported`: Untrusted claims by AI; cannot satisfy verification gates or upgrade provenance.
- Verification summaries honestly present counts of executor-verified, user-verified, agent-reported, and blocked checks.

### 6. Same-Chat Continuity & Explicit Send Confirmation (S24)
- Feedback is strictly constrained to the originating conversation (`provider`, `conversationId`, `tabId`).
- Preparation sets state to `awaiting-send-confirmation`. Transmission requires explicit user confirmation.
- Ambiguous identity or navigation changes trigger a safe pause (`paused`), never creating a new conversation or retrying blindly.

## Consequences

### Positive
- Strict security invariants maintained: AI cannot execute arbitrary code or bypass reviews.
- Complete deterministic traceability from browser proposal to shadow stage, manual handoff, and feedback.
- Honesty in verification: no false claims of test execution or security assurance.
- 10 controlled test-repo tasks provide exhaustive automated regression protection for all error/edge branches.

### Negative / Limitations
- Automated test and build verification remains unavailable pending trusted, isolated execution infrastructure.
- User must run tests manually in their terminal and confirm completion via the trusted UI.
