# ADR-023 — Windows Execution Sandbox Feasibility & Autopilot Qualification

**Date:** 2026-10-12  
**Status:** ACCEPTED (Decision: `CONDITIONAL — PROTOTYPE WORKS, REQUIRED CAPABILITY UNVERIFIED`; S00 `NO-GO-AUTOEXEC` Maintained)  
**Sprint:** S40 Windows Execution Sandbox Feasibility and Autopilot Qualification  
**Deciders:** Mediator Architecture & Safety Authority  

---

## 1. Context

Following Sprint S39, live browser acceptance is verified as `PASS` for OpenAI ChatGPT, Google Gemini, and DeepSeek. S40 focused on evaluating whether approved local validation recipes can be securely executed in an automated code/test/fix loop on the user's actual Windows 11 Home system.

The desired workflow is:
1. User enters a task in Mediator.
2. The selected provider generates proposed code.
3. Mediator stages proposed changes into a shadow staging workspace.
4. An eligible validation recipe runs in an isolated task environment.
5. Mediator captures the actual process exit code and sanitized output.
6. The result is returned to the same provider conversation.
7. The loop repeats within persistent limits.
8. Final changes are presented for human review and single-use cryptographic approval.

The authoritative baseline decision from S00 was `NO-GO-AUTOEXEC` (Review-Only V1), with Autopilot deferred fail-closed under S26 Outcome B due to three unverified capabilities:
- `process.childProcessesConfined`
- `network.networkDefaultDeny`
- `limits.capturesRealExitCode`

Sprint S40 performed read-only environmental discovery and built a disposable execution prototype to evaluate real Windows 11 Home operating-system capabilities against 12 live adversarial canaries.

---

## 2. Environment Discovery & Findings

Read-only discovery of the user's actual host system revealed:
1. **Operating System:** Windows 10 Home Single Language (DisplayVersion: `26H2`, Build: `26300`, Edition: `CoreSingleLanguage`). Branded as Windows 11 Home Insider/Prerelease build.
2. **User Privileges:** Standard non-elevated user (`ATULYADAV\Atul2`). Current process is not running as Administrator (`Is Administrator: False`).
3. **Virtualization Facilities:** 
   - Windows Sandbox (`Containers-DisposableClientVM`) is **not supported** on Home Single Language editions (requires Windows Pro, Enterprise, or Education).
   - Intel Core i7-12700H CPU; firmware virtualization reported `VirtualizationFirmwareEnabled: False` via CIM/WMI.
   - WSL2 is installed with `Ubuntu` distribution (stopped). Per architectural guidelines, neither WSL2 nor Docker/Podman can be made mandatory dependencies for host users.
4. **Security Isolation Constraints:**
   - A standard non-elevated Win32 process shares the user's ambient security authority. The operating system kernel enforces DACL permissions for the current user across the entire user profile (`C:\Users\Atul2\`), meaning that without elevation or a container hypervisor, a child process can read other user files.
   - Creating process-level Windows Firewall rules requires Administrator elevation. Standard users cannot enforce network default-deny boundaries at the OS level.

---

## 3. Decisions & Prototype Architecture

