# HOST PROCESS CONTAINMENT & BOUNDARY IMPLEMENTATION

**Document Status:** Complete & Verified (Sprint S49.1)  
**System Component:** `@mediator/orchestrator` (`TrustedHostBroker`, `ContainedOrchestrator`, `ProcessIsolatedBrokerTransport`, `brokerProcessHost`)  
**Target Environment:** Windows 11 Home, Standard User Account  
**Security Policy:** S00 `NO-GO-AUTOEXEC` remains authoritative  

---

## 1. Executive Summary & Objective

In S45–S48, host-side containment was modeled logically between `ContainedOrchestrator` and `TrustedHostBroker`. While module-level separation and cryptographic HMAC envelopes were implemented, both components operated within the same runtime process memory space in prior prototypes.

Under Sprint S49.1, Mediator bridges this gap by integrating **Process-Isolated Host Broker Transport** (`ProcessIsolatedBrokerTransport`), physically executing `TrustedHostBroker` in a distinct Windows child process (`brokerProcessHost.js`) with an isolated operating system PID, decoupled process heap, sanitized environment block, and standard I/O stream framing.

This document records the exact process topology, Windows OS privilege context, boundary enforcement mechanisms, adversarial test evidence, and honest operational limitations on Windows 11 Home standard user accounts.

---

## 2. Process Topology & Privilege Architecture

### 2.1 Process Diagram

```
+-----------------------------------------------------------------------------------+
| WINDOWS 11 HOST (Standard User Context: Token = Medium Mandatory Integrity Level)  |
|                                                                                   |
|  +-------------------------------------+        Stdio IPC (Framed JSON-Lines)    |
|  |       ContainedOrchestrator         | -------------------------------------+   |
|  |             (PID A)                 | <----------------------------------+ |   |
|  | - Lower-privilege task orchestration |                                    | |   |
|  | - Model response parsing             |                                    | |   |
|  | - No direct live workspace handles   |                                    | |   |
|  | - Generates HMAC-signed requests     |                                    | |   |
|  +-------------------------------------+                                    | |   |
|                                                                              | |   |
|                                                                              v |   |
|  +------------------------------------------------------------------------+  | |   |
|  |                TrustedHostBroker Process (`brokerProcessHost.js`)      |  | |   |
|  |                               (PID B != PID A)                         |  | |   |
|  | - Owns live workspace filesystem handles                              |  | |   |
|  | - Environment scrubbed: AWS/GH/SSH host secrets purged                 |  | |   |
|  | - Authoritative approval ledger (single-use, revision-bound)           |  | |   |
|  | - Strictly verifies HMAC-SHA256, 30s freshness, nonces, canonical paths |  | |   |
|  | - Arbitrary shell execution (`cmd.exe`, `powershell.exe`) prohibited     |  | |   |
|  +------------------------------------------------------------------------+  | |   |
|                                        |                                     | |   |
|                       WSL2 Interop     v (Default-Deny Network Isolation)     | |   |
|  +------------------------------------------------------------------------+  | |   |
|  | `MediatorSandbox` (WSL2 Dedicated Distro / `CLONE_NEWNET` Network Namespace)    | |
|  | - Unshare --user --net default-deny execution                          |  | |   |
|  | - Pinned offline recipes (Node.js / Python / Rust)                     |  | |   |
|  +------------------------------------------------------------------------+  | |   |
+-----------------------------------------------------------------------------------+
```

### 2.2 Process & Privilege Inventory

| Property | `ContainedOrchestrator` (PID A) | `TrustedHostBroker` Worker (PID B) | Enforcement Level |
| :--- | :--- | :--- | :--- |
| **OS Process ID** | Standalone Node.js process (PID A) | Standalone Node.js child (PID B) | **OS Kernel (Distinct PID & Heap)** |
| **Windows Token** | Medium Mandatory Integrity (Standard User) | Medium Mandatory Integrity (Standard User) | Same User Account Context |
| **Environment Block** | Standard inherited user environment | Sanitized: AWS, GH, SSH, GPG secrets stripped | **OS Process Creation Parameter** |
| **Workspace Access** | Shadow staging & read-only requests via broker | Authoritative live workspace handles & backups | Application & Architectural Contract |
| **Shell Invocation** | Cannot invoke host shell directly | Prohibits arbitrary shell commands (`cmd.exe`) | Application Typed Broker Schema |
| **Child Lifetime** | Supervisor process | Terminated via tree kill (`taskkill /T /F`) | **OS Process Supervisor / Tree Termination** |
| **IPC Mechanism** | Stdio pipe (`stdin`/`stdout`) | Stdio pipe (`stdin`/`stdout`) | **OS Anonymous Pipe Isolation** |

---

## 3. Real Windows Enforcement Mechanisms & Honest Boundary Limits

### 3.1 What OS-Level Isolation DOES Provide Here

