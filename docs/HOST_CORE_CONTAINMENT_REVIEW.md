# Mediator Host-Side Core Containment & Privilege-Boundary Review

**Sprint:** S45 Host-Side Core Containment & Privilege-Boundary Prototype  
**Date:** 2026-10-12  
**Status:** COMPLETED — CONTAINMENT DESIGN VALIDATED  
**Primary Target Blocker:** TH-19 — Host-Side Windows Ambient Authority  
**Secondary Blocker:** TH-20 — Offline Toolchain and Dependency Supply Chain Gap  
**Authoritative Policy:** S00 `NO-GO-AUTOEXEC` Remains Authoritative  
**Local Autopilot State:** `BLOCKED` fail-closed  

---

## 1. Executive Summary

Sprint S45 investigated the fundamental trust boundary between the Windows host operating system and Mediator Core.

While Sprint S43 conclusively proved Linux network namespace isolation (`CLONE_NEWNET`), host drive detachment (`[automount] enabled=false`), and process supervision (`--kill-child`) inside the dedicated `MediatorSandbox` WSL2 virtual machine, Sprint S44 identified that **Mediator Core itself executes as a standard Node.js process under the logged-in Windows user account (`atulyadav\atul2`, SID `S-1-5-21-677798973-984577126-3376073714-1003`)**.

Consequently, the Linux VM isolates the host from the guest; it does **not** isolate the host Node.js process from the user's personal host environment. If Mediator Core were compromised (via third-party dependency vulnerabilities, malicious IPC, or memory corruption), it would inherit the user's ambient authority over files, credentials, and network sockets.

Sprint S45 designed, implemented, and empirically validated a **Tiered Host Containment Architecture** featuring a **Split Core-and-Broker Model**, an **OS-Level Windows Process Supervisor**, and a **Strict Cryptographic Protocol**.

### Core Verdict:
**PASS — CONTAINMENT DESIGN VALIDATED.**
A defensible host security boundary has been demonstrated with reproducible OS-level evidence across 11 adversarial canaries. However, because offline toolchain delivery (TH-20) remains unresolved and Windows Home lacks native unprivileged AppContainer wrappers in pure Node.js, **Local Autopilot remains strictly `BLOCKED` fail-closed under S00 `NO-GO-AUTOEXEC`**. Mediator operates exclusively in Review-only V1 mode.

---

## 2. Windows 11 Host Environment Discovery & Ambient Authority

Diagnostics conducted on the live host environment established the authoritative baseline:

| Attribute | Observed Host Value | Security Significance |
|---|---|---|
| **OS Platform** | Windows NT 10.0.26300.0 (Windows 11 Home / 26H2) | Standard consumer edition; Windows Sandbox and Group Policy features unavailable. |
| **User Identity** | `atulyadav\atul2` | Standard non-elevated interactive user. |
| **User SID** | `S-1-5-21-677798973-984577126-3376073714-1003` | Security identifier governing NTFS file permissions. |
| **Token Privileges** | `SeChangeNotifyPrivilege` Enabled; `SeShutdownPrivilege`, `SeUndockPrivilege`, `SeIncreaseWorkingSetPrivilege`, `SeTimeZonePrivilege` Disabled. | Zero elevated privileges. `SeDebugPrivilege` and `SeAssignPrimaryTokenPrivilege` are completely absent. |
| **Node.js Runtime** | v24.13.0 (x64) | Executes with standard user ambient authority. |
| **File Permissions** | Ambient read/write access to `%USERPROFILE%` (`Documents`, `Desktop`, `OneDrive`, `.ssh`, `.aws`). | A compromised Node process can read user secrets without elevation unless partitioned. |

### Attack Vectors Targeting Host Ambient Authority:
1. **Malicious Model / Prompt-Injected Payload:** AI provider proposes code attempting to traverse outside project workspace or access `.env` files.
2. **Third-Party Dependency Compromise:** Malicious package in `node_modules` attempting to scan `%USERPROFILE%` or spawn background daemons.
3. **Local Loopback Hijacking:** Other unprivileged local software probing `127.0.0.1:23456` attempting to invoke file-writing operations.

---

## 3. Comparative Evaluation of Windows Containment Mechanisms

