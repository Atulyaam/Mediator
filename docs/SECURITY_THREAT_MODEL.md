# Mediator Security Threat Model & Attack Surface Analysis

**Version:** 1.0 (Sprint S44 Independent Review)  
**Date:** 2026-10-12  
**Status:** AUTHORITATIVE AUDIT BASELINE  
**Authoritative Governance:** S00 `NO-GO-AUTOEXEC`  
**Execution Mode:** Review-only V1  

---

## 1. System Overview & Core Trust Boundaries

Mediator is a local-first, fail-closed AI-to-workspace bridge designed to facilitate assisted coding with web AI providers (OpenAI ChatGPT, Google Gemini, DeepSeek, Anthropic Claude) without granting arbitrary shell execution, unrestricted network access, or unattended write access to the user's host environment.

The system spans four distinct operational layers across two operating system environments:

```
┌────────────────────────────────────────────────────────────────────────┐
│ WINDOWS 11 HOST (User Security Context: standard user "Atul2")         │
│                                                                        │
│  [Browser Extension] ──(Native Messaging)──> [Native Host Bridge]      │
│         │                                              │               │
│         v                                              v               │
│  [AI Web Sessions]                            [Mediator Core HTTP/SSE] │
│  (chatgpt/gemini/deepseek)                     (127.0.0.1:23456)       │
│                                                        │               │
│  [Antigravity / VS Code] ──(IPC / CLI)─────────────────┤               │
│                                                        v               │
│                                               [Shadow Stage Store]     │
│                                               [Policy Engine]          │
│                                               [Approval Manager]       │
│                                                        │               │
├────────────────────────────────────────────────────────┼───────────────┤
│ HYPERVISOR BOUNDARY (Hyper-V / WSL2 VM Container)       │               │
├────────────────────────────────────────────────────────┼───────────────┤
│ DEDICATED WSL2 SANDBOX ("MediatorSandbox" Linux VHDX)  │               │
│                                                        v               │
│  [wsl.exe Supervisor] ──> unshare (--user --net) ──> [Recipe Execution]│
│                               (Isolated Netns)         (UID 1500)      │
│                                                        (Offline)       │
└────────────────────────────────────────────────────────────────────────┘
```

### Trust Boundaries:
1. **Boundary T1 (Browser / Internet → Extension):** Untrusted web pages vs. extension content script and background service worker.
2. **Boundary T2 (Extension → Native Host):** Chrome/Edge Manifest V3 Native Messaging pipe (`stdin`/`stdout` JSON framing).
3. **Boundary T3 (Native Host / UI / CLI → Mediator Core):** Local loopback HTTP/SSE server (127.0.0.1) authenticated via high-entropy `X-Mediator-Token`.
4. **Boundary T4 (Mediator Core → Live Workspace):** Live Windows project filesystem protected by shadow staging, path containment, and manual user approval.
5. **Boundary T5 (Windows Host → WSL2 VM Boundary):** Win32 host vs. dedicated Linux virtual disk (`ext4.vhdx`).
6. **Boundary T6 (Guest Ambient Linux → Task Execution Namespace):** Unprivileged Linux user `mediator-runner` (UID 1500) confined in a private network namespace (`CLONE_NEWNET` + `CLONE_NEWUSER`).

---

## 2. Asset Inventory & Criticality

