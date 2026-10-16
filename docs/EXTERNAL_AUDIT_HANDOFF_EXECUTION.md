# External Security Audit — Handoff Execution & Transfer Guide

**Target Candidate:** Mediator `v0.1.0-beta.1.post1`  
**Git Commit SHA:** `228e974fc11ee0f1ce71939d4d3e038c82918a21`  
**Git Tag:** `v0.1.0-beta.1.post1`  
**Portable Archive:** `mediator-audit-candidate-v0.1.0-beta.1.post1.zip`  
**Archive SHA-256:** `171C756DDFCF51A9E1D4035A35E9E45F44F8049DE2133ECD25947ABFAC74BD23`  
**Document Purpose:** Operational protocol for secure packaging, cryptographic verification, receipt acknowledgment, authorized testing, emergency vulnerability reporting, and retest execution.  
**Date:** 2026-10-14  

---

## 1. Secure Package Delivery Protocol

To maintain chain-of-custody and prevent in-transit tampering, the audit package must be transferred using secure, encrypted channels:

### 1.1 Recommended Transfer Methods
1. **Encrypted Cloud Transfer (Primary):**
   - Transferred via an encrypted, authenticated storage channel (e.g., end-to-end encrypted file sharing, SFTP, or access-restricted repository).
   - Checksum file transmitted out-of-band (e.g., via a separate encrypted messaging channel or PGP-signed email).
2. **Direct PGP-Encrypted Archive:**
   - The archive may be encrypted to the lead auditor's public PGP key prior to transfer.
3. **Physical Media Handover (Air-Gapped Option):**
   - Cryptographically hashed and copied to a sealed, read-only USB storage device delivered directly to the audit team.

> [!CAUTION]
> **Zero Live Credentials Invariant:**  
> In accordance with project security hygiene policies, this handoff package contains **zero** real API keys, pairing tokens, active browser profile data, session cookies, or personal user information. If any live secret is ever detected, testing must halt immediately and be reported to project security governance.

---

## 2. Recipient Cryptographic Verification Procedure

Upon receiving the audit bundle, the auditor or recipient must verify the integrity of the archive before unpacking or inspecting files:

### Step 1: Verify Portable Archive Checksum
Run standard PowerShell or Linux CLI tools to compute the SHA-256 hash of `mediator-audit-candidate-v0.1.0-beta.1.post1.zip`:

```powershell
# Windows PowerShell
$expectedHash = "171C756DDFCF51A9E1D4035A35E9E45F44F8049DE2133ECD25947ABFAC74BD23"
$actualHash = (Get-FileHash -Path "mediator-audit-candidate-v0.1.0-beta.1.post1.zip" -Algorithm SHA256).Hash
if ($actualHash -eq $expectedHash) {
    Write-Host "ARCHIVE VERIFIED: Hash matches ($actualHash)" -ForegroundColor Green
} else {
    Write-Error "INTEGRITY VIOLATION: Expected $expectedHash but got $actualHash"
}
```

```bash
# Linux / macOS
echo "171C756DDFCF51A9E1D4035A35E9E45F44F8049DE2133ECD25947ABFAC74BD23  mediator-audit-candidate-v0.1.0-beta.1.post1.zip" | sha256sum --check
```

### Step 2: Verify Native Host Binary Hash
Unpack the archive and verify the standalone native messaging host executable:

```powershell
# Windows PowerShell
$expectedBinHash = "87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584"
$actualBinHash = (Get-FileHash -Path "packages/native-host/dist/mediator-native-host.exe" -Algorithm SHA256).Hash
$actualBinSize = (Get-Item "packages/native-host/dist/mediator-native-host.exe").Length

Write-Host "Native Host Binary SHA-256: $actualBinHash (Matches: $($actualBinHash -eq $expectedBinHash))"
Write-Host "Native Host Binary Size:    $actualBinSize bytes (Expected: 90250240)"
```

### Step 3: Verify Source Repository Commit (If Cloned from Git)
If the auditor is reviewing directly from an isolated Git clone:

