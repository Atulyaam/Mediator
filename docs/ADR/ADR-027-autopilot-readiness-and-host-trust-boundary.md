# ADR-027 — Autopilot Readiness, Host Trust Boundary & Release Governance Decision

**Date:** 2026-10-12  
**Status:** ACCEPTED (Decision: `LOCAL AUTOPILOT BLOCKED`; S00 `NO-GO-AUTOEXEC` Authoritative)  
**Sprint:** S44 Independent Security Readiness Review & Autopilot Governance Audit  
**Deciders:** Mediator Architecture & Safety Authority  

---

## 1. Context & Problem Statement

Following the completion of Sprint S43, Mediator demonstrated:
- A dedicated, standalone WSL2 execution sandbox (`MediatorSandbox`) with host drive automounting (`/mnt/c`) and Windows binary interop (`cmd.exe`) disabled.
- Full network egress denial enforced via unprivileged Linux network namespaces (`CLONE_NEWNET` via `unshare --user --net --map-root-user --fork --kill-child`).
- Thirty-one live OS canaries passing deterministically with real exit code capture, timeout, cancellation, and secret redaction.

Sprint S44 was chartered to conduct an independent security review of Mediator before any future consideration of autonomous local code execution.

The critical architectural question facing Mediator is:
*Does proving operating-system and network isolation inside `MediatorSandbox` justify unlocking or activating autonomous local code execution (Local Autopilot)?*

---

## 2. Evaluated Architectural Options

We evaluated three architectural options for release qualification and governance:

### Option A: Unlock Local Autopilot Based on S43 Sandbox Verification
- **Description:** Declare that because all 10 core capability fields in `SANDBOX_CAPABILITIES.md` are verified by live OS canaries, Mediator has proven sufficient isolation to activate autonomous code execution loops.
- **Evaluation & Risks:**
  1. *Host Process Ambient Authority:* Mediator Core executes on Windows as a standard user process. While the Linux VM protects the host from guest code, it provides zero protection if Mediator Core itself is compromised or manipulated via untrusted IPC.
  2. *Offline Toolchain Supply Chain Gap:* In a default-deny network environment, standard language toolchains cannot download dependencies dynamically (`npm install` or `pip install` fail). Bypassing this by re-enabling network access would destroy the isolation boundary and re-introduce exfiltration channels.
  3. *Prompt Injection Risk:* An autonomous coding loop that applies changes without human approval allows prompt-injected instructions to escalate across iterations.
- **Verdict:** **REJECTED AS UNACCEPTABLE SECURITY RISK.**

### Option B: Introduce an "Experimental" / "Debug" Autopilot Flag
- **Description:** Maintain `NO-GO-AUTOEXEC` as the default, but allow an environment variable, hidden CLI flag, or developer config to bypass the authorization gate.
- **Evaluation & Risks:**
  1. Violates Mediator's core governance rule: *"No temporary exceptions, hidden feature flags, debug routes, or test-only production bypasses."*
  2. Creates a fragile security boundary that can be accidentally enabled or targeted by malicious scripts.
- **Verdict:** **REJECTED AS VIOLATION OF FAIL-CLOSED GOVERNANCE.**

### Option C (Selected): Maintain Authoritative S00 `NO-GO-AUTOEXEC` — Autopilot Remains Strictly Blocked
- **Description:** Maintain S00 `NO-GO-AUTOEXEC` as absolute and authoritative. Keep Local Autopilot strictly `BLOCKED` fail-closed (`canRun: false`). Preserve Mediator in Review-only V1 mode, requiring human review and explicit approval for all workspace changes. Document the host ambient authority and offline toolchain gaps as formal prerequisites for any future architectural review.
- **Evaluation & Benefits:**
  1. *Guaranteed Safety:* Eliminates all risk of unattended host modification, secret leakage, or runaway autonomous loops.
  2. *High Practical Utility:* Mediator delivers full functionality as an assisted, human-in-the-loop pair programming bridge (multi-provider browser automation, shadow staging, unified diff review, and transactional apply-back).
  3. *Audit Integrity:* Adheres strictly to the principle of honest capability evaluation without manufacturing false claims.
- **Verdict:** **ACCEPTED.**

---

## 3. Decision & Invariants

1. **Local Autopilot Remains Strictly Blocked:**
   - The authoritative status of Local Autopilot is **`BLOCKED`** fail-closed.
   - Any attempt to toggle Autopilot on reports `status: 'blocked'`, `canRun: false`.
2. **S00 `NO-GO-AUTOEXEC` Remains Authoritative:**
   - The S00 feasibility decision remains `NO-GO-AUTOEXEC`.
   - `ExecutionAuthorizationGate` and `AutopilotGateEvaluator` fail closed on any request attempting automated execution.
3. **Review-Only V1 Mode Preserved:**
   - Mediator operates exclusively in Review-only mode.
   - All AI-generated proposals must be staged in shadow storage, inspected via diff, and explicitly approved by the user before being applied to the live project.
4. **Dedicated Sandbox Retained for Bounded Validation:**
   - `MediatorSandbox` remains provisioned and operational as an isolated environment for safe, manual or test recipe execution.
   - Network isolation on `MediatorSandbox` is mandatory; attempting to execute without network isolation is rejected fail-closed as a `security_violation` unless explicitly authorized by a dedicated canary test flag.
5. **No Automatic Transition to S45:**
   - Sprint S44 concludes the security review. No automated execution sprint may begin without a separate, explicit architectural authorization review.

---

## 4. Consequences & Follow-Up Requirements

### Positive Consequences:
- Zero risk of unattended workspace corruption or data exfiltration.
- Clear, honest, and tamper-evident capability boundaries.
- Complete regression coverage across 47 test files and 951 tests.

### Required Prerequisites Before Any Future Execution Authorization Review:
1. **Host-Side Process Confinement Architecture:** Design and evaluate mechanisms to bound the ambient authority of the Windows Mediator Core process (e.g., Windows AppContainer, low-privilege service account, or token privilege stripping).
2. **Offline Toolchain & Dependency Pipeline:** Design a secure, offline dependency ingestion mechanism (pre-bundled language environments or hash-verified offline caches) that operates without internet access.
3. **Dual-Key Human Authorization UX:** Establish a multi-factor or cryptographically signed approval protocol for sensitive validation recipes.
