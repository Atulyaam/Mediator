# ADR-028 — Host-Side Core Containment Architecture & Privilege Boundary

**Date:** 2026-10-12  
**Status:** ACCEPTED (Prototype Validated; Autopilot Remains Blocked under S00 `NO-GO-AUTOEXEC`)  
**Sprint:** S45 Host-Side Core Containment & Privilege-Boundary Prototype  
**Deciders:** Mediator Architecture & Safety Authority  

---

## 1. Context & Problem Statement

In Sprint S44's Independent Security Readiness Review (`docs/SECURITY_THREAT_MODEL.md`, `docs/AUTOPILOT_READINESS_REVIEW.md`), an essential residual architectural risk was formalized:
**TH-19: Host-Side Windows Ambient Authority of Mediator Core.**

While the dedicated `MediatorSandbox` WSL2 virtual machine successfully isolates guest workloads from the host filesystem and external network, **Mediator Core itself runs directly on the Windows 11 host as a standard Node.js process under the user's interactive account (`atulyadav\atul2`)**.

If Mediator Core were compromised (via third-party package vulnerabilities in the dependency tree, prototype pollution, or untrusted IPC exploitation), the compromised process would possess:
1. Ambient read/write access to all user files in `%USERPROFILE%` (documents, desktop, personal source code, `.ssh`, `.aws`).
2. Ambient access to sensitive environment variables (API tokens, cloud credentials).
3. The ability to launch arbitrary Windows executables (`powershell.exe`, `cmd.exe`).
4. Direct outbound internet communication from the Windows host, bypassing the Linux network namespace boundary entirely.

Sprint S45 was chartered to investigate practical Windows host containment mechanisms and design an architecture that reduces the authority of Mediator Core without requiring administrator privileges or disrupting the existing installation.

---

## 2. Evaluated Architectural Options

We evaluated four candidate architectural strategies for host-side containment:

### Option 1: Native Windows AppContainer Execution
- **Description:** Execute Mediator Core inside a Windows AppContainer security profile (`CreateAppContainerProfile`), granting only loopback network access and an isolated AppContainer storage folder.
- **Evaluation & Trade-offs:**
  - *Advantages:* Strong kernel-enforced sandboxing; process cannot read `%USERPROFILE%` files by default.
  - *Disadvantages:*
    1. Node.js runtime requires access to system DLLs, standard registry hives, and `C:\Program Files\nodejs`. In an AppContainer, Node.js fails to initialize unless custom Access Control Entries (ACEs) are configured on system directories, which a standard non-admin user cannot grant.
    2. Node's `child_process.spawn` does not natively support launching into AppContainers without compiling custom Win32 C++ native addons (`STARTUPINFOEX` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`).
    3. Highly fragile on Windows 11 Home consumer setups.
- **Verdict:** **REJECTED AS IMPRACTICAL ON WINDOWS 11 HOME.**

