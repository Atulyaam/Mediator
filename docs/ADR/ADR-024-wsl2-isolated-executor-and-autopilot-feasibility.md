# ADR-024 — WSL2 Isolated Executor & Autopilot Feasibility

**Date:** 2026-10-12  
**Status:** ACCEPTED (Decision: `CONDITIONAL — SOME ISOLATION CAPABILITIES REMAIN UNVERIFIED`; S00 `NO-GO-AUTOEXEC` Maintained)  
**Sprint:** S41 WSL2 Isolated Executor and Autopilot Feasibility  
**Deciders:** Mediator Architecture & Safety Authority  

---

## 1. Context

Following Sprint S40, live browser acceptance across OpenAI ChatGPT, Google Gemini, and DeepSeek is verified as `PASS`. Sprint S40 investigated the feasibility of a Windows 11 Home sandbox, demonstrating that standard non-elevated Win32 processes share the user's ambient security authority, precluding OS-level filesystem and network containment without a container hypervisor.

Sprint S41 explores whether an isolated Windows Subsystem for Linux 2 (WSL2) environment can safely execute approved coding-validation recipes on Windows 11 Home without requiring Docker or Podman.

The intended workflow is:
1. User enters a task once in Mediator.
2. Selected provider returns proposed code.
3. Mediator validates and stages changes in the shadow staging database.
4. The task workspace snapshot is transferred into an isolated Linux environment.
5. Only approved, hash-pinned recipes execute inside the Linux environment.
6. Mediator captures real exit codes, stdout/stderr, timeout, and cancellation states.
7. Sanitized results are returned to the verified provider conversation.
8. The loop repeats within persistent budgets.
9. Final diffs are reviewed and approved by the human user before applying to the live project.

Authoritative baseline:
- S00 remains strictly `NO-GO-AUTOEXEC` (Review-Only V1).
- Local Autopilot remains strictly `BLOCKED`.

---

## 2. Correction of S40 Canary Result Inconsistency

Prior to adding new capabilities, the S40 canary evidence classification was audited:
- **Historical Inconsistency:** In S40 Canary 1, `liveWorkspaceIntegrityPreserved: false` was recorded after a simulated write to the live sentinel, yet the canary was marked `PASS` because a post-hoc tree hash detected the alteration.
- **Architectural Clarification:** Detecting a write after it has already occurred does **not** prove that the write was prevented. Prevention, detection, containment, and recovery must be rigorously separated:
  - *Policy Denial:* PASS (Mediator strictly refuses to launch execution inside the live workspace).
  - *OS Write Prevention:* FAILED (Without container mount isolation, OS ambient authority permits standard user writes).
  - *Tamper Detection:* PASS (Post-execution tree-hash comparison caught the unauthorized modification).
- **Capability Engine Hardening:** Enhanced `CapabilityEvaluationEngine` in `packages/executor-contract/src/capabilityEvaluator.ts` to detect and reject contradictory evidence:
  - Rejects capability claims of `value: true` when underlying canary run records or status notes indicate an integrity breach.
  - Prohibits post-hoc restoration or detection from satisfying mandatory prevention gates.
  - Added 4 dedicated regression tests (Tests 25–27) in `capabilityEvaluator.test.ts`.

---

## 3. Read-Only Discovery of Host WSL2 Subsystem

Read-only environmental inspection of the user's host machine was performed via `wsl.exe`:
1. **WSL2 Subsystem:** Installed and operational (`wsl.exe -l -v`).
2. **Installed Distribution:** `Ubuntu` (Version 2, Stopped during discovery).
3. **Linux Kernel:** `6.18.40.1-microsoft-standard-WSL2` with systemd support and cgroup v2 (`cgroup2 on /sys/fs/cgroup`) mounted.
4. **Default Distribution Configuration:**
   - **DrvFS Automounting:** ENABLED. `/mnt/c` and `/mnt/d` are mounted writable as standard user `atul2`.
   - **Windows Interop:** ENABLED. `/init` binfmt interop allows executing Windows executables (e.g., `cmd.exe`, `powershell.exe`) directly from Linux.
5. **Critical Safety Finding:** The user's default `Ubuntu` distribution is **UNSAFE** for untrusted code execution. Running untrusted AI code inside default `Ubuntu` would allow full read/write access to host drives (`/mnt/c`) and host command execution via interop.
6. **Dedicated Sandbox Status:** Dedicated `MediatorSandbox` distribution does **not** yet exist. Per S41 constraints, no distribution was downloaded or created without explicit user authorization.

---

## 4. Architecture of Dedicated Distribution (`MediatorSandbox`)

To achieve true isolation without Docker, Mediator specifies a dedicated WSL2 distribution:
- **Distribution Name:** `MediatorSandbox`.
- **Dedicated Filesystem:** Root filesystem isolated in a separate VHDX (`ext4.vhdx`), decoupled from the user's default distribution.
- **Unhardened Interop & Automount Disabled:**
  ```ini
  # /etc/wsl.conf
  [boot]
  systemd = true

  [automount]
  enabled = false
  mountFsTab = false

  [interop]
  enabled = false
  appendWindowsPath = false

  [user]
  default = mediator-runner
  ```
- **Unprivileged Execution Identity:** User `mediator-runner` (UID 1500) without `sudo` privileges or access to docker/system groups.
- **Controlled Snapshot Transfer:** Host creates an in-memory tarball of staged files and imports it to `/workspace/task` inside the sandbox; results are exported back via a bounded tar stream. No live project paths are ever mounted into Linux.
- **Network Default-Deny:** Guest `iptables` / `nftables` policy blocking all outbound traffic except loopback, preventing arbitrary internet and local network access.