We evaluated five architectural containment approaches on Windows 11 Home under a standard user account:

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              WINDOWS CONTAINMENT FEASIBILITY MATRIX                                    │
├─────────────────────────┬──────────────────────────┬──────────────────────────┬────────────────────────┤
│ Approach                │ What It Protects         │ What It Cannot Protect   │ Windows Home Feasibility│
├─────────────────────────┼──────────────────────────┼──────────────────────────┼────────────────────────┤
│ 1. Windows AppContainer │ Blocks access to user    │ Requires C++ FFI / native│ ⚠️ Complex / Fragile;  │
│    (Restricted SID)     │ profile, files, registry,│ launcher; breaks Node.js │ Node requires system   │
│                         │ and network by default.  │ module and Winsock loading.│ DLLs not accessible.  │
├─────────────────────────┼──────────────────────────┼──────────────────────────┼────────────────────────┤
│ 2. Dedicated Low-Priv   │ OS DACL separation       │ Requires Administrator   │ ❌ Incompatible with   │
│    Windows Account      │ between user and service.│ elevation (`runas` / UAC)│ standard non-admin     │
│                         │                          │ to create user & services.│ Home user account.     │
├─────────────────────────┼──────────────────────────┼──────────────────────────┼────────────────────────┤
│ 3. Process Tokens &     │ Enforces process tree    │ Does NOT restrict NTFS   │ ✅ Fully supported;    │
│    Win32 Job Objects    │ termination; caps memory │ reads/writes; does not   │ standard users can     │
│                         │ and active process count.│ block outbound network.  │ create Job Objects.    │
├─────────────────────────┼──────────────────────────┼──────────────────────────┼────────────────────────┤
│ 4. Split Core & Broker  │ Strips direct live write │ Does not isolate Node's  │ ✅ Fully portable, pure│
│    Architecture         │ authority; enforces path │ internal memory space;   │ TypeScript, 100% fail- │
│                         │ containment & approvals. │ requires trusted broker. │ closed, zero elevation.│
├─────────────────────────┼──────────────────────────┼──────────────────────────┼────────────────────────┤
│ 5. Layered Architecture │ Combines (3) and (4)     │ Does not solve offline   │ ✅ SELECTED OPTION:    │
│    (Layered Defense)    │ with env secret scrubbing│ package delivery (TH-20).│ High security & zero   │
│                         │ and WSL2 netns isolation.│                          │ administrator friction.│
└─────────────────────────┴──────────────────────────┴──────────────────────────┴────────────────────────┘
```

### Detailed Evaluation:

#### Approach 1: Windows AppContainer
- *Mechanism:* `CreateAppContainerProfile`, `CreateProcessW` with `STARTUPINFOEX` and `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`.
- *Pros:* Kernel-enforced isolation. AppContainer processes cannot read user files or bind sockets without explicit capabilities.
- *Cons:* Standard Node.js crashes when launched in a strict AppContainer because it cannot read standard registry keys, temp directories, or system DLLs unless custom ACLs are granted across `C:\Program Files\nodejs`. Standard Windows users cannot grant global ACLs on system folders. Requires custom C++ native binary.

#### Approach 2: Dedicated Low-Privilege Local Account
- *Mechanism:* Create `MediatorRunner` account with restricted NTFS ACLs.
- *Pros:* Standard Windows DACL security boundary.
- *Cons:* Creating a local account (`net user`) and setting up Windows Services requires **Administrator / UAC elevation**. Mediator's core design invariant is zero-elevation current-user execution (`HKCU`). Rejected.

#### Approach 3: Windows Job Objects & Process Tokens
- *Mechanism:* `CreateJobObjectW` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
- *Pros:* Standard users can create Job Objects. Guarantees that child processes cannot detach or outlive their parent.
- *Cons:* Job Objects do **not** constrain filesystem access. A process in a Job Object can still read `C:\Users\Atul2\.ssh\id_rsa`. Must be combined with application-level broker boundaries.

#### Approach 4 & 5 (Selected): Layered Split Core-and-Broker Architecture
- *Mechanism:*
  1. **Orchestration Process (Contained Core):** Manages AI sessions, SSE streaming, diff generation. Stripped of direct live file write handles. Operates in a sanitized environment where host secrets are scrubbed.
  2. **Narrow Trusted Host Broker:** Exposes only 5 strictly typed, declarative operations over an HMAC-SHA256 authenticated protocol with nonce replay protection and timestamp freshness. Enforces `@mediator/workspace-boundary` path containment, Alternate Data Stream rejection, and single-use cryptographic approval consumption.
  3. **Windows Process Supervisor:** Enforces environment scrubbing and process-tree termination.
  4. **WSL2 Isolated Sandbox:** Dedicated `MediatorSandbox` with `unshare --net` for offline validation.

---

## 4. Prototype Implementation & Architecture

The prototype is implemented in `packages/orchestrator/src/hostContainment/`:

```
┌────────────────────────────────────────────────────────────────────────┐
│ WINDOWS HOST (User Security Context: standard user "Atul2")            │
│                                                                        │
│  [Web AI Providers]       [User UI / CLI]       [Browser Extension]    │
│         │                        │                        │            │
│         v                        v                        v            │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ LOWER-PRIVILEGE ORCHESTRATION LAYER (ContainedOrchestrator)      │  │
│  │ - Environment cleansed of host secrets (cleanseEnvironment)      │  │
│  │ - Manages prompt formatting, diff generation, task lifecycle     │  │
│  │ - Holds ZERO write handles to live workspace                     │  │
│  │ - Holds ZERO generic shell execution tools                       │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                  │                                     │
│                     Framed Local Protocol (HMAC)                       │
│                     (Nonce + Freshness + Origin Gating)                │
│                                  │                                     │
│                                  v                                     │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ NARROW TRUSTED HOST BROKER (TrustedHostBroker)                   │  │
│  │  Allowed Operations (5 Only):                                    │  │
│  │   1. broker.workspace_status     (validate confirmed root)       │  │
│  │   2. broker.read_snapshot        (contained path read only)      │  │
│  │   3. broker.stage_proposal       (write to shadow staging ONLY)  │  │
│  │   4. broker.apply_approved_stage (requires bound user approval)  │  │
│  │   5. broker.dispatch_sandbox     (MediatorSandbox + netns ONLY)  │  │
│  │                                                                  │  │
│  │  Enforces:                                                       │  │
│  │   - validateContainedPath (pathContainment.ts)                   │  │
│  │   - ADS rejection (:stream) & DOS device rejection (CON, NUL)    │  │
│  │   - Single-use approval consumption & TOCTOU hash verification   │  │
│  │   - S00 NO-GO-AUTOEXEC fail-closed policy gating                 │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│            │                                       │                   │
│            v                                       v                   │
│  [Shadow Staging Dir]                    [Live Project Workspace]      │
│  (%TEMP%/shadow-staging)                 (C:\Users\Atul2\...\project)  │
│  (Isolated Proposals)                    (Atomic Apply AFTER Approval) │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Adversarial Verification Matrix (11 Canaries)

