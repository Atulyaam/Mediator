# ADR-017 — Executor Capability Schema, Runtime Canary Harness & Review-Only Execution Path

**Date:** 2026-10-11  
**Status:** ACCEPTED  
**Sprints:** S21, S22  
**Deciders:** Mediator Architecture & Security Team  

---

## 1. Context

Sprint S21 requires a formal, testable capability contract describing what an executor can enforce and a runtime canary harness collecting concrete evidence. Sprint S22 requires implementing strictly the execution path permitted by the S00 feasibility decision and supported by S21 runtime evidence.

The canonical S00 feasibility decision in `docs/FEASIBILITY_SPIKE.md`, `docs/SANDBOX_CAPABILITIES.md`, and `ADR-002` recorded:
- **Decision:** `NO-GO-AUTOEXEC`
- **Rationale:** No documented third-party programmatic invocation API exists in Antigravity IDE on Windows 11 for custom stage roots; Windows restricted token + Job Object is insufficient for filesystem isolation; WSL2 is deferred and not opted in by the user.

A core principle of Mediator is: *Never enable automatic execution merely because code compiles or mocks pass. The only permitted execution path is the one explicitly approved by S00 and independently supported by S21 runtime canary evidence.*

---

## 2. Decision

### 2.1 Authoritative Capability Schema (`@mediator/shared-contracts`)
Every security-relevant capability is formally typed with:
- `value`: boolean | 'unknown'
- `enforcedBy`: 'mediator' | 'ide' | 'unknown'
- `evidenceRef`: string (cryptographic hash or canary record identifier)
- `observedAt`: timestamp
- `executorId` & `executorVersion`
- `canaryId`, `status`, `limitations`, `correlationId`

Capabilities are categorized across:
1. Filesystem (`stageRootRead`, `stageRootWrite`, `liveWorkspaceWriteDenied`, `outsideRootDenied`, `secretFilesProtected`, `symlinkEscapeDenied`, `liveWorkspaceIntegrity`)
2. Process (`executableAllowlistEnforced`, `approvedArgumentSchemaOnly`, `untrustedScriptsRejected`, `childProcessesConfined`, `processTerminationEnforced`)
3. Network (`networkDefaultDeny`, `networkEnforcementObserved`)
4. Resource Limits (`timeoutEnforced`, `cancellationEnforced`, `outputByteCapEnforced`, `capturesRealExitCode`)
5. Execution Model (`fixedRecipeOnly`, `stagedSourceDemonstrated`, `exitCodeAvailable`, `crashStateReconciled`)

### 2.2 Strict Invariants
1. **Rule of Unknowns:** Any capability marked `unknown` unconditionally evaluates as `false` for every required security guarantee.
2. **Evidence Provenance Gate:** Only `runtime-canary` evidence can satisfy a runtime gate. `documentation-only`, `mock-only`, `agent-reported`, or `ide-reported` claims cannot satisfy runtime gates.
3. **Freshness & Scope Binding:** Evidence must match the active executor ID, executor version, workspace root, stage ID, and must be within the maximum TTL (default 24 hours).
4. **No AI/MCP Self-Authorization:** AI messages, browser DOM content, or MCP requests cannot modify capabilities, alter S00 decisions, or grant execution authority.

### 2.3 S22 Execution Path: Review-Only under `NO-GO-AUTOEXEC`
Because S00 decided `NO-GO-AUTOEXEC`:
1. **No automatic runner is exposed or executed.**
2. `ApprovedExecutionPathService` operates strictly in Review-only mode (`ReviewOnlyExecutionService`).
3. Any execution attempt returns typed status `execution-unavailable` / code `EXECUTION_UNAVAILABLE`.
4. Any attempt to supply arbitrary commands, executable paths, or shell operators (`&&`, `;`, `|`, `$(`, etc.) is immediately rejected with `UNTRUSTED_COMMAND_REJECTED`.
5. For user convenience, safe copyable manual recipe suggestions and manual handoff snippets are generated for approved recipes. These snippets carry an explicit warning that manual execution is external and unverified by Mediator.
6. The original live workspace remains 100% immutable and unmutated.

---

## 3. Consequences

### Positive
- **Provable Safety:** Zero risk of unintended command execution or filesystem escape against the live workspace.
- **Fail-Closed Architecture:** If evidence is stale, corrupted, mismatched, or inconclusive, execution remains blocked.
- **Auditable Evidence:** All canary runs record structured JSON records with pre- and post-test SHA-256 tree hashes proving live workspace integrity.
- **Smooth Operator Experience:** Developers receive copyable CLI instructions that they can run in their own terminal outside Mediator's boundary.

### Negative / Trade-offs
- Automatic test execution, linting, and building remain disabled in V1 until an approved, isolated sandbox API is available.
- Operators must manually run tests and report results via the S17 IDE-agent handoff channel.

---

## 4. Re-evaluation Criteria

Automatic execution may only be enabled if:
1. S00 feasibility decision is formally amended via a documented spike.
2. A supported programmatic executor API (e.g. Antigravity IDE terminal sandbox or opt-in WSL2 dedicated distro) is proven with real runtime canaries.
3. All mandatory filesystem, process, network, and resource capabilities pass with real `runtime-canary` provenance.
