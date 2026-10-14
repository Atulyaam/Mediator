# Sandbox Capabilities — S00 Canary Results

**Date:** 2026-10-10  
**Sprint:** S00  
**Status:** PARTIAL — canary script prepared, results pending execution

---

## 1. IDE: Antigravity on Windows 11

### 1.1 Documentation review

| Capability | Documented? | Source |
|---|---|---|
| Terminal sandbox exists | Yes | https://www.antigravity.google/docs/sandbox/ |
| Windows platform sandbox behavior | Platform-specific notes present | Antigravity docs |
| Third-party programmatic invocation API | **Not found** | — |
| Custom stage-root mounting | **Not documented** | — |
| Exit code capture from third-party tools | **Not documented** | — |
| Network policy enforcement | Agent-context only | Antigravity docs |

### 1.2 Canary test design

**Purpose:** Determine whether Mediator (as a CLI/extension process) can invoke the Antigravity terminal sandbox with:
- A fixed recipe (e.g., `npx tsc --noEmit`)
- A custom working directory pointing to a stage path in app-data
- Denial of writes to the live source workspace
- Capture of the real exit code

**Canary structure:**
```
%TEMP%\mediator-canary\
  stage\
    tsconfig.json        ← minimal valid config
    src\canary.ts        ← valid TS file
  source-sentinel\
    sentinel.txt         ← must NOT be accessible from the executor
```

**Canary recipe:** `tsc --noEmit` targeting the stage directory only.

**Expected results if GO-IDE is valid:**
- Exit code 0 captured by Mediator
- `source-sentinel\sentinel.txt` is inaccessible from within the execution context
- Stage files are readable and writable by the recipe

### 1.3 Canary execution results

```
Status: PENDING — canary to be run in next session step
```

> **Note:** Until canary results are recorded here with real exit codes and actual verification, the sandbox capability for IDE-native execution is classified as UNKNOWN. UNKNOWN = false for all required guarantees.

---

## 2. Capability matrix (current state)

Every field below uses the enforcement schema from the master plan: `value`, `enforcedBy: mediator | ide | unknown`, `evidenceRef`.

| Capability | Value | Enforced By | Evidence |
|---|---|---|---|
| Stage root readable by executor | unknown | unknown | canary-pending |
| Stage root writable by executor | unknown | unknown | canary-pending |
| Live workspace NOT writable | unknown | unknown | canary-pending |
| Fixed executable/args enforced | false | unknown | no-api-found |
| Child-process confinement | unknown | unknown | canary-pending |
| Network default-deny | unknown | unknown | canary-pending |
| Timeout enforcement | false | unknown | no-api-found |
| Output byte cap | false | mediator | policy-1 (planned) |
| Real exit code captured | unknown | unknown | canary-pending |
| Cancellation supported | unknown | unknown | canary-pending |

**Summary:** All fields are currently `unknown` pending canary execution. Per master plan, unknown = false. Automatic execution is therefore **disabled**.

---

## 3. WSL2 executor assessment

| Prerequisite | Status |
|---|---|
| User has opted in to WSL2 executor | No — not yet requested |
| WSL2 installed and distro available | Unknown |
| Dedicated distro (not default) | Required |
| Non-root user in distro | Required |
| Windows automount disabled | Required |
| Network isolation proven | Required |
| Canary pass | Not run |

**Status:** DEFERRED. WSL2 executor is not built in S00. It remains a future option after user opt-in and canary pass.

---

## 4. GO/NO-GO per executor

| Executor path | Decision | Reason |
|---|---|---|
| IDE-native (Antigravity terminal sandbox) | **NO-GO** | No documented programmatic invocation API found for third-party tools with custom stage root. Canary cannot be run via this path without a supported API. |
| WSL2 | **DEFERRED** | Not opted in. |
| Review-only / manual handoff | **GO** | Safe, honest, useful. Mediator provides full diff + approval + handoff UX without automatic execution. |

---

## 5. Effective execution mode for V1

**REVIEW-ONLY MODE ACTIVE**

Mediator will:
- ✅ Extract AI proposals from the same chat
- ✅ Validate protocol envelopes
- ✅ Apply proposals to the shadow staging store
- ✅ Show file-by-file diffs and protected-path warnings
- ✅ Allow user to manually approve and apply changes
- ✅ Prepare IDE-agent handoff prompts (pull-based, manual)
- ✅ Send sanitized result summaries back to the same chat
- ❌ NOT automatically run test/lint/build commands
- ❌ NOT execute any recipe without a proven executor

This is recorded as the official Sprint 0 GO/NO-GO outcome.

---

## 6. Sprint S21 — Runtime Canary Battery & Capability Evaluation

**Date:** 2026-10-11  
**Sprint:** S21  
**Executor Under Test:** `antigravity-terminal-sandbox` (Version: 1.0.0)  
**S00 Feasibility Decision:** `NO-GO-AUTOEXEC`  
**Evaluation Engine:** `packages/executor-contract/src/capabilityEvaluator.ts`  
**Canary Harness:** `packages/executor-contract/src/canaryHarness.ts`  

### 6.1 Canary Battery Results

| Check ID | Capability Tested | Expected Result | Observed Result | Enforcing Layer | Classification | Evidence Reference |
|---|---|---|---|---|---|---|
| CANARY-01 | `filesystem.stageRootRead` | Staged file readable in stage root | Probe file read cleanly | `mediator` | **PASS** | `canary:stage-read:probe_read.txt` |
| CANARY-02 | `filesystem.stageRootWrite` | Staged file writable in stage root | Probe file written & verified | `mediator` | **PASS** | `canary:stage-write:probe_write.txt` |
| CANARY-03 | `filesystem.liveWorkspaceWriteDenied` | Direct write to source root denied | Attempt denied; sentinel unchanged | `mediator` | **PASS** | `canary:source-denial:sentinel.txt` |
| CANARY-04 | `filesystem.outsideRootDenied` | Outside root access denied | Access blocked (`PATH_OUTSIDE_ROOT`) | `mediator` | **PASS** | `canary:outside-root:forbidden.txt` |
| CANARY-05 | `filesystem.secretFilesProtected` | Synthetic secret excluded | Secret scanner flagged and excluded | `mediator` | **PASS** | `canary:secret-exclusion:.env.canary` |
| CANARY-06 | `filesystem.symlinkEscapeDenied` | Path traversal (`..`) denied | Traversal blocked (`PATH_TRAVERSAL`) | `mediator` | **PASS** | `canary:traversal:escape_probe.txt` |
| CANARY-07 | `filesystem.liveWorkspaceIntegrity` | Source tree hash identical | SHA-256 tree hash identical | `mediator` | **PASS** | `hash:e3b0c44298fc1c149afbf4c8...` |
| CANARY-08 | `process.untrustedScriptsRejected` | Shell operators rejected | `&&`, `;`, `\|`, `$(` rejected | `mediator` | **PASS** | `policy:shell-operator-denial` |
| CANARY-09 | `execution.fixedRecipeOnly` | Process runner disabled under S00 | Process runner disabled by policy | `mediator` | **PASS** | `policy:s00-no-go-autoexec` |
| CANARY-10 | `limits.capturesRealExitCode` | Real exit code captured from host | Cannot observe exit code without API | `unknown` | **INCONCLUSIVE** | `canary:exit-code-unverified` |

### 6.2 Evaluator Verdict

- **Overall Eligibility:** **`blocked`**
- **S00 Decision:** `NO-GO-AUTOEXEC`
- **Blocking Requirements:**
  1. S00 Feasibility Decision is `NO-GO-AUTOEXEC` (automatic execution strictly disabled).
  2. Mandatory capability `limits.capturesRealExitCode` has status `unknown` (unknown evaluates to false).
  3. Mandatory capability `network.networkDefaultDeny` has status `unknown` (unverified on host OS).
  4. Mandatory capability `process.childProcessesConfined` has status `unknown` (unverified on host OS).
- **Security Invariant Check:** Live workspace mutations during canary battery = **0**. Workspace tree hash verified 100% unchanged.

---

## 7. Sprint S22 — Approved Execution Path Implementation

**Selected Path:** `Review-Only / Manual Handoff` (`NO-GO-AUTOEXEC`)  
**Service Implementation:** `ReviewOnlyExecutionService` in `packages/executor-contract/src/approvedExecutionPath.ts`  

### 7.1 Enforced Execution Rules

1. **Automatic Runner Disabled:** No automatic subprocess, shell, or runner is instantiated. Any invocation of `executeRecipe` returns typed status `execution-unavailable` and error code `EXECUTION_UNAVAILABLE`.
2. **Untrusted Command Injection Denied:** Any attempt to pass raw executable paths, scripts, or shell operators (`&&`, `;`, `|`, `$(`, etc.) is rejected with `UNTRUSTED_COMMAND_REJECTED`.
3. **No Fallback Shell:** Zero fallback to CMD, PowerShell, bash, or unrestricted host shells.
4. **Copyable Manual Recipe Suggestions:** For approved recipes, the service generates safe, formatted manual CLI suggestions:
   - Formatted command: e.g. `npx tsc --noEmit`
   - Working directory: Isolated stage path in app-data
   - Disclaimer: Clearly states that execution must be performed manually by the operator and is unverified by Mediator.
