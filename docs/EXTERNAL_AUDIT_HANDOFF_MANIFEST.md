# External Independent Security Audit — Artifact & Documentation Manifest

- **Release Candidate Target:** Mediator `v0.1.0-beta.1.post1` (Immutable Audit Snapshot)
- **Baseline Revision:** Commit `c55177400bd399adf05578ad80f8268f1173e371` (`v0.1.0-beta.1` frozen baseline)
- **Candidate Git Commit SHA:** `228e974fc11ee0f1ce71939d4d3e038c82918a21`
- **Candidate Annotated Tag:** `v0.1.0-beta.1.post1`
- **Package Scope:** Chromium Native Messaging Host (`mediator-native-host.exe`), IPC Framing, Trust Boundaries, Sandboxing, and Monorepo Source
- **Audit Evaluation Posture:** `PENDING_EXTERNAL_REVIEW`
- **Public Release Status:** `STRICTLY BLOCKED PENDING INDEPENDENT AUDIT SIGN-OFF`
- **Security Policy Invariant:** S00 `NO-GO-AUTOEXEC` — Local Autopilot strictly **`BLOCKED`** fail-closed
- **Manifest Generation Timestamp:** 2026-10-14T09:48:00+05:30

---

## 1. Candidate Source Revisions & Audit Target Identification

| Candidate Designation | Source Revision / Branch / Tag | Native Host Binary SHA-256 | Purpose & Verification Scope |
|---|---|---|---|
| **Candidate A (Frozen Baseline)** | Commit `c55177400bd399adf05578ad80f8268f1173e371` | `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584` | Frozen baseline commit `v0.1.0-beta.1`. Preserved completely unaltered. |
| **Candidate B (Immutable Audit Snapshot)** | Commit `228e974fc11ee0f1ce71939d4d3e038c82918a21`<br>Branch: `audit/v0.1.0-beta.1.post1`<br>Tag: `v0.1.0-beta.1.post1` | `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584` | **Authoritative handoff target (`v0.1.0-beta.1.post1`)**. Verified across all 1,074 tests (100% pass) in isolated clean-room worktree with complete audit package. |

*Note: The native messaging host executable binary is bit-for-bit identical across Candidate A and Candidate B because `@mediator/native-host` depends exclusively on `@mediator/shared-contracts`, `@mediator/ipc-core`, `@mediator/protocol`, `@mediator/content-transfer`, `@mediator/persistence`, and `zod`. It does not bundle or depend on `@mediator/stage-store` or tests.*

---

## 2. Release Binary Artifact Manifest

| Property | Value | Notes |
|---|---|---|
| **Binary Artifact Path** | `packages/native-host/dist/mediator-native-host.exe` | Compiled PE32+ standalone binary |
| **Installed User Path** | `%APPDATA%\Mediator\native-host\mediator-native-host.exe` | User runtime path (HKCU registration) |
| **File Size** | **90,250,240 bytes** (~86.07 MiB) | Node v24.13.0 base + injected SEA blob |
| **SHA-256 Checksum** | `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584` | Verified identical on disk across all checkouts |
| **Executable Packager** | Node.js Single Executable Application (SEA) via `esbuild` + `postject` | Standard Node.js SEA injection recipe |
| **Host Runtime Base** | Node.js v24.13.0 (win32-x64 PE32+ console executable) | Sourced from `process.execPath` |
| **Target OS / Arch** | Windows 10 (Build 1809+) / Windows 11 (x64) | Tested on Windows 11 Build 26300 |
| **Privilege Requirement** | Standard User (Medium Integrity Level) | **Zero administrator elevation required** |

### 2.1 Provenance Distinction (Verified vs Inferred)
- **Verified Provenance:** The binary is present, functionally verified across 32 security tests (`packages/native-host/src/packagedHost.test.ts`, `nativeHostSecurityAudit.test.ts`, and `nativeHost.test.ts`), and independently calculated to match SHA-256 `87FCB987...` and size 90,250,240 bytes.
- **Inferred Provenance & Deterministic Build Limitation:** Node.js SEA injection via `postject` embeds the host PE headers and system timestamps. Deterministic byte-for-byte rebuilding across arbitrary machines requires bit-identical host Node.js binaries. For this reason, the exact, verified binary artifact is directly included in the portable audit archive for independent auditor examination.

---

## 3. Security Audit Package Documentation Manifest

