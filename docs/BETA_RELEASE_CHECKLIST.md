# CONTROLLED BETA RELEASE CHECKLIST — SPRINT S50

**Release Candidate:** `v0.1.0-beta.1` (Review-only V1 Controlled Personal Beta)  
**Target Environment:** Windows 11 Home (Standard User), Dedicated `MediatorSandbox` WSL2  
**Security Governance:** S00 `NO-GO-AUTOEXEC` — **BLOCKED**  
**Evaluation Date:** October 2026  

---

## 1. Mandatory Pre-Beta Release Checklist

| # | Quality & Security Gate | Verification Criterion | Status | Evidence Reference |
| :---: | :--- | :--- | :---: | :--- |
| **1** | **Host Process Containment** | OS-level process boundary with unique PIDs, sanitized environment block, and stdio stream IPC. | ✅ **VERIFIED** | `packages/orchestrator/src/hostContainment/processIsolatedContainment.test.ts` (10/10 passed) |
| **2** | **Honest Boundary Documentation** | Distinguishes Review-only V1 process separation from kernel DACL multi-user sandboxing on standard Windows. | ✅ **VERIFIED** | `docs/HOST_PROCESS_CONTAINMENT_IMPLEMENTATION.md` |
| **3** | **Offline Dependency Resolution** | 3-stage resolver: trusted prep -> verification -> sandbox staging; zero dynamic network egress during tasks. | ✅ **VERIFIED** | `tests/offlineDependencyResolver.test.ts` (8/8 passed) |
| **4** | **Sandbox Network Namespace Isolation** | Mandatory `unshare --user --net` default-deny; zero network egress to internet or DNS tunnels. | ✅ **VERIFIED** | `tests/offlineToolchain.test.ts` (13/13 passed) |
| **5** | **Human Review & Staging Integrity** | All live workspace modifications require unconsumed approval token and matching base content hash. | ✅ **VERIFIED** | `tests/betaOperationalAcceptance.test.ts` (Scenario A & D) |
| **6** | **Native Messaging Security (Internal)** | 512 KiB frame limit, origin allowlist, prohibited shell commands rejected fail-closed. | ✅ **VERIFIED** | `packages/native-host/src/nativeHostSecurityAudit.test.ts` (12/12 passed) |
| **7** | **Independent External Audit** | Professional third-party penetration testing of Native Messaging Host binary & IPC. | ⏳ **PENDING** | `docs/NATIVE_MESSAGING_SECURITY_AUDIT.md` (`PENDING_EXTERNAL_REVIEW`) |
| **8** | **Zero Unresolved Critical Findings** | Zero open critical/high vulnerabilities; fail-closed behavior verified on all error paths. | ✅ **VERIFIED** | Full Monorepo Audit (0 errors, 0 warnings) |
| **9** | **Installer & Uninstaller Safety** | Reversible HKCU registry registration; preserves user's personal WSL distros (`Ubuntu`) and workspaces. | ✅ **VERIFIED** | `tests/install/windowsInstall.test.ts` (9/9 passed) |
| **10** | **Operational Acceptance Suite** | All 9 end-to-end scenarios (A through I) pass with live workspace integrity verification. | ✅ **VERIFIED** | `tests/betaOperationalAcceptance.test.ts` (9/9 passed) |
| **11** | **Platform Scope & Limitations Documented** | Supported projects matrix, toolchain constraints, and troubleshooting guidance published. | ✅ **VERIFIED** | `docs/SUPPORTED_PLATFORM_MATRIX.md`, `docs/KNOWN_LIMITATIONS.md` |
| **12** | **Autopilot Invariant Governance** | S00 `NO-GO-AUTOEXEC` remains authoritative; Autopilot status strictly `BLOCKED`. | ✅ **VERIFIED** | `docs/AUTOPILOT_READINESS_REVIEW.md`, `docs/SPRINT_STATUS.md` |

---

## 2. Beta Gate Verdict

- **Beta Rollout Recommendation:** **CONDITIONAL APPROVAL FOR CONTROLLED PERSONAL BETA**
- **Public Broad Distribution:** **NOT APPROVED (BLOCKED PENDING EXTERNAL SECURITY AUDIT)**
- **Permitted Operational Scope:**
  - Standard user on Windows 11 Home.
  - Review-only V1 mode with explicit human approval for every diff apply.
  - Node.js (with `package-lock.json`) and Python (with pinned `requirements.txt`) projects.
  - Dedicated `MediatorSandbox` WSL2 distribution only.