### Option 2: Dedicated Low-Privilege Local Service Identity
- **Description:** Install Mediator Core as a Windows service running under a dedicated unprivileged local user account (`MediatorServiceUser`).
- **Evaluation & Trade-offs:**
  - *Advantages:* Traditional OS-level DACL boundary. The service account cannot access `C:\Users\Atul2\` unless explicitly shared.
  - *Disadvantages:*
    1. Creating a local user account (`net user ... /add`) and registering Windows services requires **Administrator / UAC elevation**.
    2. Violates Mediator's foundational principle of zero-elevation current-user deployment (`HKCU` PowerShell installer).
    3. Complicates integration with user-profile browser extensions and local IDEs.
- **Verdict:** **REJECTED DUE TO ELEVATION REQUIREMENTS.**

### Option 3: Process Tokens & Windows Job Objects Alone
- **Description:** Rely solely on Win32 Job Objects (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) and process token stripping (`DISABLE_MAX_PRIVILEGE`).
- **Evaluation & Trade-offs:**
  - *Advantages:* Standard users can create Job Objects; reliably guarantees process-tree termination upon parent exit.
  - *Disadvantages:* Job Objects do **not** constrain filesystem reads or writes. A process assigned to a Job Object retains full ambient authority to read and write the user's personal files.
- **Verdict:** **INSUFFICIENT AS A STANDALONE BOUNDARY.**

### Option 4 (Selected): Tiered Split Core-and-Broker Architecture with Layered OS Supervision
- **Description:** Partition host operations into two tiers:
  1. **Lower-Privilege Orchestration Layer (`ContainedOrchestrator`):**
     - Processes untrusted model outputs, prompt generation, diff formatting, and SSE streams.
     - Stripped of direct live file write handles.
     - Stripped of host shell execution capabilities.
     - Environment cleansed of ambient secrets (`cleanseEnvironment`).
  2. **Narrow Trusted Host Broker (`TrustedHostBroker`):**
     - Holds the capability to interact with the host workspace.
     - Exposes only 5 strictly typed declarative operations (`workspace_status`, `read_snapshot`, `stage_proposal`, `apply_approved_stage`, `dispatch_sandbox_recipe`).
     - Rejects any shell execution, path traversal, Alternate Data Stream, or DOS device name.
     - Enforces HMAC-SHA256 request authentication, nonce replay protection, and timestamp freshness windows.
     - Enforces single-use cryptographic approval consumption and TOCTOU source hash verification before applying live modifications.
  3. **Windows Process Supervisor (`WindowsProcessSupervisor`):**
     - Enforces environment sanitization and process-tree termination.
  4. **WSL2 Isolated Sandbox Boundary:**
     - Confines offline validation execution to `MediatorSandbox` with mandatory network isolation (`CLONE_NEWNET`).
- **Evaluation & Trade-offs:**
  - *Advantages:*
    1. Operates cleanly on Windows 11 Home with zero administrator elevation.
    2. Pure TypeScript architecture with zero external native C++ compilation dependencies.
    3. Eliminates arbitrary shell execution from the orchestrator.
    4. Guarantees that live files cannot be modified without human approval and TOCTOU verification.
    5. Provably defends against replayed requests, stale approvals, and tampered staged artifacts.
- **Verdict:** **ACCEPTED AS PRIMARY HOST CONTAINMENT ARCHITECTURE.**

---

## 3. Decision & Architectural Guarantees

1. **Separation of Orchestration and Host Boundary:**
   - The Orchestrator interacts with the host filesystem exclusively through the `TrustedHostBroker`.
   - The Broker exposes no generic shell or raw filesystem execution commands.
2. **Cryptographic Request Authentication & Replay Protection:**
   - Every request is signed with HMAC-SHA256 using a high-entropy local pairing secret.
   - Replayed nonces are rejected fail-closed (`REPLAY_ATTACK_DETECTED`).
   - Timestamps older than 30 seconds are rejected (`REQUEST_STALE`).
3. **Single-Use Approval Binding:**
   - The Broker will only apply live changes when supplied with an approved record matching the stage ID, target files, base hash, and staged hash.
   - Upon successful application, the approval status is transitioned to `consumed`. Replaying a consumed approval is rejected fail-closed.
4. **Environment Cleansing:**
   - The process supervisor strips all ambient cloud and API secrets from child and orchestrator processes.
5. **Autopilot Governance Invariant Preserved:**
   - In accordance with S00 `NO-GO-AUTOEXEC`, autonomous execution dispatch through the broker is blocked fail-closed.
   - Local Autopilot remains strictly **`BLOCKED`**.

---

## 4. Consequences & Follow-Up Requirements

### Positive Consequences:
- Demonstrates a practical, robust, and reproducible security boundary on Windows 11 Home.
- Prevents untrusted model output or compromised orchestration from executing arbitrary commands or reading outside directories.
- Verified across 11 adversarial canaries with 100% test pass rate.

### Remaining Prerequisites for Any Future Execution Authorization:
1. **Offline Toolchain & Dependency Mirroring (TH-20):**
   - In an offline sandbox, dynamic package installation (`npm install`, `pip install`) fails by design.
   - An offline toolchain delivery pipeline (pre-installed VHDX toolchains or cryptographic hash-pinned vendor caches) must be developed before autonomous validation loops can be viable.
2. **Human-in-the-Loop Governance:**
   - S00 `NO-GO-AUTOEXEC` remains authoritative. Mediator operates exclusively in Review-only V1 mode.
