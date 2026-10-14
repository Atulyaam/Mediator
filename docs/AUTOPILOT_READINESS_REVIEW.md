# Autopilot Readiness Review & Governance Audit

**Version:** 1.0 (Sprint S44 Independent Review)  
**Date:** 2026-10-12  
**Status:** COMPLETE — GOVERNANCE AUDIT REPORT  
**Authoritative Verdict:** **AUTOPILOT REMAINS BLOCKED (S00 NO-GO-AUTOEXEC AUTHORITATIVE)**  
**Operating Mode:** Review-only V1  

---

## 1. Executive Governance Summary

Sprint S44 conducted an independent, architectural, and adversarial audit of Mediator's execution authorization gate, capability evaluation pipeline, sandbox isolation mechanisms, and supply chain prerequisites to determine whether autonomous local code execution (Autopilot) could be safely considered.

### Authoritative Finding:
**Local Autopilot CANNOT and MUST NOT be enabled.**
While the dedicated `MediatorSandbox` WSL2 environment successfully enforces Linux network namespace isolation (`CLONE_NEWNET`), host drive detachment (`[automount] enabled=false`), and process supervision (`--kill-child`), multiple critical architectural blockers and residual risks preclude autonomous execution at this time:

1. **Host-Side Windows Ambient Authority:** Mediator Core executes on Windows under the logged-in user context. The Linux sandbox isolates the guest; it does not isolate the host Node.js process itself from the host environment.
2. **Offline Toolchain & Dependency Supply Chain Gap:** In an offline sandbox with complete network default-deny, compilers, package managers, and dependencies cannot be dynamically fetched (`npm install`, `pip install`, `cargo fetch` fail by design). A trusted, offline, hash-pinned package delivery mechanism has not yet been designed or implemented.
3. **Absence of Dual-Key Human Oversight:** Allowing autonomous execution without per-action human review introduces prompt-injection and model-hallucination escalation risks that cannot be mitigated by sandbox isolation alone.

**Authoritative Decision:** **`LOCAL AUTOPILOT: BLOCKED — S00 NO-GO-AUTOEXEC REMAINS AUTHORITATIVE`**

---

## 2. Comprehensive Execution-Readiness Criterion Audit

