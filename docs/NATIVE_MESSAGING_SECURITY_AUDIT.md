# CHROMIUM NATIVE MESSAGING HOST SECURITY AUDIT & EXTERNAL AUDIT PACKAGE

**Document Status:** Internal Adversarial Testing Complete — **PENDING INDEPENDENT EXTERNAL AUDIT**  
**Audit Target:** `@mediator/native-host` (`mediator-native-host.exe`, `NativeHostController`, `framing.ts`, `registration.ts`)  
**Current Audit Gate Status:** `PENDING_EXTERNAL_REVIEW`  
**Security Policy:** S00 `NO-GO-AUTOEXEC` remains authoritative  

---

## 1. Executive Summary & Audit Scope

Mediator integrates with web-based AI chat providers (ChatGPT, Claude, DeepSeek, Gemini) through a Manifest V3 Chromium browser extension. Because web browser content scripts and extension contexts are exposed to untrusted web content and model outputs, the browser extension cannot be permitted to execute system commands or access host filesystems.

Communication between the browser extension and the local Mediator Core is bridged exclusively via the **Chromium Native Messaging Host** (`mediator-native-host.exe`). 

This document serves as both:
1. **The Internal Adversarial Security Audit Report** (documenting empirical fuzzing and protocol boundary tests).
2. **The Formal Independent External Audit Package** (prepared for third-party professional security reviewers, with exact source manifests, reproducible build steps, trust boundaries, threat models, and explicit reviewer audit questions).

> [!IMPORTANT]
> **Independent Review Gate Notice:**
> In accordance with Mediator Master Completion Plan Governance (S49.3 & Gate 4), internal adversarial test suites do NOT substitute for an independent external penetration audit. This document records the external audit as **`PENDING_EXTERNAL_REVIEW`**; no reviewer identity, signature, or passing verdict is fabricated. The release readiness gate remains conditional on external review completion.

---

## 2. Real Distribution Artifact Specification

| Property | Value / Specification |
| :--- | :--- |
| **Artifact Binary** | `packages/native-host/dist/mediator-native-host.exe` |
| **Packaging Model** | Standalone Node.js compiled binary (via `@yao-pkg/pkg`) |
| **Registration Location** | Windows Registry: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mediator.native_host` |
| **Target Manifest** | `packages/native-host/dist/manifest.json` |
| **Allowed Extension Origin** | Exact 32-character extension ID allowlist (no wildcards `*`) |
| **IPC Endpoint** | Local Windows Named Pipe: `\\.\pipe\mediator-ipc-*` (authenticated with high-entropy pairing token) |
| **Privilege Level** | Standard User (Medium Mandatory Integrity Level; zero elevation required) |

### 2.1 Reproducible Build Procedure

```powershell
# 1. Compile TypeScript sources
cd packages/native-host
npm run build

# 2. Package standalone Windows .exe
node ./scripts/buildExecutable.mjs

# 3. Verify artifact existence and hash
Get-FileHash -Algorithm SHA256 ./dist/mediator-native-host.exe
```

---

## 3. Protocol & Trust Boundary Architecture

```
+-----------------------------------------------------------------------------------+
| UNTRUSTED WEB & EXTENSION CONTEXT                                                 |
|                                                                                   |
|  [AI Provider Web Page] (ChatGPT / Claude / DeepSeek / Gemini DOM)                |
|           |                                                                       |
|           v (Content Script Bridge)                                               |
|  [Manifest V3 Browser Extension] (Background Service Worker)                      |
+-----------------------------------------------------------------------------------+
                                         |
                       Chromium Native   | 4-byte LE length prefix (Max 512 KiB)
                       Messaging Pipe    | Validated Origin: chrome-extension://<id>/
                                         v
+-----------------------------------------------------------------------------------+
| CHROMIUM NATIVE MESSAGING HOST (`mediator-native-host.exe`)                        |
|                                                                                   |
|  1. Origin Verification: Rejects any origin not matching allowlist                 |
|  2. Framing Reader: Drops oversized frames (>512 KiB) before buffering memory     |
|  3. Narrow Message Dispatcher:                                                    |
|     - Permitted: ping, handshake, get_status, transfer_chunk, submit_envelope    |
|     - Strictly Prohibited: shell.exec, run_command, system, broker.*               |
|  4. Secret Redaction: Stderr logger masks tokens/secrets; stdout kept protocol-pure|
+-----------------------------------------------------------------------------------+
                                         |
                       Windows Named     | Authenticated with single-use pairing token
                       Pipe Transport    v