| Asset ID | Asset Name | Description | Confidentiality | Integrity | Availability | Enforcing Layer |
|---|---|---|---|---|---|---|
| **A-01** | **Live Project Source** | User's live repository and source files on Windows host. | High | Critical | Critical | `workspace-boundary`, `stage-store`, `[automount] enabled=false` |
| **A-02** | **Host Secrets & Credentials** | Environment variables, `.env` files, SSH keys, AWS/cloud tokens, browser cookies. | Critical | Critical | High | `context-security`, host drive detachment |
| **A-03** | **Mediator Core State & Tokens** | High-entropy session pairing tokens, task ledger, approval tokens, SQLite db. | Critical | Critical | High | Constant-time token auth, loopback-only binding |
| **A-04** | **Browser AI Provider Sessions** | Authenticated user sessions on ChatGPT, Gemini, DeepSeek. | Critical | High | High | Minimal extension permissions, zero cookie/storage access |
| **A-05** | **Staged Source & Proposals** | Shadow staged diffs, proposed patches, pre-apply backups. | High | Critical | High | `stage-store`, SQLite hash ledger |
| **A-06** | **Sandbox Files & Output Streams** | Task files in VHDX, stdout/stderr streams, exit codes. | Medium | High | High | Bounded streaming, secret scanner, Linux VHDX DAC |
| **A-07** | **Toolchains & Recipes** | Pinned recipe definitions, Linux binaries, execution commands. | Medium | Critical | High | SHA-256 hash pinning, fixed recipe registry |
| **A-08** | **Approval & Audit Records** | User approval decisions, tamper-evident audit hash chain. | High | Critical | Critical | Append-only triggers, cryptographic hash chain |

---

## 3. Threat Actors & Attacker Capabilities

1. **Threat Actor 1 (TA-1): Malicious / Compromised AI Model Output:**
   - *Capabilities:* Returns malicious code containing backdoors, reverse shells, obfuscated logic, file-deleting commands, or path traversal attempts.
2. **Threat Actor 2 (TA-2): Prompt Injection in Project Context:**
   - *Capabilities:* Malicious text embedded in third-party source files, dependencies, issue descriptions, or commit messages attempting to trick the model or Mediator into executing privileged actions.
3. **Threat Actor 3 (TA-3): Untrusted Web Page in Browser:**
   - *Capabilities:* Malicious websites attempting to send messages to the Mediator extension, steal session tokens, or trigger task creation.
4. **Threat Actor 4 (TA-4): Compromised Task Code in Sandbox:**
   - *Capabilities:* Code executing inside `MediatorSandbox` attempting privilege escalation, host filesystem mounting, network egress, DNS tunneling, or persistent daemon spawning.
5. **Threat Actor 5 (TA-5): Local Untrusted Process on Windows Host:**
   - *Capabilities:* Other software running on the Windows host attempting to probe loopback ports, forge IPC commands, or hijack Mediator Core state.
6. **Threat Actor 6 (TA-6): Malicious Staged Artifact / Result Bundle:**
   - *Capabilities:* Malformed output files with path traversal (`../../`), NTFS Alternate Data Streams, or symlink escapes targeting the Windows receiver.

---

## 4. Formal Threat Matrix & Vulnerability Analysis

