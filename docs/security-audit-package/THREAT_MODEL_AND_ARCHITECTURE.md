# Security Architecture, Trust Boundaries & Threat Model

**Audit Scope:** `@mediator/native-host` (`mediator-native-host.exe`), IPC Framing, and Trust Boundary Controls  
**Release Candidate:** Mediator `v0.1.0-beta.1`  
**Security Policy Invariant:** S00 `NO-GO-AUTOEXEC` — Local Autopilot strictly **`BLOCKED`** fail-closed  

---

## 1. System Architecture & Trust Boundary Model

Mediator enables local development assisted by browser-based AI chat services (ChatGPT, Gemini, DeepSeek, Claude). Because web browser tabs and extension contexts run arbitrary web content and untrusted model outputs, the browser extension must NEVER be granted direct file access or shell execution privileges on the host.

```
+-----------------------------------------------------------------------------------------+
| UNTRUSTED EXTERNAL WEB & MODEL CONTEXT                                                  |
|                                                                                         |
|  [AI Provider Web Page] (OpenAI ChatGPT / Google Gemini / DeepSeek / Claude)            |
|           |                                                                             |
|           v (Content Script Bridge / CDP Session)                                       |
|  [Manifest V3 Chromium Browser Extension]                                               |
+-----------------------------------------------------------------------------------------+
                                          |
                        Chromium Native   | 4-byte Little-Endian Length Prefix (Hard Cap 512 KiB)
                        Messaging Pipe    | Validated Origin: chrome-extension://<32_char_id>/
                                          v
+-----------------------------------------------------------------------------------------+
| CHROMIUM NATIVE MESSAGING HOST (`mediator-native-host.exe`)                              |
|                                                                                         |
|  [OriginValidator]           --> Strictly rejects unauthorized extension IDs & wildcards|
|  [NativeMessageReader]       --> Enforces 512 KiB limit before allocating buffer memory |
|  [Typed Operation Router]    --> Permits ONLY: ping, handshake, status, chunk, envelope |
|                                  STRICTLY PROHIBITS: shell, exec, broker, apply         |
|  [Diagnostic Logger]         --> Redacts tokens, passwords, keys; stdout kept protocol-pure|
+-----------------------------------------------------------------------------------------+
                                          |
                        Windows Named     | High-Entropy Pairing Token Handshake
                        Pipe Transport    | Endpoint: \\.\pipe\mediator-ipc-*
                                          v
+-----------------------------------------------------------------------------------------+
| MEDIATOR CORE ENGINE & CONTAINED ORCHESTRATOR                                           |
|                                                                                         |
|  - Ingests draft code proposals into in-memory shadow storage                           |
|  - ZERO arbitrary host shell execution capability                                       |
|  - Untrusted code validation dispatched strictly to isolated WSL2 MediatorSandbox       |
+-----------------------------------------------------------------------------------------+
             |                                                                 |
             | Isolated Verification                                           | Gated Live Apply
             v (CLONE_NEWNET)                                                  v (Single-Use Approval)
+-------------------------------------------+     +-----------------------------------------------+
| WSL2 MediatorSandbox (Network-Isolated)   |     | TrustedHostBroker (Windows Host)              |
|                                           |     |                                               |
| - Linux Network Namespace Isolation       |     | - Caller Origin Check ('trusted_ui' ONLY)     |
| - unshare --user --net (CLONE_NEWNET)     |     | - Single-Use Consumable Approval ID           |
| - Zero network egress (ENETUNREACH)       |     | - Cryptographic TOCTOU Base Hash Verification |
| - Pinned offline recipes only             |     | - Atomic Pre-Apply Rollback Backup Snapshot   |
+-------------------------------------------+     +-----------------------------------------------+
```

---

## 2. Formal Threat Model Matrix

The following threats against the Native Messaging Host and host boundary are mitigated and tested:

| Threat ID | Threat Vector | System Defense & Mitigation | Test Case Verification |
| :--- | :--- | :--- | :--- |
| **TM-NMH-01** | **Memory Exhaustion / Buffer Overflow:** Malicious extension floods native host with multi-megabyte frames. | `NativeMessageReader` inspects 4-byte LE length prefix and aborts before reading if > 512 KiB. Hard limit 1 MiB. | `nativeHostSecurityAudit.test.ts` (Tests 1 & 2) — **PASS** |
| **TM-NMH-02** | **Framing Desynchronization:** Truncated, 1-byte, or partial headers causing stream confusion. | Length prefix must be >= 2 bytes. Malformed headers trigger immediate stream reset. | `nativeHostSecurityAudit.test.ts` (Test 3) — **PASS** |
| **TM-NMH-03** | **Origin Spoofing / Malicious Extension:** Rogue extension attempts connecting to native host binary. | Host validates command-line origin (`argv[1]`) against exact 32-character extension ID allowlist. Wildcards rejected. | `nativeHostSecurityAudit.test.ts` (Tests 7 & 8) — **PASS** |
| **TM-NMH-04** | **Arbitrary Shell Execution:** Payload requests `cmd.exe /c calc` or `shell.exec`. | Native host message router strictly allows 6 typed operations; generic execution commands fail-closed. | `nativeHostSecurityAudit.test.ts` (Test 9) — **PASS** |
| **TM-NMH-05** | **Privilege Escalation to Host Broker:** Browser payload requests `apply_approved_stage` or workspace write. | Native host lacks broker credentials. Broker checks caller origin: `browser_ai` is rejected with `CALLER_UNAUTHORIZED`. | `nativeHostSecurityAudit.test.ts` (Test 10) — **PASS** |
| **TM-NMH-06** | **Credential Leakage via Logs:** Extension transmits pairing token or API key that leaks to stdout/stderr. | Diagnostic logger redacts inline `token=`, `secret=`, `key=` in strings and objects. Stdout never receives logs. | `nativeHostSecurityAudit.test.ts` (Test 12) — **PASS** |
| **TM-NMH-07** | **Malformed / Nested JSON Injection:** Deeply nested JSON or null-byte injections causing crash or DOS. | JSON parsing wrapped in try/catch; deeply nested objects parsed without stack overflow; null bytes safely handled. | `nativeHostSecurityAudit.test.ts` (Tests 5 & 6) — **PASS** |

---

## 3. Trust Boundaries & Honest Security Assumptions

1. **Standard User Privilege Model:** On Windows 11 Home / Pro, Mediator Core and the Native Messaging Host execute under the user's standard account token. While they run in separate process address spaces with stripped environment blocks, this does not constitute a kernel-level DACL multi-user privilege boundary.
2. **Untrusted Code Execution Isolation:** Untrusted candidate code is NEVER executed on the Windows host. Validation execution is confined strictly to the dedicated `MediatorSandbox` WSL2 guest with Linux network namespace severance (`CLONE_NEWNET`).
3. **Fail-Closed Autopilot Policy:** Autonomous self-approving execution loops are strictly prohibited under S00 `NO-GO-AUTOEXEC`. All live workspace writes require human diff review and manual approval click.
