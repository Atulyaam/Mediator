# Mediator Release Notes — v0.1.0-beta.1

**Release Version:** `v0.1.0-beta.1` (Controlled Personal Beta)  
**Release Date:** October 2026  
**Mode:** Review-only V1  
**Target Environment:** Windows 11 Home, Standard User Account, Dedicated `MediatorSandbox` WSL2  
**Governance Policy:** S00 `NO-GO-AUTOEXEC` — **BLOCKED**  

---

## Highlights & Major Capabilities

### 1. Host Process Containment (`@mediator/orchestrator`)
- **Physical Process Separation:** `TrustedHostBroker` executes in an isolated child process with a distinct Windows PID and private address space.
- **Environment Block Scrubbing:** Automatically scrubs AWS keys, GitHub tokens, and SSH credentials from child process environments.
- **Narrow Typed Schema:** Strictly rejects arbitrary shell execution commands (`cmd.exe`, `powershell.exe`).
- **Cryptographic Request Authentication:** All broker requests require HMAC-SHA256 signatures, 30s freshness windows, and replay-resistant nonces.

### 2. Automated Offline Dependency Bundle Resolver (`@mediator/recipe-registry`)
- **3-Stage Resolution Architecture:** Trusted Preparation (lockfile hashing, registry download outside sandbox) -> Bundle Verification & Sealing (Merkle root SHA-256, zero path traversal, zero secrets) -> Offline Sandbox Provisioning (immutable master cache).
- **Zero Dynamic Downloads in Sandbox:** Enforces strict Linux network namespace isolation (`unshare --user --net`). Missing dependencies fail closed with actionable remediation.

### 3. Chromium Native Messaging Host Security Hardening (`@mediator/native-host`)
- **Hardened Framing Protocol:** Drops frames > 512 KiB before buffering memory; rejects malformed lengths < 2 bytes.
- **Strict Origin Allowlist:** Rejects untrusted or spoofed browser extension IDs.
- **Secret Redaction:** Diagnostic logs automatically redact inline tokens, secrets, and auth credentials.
- **External Audit Package:** Full reproducible build and threat model package prepared for independent third-party review.

### 4. Review-Only V1 Workflow & TOCTOU Protection
- **Shadow Staging:** Proposals are staged in isolated shadow directories without modifying live files.
- **Unified Diff Inspection:** Complete unified diff previews available in UI, CLI, and IDE.
- **Single-Use Cryptographic Approvals:** Live workspace writes strictly require human authorization.
- **TOCTOU Hash Verification:** Verifies base content hashes match live disk immediately prior to write.
- **Pre-Apply Atomic Backups:** Automatic snapshot created in `.mediator/backups/<txId>/` before write.

### 5. Multi-Provider Browser Bridges
- Simultaneous support for **Google Gemini**, **OpenAI ChatGPT**, **DeepSeek**, and **Anthropic Claude**.
- Operates via active authenticated browser tabs with strict content script boundaries.

---

## Quality Gates & Verification Summary

- **Total Test Suites:** 54 passing test files (100%)
- **Total Automated Tests:** 1,027+ passing tests
- **Process Containment Tests:** 21/21 passing (`processIsolatedContainment.test.ts`, `hostContainmentAdversarial.test.ts`)
- **Offline Toolchain & Resolver Tests:** 21/21 passing (`offlineDependencyResolver.test.ts`, `offlineToolchain.test.ts`)
- **Native Host Security Audit Tests:** 32/32 passing (`nativeHostSecurityAudit.test.ts`, `nativeHost.test.ts`, `packagedHost.test.ts`)
- **Beta Operational Acceptance:** 9/9 passing (`betaOperationalAcceptance.test.ts` Scenarios A through I)
- **Windows Installer Tests:** 9/9 passing (`windowsInstall.test.ts`)

---

## Known Release Constraints & Unresolved Items

1. **Independent External Security Audit:** The Native Messaging Host independent third-party penetration audit is recorded as `PENDING_EXTERNAL_REVIEW`. Broad public distribution is blocked until audit closure.
2. **Standard User Boundary Model:** On Windows 11 Home standard user accounts, two processes running as the same user share identical security tokens. Process separation provides memory and environmental isolation, but not kernel-level DACL multi-user sandboxing.
3. **Local Autopilot State:** Local Autopilot is **`BLOCKED`** fail-closed under S00 `NO-GO-AUTOEXEC`.