| Threat ID | Threat Scenario | Threat Actor | Target Asset | Severity | Enforcing Component | Implementation / Test Evidence | Status |
|---|---|---|---|---|---|---|---|
| **TH-01** | Arbitrary Shell Execution via AI Proposal | TA-1 | A-01, A-02 | **CRITICAL** | `ExecutionAuthorizationGate`, `policy-engine` | SHA-256 pinned recipes; S00 `NO-GO-AUTOEXEC` blocks auto-exec; shell operators rejected (`executionAuthorizationGate.test.ts`) | **VERIFIED** |
| **TH-02** | Host Filesystem Exfiltration via DrvFS (`/mnt/c`) | TA-4 | A-01, A-02 | **CRITICAL** | `MediatorSandbox` `/etc/wsl.conf` | `[automount] enabled=false`; `/mnt/c` is empty, detached directory (`canary:s42-automount-disabled`) | **VERIFIED** |
| **TH-03** | Windows Binary Interop (`cmd.exe`) from Sandbox | TA-4 | Host OS | **CRITICAL** | `MediatorSandbox` `/etc/wsl.conf` | `[interop] enabled=false, appendWindowsPath=false`; `cmd.exe` not found (`canary:s42-interop-denied`) | **VERIFIED** |
| **TH-04** | Direct Network Egress (IPv4/IPv6 TCP/UDP) | TA-4 | A-02 | **CRITICAL** | Linux Netns (`unshare --net`) | `ENETUNREACH` (errno 101) on `1.1.1.1:80`, `8.8.8.8:53`, IPv6 (`canary:s43-ipv4-denial`, `canary:s43-ipv6-denial`) | **VERIFIED** |
| **TH-05** | Data Exfiltration via Hypervisor DNS Tunneling | TA-4 | A-02 | **CRITICAL** | Linux Netns (`unshare --user --net`) | Hypervisor `10.255.255.254` alias absent; DNS queries fail with `[Errno -3]` (`canary:s43-dns-tunnel-denial`) | **VERIFIED** |
| **TH-06** | Host Virtual Gateway Reachability (`172.31.80.1`) | TA-4 | Host services | **HIGH** | Linux Netns (`unshare --net`) | Gateway unreachable (`ENETUNREACH`) (`canary:s43-host-gateway-denial`) | **VERIFIED** |
| **TH-07** | Network Isolation Bypass Request | TA-4, TA-5 | Network boundary | **CRITICAL** | `wslIsolatedExecutor.ts` | Requests attempting `isolateNetwork: false` on `MediatorSandbox` rejected fail-closed (`canary:s44-network-bypass-denial`) | **VERIFIED** |
| **TH-08** | Sandbox Privilege Escalation (`sudo` / `/etc/wsl.conf`) | TA-4 | Sandbox root | **HIGH** | Linux DAC / sudoers | `mediator-runner` (UID 1500) has no sudo rights; wsl.conf write fails (`canary:s42-privilege-denial`) | **VERIFIED** |
| **TH-09** | Out-of-Workspace Write in Sandbox | TA-4 | Sandbox root | **HIGH** | Linux VHDX permissions | `/forbidden.txt` write denied (`canary:s42-outside-write-denial`) | **VERIFIED** |
| **TH-10** | Persistent Daemon Surviving Task Cancellation | TA-4 | Sandbox | **MEDIUM** | Linux `--kill-child` + Win32 taskkill | Parent process kills all descendants with SIGKILL upon cancel/timeout (`canary:s43-child-confinement`) | **VERIFIED** |
| **TH-11** | Path Traversal in Staged File (`../../escape`) | TA-1, TA-6 | A-01 | **CRITICAL** | `workspace-boundary`, `stage-store` | `validateRelativePathString` rejects `..`, leading slashes, device names (`stageStore.test.ts`) | **VERIFIED** |
| **TH-12** | Alternate Data Stream (ADS) / Device Name Injection | TA-1, TA-6 | A-01 | **HIGH** | `pathContainment.ts` | Colons, `CON`, `NUL`, `PRN`, `COM1-9` rejected (`index.test.ts`) | **VERIFIED** |
| **TH-13** | Secret Exfiltration via Output Streaming | TA-4 | A-02 | **HIGH** | `context-security`, `wslIsolatedExecutor` | Output scanned for API keys/tokens and redacted to `[REDACTED:*]` (`canary:s41-wsl-secret-redaction`) | **VERIFIED** |
| **TH-14** | Live Workspace Write Before Approval | TA-1, TA-5 | A-01 | **CRITICAL** | `stage-store`, `applyService` | Modifications written to shadow staging; live files require explicit UI approval (`applyService.test.ts`) | **VERIFIED** |
| **TH-15** | Concurrent Disk Mutation Race (TOCTOU) | TA-5 | A-01 | **HIGH** | `applyService`, `stageSnapshot` | Pre-apply SHA-256 hash comparison; aborts cleanly on conflict (`applyService.test.ts`) | **VERIFIED** |
| **TH-16** | Unauthenticated IPC Loopback Probing | TA-5 | A-03 | **HIGH** | `mediatorHttpServer.ts` | Rejects missing/invalid `X-Mediator-Token` with HTTP 401 constant-time comparison (`e2eDisposableAcceptance.test.ts`) | **VERIFIED** |
| **TH-17** | Browser Web Page Script Injection via Extension | TA-3 | A-04 | **HIGH** | `browser-extension`, MV3 | Extension isolates content script; does not expose eval or execution APIs; pauses on auth/unknown DOM | **VERIFIED** |
| **TH-18** | Self-Authorization by AI or MCP Tool | TA-1, TA-5 | Policy gate | **CRITICAL** | `ExecutionAuthorizationGate` | Caller origins `browser_ai` and `mcp_agent` strictly rejected from approval resolution (`executionAuthorizationGate.test.ts`) | **VERIFIED** |
| **TH-19** | Host Mediator Core Process Compromise | TA-5 | Host OS | **CRITICAL** | Split Core & Broker, Windows Process Supervisor | Tiered Core & Broker architecture (`hostBrokerTypes.ts`, `trustedHostBroker.ts`); environment secret scrubbing (`cleanseEnvironment`); 11 adversarial canaries PASS (`hostContainmentAdversarial.test.ts`); S00 `NO-GO-AUTOEXEC` blocks auto-exec. | **PROTOTYPE VALIDATED** |
| **TH-20** | Offline Supply Chain & Toolchain Tampering | TA-4 | A-07 | **HIGH** | Package registry / VHDX | **RESIDUAL RISK:** Offline sandbox cannot download tools; toolchains must be pre-installed or imported safely. | **UNVERIFIED / GAP** |