| Criterion ID | Evaluation Criterion | Architectural Requirement | Observed Implementation Status | Evaluation Result | Evidence Reference |
|---|---|---|---|---|---|
| **CRIT-01** | **Default Inactivity** | Autopilot must be disabled by default on startup. | `MediatorCore.autopilotEnabled` defaults to `false`. Initial state is `'off'`. | **SATISFIED** | `mediatorCore.ts` L656, `mediatorCore.test.ts` |
| **CRIT-02** | **Capability Separation** | Provider Conversation Loop and Autopilot must be independently controlled. | `toggleLoop` and `toggleAutopilot` operate separate state variables. Loop operates without Autopilot. | **SATISFIED** | `mediatorCore.ts` L618, L663; `crossInterface.test.ts` |
| **CRIT-03** | **S00 Policy Primacy** | No CLI flag, env var, database state, IPC, or UI toggle can bypass S00 `NO-GO-AUTOEXEC`. | `ExecutionAuthorizationGate` and `AutopilotGateEvaluator` fail closed on `NO-GO-AUTOEXEC`. | **SATISFIED** | `executionAuthorizationGate.ts` L64; `autopilotGate.ts` L58 |
| **CRIT-04** | **Anti-Self-Authorization** | AI models, browser extensions, or MCP tools cannot self-authorize execution or approvals. | Caller origins `browser_ai` and `mcp_agent` strictly rejected by gate. | **SATISFIED** | `executionAuthorizationGate.ts` L75; `mcpServer.test.ts` |
| **CRIT-05** | **Cryptographic Recipe Pinning** | Only pre-registered, SHA-256 hash-pinned recipes can execute; arbitrary commands rejected. | `trustedRecipes.definitionHash !== request.recipeHash` fails closed. Shell operators rejected. | **SATISFIED** | `wslIsolatedExecutor.ts` L197; `executionAuthorizationGate.ts` L176 |
| **CRIT-06** | **Live Workspace Detachment** | Untrusted tasks must never execute in or mount live workspace. | `MediatorSandbox` `/etc/wsl.conf` has `[automount] enabled=false`; pre/post tree hashes verified. | **SATISFIED** | `canary:s42-automount-disabled`; `canary:s41-live-workspace-integrity` |
| **CRIT-07** | **Host Binary Interop Detachment** | Linux tasks must not invoke Windows binaries (`cmd.exe`). | `[interop] enabled=false, appendWindowsPath=false` in `/etc/wsl.conf`. | **SATISFIED** | `canary:s42-interop-denied` |
| **CRIT-08** | **Guest Privilege Containment** | Task runs as unprivileged user with zero root/sudo access. | `mediator-runner` (UID 1500) created without sudoer entry. | **SATISFIED** | `canary:s42-privilege-denial` |
| **CRIT-09** | **Network Default-Deny** | Task execution environment must block all network egress. | `unshare --user --net` creates private netns; zero external interfaces; DNS proxy alias absent. | **SATISFIED** | `canary:s43-ipv4-denial`; `canary:s43-dns-proxy-denial` |
| **CRIT-10** | **Process Lifecycle & Cleanup** | Child processes confined; orphaned processes killed on exit. | `--fork --kill-child` propagates SIGKILL; Windows supervisor uses Win32 `taskkill /pid <PID> /T /F`. | **SATISFIED** | `canary:s43-child-confinement`; `canary:s41-wsl-timeout` |
| **CRIT-11** | **Deterministic Exit Code Capture** | Supervisor must capture real process exit codes without guest trust. | WSL process exit code captured directly by Windows supervisor. | **SATISFIED** | `canary:s41-wsl-exit-0`; `canary:s41-wsl-exit-42` |
| **CRIT-12** | **Single-Use Approval Binding** | Approvals must be bound to specific payload hash and expire after TTL. | Approvals single-use; replayed tokens rejected; payload hash verified. | **SATISFIED** | `applyService.test.ts`; `persistence.test.ts` |
| **CRIT-13** | **Fail-Closed Revocation** | Any capability loss or conflict revokes eligibility immediately. | `checkImmediateRevocation` monitors capability signals; immediately revokes. | **SATISFIED** | `autopilotGate.ts` L171; `autopilotGate.test.ts` |
| **CRIT-14** | **Host Process Security Sandbox** | Windows host Mediator process must be protected from ambient compromise. | S45 implemented and validated Tiered Split Core & Broker architecture (`TrustedHostBroker`, `cleanseEnvironment`); 11 adversarial canaries PASS in `hostContainmentAdversarial.test.ts`. | **PROTOTYPE VALIDATED** | ADR-028, `docs/HOST_CORE_CONTAINMENT_REVIEW.md`, Threat Model TH-19 |
| **CRIT-15** | **Offline Toolchain & Supply Chain** | Offline sandbox must have verified toolchains and dependencies without internet. | Sandbox is completely offline; dynamic `npm/pip` downloads blocked; offline toolchain pipeline unbuilt. | **NOT SATISFIED (RELEASE BLOCKER)** | Threat Model TH-20 |

---

## 3. Detailed Walkthrough of the Authorization Pipeline

We traced every execution request from UI trigger to operating system invocation:

```
[User UI / CLI Request: "toggleAutopilot(true)"]
               │
               v
[MediatorCore.recomputeAutopilotStatus()]
               │
               ├──> [AutopilotGateEvaluator.evaluateEligibility()]
               │         │
               │         ├──> Check: input.s00Decision === 'NO-GO-AUTOEXEC'?
               │         │         └──> YES: Add blockingReason: "Authoritative S00 decision is NO-GO-AUTOEXEC"
               │         │                   Status: "deferred", isEligible: false
               │         │
               │         └──> Check: input.userOptInSetting === true?
               │                   └──> Add blockingReason: "User opt-in alone cannot authorize execution when security gates are unverified"
               │
               v
[MediatorCore.autopilotStatus = 'blocked', canRun = false]
               │
[Execute Recipe Invocation Attempt via ApprovedExecutionPathService]
               │
               v
[ExecutionAuthorizationGate.authorize()]
               │
               ├──> Step 1: Check s00Decision === GO_IDE or GO_WSL2?
               │         └──> FAILS: Returns ErrorCode.EXECUTION_UNAVAILABLE
               │
               └──> Immediate Return: execution-unavailable
                     (ZERO process spawned; ZERO shell call executed)
```