The following files constitute the formal handoff package located in [`docs/security-audit-package/`](file:///c:/Users/Atul2/OneDrive/Desktop/Mediator/docs/security-audit-package/):

| File Name | Size (Bytes) | SHA-256 Checksum | Description & Scope |
|---|---|---|---|
| **`BINARY_PROVENANCE_AND_HASHES.md`** | 7,859 | `0CAFD7047FC52571C1BBEE54F34BACF081DF349653B4E58760163F41F32BD83B` | Binary build specs, SEA injection details, candidate definitions, verified vs inferred provenance, and manifest specifications. |
| **`THREAT_MODEL_AND_ARCHITECTURE.md`** | 7,688 | `17B84E9B53EC9245D961B989EC739BAD8444A20CA51BD356E39E5C53F806EA87` | System trust boundary architecture, 7 formal threat models (TM-NMH-01 through 07), and security assumptions. |
| **`REPRODUCIBLE_BUILD_AND_TEST_GUIDE.md`** | 2,916 | `F1B02D7300789E7A5C24A4550CA79A9073282943A8494C1CF38678F69F4A6160` | Step-by-step instructions to compile, package, install, test, and cleanly uninstall the native messaging host. |
| **`DEPENDENCY_SECURITY_REPORT.md`** | 4,486 | `17A46C9B4DB0ABA3BC2BF99EAEC1488C5617446DF6BA3E9CCF406E36E2F0EF40` | Full license audit, empirical `npm audit` findings (14 devtooling vulnerabilities documented), and supply chain controls. |
| **`INTERNAL_ADVERSARIAL_TEST_EVIDENCE.md`** | 4,485 | `C40F4FE29F1B960CCFAC616DAB64B31DF30D3023A9244EAE6CA6BED6198F54C6` | Empirical test logs for 3 native host test suites (32/32 tests pass) with secret redactions. |
| **`AUDITOR_CHECKLIST_AND_ABUSE_CASES.md`** | 3,659 | `3B30907081F987E4EEB9D51A86D6BBEE51CA04E62C6128FDEE9ECB575A122290` | Checklist of 10 key auditor questions, expected behaviors, abuse test vectors, and reproduction steps. |
| **`sbom.cyclonedx.json`** | 611,136 | `B412D6187E1AC25CC97995092BA84213116B7A3F4F5F259AD249480425DEAF43` | Machine-readable CycloneDX v1.5 Software Bill of Materials. |
| **`sbom.spdx.json`** | 738,248 | `42F10119604ACF47A5DA7A2C84801A10D6951C760DDEAA5A91017E04A5C485E8` | Machine-readable SPDX 2.3 Software Bill of Materials. |

---

## 4. Quality Gate Verification Record (Commit `228e974fc11ee0f1ce71939d4d3e038c82918a21`)

All quality gates were executed independently in an isolated worktree checkout at commit `228e974fc11ee0f1ce71939d4d3e038c82918a21`:

| Gate | Execution Command | Result | Details |
|---|---|---|---|
| **Clean Install** | `npm ci` | **PASS** | 269 packages added, zero install errors; 14 devtooling vulnerabilities flagged and documented. |
| **Linter** | `npm run lint` | **PASS** | `eslint . --ext .ts` exited with 0 errors and 0 warnings. |
| **Type Check** | `npm run typecheck` | **PASS** | `tsc -b` exited with 0 errors across all monorepo packages and apps. |
| **Production Build** | `npm run build` | **PASS** | Topological build completed cleanly without warnings. |
| **Platform Doctor** | `node apps/cli/dist/index.js doctor` | **PASS** | 11/11 checks [READY], Overall Status: HEALTHY, Autopilot Policy: BLOCKED. |
| **Native Host Security** | `npx vitest run packages/native-host` | **PASS** | 3 test files, 32 passed, 0 failed (100%). |
| **Browser & Provider Core** | `npx vitest run packages/provider-core apps/ide-extension` | **PASS** | 7 test files, 158 passed, 0 failed (100%). |
| **Full Regression Suite** | `npm test` | **PASS** | **57 test files, 1,074 passed, 0 failed (100%)**, duration 99.58s. |

---

## 5. Software Supply Chain & Vulnerability Disclosures

### 5.1 SBOM Generation & Identities
- **CycloneDX SBOM:** Generated using `@cyclonedx/cyclonedx-npm` v1.19.2 adhering to CycloneDX v1.5 JSON schema (`docs/security-audit-package/sbom.cyclonedx.json`).
- **SPDX SBOM:** Generated using `@spdx/spdx-sbom-generator` adhering to SPDX 2.3 JSON specification (`docs/security-audit-package/sbom.spdx.json`).
- **Generation Inputs:** `package.json`, `package-lock.json`, workspace topological packages in `packages/*` and `apps/*`.

### 5.2 Known Vulnerabilities & Unresolved Limitations
- **Devtooling CVEs (14 total):** `npm audit` reports 14 vulnerabilities restricted entirely to development tooling:
  - `tinypool` (dev dependency of Vitest test runner)
  - `braces` (indirect dev dependency of build tools)
  - `esbuild` (dev dependency bundler)
  - **Zero runtime vulnerabilities** exist in production runtime code or dependencies (`zod` is clean).
  - These findings are intentionally preserved and disclosed rather than suppressed via unreviewed `--force` upgrades.
- **Deterministic Rebuild Limitation:** Standalone PE32+ Node.js SEA injection embeds host PE metadata. Exact byte-for-byte binary reconstruction requires an identical host Node runtime environment.
- **Sandbox Requirement:** Hardened Linux kernel namespace isolation requires a provisioned WSL2 environment (`MediatorSandbox`). On systems without WSL2, the platform fails closed to Review-only mode.

---

## 6. Portable Audit Archive Specification

The delivered portable audit archive encapsulates the complete, reproducible candidate source and verified binary:

- **Archive File:** `mediator-audit-candidate-v0.1.0-beta.1.post1.zip`
- **File Size:** `34,883,806 bytes` (~33.27 MiB)
- **SHA-256 Hash:** `171C756DDFCF51A9E1D4035A35E9E45F44F8049DE2133ECD25947ABFAC74BD23`
- **Checksum File:** `mediator-audit-candidate-v0.1.0-beta.1.post1.zip.sha256`
- **Contents Included:**
  - Complete monorepo source (`packages/*`, `apps/*`, `tsconfig.json`, `package.json`, `package-lock.json`, `vitest.config.ts`)
  - All test suites (`tests/`, unit/integration tests in packages and apps)
  - Operational scripts (`scripts/install-windows.ps1`, `scripts/uninstall-windows.ps1`, `scripts/prepare-wsl2-sandbox.ps1`, `scripts/dev-runner.mjs`)
  - Full audit materials (`docs/security-audit-package/*`, manifests, checklists, ADRs)
  - Exact compiled native host binary (`packages/native-host/dist/mediator-native-host.exe`)
- **Exclusions:**
  - `.git` directory and Git internal objects
  - `node_modules/` (reproduced cleanly via `npm ci`)
  - Intermediate build artifacts (`dist/` directories, except for the native host binary)
  - Ad-hoc machine-specific debug scripts (`scripts/check-*.mjs`, etc.)
  - Private credentials, `.env` files, browser profile directories, and OS temporary files

---

## 7. Auditor Hash Verification Procedure

Auditors can verify the integrity of all handoff artifacts using standard PowerShell or Node.js commands:

```powershell
# 1. Verify Native Host Executable
(Get-FileHash -Algorithm SHA256 packages/native-host/dist/mediator-native-host.exe).Hash -eq "87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584"

# 2. Verify Audit Package Files
Get-ChildItem -Path "docs/security-audit-package" | ForEach-Object {
    [PSCustomObject]@{
        File = $_.Name
        SHA256 = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash
    }
} | Format-Table -AutoSize

# 3. Verify Portable Audit Archive
(Get-FileHash -Algorithm SHA256 mediator-audit-candidate-v0.1.0-beta.1.post1.zip).Hash -eq "171C756DDFCF51A9E1D4035A35E9E45F44F8049DE2133ECD25947ABFAC74BD23"
```

---

## 8. Governance Invariant & Independent Audit Posture

- **S00 `NO-GO-AUTOEXEC`:** Local Autopilot is strictly **`BLOCKED`** fail-closed.
- **Review-Only V1 Mode:** All proposed code edits require explicit, single-use, out-of-band user approval before live workspace files can be touched.
- **Third-Party Review Required:** Internal quality gates and test passes do not constitute independent security approval.
- **Status:** **`PENDING_EXTERNAL_REVIEW`**. Public distribution remains strictly prohibited until formal independent audit evaluation is completed.