1. **Distinct Address Space & Heap Isolation:**
   - PID A and PID B reside in separate virtual memory address spaces. Orchestrator code cannot accidentally read or mutate the in-memory approval ledger, HMAC keys, or open file buffers of the broker through pointer dereferencing or JavaScript runtime introspection.
2. **Environment Variable Scrubbing (`cleanseEnvironment`):**
   - When PID B is spawned, `windowsProcessSupervisor.ts` generates a scrubbed environment map where `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, and other developer host secrets are eliminated. Child processes of the broker do not inherit these credentials.
3. **Anonymous Pipe IPC vs Loopback TCP/Named Pipes:**
   - Communication uses standard input/output anonymous pipes created during `spawn`. No local TCP port is opened, preventing other non-administrative local processes from scanning or connecting to a network socket.
4. **OS-Enforced Lifetime & Process-Tree Cleanup:**
   - Broker shutdown or timeout triggers a recursive process-tree termination (`taskkill /T /F /PID`) ensuring orphaned broker workers cannot linger in the background.
5. **Fail-Closed Pipe Break:**
   - If the broker worker crashes or is killed, the pipe breaks and subsequent requests immediately fail closed with error code `BROKER_UNAVAILABLE`.

### 3.2 What OS-Level Isolation DOES NOT Provide (Standard User Boundary Reality)

> [!WARNING]
> **Windows Security Reality on Standard User Accounts:**
> Under the standard Windows security architecture, two processes running under the **same user security token (identical SID and Medium Integrity Level)** share equivalent OS DACL permissions.
> Specifically:
> - A malicious native binary running as the same standard user can inspect or attach to other processes of the same user using Windows debugging APIs (`OpenProcess` with `PROCESS_VM_READ`) unless running inside an isolated AppContainer or separate service account.
> - On Windows 11 Home, creating separate local user accounts or configuring AppContainers for arbitrary Node.js scripts requires administrator privileges and specialized packaging (MSIX / Windows Service), which conflicts with Mediator's standard-user zero-privilege installation invariant.
> - **Therefore: Mediator distinguishes Review-only V1 process-isolated memory separation from kernel DACL multi-user sandboxing.** The OS separation prevents inadvertent leakages, memory corruptions, and direct call-stack bypasses, while S00 `NO-GO-AUTOEXEC` and explicit cryptographic HMAC signatures enforce authorization boundaries.

---

## 4. Verification Evidence (Sprint S49.1 Test Matrix)

The test suite `packages/orchestrator/src/hostContainment/processIsolatedContainment.test.ts` exercises the real OS process boundary:

```
 RUN  v1.6.1 C:/Users/Atul2/OneDrive/Desktop/Mediator

 ✓ packages/orchestrator/src/hostContainment/processIsolatedContainment.test.ts > Sprint S49.1 — Host-Side Process Containment & Boundary Verification
   ✓ 1. establishes distinct OS process boundary with unique PID and separate memory (childPid != process.pid)
   ✓ 2. executes valid HMAC-signed queryWorkspace across process boundary
   ✓ 3. rejects forged HMAC signature across process boundary fail-closed (code: AUTHENTICATION_FAILED)
   ✓ 4. rejects replayed nonces across process boundary fail-closed (code: REPLAY_ATTACK_DETECTED)
   ✓ 5. rejects stale request timestamps across process boundary fail-closed (code: REQUEST_STALE)
   ✓ 6. strictly rejects prohibited arbitrary shell execution operations across process boundary (code: PROHIBITED_OPERATION)
   ✓ 7. stages proposals in shadow staging through isolated broker without modifying live files
   ✓ 8. strictly denies live apply without approval record across process boundary (code: APPROVAL_NOT_FOUND)
   ✓ 9. caller origin gating strictly prevents contained_orchestrator from applying live changes (code: APPROVAL_CALLER_UNAUTHORIZED)
   ✓ 10. fails closed with BROKER_UNAVAILABLE when broker process is terminated

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

Combined with S45 adversarial suite (`packages/orchestrator/src/hostContainment/hostContainmentAdversarial.test.ts`), **21/21 containment tests pass**.

---

## 5. Containment Invariant Guarantees

1. **Live Workspace Immutability:** Untrusted task orchestration code cannot directly alter live workspace files; modifications must be staged into shadow staging directories.
2. **Narrow Typed Schema:** The broker only accepts 5 typed operations: `workspace.status`, `workspace.read_snapshot`, `workspace.stage_proposal`, `workspace.apply_approved_stage`, and `sandbox.dispatch_recipe`. Generic shell execution (`cmd.exe`, `powershell.exe`) is rejected at schema validation.
3. **Cryptographic Binding & Freshness:** All requests require HMAC-SHA256 signatures, unique nonces cached with 5-minute TTL, and timestamps within a 30-second freshness window.
4. **Approval Single-Use & TOCTOU Verification:** Live apply requires a valid, pre-registered approval token tied to target files and exact base content hashes. Any post-staging modification invalidates the apply.
5. **Fail-Closed Lifetime:** Termination of the broker process triggers `BROKER_UNAVAILABLE` across all pending and subsequent operations.