```bash
# Verify Commit and Parent
git rev-parse HEAD
# Output must match: 228e974fc11ee0f1ce71939d4d3e038c82918a21

git rev-parse HEAD~1
# Output must match: c55177400bd399adf05578ad80f8268f1173e371

git describe --tags --exact-match
# Output must match: v0.1.0-beta.1.post1
```

---

## 3. Package Inventory & Verification Checklist

The recipient must confirm receipt of all required components:

| Component | Path | Verified Size | Documented SHA-256 | Received? |
|---|---|---|---|---|
| **Audit Archive** | `mediator-audit-candidate-v0.1.0-beta.1.post1.zip` | 34,883,806 bytes | `171C756DDFCF51A9E1D4035A35E9E45F44F8049DE2133ECD25947ABFAC74BD23` | `[ ]` |
| **Archive Checksum** | `mediator-audit-candidate-v0.1.0-beta.1.post1.zip.sha256` | 116 bytes | Checksum file | `[ ]` |
| **Native Host Binary** | `packages/native-host/dist/mediator-native-host.exe` | 90,250,240 bytes | `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584` | `[ ]` |
| **Audit Request Spec** | `docs/EXTERNAL_SECURITY_AUDIT_REQUEST.md` | Complete text | Scope and objectives | `[ ]` |
| **Handoff Manifest** | `docs/EXTERNAL_AUDIT_HANDOFF_MANIFEST.md` | Complete text | Full handoff manifest | `[ ]` |
| **Auditor Checklist** | `docs/EXTERNAL_AUDIT_HANDOFF_CHECKLIST.md` | Complete text | Verification checklist | `[ ]` |
| **Binary Provenance** | `docs/security-audit-package/BINARY_PROVENANCE_AND_HASHES.md` | 7,859 bytes | `0CAFD7047FC52571C1BBEE54F34BACF081DF349653B4E58760163F41F32BD83B` | `[ ]` |
| **Threat Model** | `docs/security-audit-package/THREAT_MODEL_AND_ARCHITECTURE.md` | 7,688 bytes | `17B84E9B53EC9245D961B989EC739BAD8444A20CA51BD356E39E5C53F806EA87` | `[ ]` |
| **Build & Test Guide** | `docs/security-audit-package/REPRODUCIBLE_BUILD_AND_TEST_GUIDE.md` | 2,916 bytes | `F1B02D7300789E7A5C24A4550CA79A9073282943A8494C1CF38678F69F4A6160` | `[ ]` |
| **Dependency Report** | `docs/security-audit-package/DEPENDENCY_SECURITY_REPORT.md` | 4,486 bytes | `17A46C9B4DB0ABA3BC2BF99EAEC1488C5617446DF6BA3E9CCF406E36E2F0EF40` | `[ ]` |
| **Adversarial Evidence**| `docs/security-audit-package/INTERNAL_ADVERSARIAL_TEST_EVIDENCE.md` | 4,485 bytes | `C40F4FE29F1B960CCFAC616DAB64B31DF30D3023A9244EAE6CA6BED6198F54C6` | `[ ]` |
| **Abuse Cases Guide** | `docs/security-audit-package/AUDITOR_CHECKLIST_AND_ABUSE_CASES.md` | 3,659 bytes | `3B30907081F987E4EEB9D51A86D6BBEE51CA04E62C6128FDEE9ECB575A122290` | `[ ]` |
| **CycloneDX SBOM** | `docs/security-audit-package/sbom.cyclonedx.json` | 611,136 bytes | `B412D6187E1AC25CC97995092BA84213116B7A3F4F5F259AD249480425DEAF43` | `[ ]` |
| **SPDX SBOM** | `docs/security-audit-package/sbom.spdx.json` | 738,248 bytes | `42F10119604ACF47A5DA7A2C84801A10D6951C760DDEAA5A91017E04A5C485E8` | `[ ]` |
| **Monorepo Source** | `packages/*`, `apps/*`, `tests/*`, `package.json` | Monorepo source | 270 reviewed files included in candidate | `[ ]` |

---

## 4. Written Authorization to Test & Scope Agreement

Before initiating adversarial testing, penetration testing, or reverse engineering, both parties must formally execute this authorization:

```
AUTHORIZATION TO CONDUCT SECURITY ASSESSMENT

Project:       Mediator (Desktop AI-to-Workspace Bridge)
Target:        v0.1.0-beta.1.post1 (Commit 228e974fc11ee0f1ce71939d4d3e038c82918a21)
Client:        Mediator Project Governance
Auditor:       [Auditor Name / Consultancy]
Scope:         Chromium Native Messaging Host, IPC, Workspace Boundary, WSL2 Sandbox, SBOM
Exclusions:    Third-party LLM cloud APIs, production web servers, hardware-level physical attacks

The Mediator Project hereby authorizes [Auditor Name] to perform technical security evaluations,
fuzzing, adversarial testing, and source code review against the specified target in accordance
with the agreed Rules of Engagement and Mutual NDA.

Authorized By: ____________________________________    Date: ________________________
               (Mediator Project Governance Lead)

Accepted By:   ____________________________________    Date: ________________________
               (Lead Security Evaluator)
```

---

## 5. Vulnerability Disclosure & Emergency Escalation Protocol

If the audit team identifies a **Critical** or **High** severity finding (specifically: arbitrary host code execution without user approval, unauthorized live workspace write, or total sandbox escape):

1. **Immediate Notification:** Report within 24 hours to the primary security contact:
   - **Contact Email:** `security@mediator.local`
   - **Emergency Subject Line:** `[CRITICAL SECURITY FINDING] Mediator Audit — [Brief Title]`
   - **Encrypted Transmission:** Use established PGP public key or secure portal.
2. **Finding Details Required:**
   - Vulnerability title and CVSS score.
   - Affected source file and line numbers.
   - Step-by-step reproduction instructions.
   - Working proof-of-concept (PoC) exploit or test script.
   - Initial remediation recommendation.
3. **Embargo & Coordinated Disclosure:** All findings remain under strict non-disclosure during the audit and remediation period (minimum 90 days from initial report unless mutually agreed).

---

## 6. Report Format & Retest Acceptance Criteria

### 6.1 Report Deliverable Structure
The auditor's report must include:
1. **Executive Summary:** High-level posture assessment, methodology overview, and overall risk summary.
2. **Scope & Methodology Statement:** Clear record of targets evaluated, testing tools used, and testing constraints.
3. **Findings Matrix:** Standardized table listing ID, Title, Severity (Critical, High, Medium, Low, Informative), Affected Component, and Status.
4. **Detailed Technical Findings:** Root cause analysis, code trace, reproduction steps, proof of concept, and specific code-level remediation steps.
5. **Architectural Observations:** Strategic hardening suggestions not qualifying as discrete vulnerabilities.

### 6.2 Retest Acceptance Criteria
- Upon delivery of the initial report, the Mediator development team will author remediations in dedicated branches.
- The auditor will conduct retesting within an agreed window (typically 14–30 business days).
- A finding is marked **CLOSED / RESOLVED** only when:
  1. The proof-of-concept exploit no longer succeeds.
  2. The code fix does not introduce secondary regressions or violate core governance invariants (S00 `NO-GO-AUTOEXEC`, Review-only V1 mode).
  3. The auditor issues a formal, written Retest Attestation Letter.

---

## 7. Engagement Tracking Record

*(To be maintained as engagement progresses)*

| Record Field | Active Status / Details |
|---|---|
| **Auditor / Consultancy Name:** | `[Pending Engagement Selection]` |
| **Lead Security Evaluator:** | `[Pending Engagement Selection]` |
| **Agreed Assessment Scope:** | Native Messaging Host, IPC, Boundary, Sandbox, Dependencies |
| **Mutual NDA Execution Date:** | `[Pending]` |
| **Package Handover Date:** | `[Pending]` |
| **Package Verification Confirmed:** | `[ ] YES / [ ] PENDING` |
| **Testing Window (Start / End):** | `[Pending]` |
| **Initial Report Delivery Date:** | `[Pending]` |
| **Remediation Phase:** | `[Pending]` |
| **Retest Completion Date:** | `[Pending]` |
| **Final Audit Sign-Off Status:** | `[ ] PENDING / [ ] APPROVED / [ ] BLOCKED` |