---

## 5. Prototype Implementation & Live Operating-System Canaries

Implemented the following components in `packages/executor-contract`:
1. `WslSandboxProvisioner` (`src/wslSandboxProvisioner.ts`): Read-only discovery, `wsl.conf` template generator, and iptables hardening scripts.
2. `prepare-wsl2-sandbox.ps1` (`scripts/prepare-wsl2-sandbox.ps1`): Non-destructive diagnostic and step-by-step setup script requiring user consent.
3. `WslIsolatedExecutor` (`src/wslIsolatedExecutor.ts`): Real WSL2 process supervisor with hash-pinned recipes, real exit-code capture, output bounding, timeout, `AbortSignal` cancellation via `taskkill /pid <PID> /T /F`, pre/post tree-hash verification, and `@mediator/context-security` sanitization.
4. `wslSandboxCanaries.test.ts` (`src/wslSandboxCanaries.test.ts`): 13 live operating-system canaries executed against the host WSL2 subsystem.

### Live Canary Results (13/13 PASS):
- **Canary 1 (WSL2 Subsystem Discovery):** PASS. Detected WSL2, Ubuntu, and kernel `6.18.40.1-microsoft-standard-WSL2`.
- **Canary 2 (Linux Exit Code 0 Capture):** PASS. Captured real exit code `0` and verified stdout from `/bin/sh`.
- **Canary 3 (Linux Exit Code 42 Capture):** PASS. Captured real nonzero exit code `42` from Linux process.
- **Canary 4 (Timeout Enforcement):** PASS. Terminated hanging process in 1.46s (limit 1.2s) and recorded status `timeout`.
- **Canary 5 (Cancellation Enforcement):** PASS. Terminated workload cleanly via `AbortSignal` in 865ms and recorded status `cancelled`.
- **Canary 6 (Output Buffer Bounding):** PASS. Enforced 2048-byte limit and flagged `outputTruncated: true`.
- **Canary 7 (Secret Token Redaction):** PASS. Detected OpenAI secret key and redacted output to `[REDACTED:OPENAI_KEY]`.
- **Canary 8 (Default Distro Vulnerability Probe):** PASS. Formally recorded that default Ubuntu has automount and interop enabled.
- **Canary 9 (Default Distro Rejection):** PASS. Rejected untrusted task execution against default Ubuntu without explicit canary authorization flag.
- **Canary 10 (Missing Sandbox Fail-Closed):** PASS. Returned `distribution_unavailable` when targeting unprovisioned `MediatorSandbox`.
- **Canary 11 (Recipe Hash Tamper Rejection):** PASS. Rejected execution immediately when recipe hash was tampered.
- **Canary 12 (Live Workspace Integrity):** PASS. Pre- and post-execution tree hash verified live project files were 100% unaltered.
- **Canary 13 (Autopilot Gate):** PASS. Verified that Local Autopilot remains strictly blocked under S00 `NO-GO-AUTOEXEC`.

---

## 6. Authoritative Exit Decision

### Verdict: `CONDITIONAL — SOME ISOLATION CAPABILITIES REMAIN UNVERIFIED`

### Capability Verification Status:
| Capability Key | Status | Enforcement Mechanism | S41 Notes |
|---|---|---|---|
| `filesystem.sourceWriteDenied` | VERIFIED | Staging Isolation & Pre/Post Tree-Hash | Live workspace never exposed to WSL2 |
| `filesystem.outsideTaskRootDenied` | UNVERIFIED | Pending `MediatorSandbox` Provisioning | Default Ubuntu has automount enabled; dedicated distro pending user authorization |
| `filesystem.secretsDenied` | VERIFIED | Input White-listing & Context Redactor | Output scanned and redacted via `@mediator/context-security` |
| `network.networkDefaultDeny` | UNVERIFIED | Pending `MediatorSandbox` iptables | Default WSL2 allows host NAT internet access; dedicated iptables rules pending |
| `process.childProcessesConfined` | VERIFIED (Prototype) | Windows `taskkill /T /F` on `wsl.exe` | Cleanly terminates guest workloads; cgroups v2 available in kernel |
| `limits.capturesRealExitCode` | VERIFIED | Real `wsl.exe` exit-code propagation | Verified exit codes `0` and `42` |
| `limits.enforcesTimeout` | VERIFIED | Watchdog timer & process termination | Verified termination at 1.2s |
| `limits.enforcesCancellation` | VERIFIED | `AbortSignal` listener & process termination | Verified termination in 865ms |
| `limits.enforcesOutputLimit` | VERIFIED | Stream byte bounding & truncation flag | Verified at 2048 bytes |

### Rationale:
While the `WslIsolatedExecutor` prototype and real OS process canaries demonstrate that WSL2 can reliably capture real exit codes, timeout, cancellation, output limits, and secret redaction, the dedicated `MediatorSandbox` distribution has not yet been provisioned on the host machine. Because operating in the default `Ubuntu` distribution is unsafe due to host drive automounting and Windows interop, filesystem boundary isolation and network default-deny cannot be declared verified until `MediatorSandbox` is formally provisioned with explicit user authorization.

### Operational Guardrails:
1. S00 remains strictly `NO-GO-AUTOEXEC`.
2. Local Autopilot remains `BLOCKED`.
3. Untrusted task execution in the default `Ubuntu` distribution is strictly prohibited.
4. Provisioning `MediatorSandbox` requires explicit user consent via `scripts/prepare-wsl2-sandbox.ps1`.
