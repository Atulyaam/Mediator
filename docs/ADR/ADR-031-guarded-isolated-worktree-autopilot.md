# ADR-031: Guarded Isolated-Worktree Autopilot Architecture, S00 Feasibility Reassessment, and Strict Human Approval Boundary

**Status:** Accepted  
**Date:** October 2026  
**Deciders:** Mediator Engineering & Architecture Core, Application Security Lead, QA Lead  
**Sprint:** Release Convergence (Phase D)  

---

## 1. Context

In Sprint S00, the foundational execution feasibility decision was set to `NO-GO-AUTOEXEC`. At that time, Mediator lacked:
1. True process and network isolation on Windows hosts.
2. Verified exit-code capture without host-shell escapes.
3. Protected workspace boundary mechanisms capable of containing iterative AI mutations.
4. Deterministic offline toolchain pipelines.

Under `NO-GO-AUTOEXEC`, Mediator operated in a strictly Review-Only mode: every proposed patch was staged in memory, no automated test runners were instantiated, and all execution instructions were generated as manual suggestions for the developer to run independently.

Between S41 and S50, Mediator designed, implemented, and verified the necessary containment infrastructure:
- **`MediatorSandbox` (WSL2 dedicated environment):** A purpose-built lightweight Linux rootfs with isolated mounts and zero default automounting of the Windows host.
- **Linux Network Namespace Isolation (`unshare -n`):** Demonstrated 100% default-deny packet drop for loopback, local subnet, and public internet egress.
- **`WslIsolatedExecutor`:** Real process execution capturing authentic exit codes (zero and nonzero), enforcing strict memory/output truncation limits, and preventing child process escapes.
- **`TrustedHostBroker` & `ContainedOrchestrator`:** Process-level separation ensuring untrusted orchestration logic cannot directly mutate host files or read developer secrets.
- **Immutable Offline Bundle Pipeline:** Dependency resolution performed through hash-pinned, sealed offline bundles.

With these controls verified, the product convergence objective requires enabling a guarded, reliable Autopilot capability without compromising system safety or violating developer trust.

---

## 2. Decision: Reassessment to `GO-GUARDED-AUTOPILOT`

We formally reassess the authoritative execution decision from `NO-GO-AUTOEXEC` to `GO-GUARDED-AUTOPILOT` under the strict boundaries specified herein.

`GO-GUARDED-AUTOPILOT` is NOT an unconstrained "auto-coder" or generic agentic computer-use mode. It is an isolated, bounded, fail-closed verification loop.

### 2.1 The Permitted Autonomy Boundary

Within its approved scope, Guarded Autopilot may:
1. **Decompose Tasks:** Break a developer's high-level task into bounded, testable steps.
2. **Route to Authorized Providers:** Submit structured context to the selected AI provider (ChatGPT, Gemini, DeepSeek, Claude manual-handoff).
3. **Capture & Stage Proposals in Isolation:** Ingest structured protocol envelopes into a dedicated task worktree.
4. **Sandbox Validation:** Execute allowed, hash-pinned recipes (`project.test`, `project.lint`, `project.typecheck`, `python.test`) inside `MediatorSandbox` with network isolation (`CLONE_NEWNET`).
5. **Interpret Authentic Failures:** Capture actual exit codes, compiler errors, and stack traces.
6. **Bounded Iterative Correction:** Submit targeted failure evidence back to the provider to request corrections within a strict iteration budget.
7. **Stage Final Verified Patch:** When all acceptance criteria pass (exit code 0), produce a clean diff and register an approval record for human review.

### 2.2 Strict Non-Autonomy Boundaries (Privileged Operations Prohibited)

Guarded Autopilot must NEVER independently:
1. **Write to Live Workspace:** Autopilot may NOT write directly to the user's active repository working tree. All writes are confined to `.mediator/task-worktrees/<taskId>`.
2. **Merge or Commit to Protected Branches:** Autopilot cannot merge branches, push to remote repositories, or commit to `main`/`master`.
3. **Publish or Deploy Software:** Any publication to registries (npm, PyPI, GitHub releases) is strictly forbidden.
4. **Execute Arbitrary Host Commands:** Running commands outside the approved recipe registry or directly on the Windows host shell (`cmd.exe`, `powershell.exe`) is rejected with `ErrorCode.UNTRUSTED_COMMAND_REJECTED`.
5. **Execute with Elevated Privileges:** Autopilot commands never run with Administrator / root privileges.
6. **Disable Security Controls:** Any attempt to disable Windows Defender, modify firewall rules, alter WSL global configuration (`.wslconfig`), or disable sandboxing fails closed immediately.
7. **Access Host Secrets or Profiles:** Developer SSH keys, AWS credentials, browser cookies, and session profiles are scrubbed from execution environments.
8. **Egress to the Network:** Code executing inside the validation sandbox has no network access.

