# Formal Request for Independent Third-Party Security Audit

**Target Product:** Mediator  
**Target Candidate:** `v0.1.0-beta.1.post1` (Candidate B — Immutable Audit Snapshot)  
**Parent Baseline Commit:** `c55177400bd399adf05578ad80f8268f1173e371` (`v0.1.0-beta.1` frozen baseline)  
**Target Git Commit SHA:** `228e974fc11ee0f1ce71939d4d3e038c82918a21`  
**Dedicated Git Branch:** `audit/v0.1.0-beta.1.post1`  
**Annotated Git Tag:** `v0.1.0-beta.1.post1`  
**Native Messaging Host Binary SHA-256:** `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584` (90,250,240 bytes)  
**Portable Audit Archive SHA-256:** `171C756DDFCF51A9E1D4035A35E9E45F44F8049DE2133ECD25947ABFAC74BD23` (34,883,806 bytes)  
**Security Governance Invariant:** S00 `NO-GO-AUTOEXEC` — Local Autopilot strictly **`BLOCKED`** fail-closed; Review-only V1 mode enforced  
**Audit Evaluation Posture:** `PENDING_EXTERNAL_REVIEW`  
**Public Distribution Status:** `STRICTLY BLOCKED PENDING INDEPENDENT AUDIT CLEARANCE`  
**Date of Request:** 2026-10-14  

---

## 1. Product Overview & Intended Usage

Mediator is a local-first, fail-closed desktop bridge connecting AI coding assistants (e.g., Google Gemini, OpenAI ChatGPT, DeepSeek, and Anthropic Claude) to a developer's local filesystem and developer tools.

### Intended Architecture & Operation
- **Review-Only V1 Architecture:** In version 1, Mediator operates strictly in a **human-in-the-loop review mode**. AI providers propose code changes, which are captured across a browser extension or API connection and staged into an isolated shadow staging area (`packages/stage-store`). Proposed modifications are never applied to live user workspace files without an explicit, cryptographic, single-use user approval issued through the Mediator UI or CLI.
- **Fail-Closed Autopilot Policy:** Under architectural policy decision S00 `NO-GO-AUTOEXEC`, autonomous execution (Local Autopilot) is completely disabled. All policy evaluation gates fail closed.
- **Inter-Process Architecture:**
  1. **Chromium Browser Extension (`apps/browser-extension`):** Ingests code snippets and unified diffs from AI provider web sessions.
  2. **Native Messaging Host (`packages/native-host/dist/mediator-native-host.exe`):** A standalone Windows console executable invoked by Chromium over standard I/O (stdin/stdout) via 32-bit length-prefixed protocol.
  3. **Local Loopback Named-Pipe & HTTP Broker (`packages/ipc-core` & `packages/orchestrator`):** Communicates with the native messaging host and UI clients over authenticated loopback pipes (`\\.\pipe\mediator-ipc-*`) or `127.0.0.1` HTTP using cryptographically unguessable single-use pairing tokens.
  4. **Isolated Sandbox Execution (`packages/executor-contract`):** Untrusted code validation and test canaries execute inside a dedicated, non-default WSL2 Linux distribution (`MediatorSandbox`) with host Windows drives unmounted and network namespaces severed (`CLONE_NEWNET`).

---

## 2. Independent Verification Mandate

> [!IMPORTANT]
> **Independent Verification Required:**  
> The independent security auditor is explicitly requested to **independently test, verify, and attempt to falsify all security claims** rather than relying on project documentation or internal test reports. Internal test evidence provided in this repository is strictly disclosed as historical internal baseline data, not as third-party certified fact.

---

## 3. Candidate Identification & Cryptographic Fingerprints

The auditor must perform all security assessments against the exact, immutable candidate identity:

| Identity Parameter | Verified Value | Verification Command |
|---|---|---|
| **Release Version** | `v0.1.0-beta.1.post1` | `node apps/cli/dist/index.js --version` |
| **Git Commit SHA** | `228e974fc11ee0f1ce71939d4d3e038c82918a21` | `git rev-parse HEAD` |
| **Git Branch** | `audit/v0.1.0-beta.1.post1` | `git branch --show-current` |
| **Annotated Git Tag** | `v0.1.0-beta.1.post1` | `git describe --tags --exact-match` |
| **Native Host Binary Path** | `packages/native-host/dist/mediator-native-host.exe` | — |
| **Native Host Size** | **90,250,240 bytes** (~86.07 MiB) | `(Get-Item packages/native-host/dist/mediator-native-host.exe).Length` |
| **Native Host SHA-256** | `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584` | `(Get-FileHash -Algorithm SHA256 packages/native-host/dist/mediator-native-host.exe).Hash` |
| **Portable Archive File** | `mediator-audit-candidate-v0.1.0-beta.1.post1.zip` | — |
| **Portable Archive Size** | **34,883,806 bytes** (~33.27 MiB) | `(Get-Item mediator-audit-candidate-v0.1.0-beta.1.post1.zip).Length` |
| **Portable Archive SHA-256** | `171C756DDFCF51A9E1D4035A35E9E45F44F8049DE2133ECD25947ABFAC74BD23` | `(Get-FileHash -Algorithm SHA256 mediator-audit-candidate-v0.1.0-beta.1.post1.zip).Hash` |
| **Archive Checksum File** | `mediator-audit-candidate-v0.1.0-beta.1.post1.zip.sha256` | `Get-Content mediator-audit-candidate-v0.1.0-beta.1.post1.zip.sha256` |