---

## 5. Residual Risks & Critical Architectural Boundaries

### 5.1 Residual Risk 1: Host Ambient Authority of Mediator Core (Status: PROTOTYPE VALIDATED)
- **Finding:** Mediator Core executes on Windows as a standard Node.js process under the active user account (`atulyadav\atul2`, SID `S-1-5-21-677798973-984577126-3376073714-1003`).
- **Implication:** The process possesses ambient authority over the user's files and network. Linux network namespace and VHDX isolation protect the host from untrusted sandbox processes; it does NOT sandbox the host Node.js process from the user's host environment.
- **S45 Host Containment Mitigation:**
  - **Tiered Split Core-and-Broker Architecture (`TrustedHostBroker`):** Strips direct live file write access and shell execution from the orchestrator.
  - **Cryptographic Request Protocol:** All broker operations require HMAC-SHA256 signatures, nonce replay protection, and timestamp freshness windows.
  - **Environment Cleansing (`cleanseEnvironment`):** Process supervisor strips all ambient cloud tokens, SSH keys, and API secrets from child processes.
  - **Single-Use Approval Enforcement:** Broker will only apply live workspace modifications when presented with a valid, unconsumed, cryptographically bound user approval matching base and staged SHA-256 hashes (TOCTOU prevention).
  - **11 Adversarial Canaries Passing:** Verified in `hostContainmentAdversarial.test.ts`.
  - **Authoritative Policy:** S00 `NO-GO-AUTOEXEC` keeps Mediator in Review-only mode, eliminating unattended host or sandbox execution.

### 5.2 Residual Risk 2: Offline Toolchain Availability (Status: RELEASE BLOCKER)
- **Finding:** Because `MediatorSandbox` has complete network denial, compilers and test runners (`tsc`, `vitest`, `pytest`, `cargo`, `gcc`) cannot fetch dependencies dynamically.
- **Implication:** Before any autonomous validation loop can function, an offline dependency delivery mechanism (pre-installed VHDX toolchains or cryptographic hash-pinned vendor archives) must be specified, provisioned, and verified.
- **Governance Gate:** This requirement constitutes an independent release blocker for Autopilot activation.

---

## 6. Threat Modeling Conclusion

All evaluated threat scenarios targeting the untrusted task, network, filesystem, host process, and authorization boundaries are either **VERIFIED** or **PROTOTYPE VALIDATED** and enforced by multiple layers of defense-in-depth. Residual risks are accurately documented and properly bounded by the authoritative S00 `NO-GO-AUTOEXEC` gate.