+-----------------------------------------------------------------------------------+
| MEDIATOR CORE & CONTAINED ORCHESTRATOR                                            |
|                                                                                   |
|  - Receives draft code proposals into memory                                      |
|  - ZERO direct execution capability                                               |
|  - Live workspace modifications strictly gated behind TrustedHostBroker & Approval|
+-----------------------------------------------------------------------------------+
```

---

## 4. Threat Model & Adversarial Surface

| Threat ID | Threat Vector | System Defense & Mitigation | Status |
| :--- | :--- | :--- | :--- |
| **TM-NMH-01** | **Buffer Overflow / Memory Exhaustion:** Host flooded with multi-megabyte native messaging frames. | NativeMessageReader inspects 4-byte LE length prefix and aborts before reading if > 512 KiB. Hard cap 1 MiB. | **VERIFIED PASS** (Tests 1 & 2) |
| **TM-NMH-02** | **Framing Desynchronization:** Truncated or 1-byte headers causing stream misinterpretation. | Length prefix must be >= 2 bytes. Malformed headers trigger immediate stream reset. | **VERIFIED PASS** (Test 3) |
| **TM-NMH-03** | **Origin Spoofing / Malicious Extension:** Rogue browser extension attempts connecting to native host. | Host validates command-line origin (`argv[1]`) against exact 32-char ID allowlist. Wildcards rejected. | **VERIFIED PASS** (Tests 7 & 8) |
| **TM-NMH-04** | **Arbitrary Shell Execution:** Attacker crafts payload requesting `cmd.exe /c calc` or `shell.exec`. | Native host message router strictly allows 6 typed operations; generic execution commands fail-closed. | **VERIFIED PASS** (Test 9) |
| **TM-NMH-05** | **Privilege Escalation to Host Broker:** Browser payload requests `apply_approved_stage` or workspace write. | Native host lacks broker credentials. Broker checks caller origin: `browser_ai` is rejected with `CALLER_UNAUTHORIZED`. | **VERIFIED PASS** (Test 10) |
| **TM-NMH-06** | **Credential Leakage via Logs:** Extension transmits pairing token or API key that leaks to stdout/stderr. | Diagnostic logger redacts inline `token=`, `secret=`, `key=` in strings and objects. Stdout never receives logs. | **VERIFIED PASS** (Test 12) |
| **TM-NMH-07** | **Malformed / Nested JSON Injection:** Deeply nested JSON or null-byte injections causing crash or DOS. | JSON parsing wrapped in try/catch; deeply nested objects parsed without stack overflow; null bytes safely handled. | **VERIFIED PASS** (Tests 5 & 6) |

---

## 5. Internal Adversarial Security Test Results (Sprint S49.3)

All 12 adversarial test cases executed in `packages/native-host/src/nativeHostSecurityAudit.test.ts` passed:

```
 RUN  v1.6.1 C:/Users/Atul2/OneDrive/Desktop/Mediator

 ✓ packages/native-host/src/nativeHostSecurityAudit.test.ts > Sprint S49.3 — Chromium Native Messaging Host Security Audit
   ✓ A. Framing & Buffer Boundary Adversarial Tests
     ✓ 1. rejects oversized frame (> 512 KiB) before buffering memory
     ✓ 2. rejects hard Chromium limit violation (> 1 MiB) immediately
     ✓ 3. rejects truncated / impossibly short length prefixes (< 2 bytes)
     ✓ 4. handles malformed non-JSON frame content fail-closed
     ✓ 5. handles deeply nested JSON structures safely
     ✓ 6. safely handles null bytes and unconventional Unicode in payload fields
   ✓ B. Origin Validation & Identity Spoofing Adversarial Tests
     ✓ 7. strictly rejects messages from unauthorized or spoofed extension IDs
     ✓ 8. strictly fails closed if command-line origin initialization was invalid
   ✓ C. Privilege Escalation & Command Injection Adversarial Tests
     ✓ 9. strictly rejects arbitrary shell execution requests fail-closed
     ✓ 10. strictly rejects direct privileged broker operations from browser extension
     ✓ 11. strictly denies IPC connection when pairing token is missing or invalid
   ✓ D. Logging & Diagnostic Secret Redaction Tests
     ✓ 12. verifies that sensitive tokens and keys are never printed to stderr

 Test Files  1 passed (1)
      Tests  12 passed (12)
```

Combined with existing suite (`packages/native-host/src/nativeHost.test.ts` and `packagedHost.test.ts`), **32/32 native-host tests pass**.

---

## 6. Questions & Scope for Independent External Security Reviewer

When commissioning the independent audit, the following specific scope and questions must be submitted to the third-party auditor:

1. **Named Pipe Impersonation:** Does Windows named pipe DACL (`\\\\.\\pipe\\mediator-ipc-*`) permit any standard-user local process to hijack or intercept connection requests during the handshake window?
2. **Side-Channel Timing:** Does the origin string comparison in `OriginValidator` exhibit measurable timing side-channels under high-frequency query load?
3. **Registry Key Hijacking:** On Windows 11 standard user accounts, can non-administrative malware alter `HKCU\Software\Google\Chrome\NativeMessagingHosts` to point the native host registration to a malicious binary?
4. **Child Process Memory Dumping:** Can an unprivileged process running as the same standard user inspect the native host process memory using `ReadProcessMemory` before sensitive pairing tokens are cleared?
5. **IPC Message Replay:** In scenarios where local core restarts, are IPC session IDs sufficiently random to prevent replay of captured transfer chunk payloads?

---

## 7. Audit Disposition & Blocker State

- **Internal Adversarial Tests:** `VERIFIED PASS` (32/32 tests pass)
- **External Independent Audit:** `PENDING_EXTERNAL_REVIEW`
- **Release Qualification Impact:** Releases intended for public distribution remain **BLOCKED** pending independent review sign-off. Controlled Personal Beta is authorized conditionally with documented local-only use constraints.