---

## 4. Assessment Objectives & Scope

### 4.1 In-Scope Focus Areas

1. **Chromium Native Messaging Host Security (`mediator-native-host.exe`):**
   - **32-Bit Frame Length Handling:** Frame decoding in `packages/native-host/src/framing.ts`. Resistance to integer overflows, negative lengths, allocation exhaustion, and buffer manipulation exceeding the 512 KiB internal limit and 1 MiB Chromium limit.
   - **Origin Validation & Zero-Wildcard Enforcement:** Origin verification in `packages/native-host/src/originValidator.ts`. Strict verification of `chrome-extension://<32_char_id>/` format; rejection of wildcards, non-Chromium URI schemes, and unauthorized extension IDs.
   - **Command Injection Denial:** Verification that the native host executable exposes **zero** capabilities to spawn arbitrary host command lines, PowerShell, cmd.exe, or batch scripts.
   - **Registry & Permission Footprint:** Verification that registry registration scripts (`scripts/install-windows.ps1`) target Current User (`HKCU`) only, requiring zero administrative or UAC elevation.

2. **IPC Framing, Authentication & Replay Protection:**
   - **Pairing Token Security:** Unguessable token generation, validation, expiration, and single-use enforcement in `packages/ipc-core/src/pairingManager.ts`.
   - **Named-Pipe Access Control:** Loopback-only binding (`\\.\pipe\mediator-ipc-*`) and resistance to unauthorized local inter-process tampering.
   - **Replay Attack Resistance:** Rejection of expired tokens, replayed nonces, or mismatched payload hashes.