### 3.1 Disposable Windows Executor Prototype (`DisposableWindowsExecutor`)
- Implemented in `packages/executor-contract/src/disposableWindowsExecutor.ts`.
- Restricts execution strictly to pinned, canonical recipes with SHA-256 definition hashes.
- Prohibits executing directly in the live source workspace; enforces execution inside a dedicated shadow staging directory.
- Sanitizes environment variables, scrubbing API keys, credentials, and user secrets.
- Rejects shell metacharacters and command-chaining operators (`&`, `|`, `` ` ``, `$`, `<`, `>`).
- Enforces runtime limits: output buffering cap (32 KiB), timeout timers (1–30s), and cancellation signals (`AbortSignal`).
- Terminates process trees on Windows using `taskkill /pid <PID> /T /F`.
- Sanitizes captured stdout and stderr through `@mediator/context-security` (`scanContent` + `redactTerminalOutput`) before exposing output to providers, UI, or logs.

### 3.2 Live Adversarial Canaries (12 Test Battery)
Executed real operating-system processes against the prototype in `packages/executor-contract/src/windowsSandboxCanaries.test.ts`:
1. **Canary 1 (Live Source Write Denial):** Direct execution inside live workspace rejected (`security_violation`). Attempts by a staging script to write to the live sentinel were detected by pre/post tree-hash comparison (`liveWorkspaceIntegrityPreserved: false`).
2. **Canary 2 (Outside Task Root Write):** Demonstrated that Windows ambient authority permits standard user writes outside the staging root. Confirmed that filesystem isolation is not enforced at the OS kernel level on Windows 11 Home.
3. **Canary 3 (Secret File Access):** Reading synthetic credentials outside task root succeeded at the OS level, but captured output was successfully sanitized and redacted by Mediator's context security pipeline.
4. **Canary 4 (Reparse Point / Junction Escape):** Proved that NTFS directory junctions can point outside the task root without container mount isolation.
5. **Canary 5 (Child Process Confinement):** Verified child process execution and process tree termination. Confirmed that kernel-level Win32 Job Object assignment is necessary to prevent detached process escape.
6. **Canary 6 (Budget Limits & Output Bounding):** Verified output stream truncation at buffer limits (`outputTruncated: true`), preventing memory exhaustion.
7. **Canary 7 (Network Policy):** Proved that socket connections succeed on Windows 11 Home without elevation. Confirmed that `network.networkDefaultDeny` is **unverified / false** at the OS boundary.
8. **Canary 8 (Real Exit Code Capture):** Verified genuine programmatic capture of exit code `42` from a nonzero test script. `limits.capturesRealExitCode` is **verified**.
9. **Canary 9 (Timeout Enforcement):** Verified that a hanging task was killed and marked `timeout` after the configured timeout threshold.
10. **Canary 10 (Cancellation Enforcement):** Verified clean process tree termination via `AbortSignal`, marking `cancelled`.
11. **Canary 11 (Recipe Hash Tamper Rejection):** Verified that modifying a recipe hash triggers immediate rejection before launch.
12. **Canary 12 (Replay Prevention):** Verified that uncertain, failed, or interrupted operations cannot be auto-replayed without fresh user approval.

---

## 4. Authoritative Qualification Verdict

### Verdict: `CONDITIONAL — PROTOTYPE WORKS, REQUIRED CAPABILITY UNVERIFIED`

- **Verified Capabilities:**
  - `limits.capturesRealExitCode`: **VERIFIED (PASS)** via real OS execution.
  - `limits.timeoutEnforced`: **VERIFIED (PASS)**.
  - `limits.cancellationEnforced`: **VERIFIED (PASS)**.
  - `limits.outputByteLimitsEnforced`: **VERIFIED (PASS)**.
  - `execution.fixedRecipeOnly`: **VERIFIED (PASS)**.
- **Unverified / Missing Capabilities:**
  - `network.networkDefaultDeny`: **UNVERIFIED / BLOCKED** (Windows 11 Home lacks non-elevated network isolation).
  - `process.childProcessesConfined`: **UNVERIFIED / BLOCKED** (Kernel Job Object assignment required).
  - `filesystem.readIsolation`: **UNVERIFIED / BLOCKED** (Ambient user token allows reading other user files).

### Autopilot Status:
Local Autopilot remains strictly **`BLOCKED`** fail-closed under `S00 NO-GO-AUTOEXEC`. Automated execution is forbidden.

### Workflow Impact:
- Mediator continues operating in **Review-only mode** (Assisted Loop).
- The Provider Conversation Loop operates independently and continues cycling across ChatGPT, Gemini, and DeepSeek.
- The user reviews proposed diffs and provides explicit, cryptographic approval before changes are applied to the live workspace.
- Safe, copyable manual recipe commands continue to be provided for manual terminal execution.
