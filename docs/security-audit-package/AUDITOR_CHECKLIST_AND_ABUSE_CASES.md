# Independent Auditor Checklist & Abuse Case Guide

**Release Candidate Target:** Mediator `v0.1.0-beta.1`  
**Package Under Review:** `@mediator/native-host` (`mediator-native-host.exe`)  
**Intended Reviewer:** Third-Party Independent Security Assessment Firm  
**Review Status:** `PENDING_EXTERNAL_REVIEW`  

---

## 1. Reviewer Checklist & Verification Requirements

| # | Inspection Area | Specific Question / Evaluation Target | Expected Secure Behavior | Auditor Evidence Required |
|---|---|---|---|---|
| **1** | **Native Framing Limits** | Can a malicious extension cause memory allocation > 512 KiB by sending an oversized length header? | Host inspects 4-byte LE prefix and drops frame without buffering. | Memory profile / Fuzzing log |
| **2** | **Origin Validation** | Can an attacker bypass origin verification using case variations, trailing slashes, or Unicode tricks? | Exact 32-char lowercase hex ID matching required; all variations rejected. | Negative test traces |
| **3** | **IPC Named Pipe DACL** | Can a competing local unprivileged process impersonate `\\.\pipe\mediator-ipc-*`? | Named pipe created with restrictive security attributes and high-entropy token handshake. | AccessChk / Process Explorer DACL dump |
| **4** | **Arbitrary Command Injection** | Can an extension craft a message causing native host to spawn `cmd.exe` or PowerShell? | Host router allows only 6 typed message operations; shell execution is absent from codebase. | AST / Disassembly verification |
| **5** | **Privilege Escalation** | Can browser payload forge `callerOrigin: 'trusted_ui'` to apply live workspace changes? | Host lacks broker signing keys; broker rejects browser caller origin. | Broker security logs |
| **6** | **Credential Redaction** | Do debug logs ever leak API keys, pairing tokens, or auth cookies to disk or stderr? | Diagnostic logger redacts matching patterns; stdout contains 0 log strings. | Stderr capture logs |

---

## 2. Abuse Cases & Reproduction Guide

### Abuse Case A: Oversized Frame Attack (DOS / Memory Exhaustion)
- **Attack:** An attacker injects a frame claiming length `0x00100000` (1 MiB) or `0x7FFFFFFF` (2 GiB).
- **Reproduction:**
  ```powershell
  node -e "
    const len = Buffer.alloc(4);
    len.writeUInt32LE(1024 * 1024 * 10); // 10 MiB
    process.stdout.write(len);
  " | packages/native-host/dist/mediator-native-host.exe "chrome-extension://abcdefghijklmnopponmlkjihgfedcba/"
  ```
- **Expected Outcome:** Binary terminates immediately or resets stream without memory inflation. Exit code 1.

### Abuse Case B: Rogue Extension Origin Spoofing
- **Attack:** Unauthorized extension `chrome-extension://malicious_extension_id_here/` initiates native messaging.
- **Reproduction:**
  ```powershell
  packages/native-host/dist/mediator-native-host.exe "chrome-extension://malicious_extension_id_here/"
  ```
- **Expected Outcome:** Fails closed with `Origin validation failed`. Zero messages processed.

### Abuse Case C: Shell Execution Payload Injection
- **Attack:** Extension sends framed payload: `{"type": "run_command", "command": "calc.exe"}`.
- **Expected Outcome:** Router rejects action fail-closed (`unauthorized_action`).

---

## 3. Scope Exclusions & Known Environmental Boundaries

Auditors should note that:
1. Windows 11 Home standard user account processes share the same Windows security context (Medium Mandatory Integrity Level). Operating system process separation does not constitute a kernel-level DACL multi-user privilege boundary.
2. Local Autopilot remains strictly **BLOCKED** fail-closed under S00 `NO-GO-AUTOEXEC`. Review-only mode is enforced across all components.
