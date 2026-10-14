# External Independent Security Audit — Artifact & Documentation Manifest

**Release Candidate Target:** Mediator `v0.1.0-beta.1` (Review-only V1 Candidate Frozen)  
**Package Scope:** Chromium Native Messaging Host (`mediator-native-host.exe`), IPC Framing, Trust Boundaries, and Sandboxing  
**Audit Evaluation Posture:** `PENDING_EXTERNAL_REVIEW`  
**Security Policy Invariant:** S00 `NO-GO-AUTOEXEC` — Local Autopilot strictly **`BLOCKED`** fail-closed  
**Manifest Generation Timestamp:** 2026-10-14T02:11:00+05:30  

---

## 1. Candidate Source Revisions

| Candidate Designation | Source Revision / Working Tree | Native Host Binary SHA-256 | Purpose & Verification Scope |
|---|---|---|---|
| **Candidate A (Frozen Baseline)** | Commit `c55177400bd399adf05578ad80f8268f1173e371` | `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584` | Frozen baseline tag candidate `v0.1.0-beta.1`. |
| **Candidate B (Modified Beta Candidate)** | Working tree based on `c5517740...` with Windows NTFS EPERM fix, S52 structured trials, and audit documentation | `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584` | **Recommended handoff target (`v0.1.0-beta.1.post1`)**. Verified across all 1,074 tests (100% pass) with complete audit package. |

*Note: The native messaging host executable binary is bit-for-bit identical across Candidate A and Candidate B because `@mediator/native-host` does not depend on `@mediator/stage-store` or tests.*

---

## 2. Release Binary Artifact Manifest

| Property | Value |
|---|---|
| **Binary Artifact Path** | `packages/native-host/dist/mediator-native-host.exe` |
| **Installed User Path** | `%APPDATA%\Mediator\native-host\mediator-native-host.exe` |
| **File Size** | **90,250,240 bytes** (~86.07 MiB) |
| **SHA-256 Checksum** | `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584` |
| **Executable Packager** | Node.js Single Executable Application (SEA) via `esbuild` + `postject` |
| **Host Runtime Base** | Node.js v24.13.0 (win32-x64 PE32+ console executable) |
| **Operating System** | Windows 10 (Build 1809+) / Windows 11 (x64) |
| **Elevation Requirement** | None (Runs under standard user medium integrity level) |

---

## 3. Security Audit Package Documentation Manifest

The following files constitute the formal handoff package located in [`docs/security-audit-package/`](file:///c:/Users/Atul2/OneDrive/Desktop/Mediator/docs/security-audit-package/):

| File Name | Size (Bytes) | SHA-256 Checksum | Description & Scope |
|---|---|---|---|
| **`BINARY_PROVENANCE_AND_HASHES.md`** | 5,606 | `1F8D85B3CF14E65DF37961988BB6AC3B5A53466FB982641D3019E21ED3E9C9B4` | Detailed binary build specs, runtime injection details, candidate definitions, and manifest requirements. |
| **`THREAT_MODEL_AND_ARCHITECTURE.md`** | 7,688 | `17B84E9B53EC9245D961B989EC739BAD8444A20CA51BD356E39E5C53F806EA87` | System trust boundary architecture, 7 formal threat models (TM-NMH-01 through 07), and security assumptions. |
| **`REPRODUCIBLE_BUILD_AND_TEST_GUIDE.md`** | 2,916 | `F1B02D7300789E7A5C24A4550CA79A9073282943A8494C1CF38678F69F4A6160` | Step-by-step instructions to compile, package, install, test, and cleanly uninstall the native messaging host. |
| **`DEPENDENCY_SECURITY_REPORT.md`** | 4,486 | `17A46C9B4DB0ABA3BC2BF99EAEC1488C5617446DF6BA3E9CCF406E36E2F0EF40` | Full license audit, empirical `npm audit` results (14 devtooling vulnerabilities documented), and supply chain controls. |
| **`INTERNAL_ADVERSARIAL_TEST_EVIDENCE.md`** | 4,485 | `C40F4FE29F1B960CCFAC616DAB64B31DF30D3023A9244EAE6CA6BED6198F54C6` | Empirical test logs for 3 native host test suites (32/32 tests pass) with secret redactions. |
| **`AUDITOR_CHECKLIST_AND_ABUSE_CASES.md`** | 3,659 | `3B30907081F987E4EEB9D51A86D6BBEE51CA04E62C6128FDEE9ECB575A122290` | Checklist of 10 key auditor questions, expected behaviors, abuse test vectors, and reproduction steps. |
| **`sbom.cyclonedx.json`** | 611,136 | `B412D6187E1AC25CC97995092BA84213116B7A3F4F5F259AD249480425DEAF43` | Machine-readable CycloneDX v1.5 Software Bill of Materials. |
| **`sbom.spdx.json`** | 738,248 | `42F10119604ACF47A5DA7A2C84801A10D6951C760DDEAA5A91017E04A5C485E8` | Machine-readable SPDX 2.3 Software Bill of Materials. |

---

## 4. Auditor Hash Verification Procedure

Auditors can verify the integrity of all handoff artifacts using standard PowerShell or Node.js commands:

```powershell
# Verify Native Host Executable
(Get-FileHash -Algorithm SHA256 packages/native-host/dist/mediator-native-host.exe).Hash -eq "87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584"

# Verify Audit Package Files
Get-ChildItem -Path "docs/security-audit-package" | ForEach-Object {
    [PSCustomObject]@{
        File = $_.Name
        SHA256 = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash
    }
} | Format-Table -AutoSize
```

---

## 5. Sanitization & Privacy Attestation

In preparation for independent auditor transfer, this repository and audit package have been audited to ensure:
- **Zero Live Secrets:** No API keys, pairing tokens, or HMAC secrets are present in tracked files.
- **Zero Live Session Cookies or Profiles:** No browser cookies, session tokens, or profile storage included.
- **Redacted Internal Paths:** Diagnostic test fixtures use standardized sanitized paths (`/workspaces/test`, `%APPDATA%\Mediator`).
- **Fail-Closed Security Guardrails:** Local Autopilot remains strictly blocked; review-only V1 mode is permanently enforced across all code and configurations.