**Verification Finding:**
There is NO code path in Mediator Core that invokes `WslIsolatedExecutor` automatically.
`WslIsolatedExecutor` is invoked solely by the automated test harness (`wslSandboxCanaries.test.ts`).
In production, `ApprovedExecutionPathService` rejects automatic execution requests and returns safe, copyable command suggestions for manual execution by the user in their IDE terminal.

---

## 4. Offline Toolchain & Supply Chain Analysis

Because Sprint S43 conclusively proved that network egress is blocked in `MediatorSandbox` (Canaries 23–31), any practical autonomous coding workflow encounters an immediate physical constraint:

### 4.1 The Dependency Dilemma
- Real-world coding tasks require language compilers and package dependencies:
  - TypeScript/Node projects require `node`, `npm`, `tsc`, `vitest`, `eslint`, and project-specific `node_modules`.
  - Python projects require `python3`, `pytest`, `pip`, and virtual environments.
  - Rust/Go/C++ projects require compilers and build tools.
- If a task generated by an AI provider introduces a new import (`import { z } from 'zod'`) or runs `npm test`:
  - `npm test` requires existing `node_modules`.
  - `npm install` requires outbound HTTP/HTTPS access to `registry.npmjs.org`.
  - Under `unshare --net`, any outbound connection immediately fails with `ENETUNREACH` (errno 101).

### 4.2 Why Network Access Must NOT Be Re-Enabled
A naive suggestion might be: *"Temporarily allow network access during package installation."*
This must be **strictly rejected**:
1. Untrusted AI code or malicious packages could execute arbitrary preinstall scripts (`package.json` `scripts.preinstall`) with outbound network access.
2. An attacker could exfiltrate host or repository secrets during the build phase.
3. It violates the core invariant: **untrusted execution must occur in a default-deny network environment.**

### 4.3 Prerequisites for a Safe Offline Toolchain Pipeline
Before any autonomous validation recipe could be supported, Mediator would need:
1. **Curated, Pre-Installed Toolchain Images:** Compilers and test runners pre-installed inside the VHDX rootfs during the privileged administrator provisioning step.
2. **Offline Dependency Mirroring:** Staging dependencies into the task workspace from an offline host cache (e.g. pre-fetched wheels or a validated vendor tarball), verified against a hash-pinned lockfile.
3. **Hermetic Build Verification:** Proof that tests execute 100% offline without network fallbacks.

Because this offline toolchain pipeline does not yet exist, autonomous execution remains physically non-viable for complex tasks.

---

## 5. Formal Governance Recommendation & Conclusion

### Summary of Audit Status:
- **Sandbox Boundary:** VERIFIED (VHDX isolation, non-root runner, no automount, no interop).
- **Network Egress Boundary:** VERIFIED (Linux network namespaces, DNS tunneling blocked).
- **Authorization & Gating Boundary:** VERIFIED (Fail-closed on S00 `NO-GO-AUTOEXEC`, no AI self-authorization).
- **Host Process Isolation:** PROTOTYPE VALIDATED (S45 Tiered Split Core & Broker architecture validated in 11 canaries; production rollout pending).
- **Offline Toolchain Supply Chain:** UNRESOLVED GAP / RELEASE BLOCKER (Offline package delivery unbuilt).

### Authoritative Governance Recommendation:
1. **Maintain S00 `NO-GO-AUTOEXEC` Invariant:**
   Local Autopilot must remain **`BLOCKED`** fail-closed.
2. **Preserve Review-Only V1 Mode:**
   Mediator provides substantial, real-world value as a structured, assisted coding platform: AI prompt formatting, same-chat browser automation, shadow staging, unified diff visualization, and manual approval gating.
3. **Require Architectural Authorization Sprint:**
   Any future consideration of autonomous code execution must be preceded by an explicit, dedicated authorization sprint that resolves the host trust boundary and offline toolchain delivery pipeline.