The prototype was tested against real Windows 11 behavior in `hostContainmentAdversarial.test.ts`. All 11 canaries passed:

| Canary ID | Canary Description | Enforcement Level | Observed Behavior | Verdict |
|---|---|---|---|---|
| **Canary 1** | Read synthetic files outside permitted workspace area | Application / Broker | Traversal attempt `../outside/user_private.txt` rejected with `PATH_OUTSIDE_WORKSPACE`. | **PASS (Prevention)** |
| **Canary 2** | Modify synthetic protected live files without approval | Application / Broker | Unapproved apply rejected with `APPROVAL_NOT_FOUND`. Live sentinel unaltered. | **PASS (Prevention)** |
| **Canary 3** | Read synthetic secret placed outside boundary | Application / Broker | Path `../../outside/fake_cloud_credentials.env` rejected with `PATH_OUTSIDE_WORKSPACE`. | **PASS (Prevention)** |
| **Canary 4** | Launch arbitrary host shell commands via broker | Application / Broker | Shell requests (`shell.exec`, `cmd.execute`, `powershell.invoke`) rejected with `PROHIBITED_OPERATION`. | **PASS (Prevention)** |
| **Canary 5** | Inherit sensitive environment variables | OS / Process Supervisor | `cleanseEnvironment` strips `AWS_*`, `OPENAI_*`, `SYNTHETIC_*`. Real OS child process verifies `SECRETS_ABSENT`. | **PASS (OS-Enforced Prevention)** |
| **Canary 6** | Spawn child processes outliving task cancellation | OS / Process Supervisor | Spawns background process; on `signal.abort()`, process tree is terminated cleanly (`cancelled: true`, exit code `-1`). | **PASS (OS-Enforced Cleanup)** |
| **Canary 7** | Unauthorized caller origins (AI/MCP) & forged HMAC | Cryptographic Gate | Requests from `browser_ai` and `mcp_agent` rejected with `CALLER_UNAUTHORIZED`. Forged HMAC rejected with `AUTHENTICATION_FAILED`. | **PASS (Prevention)** |
| **Canary 8** | Replay nonces, stale timestamps, reused approvals & post-approval file tamper | Cryptographic & TOCTOU | Replayed nonce rejected (`REPLAY_ATTACK_DETECTED`); stale timestamp rejected (`REQUEST_STALE`); consumed approval rejected (`APPROVAL_ALREADY_CONSUMED`); modified staged file rejected (`STAGE_TAMPER_DETECTED`). | **PASS (Prevention & Detection)** |
| **Canary 9** | Path traversal, Alternate Data Streams, and DOS devices | Boundary Gate | `../../`, `file:stream`, `CON`, `NUL`, `COM1`, `PRN.ts` rejected fail-closed with `PATH_OUTSIDE_WORKSPACE`. | **PASS (Prevention)** |
| **Canary 10** | Broker unavailability or misconfiguration | Fail-Closed Integrity | Weak secret rejected on broker startup; mismatched secret fails all requests fail-closed with `AUTHENTICATION_FAILED`. Zero unauthenticated fallback. | **PASS (Fail-Closed Integrity)** |
| **Canary 11** | Policy gating & network isolation enforcement | Governance Gate | Autonomous execution blocked under S00 `NO-GO-AUTOEXEC` (`security_violation`); unisolated network request rejected (`security_violation`). | **PASS (Policy Enforcement)** |

