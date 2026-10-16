# External Security Auditor Qualification & Selection Checklist

**Candidate Target:** Mediator `v0.1.0-beta.1.post1` (`228e974fc11ee0f1ce71939d4d3e038c82918a21`)  
**Purpose:** Objective evaluation framework for selecting a qualified, independent third-party cybersecurity firm to conduct the formal security audit of Mediator.  
**Policy Invariant:** S00 `NO-GO-AUTOEXEC` — Independent third-party audit clearance is mandatory prior to public release.  
**Date:** 2026-10-14  

---

## 1. Distinction: Independent Security Auditor vs General Testing / Automated Scanning

To ensure rigorous security evaluation, Mediator project governance explicitly distinguishes between a qualified **Independent Security Auditor** and general software testing entities or automated vulnerability scanning tools:

| Attribute | Automated Vulnerability Scanner | General QA / Software Testing Firm | Independent Application Security Auditor |
|---|---|---|---|
| **Primary Method** | Automated SAST/DAST pattern matching | Functional test case execution and UX validation | Threat modeling, manual code review, and adversarial exploit development |
| **Logic Flaw Discovery** | Poor (blind to architectural design flaws and IPC state machines) | Incidental (focuses on functional bugs, not abuse vectors) | **High** (specifically probes trust boundary breaks, TOCTOU, origin spoofing) |
| **Native Messaging & IPC** | Inapplicable (cannot simulate Chrome stdio or Windows named pipes) | Limited to black-box manual operation | **Deep technical verification** of 32-bit framing, memory allocation, and token validation |
| **Sandbox Analysis** | None | Manual validation against test plan | **Kernel namespace isolation audit** (`CLONE_NEWNET`, seccomp, WSL2 boundary inspection) |
| **Independence & Bias** | Neutral but superficial | Often aligned with development deliverables | **Strictly independent**, contractually bound to disclose all findings without bias |
| **Acceptable for Release Gate?** | **NO** (Automated scanning alone is rejected fail-closed) | **NO** (QA testing does not satisfy security release gates) | **YES** (Mandatory prerequisite for public release) |

> [!IMPORTANT]
> **No Vendor Endorsement Claim:**  
> This checklist defines objective qualification criteria. No specific security vendor, consultancy, or individual is currently certified, contracted, or pre-approved by the Mediator project. Vendor selection requires verifiable evidence evaluated against this checklist.

---

## 2. Mandatory Auditor Qualification Domains

A prospective auditing firm or lead evaluator must satisfy all eight qualification domains:

### Domain 1: Independent Security Assessment Track Record
- [ ] **1.1 Institutional Independence:** The firm operates as an autonomous third-party cybersecurity consultancy with no financial interest, equity ownership, or commercial dependency on the Mediator project.
- [ ] **1.2 Proven Audit Experience:** Demonstrated history of performing publicly disclosed or verifiable private commercial application security assessments, penetration tests, and source code audits.
- [ ] **1.3 Verifiable References:** Ability to provide sanitized client references or published CVE advisories credited to the firm's security researchers.

### Domain 2: Windows Desktop Application & Process Security
- [ ] **2.1 Windows Security Architecture:** Demonstrated expertise in Windows process security boundaries, Medium Integrity Level execution, User Account Control (UAC), and user-space privilege models.
- [ ] **2.2 Inter-Process Communication (IPC):** Proven experience assessing Windows Named Pipes, local loopback transports, access control lists (DACLs), and resistance to local unprivileged privilege escalation.
- [ ] **2.3 Windows Filesystem Hardening:** Familiarity with Windows-specific filesystem attacks, including Alternate Data Streams (ADS), reserved DOS device names, 8.3 short name collisions, junction points, and symlink TOCTOU races.

### Domain 3: Chromium Extensions & Native Messaging Host Security
- [ ] **3.1 Chromium Extension Security Model:** Deep technical knowledge of Manifest V3, content script isolation, background service workers, and extension permission models.
- [ ] **3.2 Native Messaging Protocol:** Hands-on experience analyzing Chromium Native Messaging implementations (`chrome.runtime.connectNative`), 32-bit length-prefixed stdio framing, buffer allocation boundaries, and denial-of-service vulnerabilities.
- [ ] **3.3 Extension Identity & Origin Validation:** Track record evaluating origin spoofing, unauthorized extension message injection, and Windows registry host registration (`HKCU\Software\Google\Chrome\NativeMessagingHosts`).

### Domain 4: Node.js, Supply Chain & Dependency Analysis
- [ ] **4.1 Node.js Runtime Security:** Experience analyzing asynchronous event loop security, child process invocation, and single-executable application (SEA) injection mechanisms.
- [ ] **4.2 Software Bill of Materials (SBOM) Ingestion:** Ability to audit and cross-reference CycloneDX v1.5 and SPDX 2.3 SBOMs against active package lockfiles.
- [ ] **4.3 CVE Contextual Risk Evaluation:** Demonstrated ability to distinguish exploitable runtime vulnerabilities from unexploitable or non-reachable development-tooling CVEs (e.g., assessing the 14 reported devtooling dependencies).

