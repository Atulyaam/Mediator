# External Security Audit — Request for Proposal (RFP) Outreach Draft

**Document Status:** Ready-to-Send Outreach Template  
**Target Candidate:** Mediator `v0.1.0-beta.1.post1` (`228e974fc11ee0f1ce71939d4d3e038c82918a21`)  
**Usage:** Copy and dispatch to prospective independent cybersecurity audit consultancies.  
**Date:** 2026-10-14  

---

## Outreach Email Template

**Subject:** Request for Proposal (RFP): Independent Security Audit of Mediator Desktop AI Bridge (Windows / Native Messaging / Sandbox)

**To:** `[Prospective Security Firm / Security Practice Lead]`  
**From:** Mediator Project Security Governance (`security@mediator.local`)  

---

Dear `[Auditor Team / Name]`,

The Mediator Project is soliciting formal proposals from qualified, independent application security consultancies to conduct a third-party security assessment of **Mediator** (`v0.1.0-beta.1.post1`), a local-first desktop bridge connecting AI coding assistants to local developer workspaces.

Mediator is architected around a strict fail-closed, review-only governance policy (S00 `NO-GO-AUTOEXEC`), where AI-generated code proposals are staged in shadow memory and can never modify live workspace files without explicit, out-of-band user approval. Our release policy strictly mandates that public distribution remains blocked until an independent third-party security audit is completed and any resulting critical or high findings are remediated and verified.

### Core Architecture & Assessment Focus Areas
1. **Windows Native Messaging Host (`mediator-native-host.exe`):**
   - Standalone PE32+ console executable built via Node.js Single Executable Application (SEA) using `postject`.
   - 32-bit length-prefixed stdio framing, buffer bounds enforcement (512 KiB / 1 MiB hard Chromium limit).
   - Strict origin validation (`chrome-extension://<32_char_id>/`) with zero wildcard tolerance.
   - Rejection of command execution and batch wrappers; standard user (Medium Integrity Level) execution requiring zero administrative elevation.
2. **Local IPC Framing & Authentication:**
   - Loopback named pipes (`\\.\pipe\mediator-ipc-*`) authenticated via ephemeral, cryptographically unguessable pairing tokens.
   - Replay protection, token expiration, and single-use enforcement.
3. **Workspace Boundary & Staging Security:**
   - Path containment preventing directory traversal (`..`), Alternate Data Streams (ADS), and DOS 8.3 collisions.
   - Shadow staging isolation and TOCTOU pre-apply hash checks.
4. **WSL2 Isolated Linux Sandbox:**
   - Execution of untrusted code inside dedicated `MediatorSandbox` with host Windows drives (`/mnt/c`) unmounted and network namespaces severed (`CLONE_NEWNET`).
5. **Software Supply Chain & Dependency Audit:**
   - Review of CycloneDX v1.5 and SPDX 2.3 SBOMs.
   - Contextual risk analysis of 14 disclosed development-tooling vulnerabilities (`tinypool`, `braces`, `esbuild`) relative to runtime attack surfaces.

### Target Artifact & Prepared Package
The audit package is completely prepared, frozen, and cryptographically verified:
- **Version:** `v0.1.0-beta.1.post1`
- **Git Commit SHA:** `228e974fc11ee0f1ce71939d4d3e038c82918a21`
- **Tag:** `v0.1.0-beta.1.post1`
- **Native Host Binary SHA-256:** `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584` (90,250,240 bytes)
- **Portable Audit Archive SHA-256:** `171C756DDFCF51A9E1D4035A35E9E45F44F8049DE2133ECD25947ABFAC74BD23` (34,883,806 bytes)
- **Internal Baseline Evidence:** 57 test files, 1,074 tests passing (100% pass) fresh on this exact commit. Complete architectural specifications, threat models (TM-NMH-01 to 07), and reproducible build guides are bundled.

---

### Requested Proposal Information
We invite your firm to submit a proposal detailing:

1. **Relevant Experience & References:**
   - Proven track record evaluating Windows desktop software, Chromium Native Messaging Hosts, IPC protocols, and Linux sandbox isolation.
   - Sanitized sample reports or public audit references.
2. **Proposed Assessment Scope & Methodology:**
   - Proposed balance between manual code review, dynamic fuzzing, protocol inspection, and adversarial exploit attempts.
3. **Estimated Timeline & Pricing:**
   - Estimated person-days or assessment duration.
   - Commercial fee structure (fixed-price engagement or time-and-materials estimate).
   - Earliest available testing start window.
4. **Required Access & Testing Environment:**
   - Details regarding required auditor test environments (e.g., Windows 11 host with WSL2 enabled, Chromium browser).
5. **Deliverables & Severity Rating Scheme:**
   - Format of the final report, executive summary, and severity classification system (e.g., CVSS v3.1 / v4.0).
6. **Retest & Remediation Support:**
   - Terms and timelines for reviewing developer fixes and conducting retests to verify issue closure.
7. **Confidentiality & Coordinated Disclosure:**
   - Mutual Non-Disclosure Agreement (NDA) execution terms.
   - Coordinated vulnerability disclosure policy (standard 90-day embargo).

### Next Steps
If your team is interested and available to undertake this assessment, please confirm receipt of this RFP and provide your standard mutual NDA or proposal documentation. Upon NDA execution, we will transfer the complete verified audit bundle and cryptographic checksums.

We look forward to receiving your response.

Sincerely,  
**Mediator Project Security Governance**  
`security@mediator.local`