### 2.3 Dedicated Task Worktree Isolation

Every Autopilot task session operates within a dedicated Git worktree or isolated filesystem clone:
- Path: `<workspaceRoot>/.mediator/task-worktrees/<taskId>`
- All file creations, edits, and deletions generated by the AI provider occur solely inside this directory.
- The path security engine enforces that all candidate paths resolve strictly within the task worktree root. Any path traversal (`..`), symlink escape, Windows junction, alternate data stream (`::$DATA`), or reserved DOS device name (`CON`, `PRN`, `AUX`, `NUL`) aborts the session with `AUTOPILOT_STOP_SECURITY_VIOLATION`.
- Files matching protected patterns (`.git/**`, `.mediator/policy.json`, `.mediator/bundles/**`) are read-only and immutable.

### 2.4 Hard Task & Resource Budgets

To prevent runaway loops, token depletion, or resource exhaustion, every Autopilot session enforces immutable hard limits:
- **Maximum Iterations:** Default 5 (hard ceiling 10).
- **Maximum Wall-Clock Duration:** Default 10 minutes (600,000 ms; hard ceiling 30 minutes).
- **Maximum Consecutive Failures:** 3 failures without progression triggers immediate cessation.
- **Maximum Changed Files:** 10 files per task.
- **Maximum Diff Size:** 64 KiB (65,536 bytes).
- **Maximum Command Execution Duration:** 60,000 ms per validation recipe.
- **Maximum Process Output Size:** 32 KiB (32,768 bytes) with explicit truncation markers.

### 2.5 Fail-Closed Stop Conditions

An Autopilot session immediately terminates, preserves the isolated worktree for developer inspection, and reverts to a halted state if:
1. The sandbox environment is unverified or unavailable.
2. The provider produces repeated malformed responses.
3. The iteration or duration budget is exhausted.
4. Proposed changes attempt to tamper with test suites, lint configurations, or security policies to forge a false pass.
5. Path traversal or workspace escapes are attempted.
6. Embedded secrets or credentials are discovered in output.
7. The developer triggers the persistent Stop / Cancel control.
8. Unhandled application crash occurs (reconciled safely on restart).

### 2.6 The Human Approval Invariant

Successful sandbox validation (exit code 0 across all required recipes) marks the Autopilot session as `COMPLETED_AWAITING_REVIEW`.
It does NOT automatically apply changes to the developer's live workspace.

To merge or apply the staged changes:
1. An authoritative `ApprovalRecord` is generated with the verified unified diff.
2. The developer reviews the diff in the Standalone UI or CLI (`mediator approval resolve <id> approve`).
3. An explicit approval token is signed and consumed by `applyApprovedStage()`.
4. Transactional backup and rollback snapshots are verified before any file on the live workspace is modified.

---

## 3. Consequences

### Positive
- Developers gain a genuine, automated test-driven iteration capability that fixes compilation errors and test failures autonomously without manual copy-pasting.
- Untrusted AI code is physically contained in an isolated WSL2 sandbox without network access.
- Live workspace integrity is 100% protected against corruption, partial writes, and hallucinations.
- All decisions, diffs, tool executions, and exit codes are recorded with verifiable evidence hashes.

### Negative / Trade-Offs
- Worktree creation and initial file cloning incur minor disk space and setup time (typically < 1.5 seconds).
- Workflows requiring live network access during tests (e.g., third-party API integration tests) cannot run inside the default-deny sandbox and require offline mocking.
- Developers must still perform a final manual review before changes reach the live working tree (preserving safety over unconditional automation).

---

## 4. References
- S00 Feasibility Assessment & Decision Record
- ADR-024: WSL2 Isolated Executor
- ADR-025: Dedicated WSL2 Sandbox
- ADR-026: Network Egress Isolation
- ADR-027: Autopilot Readiness & Host Trust Boundary
- ADR-030: Production Containment & Release Security
- `docs/AUTOPILOT_SECURITY_POLICY.md`
- `docs/AUTOPILOT_OPERATIONS_GUIDE.md`