3. **Workspace Boundary & Staging Defense:**
   - **Path Traversal & Windows Path Normalization:** Path containment defenses in `packages/workspace-boundary/src/pathContainment.ts`. Rejection of dot-dot (`..`) traversal, Windows Alternate Data Streams (`file.txt:hidden`), DOS 8.3 short names, and reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`).
   - **Staging Isolation:** Assurance that AI proposals remain staged in shadow directories and cannot modify live workspace files prior to valid user approval.
   - **TOCTOU Pre-Apply Integrity:** Verification of pre-apply base hash validation in `packages/stage-store/src/handoffService.ts` to detect concurrent live file mutations.

4. **Linux Sandbox Isolation & Network Severance:**
   - **Dedicated WSL2 Environment:** Confinement of untrusted command recipes to the dedicated `MediatorSandbox` distribution, never touching the default Linux distribution (`Ubuntu`).
   - **Host Drive Isolation:** Verification that Windows drive automounting (`/mnt/c`) is unmounted/disabled in `MediatorSandbox`.
   - **Network Namespace Severance:** Evaluation of `CLONE_NEWNET` network isolation, ensuring outbound IPv4/IPv6 connections, DNS queries, and hypervisor proxy traffic fail closed (`ENETUNREACH`).

5. **Software Supply Chain & Vulnerability Analysis:**
   - Review of `docs/security-audit-package/sbom.cyclonedx.json` and `sbom.spdx.json`.
   - Assessment of the 14 documented development-tooling vulnerabilities in `tinypool`, `braces`, and `esbuild` regarding whether their call paths can be reached in production runtime.

### 4.2 Explicitly Out-of-Scope Areas

To ensure focused allocation of auditor effort, the following areas are excluded from this assessment:
- **Third-Party AI Model Safety & Hallucinations:** The semantic accuracy, prompt responses, or coding logic generated by external LLMs (OpenAI, Google, DeepSeek, Anthropic).
- **External Web API Infrastructure:** The external cloud servers and TLS endpoints operated by OpenAI, Google, Anthropic, or DeepSeek.
- **Physical Device Theft & Kernel Compromise:** Scenarios where an attacker possesses local administrator/SYSTEM privileges or physical kernel debugger access on the host workstation. (As documented, Mediator runs as a standard user process and does not claim kernel isolation against a malicious local administrator).

---

## 5. Threat Model Summary & Key Architectural Assumptions

The complete threat model is detailed in [`docs/security-audit-package/THREAT_MODEL_AND_ARCHITECTURE.md`](file:///c:/Users/Atul2/OneDrive/Desktop/Mediator/docs/security-audit-package/THREAT_MODEL_AND_ARCHITECTURE.md). Seven specific threat vectors are identified:

| Threat ID | Threat Description | Architectural Mitigation |
|---|---|---|
| **TM-NMH-01** | Malformed Native Messaging Frame (Buffer Overflow / DoS) | Strict 4-byte prefix validation; hard 512 KiB chunk limit; fail-closed disconnect. |
| **TM-NMH-02** | Extension Origin Spoofing / Malicious Web Page Hijack | Strict 32-character extension ID check; zero wildcards allowed; command-line initialization lock. |
| **TM-NMH-03** | Unauthorized Local IPC Tampering | Ephemeral cryptographically unguessable pairing tokens; single-use tokens; loopback pipe isolation. |
| **TM-NMH-04** | Arbitrary Command Execution via Native Host | Native host exposes zero command execution APIs; rejects `.bat` and `.cmd` wrappers fail-closed. |
| **TM-NMH-05** | Privilege Escalation via Windows Registry | Registry keys write exclusively to `HKCU`; runs at standard user Medium Integrity Level; zero UAC prompt. |
| **TM-NMH-06** | Secret Token Leakage via Diagnostic Logs | Automated redaction of API keys, pairing tokens, and bearer credentials in all logging/stderr streams. |
| **TM-NMH-07** | Workspace Path Traversal & Live File Overwrite | Shadow staging directory isolation; canonical path containment; Alternate Data Stream and DOS device blocking. |

### Architectural Security Assumptions
1. **Host Operating System Integrity:** The Windows OS kernel and Chromium browser installation are assumed uncompromised.
2. **Single-User Security Boundary:** Processes executing under the same Windows standard user account share access to user-space resources. Process isolation provides defense-in-depth against accidental corruption and sandboxing against untrusted code, not kernel-level multi-tenant separation.
3. **Fail-Closed Default:** If any network, origin, token, or hash check cannot be definitively validated, the platform immediately aborts the operation and refuses execution.

---

## 6. Disclosed Vulnerabilities & Known Limitations

The project provides full transparency regarding all known findings:

### 6.1 Disclosed Development-Tooling Vulnerabilities (14 Total)
Full details are provided in [`docs/security-audit-package/DEPENDENCY_SECURITY_REPORT.md`](file:///c:/Users/Atul2/OneDrive/Desktop/Mediator/docs/security-audit-package/DEPENDENCY_SECURITY_REPORT.md):
- **`tinypool` (Moderate):** Dev-dependency of Vitest test framework.
- **`braces` (High):** Transitive dev-dependency within TypeScript tooling.
- **`esbuild` (Moderate):** Dev-dependency bundler used in executable preparation.
- **Runtime Assessment:** Production runtime dependencies consist solely of `zod`. Zero runtime vulnerabilities exist. The development-tooling vulnerabilities were intentionally preserved and disclosed rather than masked with unreviewed bulk upgrades.

### 6.2 Known Operational Limitations
- **Claude Manual Handoff Mode:** Anthropic Claude integration currently operates exclusively via manual clipboard handoff with explicit user confirmation.
- **Browser DOM Drift:** Browser web-session adapters (Gemini, DeepSeek, ChatGPT) rely on DOM element structures which may require maintenance when provider web interfaces change.
- **Deterministic Rebuild Limitation:** Node.js SEA binaries embed host PE headers and timestamps, preventing deterministic byte-for-byte rebuilding across differing Node.js environments. The exact verified binary is provided for analysis.

---

## 7. Internal Baseline Evidence (For Context Only)

Internal test evidence is cataloged in [`docs/security-audit-package/INTERNAL_ADVERSARIAL_TEST_EVIDENCE.md`](file:///c:/Users/Atul2/OneDrive/Desktop/Mediator/docs/security-audit-package/INTERNAL_ADVERSARIAL_TEST_EVIDENCE.md). This evidence demonstrates internal test results across the exact candidate commit (`228e974`):
- Monorepo test suites: **57 test files, 1,074 tests passing (100% PASS, 0 failures)**.
- Native host security tests: **3 test files, 32 passed**.
- Platform preflight doctor: **11/11 checks [READY], HEALTHY**.

*Notice: This internal evidence is provided solely to document the test harness established by the development team. The auditor is expected to execute their own independent test cases.*

---

## 8. Expected Auditor Deliverables

The prospective auditor is requested to deliver the following items upon completion of the engagement:

1. **Formal Written Security Assessment Report:**
   - Executive summary outlining overall architectural security posture.
   - Detailed technical findings cataloging all discovered vulnerabilities, logic flaws, or boundary weaknesses.
2. **Vulnerability Severity Classification:**
   - Clear severity rankings according to standard methodology (e.g., CVSS v3.1 / v4.0: Critical, High, Medium, Low, Informational).
3. **Reproducible Proof-of-Concept (PoC) Evidence:**
   - Step-by-step reproduction instructions and exploit scripts for every identified vulnerability.
4. **Actionable Remediation Guidance:**
   - Concrete, code-level recommendations to remediate or mitigate each finding.
5. **Retest & Verification Sign-Off:**
   - Re-evaluation of remediations provided by the development team and issuance of an updated final clearance attestation.

---

## 9. Submission & Contact Information

Please direct audit proposals, scoping questions, and formal reports to:
- **Project Security Contact:** `security@mediator.local` (or designated project security representative)
- **Encryption:** Secure channel or PGP key provided upon proposal confirmation.