### Domain 5: Threat Modeling & Adversarial Testing
- [ ] **5.1 Formal Threat Modeling:** Capability to review, challenge, and extend architectural threat models (e.g., validating or finding gaps in threat models TM-NMH-01 through TM-NMH-07).
- [ ] **5.2 Adversarial Exploit Development:** Methodology prioritizing active exploit development (producing working proof-of-concept exploits) rather than theoretical conjecture.
- [ ] **5.3 Fuzzing Capabilities:** Experience deploying protocol and IPC fuzzers against binary input streams and JSON deserialization boundaries.

### Domain 6: Linux Sandbox & Network Namespace Isolation
- [ ] **6.1 Linux Kernel Namespaces:** Technical capability to audit Linux namespace isolation, including network namespaces (`CLONE_NEWNET`), user namespaces, mount namespaces, and unshare boundaries.
- [ ] **6.2 WSL2 Architecture:** Understanding of Windows Subsystem for Linux 2 (WSL2) hypervisor boundaries, 9P / virtio-fs filesystem bridges, and host interop channels (`/init`, `binfmt_misc`).
- [ ] **6.3 Egress Restriction Verification:** Capability to independently test for DNS leaks, hypervisor proxy routing bypasses, and out-of-band network egress attempts.

### Domain 7: Documented Reporting & Retest Process
- [ ] **7.1 Standardized Severity Scoring:** Uses standard vulnerability rating frameworks (CVSS v3.1 or CVSS v4.0) with clearly defined criteria for Critical, High, Medium, Low, and Informational tiers.
- [ ] **7.2 Actionable Technical Reports:** Delivers comprehensive reports containing executive summaries, reproduction steps, code snippet references, and remediation guidance.
- [ ] **7.3 Formal Retesting Phase:** Contractual commitment to perform retesting of developer remediations within an agreed timeframe (e.g., 30–60 days post-report) and issue an updated attestation.

### Domain 8: Confidentiality, Integrity & Ethical Governance
- [ ] **8.1 Strict Non-Disclosure Agreement (NDA):** Willingness to execute a binding mutual NDA prior to receiving unredacted code, binaries, or technical specifications.
- [ ] **8.2 Secure Data Handling:** Industry-standard operational security for storing client source code, test binaries, and vulnerability draft reports (e.g., encrypted at rest, access-controlled, secure erasure upon engagement completion).
- [ ] **8.3 Conflict of Interest Disclosure:** Written attestation affirming the firm has no financial, personal, or advisory conflicts of interest with the Mediator project or direct competitors.
- [ ] **8.4 Coordinated Vulnerability Disclosure:** Adherence to standard responsible disclosure timelines (e.g., 90-day coordinated disclosure policy) to allow remediation prior to public disclosure.

---

## 3. Evaluation & Selection Scoring Rubric

Each candidate firm must be scored across the 8 domains:

| Evaluation Tier | Requirement | Selection Disposition |
|---|---|---|
| **Tier 1 (Mandatory Prerequisite)** | Satisfies all 8 domains with verified prior experience in Windows desktop security, Chromium Native Messaging, and threat modeling. | **Eligible for Engagement** |
| **Tier 2 (Deficient Technical Focus)** | General web application penetration tester lacking Windows desktop, Chromium Native Messaging, or Linux namespace expertise. | **Disqualified** |
| **Tier 3 (Automated Only)** | Reliance primarily on automated scanners without dedicated manual code review and exploit verification. | **Disqualified** |
| **Tier 4 (Conflict / Insecure)** | Unwilling to execute NDA, refuses retesting, or exhibits unresolved conflicts of interest. | **Strictly Rejected** |

---

## 4. Auditor Intake Decision Record

*(To be completed by Project Security Governance upon reviewing auditor proposals)*

| Field | Evaluation Record |
|---|---|
| **Auditing Firm Name:** | `[Pending Proposal Submission]` |
| **Lead Evaluator(s):** | `[Pending Proposal Submission]` |
| **Domain 1–8 Verification Result:** | `[ ] FULLY QUALIFIED / [ ] INCOMPLETE / [ ] REJECTED` |
| **Conflict of Interest Review:** | `[ ] CLEARED / [ ] CONFLICT IDENTIFIED` |
| **NDA Execution Date:** | `[Pending]` |
| **Selection Verdict:** | `[ ] APPROVED FOR HANDOFF / [ ] REJECTED` |
| **Approving Governance Lead:** | Mediator Project Governance |
| **Date:** | `[Pending]` |