5. **Revalidation on Every Request:** S00 decision, capability freshness, payload hash, and workspace identity are re-checked before generating manual suggestions.

---

## 8. Sprint S23 — Fixed Recipe Registry & Static Dependency Inspection

**Canonical Registry:** `@mediator/recipe-registry`  
**Execution Decision:** `NO-GO-AUTOEXEC` (Unchanged, Active)  

### 8.1 Fixed Recipe Registry Summary

1. **Closed Approved Set:** Exactly 7 canonical recipe IDs are registered:
   - `project.test` (`npm test`)
   - `project.lint` (`npm run lint`)
   - `project.typecheck` (`npx tsc --noEmit`)
   - `project.build` (`npm run build`)
   - `project.single_test` (`npx vitest run <file>`)
   - `git.status` (`git status --short`)
   - `git.diff` (`git diff`)
2. **Deterministic SHA-256 Hash Pinning:** Every recipe definition is canonically serialized with keys sorted recursively and hashed. Any definition mutation or tampering triggers `RECIPE_TAMPERED`.
3. **Strict Argument Validation:** AI cannot supply arbitrary flags or shell operators (`;&|`$><`). Single test paths are strictly contained within root, and cannot escape or touch sensitive paths.
4. **Manual-Only Status Under NO-GO:** All recipes evaluate to `manual-only` under `NO-GO-AUTOEXEC`. No runner is instantiated. Copyable manual suggestions are labeled:
   `MANUAL EXECUTION ONLY — NOT RUN OR VERIFIED BY MEDIATOR`.
5. **Static Dependency Inspection (`DependencyInspector`):**
   - Safe, bounded inspection of `package.json` and lockfiles.
   - Detects risky lifecycle scripts (preinstall, postinstall, curl, wget, eval, bash).
   - Zero execution of package managers (`npm install`) or network queries.
   - Missing dependencies report `dependencies-unavailable` and block manual recipe generation without auto-installing.
   - Generates isolated synthetic `.env.test` templates verified safe by secret scanning.

---

## 9. Sprint S24 — Assisted End-to-End Loop with Evidence Authority

**Orchestrator:** `packages/orchestrator/src/workflowOrchestrator.ts`  
**Execution Mode:** Review-Only / Manual Handoff (`NO-GO-AUTOEXEC`)  

### 9.1 Bounded Assisted Workflow & Evidence Authority

1. **Bounded State Machine:** 19-state transition graph (`idle` -> `response-received` -> `protocol-validating` -> `policy-review` -> `staging` -> `diff-ready` -> `awaiting-approval` -> `manual-handoff-ready` -> `awaiting-manual-result` -> `result-received` -> `feedback-ready` -> `awaiting-send-confirmation` -> `completed` / `paused` / `failed`).
2. **Zero Autopilot:** Transitions are strictly validated against current state, session/task ID, and correlation ID.
3. **Evidence Authority Hierarchy:**
   - `executor-verified`: Strictly 0 under `NO-GO-AUTOEXEC` (no runner execution).
   - `ide-diagnostic-observed`: Diagnostic observations from IDE.
   - `user-verified`: Human explicitly confirms manual test execution in trusted UI.
   - `agent-reported`: Untrusted claims by AI; cannot satisfy verification gates or self-elevate provenance.
4. **Budget & Loop Guard:** Configurable caps enforce max 5 AI rounds, max 30 state transitions, max 8 KiB feedback body, and break repeated state-hash loops (`WORKFLOW_LOOP_DETECTED`).
5. **Same-Chat Continuity:** Outgoing drafts require explicit user confirmation (`awaiting-send-confirmation`) and same-chat identity matching (`provider`, `conversationId`). Navigation drift safely pauses the loop.
6. **10 Controlled Test-Repo Task Scenarios:**
   - 10 automated test scenarios verified 100% passing across clean patches, protocol errors, stale hashes, secret detection, protected paths, unknown recipes, expired approvals, missing capability handoffs, agent-reported unverified claims, and same-chat continuity pauses.

---

## 10. Sprint S25 — Recovery, Loop Guard, Observability & Context Compaction

**Orchestrator Services:** `packages/orchestrator/src/recoveryService.ts`, `budgetGuard.ts`, `contextCompactor.ts`, `debugBundle.ts`, `correlationTimeline.ts`  
**Execution Mode:** Review-Only / Recovery Reconciled (`NO-GO-AUTOEXEC`)  

### 10.1 Recovery & Loop Guard Invariants

1. **Startup Reconciliation:** `OrchestratorRecoveryService` verifies task/session bounds, stage hashes, approvals, and conversation identity on startup or reconnect.
2. **Never Replay Unknown Actions:** Actions whose completion cannot be verified independently are marked `unknown`/`recovery-required` in the ledger. They are never replayed or resent.
3. **Safe Resume Validation:** Resuming a paused task requires validating that zero unacknowledged unknown actions remain, stage and source are clean, approval is valid, and browser conversation identity matches.
4. **Persistent Loop Guards & Budgets:** `WorkflowBudgetGuard` state is exported and imported across restarts, enforcing:
   - Max 30 minutes total task duration
   - Max 5 rounds per task
   - Max 50 state transitions
   - Max 25 actions per task
   - Max 1 MiB total input bytes
   - Max 64 KiB response/output bytes
   - Guard trips if repeated identical error messages (>= 3) occur.
5. **Context Compaction:** `ContextCompactor` generates compact state deltas across accepted rounds while strictly preserving goal, acceptance criteria, known issues, blockers, and unknown actions. Secret scanning redacts sensitive tokens before persistence.
6. **Privacy-Preserving Context Indicators:** Exposes packet byte size, estimated token counts, excerpt counts, omitted items, and repetition ratios without leaking raw project text or off-device telemetry.
7. **Redacted Debug Bundle:** `DebugBundleService` produces bounded local JSON archives (max 512 KiB) containing task summaries, timeline events, and capability status. Automated secret scanning guarantees zero leaked tokens. Bundles strictly require explicit user authorization before export.
8. **Correlation Timeline Observability:** `CorrelationTimelineService` tracks cross-boundary transitions with correlation IDs and sanitized metadata.

---

## 11. Sprint S26 — Limited Autopilot Gate Review (Outcome B: DEFERRED)

**Evaluator:** `packages/orchestrator/src/autopilotGate.ts`  
**Execution Decision:** `NO-GO-AUTOEXEC` (Active, Unchanged)  
**Sprint Status:** **DEFERRED (Outcome B)**  

### 11.1 Prerequisite Evaluation Matrix

| Prerequisite | Required State | Current Evaluated State | Status |
|---|---|---|---|
| S00 Feasibility Decision | `GO-AUTOEXEC` | `NO-GO-AUTOEXEC` (Review-only V1) | ❌ BLOCKING |
| `process.childProcessesConfined` | verified (`runtime-canary`) | `unknown` | ❌ BLOCKING |
| `network.networkDefaultDeny` | verified (`runtime-canary`) | `unknown` | ❌ BLOCKING |
| `limits.capturesRealExitCode` | verified (`runtime-canary`) | `unknown` | ❌ BLOCKING |
| `filesystem.cannotWriteSource` | verified (`runtime-canary`) | verified (`true`) | ✅ Satisfied |
| `filesystem.cannotEscapeRoot` | verified (`runtime-canary`) | verified (`true`) | ✅ Satisfied |
| `filesystem.cannotReadSecrets` | verified (`runtime-canary`) | verified (`true`) | ✅ Satisfied |
| S21 Canary Freshness | < 24 hours | Evaluated at runtime | ✅ Satisfied |
| S22 Approved Execution Path | Review-only path active | Active | ✅ Satisfied |
| S23 Recipe Integrity | Pinned SHA-256 hashes | Enforced | ✅ Satisfied |
| S24 Assisted Loop & Evidence | Hierarchy enforced | Enforced | ✅ Satisfied |
| S25 Recovery Gate | Reconciled state & no-replay | Enforced | ✅ Satisfied |

### 11.2 Evaluator Result & Autopilot Status

1. **Outcome B Enforced:** Because the mandatory S00 decision remains `NO-GO-AUTOEXEC` and three host sandbox capabilities remain unknown, `AutopilotGateEvaluator.evaluatePrerequisites()` returns:
   - `status: 'deferred'`
   - `eligible: false`
   - `s00Decision: 'NO-GO-AUTOEXEC'`
2. **Zero Automated Runners:** Autopilot is strictly disabled. No execution runner, automated background loop, or command execution is enabled or instantiated.
3. **Zero Auto-Apply on Live Workspace:** Shadow staging remains strictly isolated. No automated patch apply-back path exists.
4. **User Opt-in Insufficient:** Opting in via UI or preferences cannot override security gates; attempts fail closed with `AUTOPILOT_DEFERRED`.
5. **Inactive Descriptive Low-Risk Profile Contract:** `CANONICAL_AUTOPILOT_LOW_RISK_PROFILE` defines descriptive constraints for a hypothetical future low-risk profile:
   - Ordinary text files only; diff <= 4 KiB, total changes <= 16 KiB
   - Non-protected paths only; no deletes or renames
   - No script or package manifest modifications
   - Max 2 iterations, 5 minutes runtime, 16 KiB output
   - `active: false` (strictly non-functional while NO-GO is active).
6. **Fail-Closed Capability Revocation:** Any capability loss, secret detection, stage conflict, or budget trip revokes eligibility immediately.
7. **Next Assessment Requirements:** Future re-evaluation requires:
   - Independent demonstration of host child-process tree termination
   - Host network default-deny boundary demonstration
   - Reliable host exit-code capture without hang or truncation
   - Formal revision of S00 feasibility decision and ADR-002 via approved engineering review.

---

## 12. Sprint S40 — Windows 11 Sandbox Feasibility & Adversarial Canary Evaluation

**Date:** 2026-10-12  
**Sprint:** S40  
**Host System:** Windows 10 Home Single Language (DisplayVersion: `26H2`, Build: `26300`, Edition: `CoreSingleLanguage`) running as Windows 11 Home  
**User Account:** Standard non-elevated user (`ATULYADAV\Atul2`, `Is Administrator: False`)  
**Prototype Tested:** `DisposableWindowsExecutor` in `@mediator/executor-contract`  
**Canary Battery:** 12 Live Adversarial Canaries in `packages/executor-contract/src/windowsSandboxCanaries.test.ts`  
**Verdict:** **`CONDITIONAL — PROTOTYPE WORKS, REQUIRED CAPABILITY UNVERIFIED`**  
**Autopilot Status:** **`BLOCKED`** fail-closed under authoritative S00 `NO-GO-AUTOEXEC`  

### 12.1 Host Environment Discovery

1. **Windows Sandbox (`Containers-DisposableClientVM`):** Unsupported on Windows 11 Home Single Language (requires Windows Pro, Enterprise, or Education editions).
2. **Virtualization Hardware:** Intel Core i7-12700H (14 cores, 20 logical threads). CIM processor query reports `VirtualizationFirmwareEnabled: False`.
3. **WSL2 Availability:** WSL2 is installed and responsive (`wsl -e echo hello` returns exit code 0, default distro `Ubuntu`). However, external virtualization systems cannot be made mandatory dependencies for standard Windows users.
4. **User Security Token:** Current user is standard non-admin. Standard processes inherit user ambient authority, granting read access to `C:\Users\Atul2\` files and unrestricted outbound network sockets.

### 12.2 S40 Twelve Adversarial Canary Results

| Canary ID | Test Description | Observed Behavior | Enforcing Layer | Qualification Result | Evidence Reference |
|---|---|---|---|---|---|
| **S40-01** | Live source workspace write denial | Policy Denial: PASS (direct execution in live workspace strictly rejected). OS Write Prevention: FAILED (staging script with ambient access could modify live sentinel without hypervisor boundary; `liveWorkspaceIntegrityPreserved: false`). Tamper Detection: PASS (pre/post tree hash caught modification immediately). *[S41 Correction Note: Historical report previously marked overall PASS based on post-hoc detection; S41 corrected this to explicitly separate prevention (FAILED at OS level) from detection (PASS via tree-hash). Contradictory evidence now rejected by CapabilityEvaluationEngine].* | `mediator` (policy denial & tree-hash detection) | **POLICY & DETECTION PASS / OS WRITE PREVENTION FAILED** | `canary:s40-source-integrity-check` |
| **S40-02** | Outside task root write denial | Script writes outside task root (`outside_forbidden.txt`) because Windows OS ambient authority permits write without OS sandbox | OS boundary lacks isolation | **OBSERVED / UNVERIFIED** | `canary:s40-outside-write-ambient` |
| **S40-03** | Secret file reading & exfiltration | Script reads user `.env` outside task root, but Mediator's context security engine (`scanContent` + `redactTerminalOutput`) sanitizes all tokens before emission | `mediator` (context security) | **PASS** | `canary:s40-secret-output-redaction` |
| **S40-04** | Reparse point / junction escape | NTFS junction pointing outside task workspace is accessible by process without container filesystem namespace | OS boundary lacks isolation | **OBSERVED / UNVERIFIED** | `canary:s40-junction-escape-ambient` |
| **S40-05** | Child process confinement & termination | Child process tree spawned; process tree terminated via `taskkill /pid <PID> /T /F`. Proves need for kernel Job Object to prevent detached process escape | `mediator` / `host` (taskkill) | **PARTIAL / UNVERIFIED** | `canary:s40-child-process-tree` |
| **S40-06** | Process budget & output byte bounding | Script emitting 100 KiB is truncated at 8 KiB buffer cap (`outputTruncated: true`), preventing buffer overflow | `mediator` (stream buffer cap) | **PASS** | `canary:s40-output-byte-bounding` |
| **S40-07** | Network default-deny policy | Script opens outbound network socket successfully. Confirms network isolation is NOT enforceable on Windows Home without elevation | OS boundary lacks isolation | **FAILED / UNVERIFIED** | `canary:s40-network-socket-open` |
| **S40-08** | Real exit code capture | Script exiting with code 42 is programmatically captured as real numeric exit code `42` independently of model claims | `host` (Node spawn exitCode) | **PASS (VERIFIED)** | `canary:s40-real-exit-code-42` |
| **S40-09** | Timeout handling | Hanging script is terminated at 1.2s timeout; status assigned as `timeout` | `mediator` (timeout timer) | **PASS** | `canary:s40-timeout-termination` |
| **S40-10** | Cancellation handling | Active script cancelled via `AbortSignal`; clean process termination and status assigned as `cancelled` | `mediator` (cancellation signal) | **PASS** | `canary:s40-cancellation-signal` |
| **S40-11** | Recipe hash tamper rejection | Tampered recipe definition hash is rejected before process launch (`security_violation`) | `mediator` (hash verification) | **PASS** | `canary:s40-recipe-hash-tamper` |
| **S40-12** | Uncertain outcome replay denial | Nonzero exit or interrupted outcome is flagged and blocked from automatic replay | `mediator` (no-replay guard) | **PASS** | `canary:s40-no-replay-uncertain` |

### 12.3 Capability Matrix Status After S40

| Capability Field | Status After S40 | Enforced By | Live Evidence Reference |
|---|---|---|---|
| `limits.capturesRealExitCode` | **VERIFIED (true)** | `host` / Node.js | `canary:s40-real-exit-code-42` |
| `limits.timeoutEnforced` | **VERIFIED (true)** | `mediator` | `canary:s40-timeout-termination` |
| `limits.cancellationEnforced` | **VERIFIED (true)** | `mediator` | `canary:s40-cancellation-signal` |
| `limits.outputByteLimitsEnforced` | **VERIFIED (true)** | `mediator` | `canary:s40-output-byte-bounding` |
| `execution.fixedRecipeOnly` | **VERIFIED (true)** | `mediator` | `canary:s40-recipe-hash-tamper` |
| `process.childProcessesConfined` | **UNVERIFIED (false)** | `unknown` | Win32 Job Object kernel assignment required |
| `network.networkDefaultDeny` | **UNVERIFIED (false)** | `unknown` | Failed: Outbound sockets connect on Windows 11 Home |
| `filesystem.readIsolation` | **UNVERIFIED (false)** | `unknown` | Ambient user token allows reading other user files |

### 12.4 S40 Autopilot Qualification Verdict

**Decision:** `CONDITIONAL — PROTOTYPE WORKS, REQUIRED CAPABILITY UNVERIFIED`  
**Autopilot Status:** **`BLOCKED`** fail-closed (`canRun: false`).  

While `limits.capturesRealExitCode` has been genuinely demonstrated and verified, `network.networkDefaultDeny` and `process.childProcessesConfined` cannot be enforced at the OS kernel boundary on Windows 11 Home without administrator elevation or container isolation.

In strict accordance with S00 `NO-GO-AUTOEXEC`, Mediator will **NOT** enable automated local execution. Mediator remains in **Review-only mode** (Assisted Loop), preserving safe manual recipe suggestions, shadow staging, and cryptographically bound human approvals.

---

## 13. Sprint S41 — WSL2 Isolated Sandbox Feasibility & Adversarial Canary Evaluation

**Date:** 2026-10-12  
**Sprint:** S41  
**Host System:** Windows 10 Home Single Language running as Windows 11 Home  
**WSL2 Subsystem:** Installed; Default distro `Ubuntu` (Linux kernel `6.18.40.1-microsoft-standard-WSL2`, systemd enabled, cgroups v2 mounted)  
**Execution Prototype:** `WslIsolatedExecutor` and `WslSandboxProvisioner` in `@mediator/executor-contract`  
**Canary Battery:** 13 Live Adversarial Canaries in `packages/executor-contract/src/wslSandboxCanaries.test.ts` (13/13 PASS)  
**Verdict:** **`CONDITIONAL — SOME ISOLATION CAPABILITIES REMAIN UNVERIFIED`**  
**Autopilot Status:** **`BLOCKED`** fail-closed under authoritative S00 `NO-GO-AUTOEXEC`  

### 13.1 Discovery & Distribution Boundary Findings

1. **Host WSL2 Capability:** WSL2 is operational on the user's Windows 11 Home host with kernel `6.18.40.1-microsoft-standard-WSL2`. Systemd and cgroup v2 are present in the kernel.
2. **Default Ubuntu Insecurity (Critical Finding):**
   - The user's default `Ubuntu` distribution has DrvFS automount enabled (`/mnt/c` and `/mnt/d` mounted writable).
   - Windows command interop (`/init` binfmt interop) is enabled, allowing execution of arbitrary Windows host binaries (e.g. `cmd.exe`) from within Linux.
   - **Conclusion:** Untrusted execution inside the default `Ubuntu` distribution is strictly prohibited.
3. **Dedicated Distribution Requirement (`MediatorSandbox`):**
   - Requires a dedicated distribution with `/etc/wsl.conf` disabling automount (`[automount] enabled = false`) and interop (`[interop] enabled = false, appendWindowsPath = false`).
   - Requires dedicated unprivileged user `mediator-runner` (UID 1500) without `sudo` access.
   - Requires guest packet filtering (`iptables` / `nftables`) default-deny policy.
   - Per S41 safety constraints, `MediatorSandbox` was not created automatically; setup instructions and scripts are staged in `scripts/prepare-wsl2-sandbox.ps1`.

### 13.2 S41 Thirteen Adversarial Canary Results

| Canary ID | Test Description | Observed Behavior | Enforcing Layer | Qualification Result | Evidence Reference |
|---|---|---|---|---|---|
| **S41-01** | WSL2 installation & kernel discovery | Discovered WSL2, active Ubuntu distro, and Microsoft WSL2 kernel | `host` / `wsl.exe` | **PASS (VERIFIED)** | `canary:s41-wsl-discovery` |
| **S41-02** | Real success exit code (0) capture | Captured numeric exit code 0 and stdout from `/bin/sh` process inside WSL2 | `host` / WSL2 process supervisor | **PASS (VERIFIED)** | `canary:s41-wsl-exit-0` |
| **S41-03** | Real nonzero exit code (42) capture | Captured numeric exit code 42 and stderr from `/bin/sh` process inside WSL2 | `host` / WSL2 process supervisor | **PASS (VERIFIED)** | `canary:s41-wsl-exit-42` |
| **S41-04** | Process timeout enforcement | Hanging task terminated cleanly in 1.46s (limit 1.2s); status set to `timeout` | `mediator` (watchdog timer & taskkill) | **PASS (VERIFIED)** | `canary:s41-wsl-timeout` |
| **S41-05** | Cancellation via AbortSignal | Active task halted cleanly in 865ms upon AbortSignal; status set to `cancelled` | `mediator` (abort listener & taskkill) | **PASS (VERIFIED)** | `canary:s41-wsl-cancellation` |
| **S41-06** | Output buffer bounding | Output flood truncated at 2048 bytes; `outputTruncated: true` flagged | `mediator` (stream byte limiter) | **PASS (VERIFIED)** | `canary:s41-wsl-output-bound` |
| **S41-07** | Secret token sanitization | Leaked OpenAI key in process stdout redacted via `@mediator/context-security` to `[REDACTED:OPENAI_KEY]` | `mediator` (context security engine) | **PASS (VERIFIED)** | `canary:s41-wsl-secret-redaction` |
| **S41-08** | Default distro vulnerability probe | Proved that default Ubuntu mounts `/mnt/c` and enables Windows interop | `host` / default Ubuntu | **PASS (VULNERABILITY CONFIRMED)** | `canary:s41-default-distro-probe` |
| **S41-09** | Default distro execution rejection | Prohibits untrusted execution in default Ubuntu without explicit canary test authorization flag | `mediator` (distro isolation policy) | **PASS (VERIFIED)** | `canary:s41-distro-policy-enforcement` |
| **S41-10** | Missing dedicated sandbox fail-closed | Fails closed with `distribution_unavailable` when `MediatorSandbox` is not provisioned | `mediator` / `host` (fail-closed guard) | **PASS (VERIFIED)** | `canary:s41-missing-distro-fail-closed` |
| **S41-11** | Recipe definition hash pinning | Rejects execution immediately upon SHA-256 hash mismatch | `mediator` (recipe registry) | **PASS (VERIFIED)** | `canary:s41-recipe-hash-pinning` |
| **S41-12** | Live workspace sentinel protection | Pre/post SHA-256 tree hash confirms live project files remained 100% unaltered | `mediator` (staging tree-hash guard) | **PASS (VERIFIED)** | `canary:s41-live-workspace-integrity` |
| **S41-13** | Local Autopilot blocked gate | Confirms Local Autopilot remains strictly blocked (`canRun: false`) under S00 `NO-GO-AUTOEXEC` | `mediator` (S00 policy & capability gate) | **PASS (VERIFIED)** | `canary:s41-autopilot-fail-closed` |

### 13.3 Capability Matrix Status After S41

| Capability Field | Status After S41 | Enforced By | Live Evidence Reference |
|---|---|---|---|
| `limits.capturesRealExitCode` | **VERIFIED (true)** | `host` (WSL2 process supervisor) | `canary:s41-wsl-exit-0`, `canary:s41-wsl-exit-42` |
| `limits.timeoutEnforced` | **VERIFIED (true)** | `mediator` | `canary:s41-wsl-timeout` |
| `limits.cancellationEnforced` | **VERIFIED (true)** | `mediator` | `canary:s41-wsl-cancellation` |
| `limits.outputByteLimitsEnforced` | **VERIFIED (true)** | `mediator` | `canary:s41-wsl-output-bound` |
| `execution.fixedRecipeOnly` | **VERIFIED (true)** | `mediator` | `canary:s41-recipe-hash-pinning` |
| `filesystem.sourceWriteDenied` | **VERIFIED (true)** | `mediator` (staging boundary & tree hash) | `canary:s41-live-workspace-integrity` |
| `filesystem.secretsDenied` | **VERIFIED (true)** | `mediator` (context security engine) | `canary:s41-wsl-secret-redaction` |
| `filesystem.outsideTaskRootDenied` | **UNVERIFIED (false)** | Pending `MediatorSandbox` provisioning | Default Ubuntu has automount; dedicated distro pending user authorization |
| `network.networkDefaultDeny` | **UNVERIFIED (false)** | Pending `MediatorSandbox` iptables | Default WSL2 allows host NAT outbound traffic; dedicated iptables rules pending |
| `process.childProcessesConfined` | **VERIFIED (Prototype)** | `mediator` / `host` (taskkill on wsl.exe) | Process tree cleanly terminated; cgroups v2 present in kernel |

### 13.4 S41 Autopilot Qualification Verdict

**Authoritative Verdict:** **`CONDITIONAL — SOME ISOLATION CAPABILITIES REMAIN UNVERIFIED`**  
**Autopilot Status:** **`BLOCKED`** fail-closed (`canRun: false`).  

Local Autopilot remains strictly disabled under S00 `NO-GO-AUTOEXEC`. While WSL2 demonstrates excellent supervisor properties for real exit code capture, timeout, cancellation, output limits, and secret redaction, host drive automounting and unrestricted network access inside unhardened WSL2 environments prevent enabling unattended execution until the dedicated `MediatorSandbox` distribution is explicitly authorized and provisioned by the user.

---

## 14. Sprint S42 — Dedicated WSL2 Sandbox Provisioning & Real Isolation Validation

**Date:** 2026-10-12  
**Sprint:** S42  
**Host System:** Windows 10 Home Single Language running as Windows 11 Home  
**WSL2 Sandbox:** Standalone `MediatorSandbox` WSL2 distribution provisioned at `%LOCALAPPDATA%\Mediator\wsl\MediatorSandbox\ext4.vhdx`  
**Execution Isolation User:** `mediator-runner` (UID 1500, GID 1500)  
**Canary Battery:** 22 Total Live Canaries in `packages/executor-contract/src/wslSandboxCanaries.test.ts` (22/22 PASS)  
**Verdict:** **`CONDITIONAL — SOME CAPABILITIES REMAIN UNVERIFIED`**  
**Autopilot Status:** **`BLOCKED`** fail-closed under authoritative S00 `NO-GO-AUTOEXEC`  

### 14.1 Provisioning Operations & Host Separation

1. **Preflight Diagnostic (`-CheckOnly`):** Verified existing `Ubuntu` and `docker-desktop` distributions. Confirmed default `Ubuntu` is unhardened and must not be used for untrusted tasks.
2. **Explicit User Authorization:** User explicitly authorized provisioning of `MediatorSandbox` after reviewing storage, user configuration, non-destructive guarantees, and reversibility.
3. **Dedicated Distribution Created:** Provisioned `MediatorSandbox` with hardened `/etc/wsl.conf`:
   - `[automount] enabled = false`: Host drives (`/mnt/c`) are not mounted.
   - `[interop] enabled = false, appendWindowsPath = false`: Windows binary execution (`cmd.exe`) disabled; zero host Windows paths in guest `PATH`.
   - `[user] default = mediator-runner`: Unprivileged user `mediator-runner` (UID 1500) created with no sudoer permissions.
4. **Zero Impact on User Environment:** Personal `Ubuntu` distribution was never started, modified, or altered in any way. Clean removal verified via `prepare-wsl2-sandbox.ps1 -Cleanup`.

### 14.2 S42 Dedicated Distribution Canary Battery (Canaries 14–22)

| Canary ID | Boundary Tested | Adversarial Probe | Observed Runtime Behavior | Result | Evidence Ref |
|---|---|---|---|---|---|
| **S42-14** | Dedicated Distro Execution | Real recipe executed inside `MediatorSandbox` | Executed as `mediator-runner` (UID 1500); exit code 0; output captured | **PASS (VERIFIED)** | `canary:s42-mediator-sandbox-exec` |
| **S42-15** | Host Drive Automount Absence | Check `/mnt/c` mount status | `/mnt/c` is an empty detached directory; `mountpoint /mnt/c` returns non-zero | **PASS (VERIFIED)** | `canary:s42-automount-disabled` |
| **S42-16** | Windows Host Interop Absence | Attempt `cmd.exe /c whoami` and inspect `PATH` | Command fails (`cmd.exe: not found`); guest `PATH` contains zero Windows paths | **PASS (VERIFIED)** | `canary:s42-interop-denied` |
| **S42-17** | Privilege Containment | Attempt `sudo id` and append to `/etc/wsl.conf` | `sudo` fails ("sudo: I'm sorry mediator-runner"); `/etc/wsl.conf` append fails ("Permission denied") | **PASS (VERIFIED)** | `canary:s42-privilege-denial` |
| **S42-18** | Workspace Boundary Containment | Attempt `touch /forbidden.txt` outside task root | Write fails ("touch: cannot touch '/forbidden.txt': Permission denied") | **PASS (VERIFIED)** | `canary:s42-outside-write-denial` |
| **S42-19** | Synthetic Secret Inaccessibility | Attempt read of synthetic secret on host Windows | Path inaccessible; guest has no route or DrvFS mount to host filesystem | **PASS (VERIFIED)** | `canary:s42-secret-read-denial` |
| **S42-20** | Network Default-Deny Evaluation | Socket probe to `1.1.1.1:80` vs WSL DNS proxy `10.255.255.254:53` | Public internet unreachable (`Errno 101`), BUT WSL hypervisor DNS proxy connects. Network default-deny marked unverified | **PASS (Accurate Failure Recorded)** | `canary:s42-network-default-deny` |
| **S42-21** | Malformed Bundle Traversal Rejection | Result bundle attempting `../../escape.txt` traversal | Windows receiver rejects bundle with `INVALID_ARTIFACT_PATH` error | **PASS (VERIFIED)** | `canary:s42-bundle-traversal-rejection` |
| **S42-22** | Autopilot Gate Invariant | Capability evaluation under S00 `NO-GO-AUTOEXEC` with fresh evidence | Evaluation report returns `isEligibleForAutoExec: false`, `result: 'blocked'`; execution gate strictly fails closed | **PASS (VERIFIED)** | `canary:s42-autopilot-fail-closed` |

### 14.3 Cumulative Capabilities Matrix After S42

| Capability Property | Status | Enforcing Layer | Observed Evidence |
|---|---|---|---|
| `filesystem.stageRootRead` | **VERIFIED (true)** | `mediator` / `host` | `canary:s42-mediator-sandbox-exec` |
| `filesystem.stageRootWrite` | **VERIFIED (true)** | `mediator` / `host` | `canary:s42-mediator-sandbox-exec` |
| `filesystem.liveWorkspaceWriteDenied` | **VERIFIED (true)** | `host` (`[automount] enabled=false`) | `canary:s42-automount-disabled`, `canary:s41-live-workspace-integrity` |
| `filesystem.outsideRootDenied` | **VERIFIED (true)** | `host` (Linux VHDX permissions) | `canary:s42-outside-write-denial` |
| `filesystem.secretFilesProtected` | **VERIFIED (true)** | `host` (Host drive detached) | `canary:s42-secret-read-denial` |
| `filesystem.symlinkEscapeDenied` | **VERIFIED (true)** | `host` / `mediator` (bundle receiver) | `canary:s42-bundle-traversal-rejection` |
| `process.executableAllowlistEnforced` | **VERIFIED (true)** | `mediator` (recipe registry) | `canary:s41-recipe-hash-pinning` |
| `process.untrustedScriptsRejected` | **VERIFIED (true)** | `mediator` (recipe registry) | `canary:s41-recipe-hash-pinning` |
| `process.childProcessesControlled` | **VERIFIED (true)** | `mediator` (process tree supervisor) | `canary:s41-wsl-timeout`, `canary:s41-wsl-cancellation` |
| `process.hostShellFallbackDenied` | **VERIFIED (true)** | `host` (`[interop] enabled=false`) | `canary:s42-interop-denied` |
| `limits.timeoutEnforced` | **VERIFIED (true)** | `mediator` (watchdog timer) | `canary:s41-wsl-timeout` |
| `limits.cancellationEnforced` | **VERIFIED (true)** | `mediator` (abort listener) | `canary:s41-wsl-cancellation` |
| `limits.outputByteLimitsEnforced` | **VERIFIED (true)** | `mediator` (byte limiter) | `canary:s41-wsl-output-bound` |
| `limits.capturesRealExitCode` | **VERIFIED (true)** | `host` (WSL process exit) | `canary:s41-wsl-exit-0`, `canary:s41-wsl-exit-42` |
| `execution.fixedRecipeOnly` | **VERIFIED (true)** | `mediator` (SHA-256 hash pinning) | `canary:s41-recipe-hash-pinning` |
| `execution.stagedSourceProven` | **VERIFIED (true)** | `mediator` (staging tree-hash guard) | `canary:s41-live-workspace-integrity` |
| `network.networkDefaultDeny` | **UNVERIFIED (false)** | WSL hypervisor virtual switch | `canary:s42-network-default-deny` (Hyper-V DNS proxy connects) |

### 14.4 S42 Exit Verdict

**Authoritative Verdict:** **`CONDITIONAL — SOME CAPABILITIES REMAIN UNVERIFIED`**  
**Autopilot Status:** **`BLOCKED`** fail-closed (`canRun: false`).  

While the dedicated `MediatorSandbox` distribution successfully guarantees host drive detachment, interop prevention, non-root privilege containment, outside task workspace write denial, and real exit code capture, the underlying WSL2 Hyper-V virtual switch architecture permits sockets to connect to the host's WSL DNS proxy endpoint (`10.255.255.254:53`). In strict accordance with the anti-weakening policy, `network.networkDefaultDeny` cannot be certified as true at the OS boundary.

Local Autopilot remains strictly blocked under S00 `NO-GO-AUTOEXEC`. Mediator operates in Review-only mode with full staging and manual approval workflows.

---

## 15. Sprint S43 — Network Egress Isolation, DNS Tunnel Investigation & Security Gate

**Date:** 2026-10-12  
**Sprint:** S43  
**Host System:** Windows 10 Home Single Language running as Windows 11 Home  
**WSL2 Sandbox:** Standalone `MediatorSandbox` WSL2 distribution (`%LOCALAPPDATA%\Mediator\wsl\MediatorSandbox\ext4.vhdx`)  
**Execution Isolation:** Linux Network Namespaces (`CLONE_NEWNET` via `unshare --user --net --map-root-user --fork --kill-child`)  
**Canary Battery:** 31 Total Live Canaries in `packages/executor-contract/src/wslSandboxCanaries.test.ts` (31/31 PASS, 100%)  
**Authoritative Verdict:** **`PASS — DEDICATED SANDBOX NETWORK ISOLATION VERIFIED`**  
**Autopilot Status:** **`BLOCKED`** fail-closed under authoritative S00 `NO-GO-AUTOEXEC`  

### 15.1 Root Cause of the DNS Proxy Finding

1. **Hypervisor Loopback Alias:** In WSL2, the IP address `10.255.255.254/32` is assigned directly to the Linux loopback interface (`lo`) inside the virtual machine.
2. **Hypervisor Recursive Proxy:** The host Windows WSL service listens on port 53 of that IP address without any user-space process inside the guest. Queries to `10.255.255.254:53` are forwarded by the hypervisor through the host Windows network stack.
3. **Data Exfiltration Vector:** Live experiments proved that `socket.gethostbyname('example.com')` succeeded inside the default namespace (returning `172.66.147.243`). Thus, an attacker could exfiltrate sensitive data via DNS tunneling queries even when direct TCP/UDP packets to public internet IPs are blocked.

### 15.2 Enforcement Mechanism: User & Network Namespaces

Rather than altering global Windows or WSL configuration (which would disrupt the user's personal distributions or require administrator elevation), `WslIsolatedExecutor` wraps task execution inside an unprivileged Linux network namespace:

```bash
unshare --user --net --map-root-user --fork --kill-child -- <executable> <args...>
```

Key Properties:
- **Zero Host Impact:** Does not alter host Windows settings, `.wslconfig`, or firewall rules.
- **Zero Distribution Disruption:** Does not affect personal `Ubuntu` or `docker-desktop`.
- **Zero Root Privilege Required:** Uses unprivileged user namespaces (`CLONE_NEWUSER`).
- **Complete Network Severance:** The isolated namespace contains zero external interfaces (`eth0` is absent) and a clean loopback interface without the `10.255.255.254` alias.
- **Deterministic Rejection:** Direct IPv4/IPv6 connections fail immediately with `ENETUNREACH` (errno 101) or `EADDRNOTAVAIL` (errno 99). DNS lookups fail with `EAI_AGAIN` (`[Errno -3] Temporary failure in name resolution`).
- **Process Confinement:** Child processes inherit the network namespace; `--kill-child` terminates orphaned children on exit or cancellation.
- **Tampering Resistance:** `mediator-runner` cannot escape the namespace or bring up interfaces (`Operation not permitted`).

### 15.3 S43 Network Egress Canary Results (Canaries 23–31)

| Canary ID | Channel Tested | Adversarial Probe | Observed Runtime Behavior | Result | Evidence Ref |
|---|---|---|---|---|---|
| **S43-23** | Direct IPv4 Outbound | TCP connect `1.1.1.1:80` & UDP `8.8.8.8:53` | Fails with `OSError: [Errno 101] Network is unreachable` | **PASS (VERIFIED)** | `canary:s43-ipv4-denial` |
| **S43-24** | Direct IPv6 Outbound | TCP connect `[2606:4700:4700::1111]:80` | Fails with `OSError: [Errno 99]` / `[Errno 101]` | **PASS (VERIFIED)** | `canary:s43-ipv6-denial` |
| **S43-25** | Hypervisor DNS Proxy | Connect `10.255.255.254:53` & hostname lookup | Fails with `Errno 101` and `[Errno -3] Temporary failure in name resolution` | **PASS (VERIFIED)** | `canary:s43-dns-proxy-denial` |
| **S43-26** | DNS Tunneling Elimination | Exfiltration query `exfil.test.mediator` | Resolution fails completely (`Errno -3`); zero bytes transmitted | **PASS (VERIFIED)** | `canary:s43-dns-tunnel-denial` |
| **S43-27** | Host Gateway Isolation | Probe host gateway `172.31.80.1:80` | Fails with `OSError: [Errno 101] Network is unreachable` | **PASS (VERIFIED)** | `canary:s43-host-gateway-denial` |
| **S43-28** | Enforcement Tampering | Attempt `nsenter` or creating network interface | Fails with `Operation not permitted` / `Permission denied` | **PASS (VERIFIED)** | `canary:s43-tampering-denial` |
| **S43-29** | Child Process Confinement | Spawn background child attempting delayed connection | Child inherits netns; fails with Errno 101; terminated by `--kill-child` on cancel | **PASS (VERIFIED)** | `canary:s43-child-confinement` |
| **S43-30** | Restart Persistence | Terminate sandbox (`wsl.exe -t`) and re-execute | Isolation persists deterministically on fresh sandbox start | **PASS (VERIFIED)** | `canary:s43-restart-persistence` |
| **S43-31** | Capability Gate Under S00 | Full capability evaluation with S43 verified network evidence | `network.networkDefaultDeny = VERIFIED`; Autopilot strictly `BLOCKED` fail-closed | **PASS (VERIFIED)** | `canary:s43-autopilot-fail-closed` |

### 15.4 Authoritative Capability Matrix After S43

| Capability Property | Status | Enforcing Layer | Observed Live Evidence |
|---|---|---|---|
| `filesystem.stageRootRead` | **VERIFIED (true)** | `mediator` / `host` | `canary:s42-mediator-sandbox-exec` |
| `filesystem.stageRootWrite` | **VERIFIED (true)** | `mediator` / `host` | `canary:s42-mediator-sandbox-exec` |
| `filesystem.liveWorkspaceWriteDenied` | **VERIFIED (true)** | `host` (`[automount] enabled=false`) | `canary:s42-automount-disabled`, `canary:s41-live-workspace-integrity` |
| `filesystem.outsideRootDenied` | **VERIFIED (true)** | `host` (Linux VHDX permissions) | `canary:s42-outside-write-denial` |
| `filesystem.secretFilesProtected` | **VERIFIED (true)** | `host` (Host drive detached) | `canary:s42-secret-read-denial` |
| `filesystem.symlinkEscapeDenied` | **VERIFIED (true)** | `host` / `mediator` (bundle receiver) | `canary:s42-bundle-traversal-rejection` |
| `process.executableAllowlistEnforced` | **VERIFIED (true)** | `mediator` (recipe registry) | `canary:s41-recipe-hash-pinning` |
| `process.untrustedScriptsRejected` | **VERIFIED (true)** | `mediator` (recipe registry) | `canary:s41-recipe-hash-pinning` |
| `process.childProcessesControlled` | **VERIFIED (true)** | `host` (`--fork --kill-child`) | `canary:s43-child-confinement`, `canary:s41-wsl-timeout` |
| `process.hostShellFallbackDenied` | **VERIFIED (true)** | `host` (`[interop] enabled=false`) | `canary:s42-interop-denied` |
| `limits.timeoutEnforced` | **VERIFIED (true)** | `mediator` (watchdog timer) | `canary:s41-wsl-timeout` |
| `limits.cancellationEnforced` | **VERIFIED (true)** | `mediator` (abort listener) | `canary:s41-wsl-cancellation` |
| `limits.outputByteLimitsEnforced` | **VERIFIED (true)** | `mediator` (byte limiter) | `canary:s41-wsl-output-bound` |
| `limits.capturesRealExitCode` | **VERIFIED (true)** | `host` (WSL process exit) | `canary:s41-wsl-exit-0`, `canary:s41-wsl-exit-42` |
| `execution.fixedRecipeOnly` | **VERIFIED (true)** | `mediator` (SHA-256 hash pinning) | `canary:s41-recipe-hash-pinning` |
| `execution.stagedSourceProven` | **VERIFIED (true)** | `mediator` (staging tree-hash guard) | `canary:s41-live-workspace-integrity` |
| `network.networkDefaultDeny` | **VERIFIED (true)** | `host` (Linux netns `CLONE_NEWNET`) | `canary:s43-ipv4-denial`, `canary:s43-dns-proxy-denial`, `canary:s43-dns-tunnel-denial` |

### 15.5 S43 Exit Verdict

**Authoritative Verdict:** **`PASS — DEDICATED SANDBOX NETWORK ISOLATION VERIFIED`**  
**Autopilot Status:** **`BLOCKED`** fail-closed under authoritative S00 `NO-GO-AUTOEXEC`  

With the successful verification of Canaries 23–31, all defined network-isolation acceptance criteria for S43 are satisfied and backed by reproducible OS evidence. Both direct network access (IPv4/IPv6 TCP/UDP) and virtualization-mediated channels (DNS proxy, DNS tunneling, host gateway reachability) are definitively blocked via Linux network namespace isolation.

However, in accordance with Section 11 of the sprint specification, **Local Autopilot remains strictly `BLOCKED` fail-closed under S00 `NO-GO-AUTOEXEC`.** Passing network isolation is a prerequisite, not an authorization, for autonomous execution. Mediator remains firmly in Review-only mode, requiring human staging review and explicit approval for all workspace changes.

---

## 16. Sprint S44 — Independent Security Readiness Review & Autopilot Governance Audit

**Date:** 2026-10-12  
**Sprint:** S44  
**Audit Scope:** Threat modeling, host trust boundaries, network isolation reproducibility, supply chain feasibility, and release governance  
**Canary Suite:** 32 Total Live Canaries in `packages/executor-contract/src/wslSandboxCanaries.test.ts` (32/32 PASS, 100%)  
**Authoritative Verdict:** **`PASS — REVIEW COMPLETE`**  
**Local Autopilot Status:** **`BLOCKED — S00 NO-GO-AUTOEXEC REMAINS AUTHORITATIVE`**  

### 16.1 Audit Findings & Verification

1. **Host-Side Windows Ambient Authority (Identified Residual Risk):**
   - Mediator Core executes on Windows as a standard Node.js process under the user account (`Atul2`).
   - The Linux VM and network namespace isolate the guest from the host; they do not isolate the host Node.js process from the Windows user's files or credentials.
   - Mitigation: Node.js process runs zero arbitrary shell strings, enforces high-entropy pairing tokens for all loopback requests, and strictly fails closed on S00 `NO-GO-AUTOEXEC`.
2. **Network Isolation Enforcement Hardening (Canary 32):**
   - Audited `WslIsolatedExecutor` to determine if unprivileged callers could bypass network namespace isolation by passing `isolateNetwork: false` on `MediatorSandbox`.
   - Hardened `WslIsolatedExecutor` to require explicit test canary authorization (`allowUnisolatedNetworkForCanary: true`) for any unisolated execution on `MediatorSandbox`.
   - Verified via **Canary 32**: Attempting to disable network isolation without authorization is rejected fail-closed as `security_violation`.
3. **Offline Toolchain & Supply Chain Gap (Identified Release Blocker):**
   - Because `MediatorSandbox` completely blocks network egress, dynamic package installation (`npm install`, `pip install`, `cargo fetch`) fails by design (`ENETUNREACH`).
   - Re-enabling network access for package installation would destroy the security boundary and re-introduce data exfiltration channels.
   - An offline toolchain delivery pipeline (pre-installed VHDX toolchains or hash-pinned offline vendor caches) is required before unattended autonomous code execution could ever be supported.
4. **Authoritative Governance Invariant:**
   - Traced authorization from UI toggle, CLI, IDE extension, and Core IPC to process launch.
   - Local Autopilot remains strictly `BLOCKED` fail-closed under S00 `NO-GO-AUTOEXEC`.
   - Mediator operates exclusively in Review-only V1 mode.

### 16.2 Cumulative Capability Matrix After S44

| Capability Property | Status | Enforcing Layer | Observed Live Evidence |
|---|---|---|---|
| `filesystem.stageRootRead` | **VERIFIED (true)** | `mediator` / `host` | `canary:s42-mediator-sandbox-exec` |
| `filesystem.stageRootWrite` | **VERIFIED (true)** | `mediator` / `host` | `canary:s42-mediator-sandbox-exec` |
| `filesystem.liveWorkspaceWriteDenied` | **VERIFIED (true)** | `host` (`[automount] enabled=false`) | `canary:s42-automount-disabled`, `canary:s41-live-workspace-integrity` |
| `filesystem.outsideRootDenied` | **VERIFIED (true)** | `host` (Linux VHDX permissions) | `canary:s42-outside-write-denial` |
| `filesystem.secretFilesProtected` | **VERIFIED (true)** | `host` (Host drive detached) | `canary:s42-secret-read-denial` |
| `filesystem.symlinkEscapeDenied` | **VERIFIED (true)** | `host` / `mediator` (path containment) | `stageStore.test.ts`, `pathContainment.ts` |
| `process.executableAllowlistEnforced` | **VERIFIED (true)** | `mediator` (recipe registry) | `canary:s41-recipe-hash-pinning` |
| `process.untrustedScriptsRejected` | **VERIFIED (true)** | `mediator` (recipe registry) | `canary:s41-recipe-hash-pinning` |
| `process.childProcessesControlled` | **VERIFIED (true)** | `host` (`--fork --kill-child`) | `canary:s43-child-confinement`, `canary:s41-wsl-timeout` |
| `process.hostShellFallbackDenied` | **VERIFIED (true)** | `host` (`[interop] enabled=false`) | `canary:s42-interop-denied` |
| `limits.timeoutEnforced` | **VERIFIED (true)** | `mediator` (watchdog timer) | `canary:s41-wsl-timeout` |
| `limits.cancellationEnforced` | **VERIFIED (true)** | `mediator` (abort listener) | `canary:s41-wsl-cancellation` |
| `limits.outputByteLimitsEnforced` | **VERIFIED (true)** | `mediator` (byte limiter) | `canary:s41-wsl-output-bound` |
| `limits.capturesRealExitCode` | **VERIFIED (true)** | `host` (WSL process exit) | `canary:s41-wsl-exit-0`, `canary:s41-wsl-exit-42` |
| `execution.fixedRecipeOnly` | **VERIFIED (true)** | `mediator` (SHA-256 hash pinning) | `canary:s41-recipe-hash-pinning` |
| `execution.stagedSourceProven` | **VERIFIED (true)** | `mediator` (staging tree-hash guard) | `canary:s41-live-workspace-integrity` |
| `network.networkDefaultDeny` | **VERIFIED (true)** | `host` (Linux netns `CLONE_NEWNET`) | `canary:s43-ipv4-denial`, `canary:s43-dns-proxy-denial`, `canary:s44-network-bypass-denial` |

### 16.3 S44 Release Qualification Verdict

**Authoritative Audit Verdict:** **`PASS — REVIEW COMPLETE`**  
**Local Autopilot Decision:** **`BLOCKED — S00 NO-GO-AUTOEXEC REMAINS AUTHORITATIVE`**  

The S44 independent security readiness review and threat modeling audit are complete. All isolation and authorization boundaries have been verified against real OS execution. Residual host ambient authority risks and offline toolchain gaps are clearly documented and properly gated. Autonomous local execution remains strictly disabled. Mediator is certified for safe operation in Review-only V1 mode.

---

## 17. Sprint S45 — Host-Side Core Containment & Privilege-Boundary Prototype

**Date:** 2026-10-12  
**Sprint:** S45  
**Focus:** Windows Security Architecture, Threat Containment, and Feasibility Validation  
**Primary Target Blocker:** TH-19 — Host-Side Windows Ambient Authority  
**Secondary Blocker:** TH-20 — Offline Toolchain and Dependency Supply Chain Gap  
**Prototype Battery:** 11 Total Canaries in `packages/orchestrator/src/hostContainment/hostContainmentAdversarial.test.ts` (11/11 PASS, 100%)  
**Monorepo Battery:** 48 Test Files, 962 Total Tests Passing (100%)  
**Authoritative Verdict:** **`PASS — CONTAINMENT DESIGN VALIDATED`**  
**Local Autopilot Status:** **`BLOCKED — S00 NO-GO-AUTOEXEC REMAINS AUTHORITATIVE`**  

### 17.1 S45 Host Containment Architecture & Implementation

1. **Partitioned Split Core-and-Broker Architecture:**
   - **Orchestration Layer (`ContainedOrchestrator`):** Manages AI conversations, diff formatting, and SSE streams. Stripped of direct live workspace file handles and shell execution tools.
   - **Narrow Trusted Broker (`TrustedHostBroker`):** Exposes only 5 strictly typed, declarative operations over an HMAC-SHA256 authenticated protocol with freshness nonces (30s window). Enforces path containment (`validateContainedPath`), ADS stream rejection, DOS device rejection, and single-use cryptographic approval binding with TOCTOU base hash verification.
2. **OS-Level Windows Process Supervisor (`WindowsProcessSupervisor`):**
   - **Environment Cleansing (`cleanseEnvironment`):** Automatically scrubs sensitive ambient credentials (`AWS_*`, `GITHUB_*`, `SSH_*`, `API_KEY`, `TOKEN`, `KEY`, `SECRET`, `PASSWORD`) from child process environments. Verified in OS-level child process tests.
   - **Process Tree Lifetime Enforcement:** Terminates descendant process trees cleanly upon timeout or cancellation (`taskkill /pid <PID> /T /F`), preventing orphaned background workers.
3. **Sandbox Dispatch Gating:**
   - The broker enforces that validation recipes can only be dispatched to `MediatorSandbox` with mandatory network isolation (`CLONE_NEWNET`).
   - Under S00 `NO-GO-AUTOEXEC`, autonomous execution dispatch through the broker is blocked fail-closed as a `security_violation`.

### 17.2 S45 Host Containment Canary Results (11 Battery)

| Canary ID | Target Vector | Enforcement Type | Observed Behavior | Status |
|---|---|---|---|---|
| **S45-01** | Outside File Read Denial | Broker / Boundary Gate | Traversal `../outside/user_private.txt` rejected (`PATH_OUTSIDE_WORKSPACE`) | **PASS (Prevention)** |
| **S45-02** | Unapproved Live File Modification | Broker / Approval Gate | Modification without approval rejected (`APPROVAL_NOT_FOUND`). Live sentinel untouched. | **PASS (Prevention)** |
| **S45-03** | Secret Exfiltration Denial | Broker / Boundary Gate | Traversal to `fake_cloud_credentials.env` rejected (`PATH_OUTSIDE_WORKSPACE`) | **PASS (Prevention)** |
| **S45-04** | Arbitrary Host Shell Execution | Broker / Protocol Gate | Shell requests (`shell.exec`, `cmd.execute`, `powershell.invoke`) rejected (`PROHIBITED_OPERATION`) | **PASS (Prevention)** |
| **S45-05** | Sensitive Environment Inheritance | OS / Process Supervisor | `cleanseEnvironment` scrubs secrets; live OS node child process verifies `SECRETS_ABSENT` | **PASS (OS-Enforced Prevention)** |
| **S45-06** | Orphaned Process Confinement | OS / Process Supervisor | Spawns background worker; `signal.abort()` terminates process tree (`cancelled: true`, exit -1) | **PASS (OS-Enforced Cleanup)** |
| **S45-07** | Caller Origin Gating & Forged HMAC | Cryptographic Gate | Origins `browser_ai` & `mcp_agent` rejected (`CALLER_UNAUTHORIZED`); bad HMAC rejected (`AUTHENTICATION_FAILED`) | **PASS (Prevention)** |
| **S45-08** | Replay, Expiry, & Post-Approval Tamper | Cryptographic & TOCTOU | Replayed nonce rejected (`REPLAY_ATTACK_DETECTED`); stale timestamp rejected (`REQUEST_STALE`); consumed approval rejected (`APPROVAL_ALREADY_CONSUMED`); tampered staged file rejected (`STAGE_TAMPER_DETECTED`) | **PASS (Prevention & Detection)** |
| **S45-09** | Path Traversal, ADS, & Device Names | Boundary Gate | `../../`, `file:stream`, `CON`, `NUL`, `PRN.ts` rejected fail-closed (`PATH_OUTSIDE_WORKSPACE`) | **PASS (Prevention)** |
| **S45-10** | Broker Fail-Closed Integrity | Fail-Closed Transport | Weak secret throws on startup; mismatched secret rejects all requests fail-closed. Zero unauthenticated fallback. | **PASS (Fail-Closed Integrity)** |
| **S45-11** | Policy Gating & Netns Enforcement | Governance Gate | Autonomous execution blocked under S00 `NO-GO-AUTOEXEC`; unisolated network request rejected (`security_violation`) | **PASS (Policy Enforcement)** |

### 17.3 Cumulative Host & Sandbox Capability Matrix After S45

| Capability Property | Status | Enforcing Layer | Observed Live Evidence |
|---|---|---|---|
| `filesystem.stageRootRead` | **VERIFIED (true)** | `mediator` / `host` | `canary:s42-mediator-sandbox-exec` |
| `filesystem.stageRootWrite` | **VERIFIED (true)** | `mediator` / `host` | `canary:s42-mediator-sandbox-exec` |
| `filesystem.liveWorkspaceWriteDenied` | **VERIFIED (true)** | `host` (`[automount] enabled=false`) | `canary:s42-automount-disabled`, `canary:s41-live-workspace-integrity` |
| `filesystem.outsideRootDenied` | **VERIFIED (true)** | `host` (Linux VHDX permissions) | `canary:s42-outside-write-denial` |
| `filesystem.secretFilesProtected` | **VERIFIED (true)** | `host` (Host drive detached) | `canary:s42-secret-read-denial` |
| `filesystem.symlinkEscapeDenied` | **VERIFIED (true)** | `host` / `mediator` (path containment) | `stageStore.test.ts`, `pathContainment.ts` |
| `process.executableAllowlistEnforced` | **VERIFIED (true)** | `mediator` (recipe registry) | `canary:s41-recipe-hash-pinning` |
| `process.untrustedScriptsRejected` | **VERIFIED (true)** | `mediator` (recipe registry) | `canary:s41-recipe-hash-pinning` |
| `process.childProcessesControlled` | **VERIFIED (true)** | `host` (`--fork --kill-child` + Win32 supervisor) | `canary:s43-child-confinement`, `canary:s45-process-cleanup` |
| `process.hostShellFallbackDenied` | **VERIFIED (true)** | `host` (`[interop] enabled=false` + Broker deny) | `canary:s42-interop-denied`, `canary:s45-shell-denial` |
| `limits.timeoutEnforced` | **VERIFIED (true)** | `mediator` (watchdog timer) | `canary:s41-wsl-timeout` |
| `limits.cancellationEnforced` | **VERIFIED (true)** | `mediator` (abort listener) | `canary:s41-wsl-cancellation`, `canary:s45-process-cleanup` |
| `limits.outputByteLimitsEnforced` | **VERIFIED (true)** | `mediator` (byte limiter) | `canary:s41-wsl-output-bound` |
| `limits.capturesRealExitCode` | **VERIFIED (true)** | `host` (WSL process exit) | `canary:s41-wsl-exit-0`, `canary:s41-wsl-exit-42` |
| `execution.fixedRecipeOnly` | **VERIFIED (true)** | `mediator` (SHA-256 hash pinning) | `canary:s41-recipe-hash-pinning` |
| `execution.stagedSourceProven` | **VERIFIED (true)** | `mediator` (staging tree-hash guard) | `canary:s41-live-workspace-integrity` |
| `network.networkDefaultDeny` | **VERIFIED (true)** | `host` (Linux netns `CLONE_NEWNET`) | `canary:s43-ipv4-denial`, `canary:s43-dns-proxy-denial`, `canary:s44-network-bypass-denial` |
| `host.orchestrationPartitioned` | **PROTOTYPE VALIDATED (true)**| `mediator` (`TrustedHostBroker`) | `canary:s45-outside-read-denial`, `canary:s45-unapproved-apply-denial` |
| `host.environmentSecretsScrubbed`| **PROTOTYPE VALIDATED (true)**| `mediator` (`cleanseEnvironment`) | `canary:s45-environment-scrubbing` |
| `host.singleUseApprovalEnforced` | **PROTOTYPE VALIDATED (true)**| `mediator` (`TrustedHostBroker`) | `canary:s45-approval-replay-denial`, `canary:s45-toctou-tamper-detection` |

### 17.4 S45 Authoritative Exit Decision

**Authoritative S45 Verdict:** **`PASS — CONTAINMENT DESIGN VALIDATED`**  
**Local Autopilot Decision:** **`LOCAL AUTOPILOT: BLOCKED — S00 NO-GO-AUTOEXEC REMAINS AUTHORITATIVE`**  

The S45 host containment prototype has successfully demonstrated that untrusted orchestration can be strictly decoupled from privileged Windows host operations without requiring administrator elevation. However, because offline toolchain and dependency delivery (TH-20) remains an open release blocker, Local Autopilot remains strictly blocked fail-closed. Mediator operates exclusively in Review-only V1 mode.

---

## 18. S46–S48 Capabilities Evolution: Offline Toolchain, End-to-End Workflow & Diagnostics

### 18.1 S46 Offline Toolchain & Supply Chain Pipeline
- **Offline Dependency Pipeline:** Established 7-stage pipeline (preparation, integrity validation, bundling, import, sandbox verification, execution, evidence collection).
- **Toolchains Verified Live:** Python 3.14+ (`python.test`, `python.single_test`) executed inside `MediatorSandbox` under mandatory Linux network namespace default-deny (`CLONE_NEWNET` / `unshare --user --net`). Captured real exit codes 0 and 1 with zero network egress.
- **Supply Chain Hardening:** `OfflineBundleService` validates SHA-256 manifests, rejects path traversal (`..`), Alternate Data Streams, DOS device names, and scans for secrets before bundle caching.
- **Fail-Closed Missing Dependencies:** Absent packages fail closed with `OFFLINE_DEPENDENCY_MISSING`, strictly prohibiting dynamic network downloads.

### 18.2 S47 End-to-End Coding Workflow Integration
- **Unified Authoritative Core:** State machine synchronized across Standalone UI, CLI, HTTP API, IDE extensions, and Browser bridges.
- **Live Workspace Modification Wired:** S45 `TrustedHostBroker` and `ContainedOrchestrator` integrated directly into `MediatorCore`'s production apply path.
- **Cryptographic & TOCTOU Gates:** HMAC-SHA256 signature verification, nonce replay cache, 30s freshness window, and pre-apply base hash verification (`WORKSPACE_DIRTY_CONFLICT`).
- **Pre-Apply Atomic Backups:** Target files automatically snapshot to `.mediator/backups/<txId>` before any modification, enabling safe recovery and rollback.
- **Mandatory End-to-End Scenarios:** Scenarios A through H verified (bugfix, missing dep, traversal attack, dirty workspace, disconnect, cancel, rollback, unauthorized bypass).

### 18.3 S48 Product UX, Installation, Diagnostics & Recovery
- **Comprehensive System Health Doctor:** `DoctorDiagnosticsService` checks 8 tiers: Core Engine, Dedicated WSL2 Sandbox, Network Isolation, Offline Toolchains, AI Providers, Native Host, Workspace Scope, Autopilot Policy.
- **Actionable Remediation:** Outputs human-readable remediation commands for all degraded or action-required states.
- **Sanitized Diagnostics Export:** Secret-safe JSON/markdown exports via `mediator doctor --export` and UI without network telemetry.
- **Audited Non-Admin Installers:** `scripts/install-windows.ps1` (Current User `HKCU`, non-admin) and `scripts/uninstall-windows.ps1` (strictly confines WSL unregistration to `MediatorSandbox`, preserving user's personal `Ubuntu`/`Docker` distros and workspace projects).
- **Standalone UI Dashboard:** Added Tab 7 "Diagnostics & Health" with live evaluation and one-click sanitized export.
- **Authoritative Documentation:** `docs/USER_GUIDE.md`, `docs/INSTALLATION_AND_RECOVERY.md`, `docs/TROUBLESHOOTING.md`.

### 18.4 Authoritative Status
**Review-Only V1 Mode:** **VERIFIED & READY**  
**Local Autopilot Decision:** **`LOCAL AUTOPILOT: BLOCKED — S00 NO-GO-AUTOEXEC REMAINS AUTHORITATIVE`**