---

## 6. Monorepo Quality Gate Verification

All quality gates passed cleanly with zero errors:

- `npm run lint` (`eslint . --ext .ts`): **PASS** (0 errors, 0 warnings across entire monorepo).
- `npm run typecheck` (`tsc -b`): **PASS** (0 errors).
- `npm run build` (`tsc -b`): **PASS** (0 errors).
- `npm test` (`vitest run`): **PASS** (**48 / 48 test files, 962 / 962 tests passing, 100%**).

---

## 7. Residual Risks & Autopilot Blocker Matrix

Even with the validated Host-Side Core Containment architecture, two fundamental blockers preclude autonomous execution:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        AUTOPILOT RELEASE BLOCKER STATUS MATRIX                         │
├────────────────────────────────┬──────────────┬────────────────────────────────────────┤
│ Security Domain                │ Status       │ Operational Impact                     │
├────────────────────────────────┼──────────────┼────────────────────────────────────────┤
│ 1. Host-Side Core Containment  │ ✅ VALIDATED │ Split Core & Broker prevents direct    │
│                                │ (PROTOTYPE)  │ live writes, shell execution & secrets.│
├────────────────────────────────┼──────────────┼────────────────────────────────────────┤
│ 2. Offline Toolchain Delivery  │ ❌ BLOCKED   │ Offline sandbox cannot fetch packages; │
│    & Dependency Mirroring      │ (TH-20 GAP)  │ dynamic npm/pip install fails offline. │
├────────────────────────────────┼──────────────┼────────────────────────────────────────┤
│ 3. Sandbox Filesystem Isolation│ ✅ VERIFIED  │ VHDX isolation, no automount (/mnt/c), │
│                                │              │ non-root runner, DAC confinement.      │
├────────────────────────────────┼──────────────┼────────────────────────────────────────┤
│ 4. Sandbox Network Isolation   │ ✅ VERIFIED  │ CLONE_NEWNET unshare, DNS proxy blocked│
│                                │              │ zero egress packets escape guest.      │
├────────────────────────────────┼──────────────┼────────────────────────────────────────┤
│ 5. Authorization & Human Gate  │ ✅ VERIFIED  │ S00 NO-GO-AUTOEXEC authoritative;      │
│                                │              │ single-use approvals; zero auto-exec.  │
├────────────────────────────────┼──────────────┼────────────────────────────────────────┤
│ 6. Browser & Multi-Interface   │ ✅ VERIFIED  │ Token authentication, constant-time eq,│
│                                │              │ no AI self-authorization path.         │
├────────────────────────────────┼──────────────┼────────────────────────────────────────┤
│ 7. Production Deployment       │ ✅ VERIFIED  │ Zero-admin HKCU installer, rollback    │
│    & Recovery                  │              │ scripts, clean removal verified.       │
└────────────────────────────────┴──────────────┴────────────────────────────────────────┘
```

### Explaining the Unresolved Offline Toolchain Blocker (TH-20):
Because `MediatorSandbox` enforces 100% network isolation, arbitrary AI proposals that introduce new dependencies cannot download packages from the public internet. Re-enabling the network during toolchain installation is unacceptable because malicious post-install scripts could exfiltrate host data. Before autonomous execution could ever be considered, an offline toolchain pre-provisioning pipeline must be developed.

---

## 8. Authoritative Governance Recommendation & S45 Exit Decision

### Exit Outcome:
**`PASS — CONTAINMENT DESIGN VALIDATED`**

### Authoritative Governance Mandate:
**`LOCAL AUTOPILOT: BLOCKED — S00 NO-GO-AUTOEXEC REMAINS AUTHORITATIVE`**

Mediator continues in **Review-only V1 mode**. All proposed code modifications must be staged, reviewed via unified diff, and explicitly approved by the human operator before live application.
