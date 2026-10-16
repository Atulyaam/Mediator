# Binary Provenance, Cryptographic Hashes & Build Specification

**Release Candidate Target:** Mediator `v0.1.0-beta.1` (Review-only V1 Candidate Frozen)  
**Package:** `@mediator/native-host`  
**Target Binary Artifact:** `packages/native-host/dist/mediator-native-host.exe`  
**Security Status:** `PENDING_EXTERNAL_REVIEW` (Internal Verification Complete)  
**Security Policy Invariant:** S00 `NO-GO-AUTOEXEC` remains authoritative  

---

## 1. Binary Identification & Cryptographic Fingerprints

| Property | Value | Notes |
|---|---|---|
| **File Name** | `mediator-native-host.exe` | Standalone Chromium Native Messaging Host |
| **Relative Path** | `packages/native-host/dist/mediator-native-host.exe` | Compiled distribution target |
| **Installed Path** | `%APPDATA%\Mediator\native-host\mediator-native-host.exe` | User-level runtime path |
| **File Size** | **90,250,240 bytes** (~86.07 MiB) | Node.js host executable + injected SEA blob |
| **SHA-256 Hash** | `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584` | Cryptographic fingerprint verified on disk |
| **Format** | Windows Portable Executable (PE32+ / 64-bit console) | Subsystem: Windows CUI |
| **Target Architecture** | x86_64 / win32-x64 | Microsoft Windows 64-bit |
| **Minimum OS** | Windows 10 (Version 1809+, Build 17763) / Windows 11 | Tested on Windows 11 Build 26300 |
| **Privilege Requirement** | Standard User (Medium Integrity Level) | **Zero administrator elevation required** |

---

## 2. Source Provenance & Build Environment

| Build Property | Specification | Details |
|---|---|---|
| **Source Commit SHA** | `c55177400bd399adf05578ad80f8268f1173e371` | Baseline commit in repository history |
| **Git Branch** | `main` | Working branch |
| **Compiler / Bundler** | TypeScript 5.9.3 (`tsc -b`) + `esbuild` 0.24.x | Bundles `packages/native-host/src/index.ts` to `dist/nativeHost.cjs` |
| **Executable Packager** | **Node.js Single Executable Application (SEA)** | Standard Node.js SEA injection via `postject` |
| **Runtime Base** | Node.js v24.13.0 (win32-x64) | Copied from `process.execPath` (89,953,280 bytes) |
| **Injected SEA Blob** | `dist/sea-prep.blob` (296,960 bytes) | Generated via `node --experimental-sea-config` |
| **Injection Tool** | `npx postject` (v1.0.0-alpha.6) | Injected into PE resource section `NODE_SEA_BLOB` |
| **Build Script** | `packages/native-host/scripts/buildExecutable.mjs` | Deterministic local build recipe |

> [!NOTE]
> **Packaging Reconciliation:**  
> Early architectural design drafts explored `@yao-pkg/pkg` (which produced ~41.4 MiB binaries under Node 20). The production implementation standardized on Node.js native SEA (`scripts/buildExecutable.mjs`) embedding Node v24.13.0. The actual file size is 90,250,240 bytes and the verified SHA-256 hash is `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584`.

---

## 3. Dependency Scope & Decoupling from Stage Store

An essential architectural integrity finding established during Sprint S53 is that `@mediator/native-host` has a minimal, strictly isolated dependency footprint:

- **Bundled Internal Packages:** `@mediator/shared-contracts`, `@mediator/ipc-core`, `@mediator/protocol`, `@mediator/content-transfer`, `@mediator/persistence`.
- **External Runtime Dependency:** `zod` (`v3.25.76`).
- **Decoupled Packages:** `@mediator/stage-store` and `@mediator/orchestrator` are **NOT** bundled into `mediator-native-host.exe`.

Therefore, workspace edits to `packages/stage-store/src/stageStorage.ts` (e.g., Windows NTFS `EPERM` copy fallbacks) do **not** affect `mediator-native-host.exe` or its binary hash.

---

## 4. Candidate Classification

To maintain audit rigor, two candidate definitions are formally cataloged:

### Candidate A — Frozen Baseline
- **Source Revision:** Commit `c55177400bd399adf05578ad80f8268f1173e371`
- **Native Host Binary:** `mediator-native-host.exe` (SHA256: `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584`, 90,250,240 bytes)
- **Role:** The historical frozen baseline for v0.1.0-beta.1.

### Candidate B — Immutable Audit Snapshot (v0.1.0-beta.1.post1)
- **Source Revision:** Dedicated branch `audit/v0.1.0-beta.1.post1` at commit **`228e974fc11ee0f1ce71939d4d3e038c82918a21`** (Parent: `c55177400bd399adf05578ad80f8268f1173e371`)
- **Annotated Git Tag:** **`v0.1.0-beta.1.post1`**
- **Changes from Baseline:**
  1. Windows NTFS file locking robustness fix in `packages/stage-store/src/stageStorage.ts`.
  2. 10 structured real-world beta qualification scenarios in `tests/s52StructuredBetaTrials.test.ts`.
  3. Machine-readable SBOMs (CycloneDX & SPDX) and sanitized security audit handoff materials in `docs/security-audit-package/`.
- **Native Host Binary:** **Identical** `mediator-native-host.exe` (SHA256: `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584`, 90,250,240 bytes).
- **Role:** Primary immutable audit target for independent security evaluation. All 57 test files (1,074 tests) pass 100% on this exact commit.

---

## 4.1 Provenance Verification vs Inferred Provenance

To maintain strict audit integrity, this document explicitly distinguishes between **verified provenance** and **inferred provenance**:

1. **Verified Provenance:**
   - **Artifact Presence & Checksum:** The binary `packages/native-host/dist/mediator-native-host.exe` is verified on disk with cryptographic SHA-256 hash `87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584` and byte length of `90,250,240 bytes`.
   - **Functional Verification:** The artifact runs directly against live stdin/stdout tests in `packages/native-host/src/packagedHost.test.ts` (3 tests pass), validating framing, origin enforcement, ping response, and stderr separation.
   - **Monorepo Integration:** Passes all 32 native host security tests and all 1,074 monorepo tests.
   - **Source Decoupling:** Static and dynamic inspection confirm that `@mediator/native-host` bundles only `@mediator/shared-contracts`, `@mediator/ipc-core`, `@mediator/protocol`, `@mediator/content-transfer`, `@mediator/persistence`, and `zod`. Edits to `stageStorage.ts` or test suites do not touch the native host package.

2. **Inferred Provenance & Deterministic Rebuild Limitations:**
   - **Build Process Recipe:** Packaging relies on Node.js Single Executable Application (SEA) using `postject` to inject `dist/sea-prep.blob` into a copy of `process.execPath` (`node.exe`).
   - **Rebuild Non-Determinism:** Node.js SEA injection embeds the host Node binary's PE headers, timestamps, and ASLR base addresses. Bit-for-bit identical binary rebuilding from source across different machines is not deterministically guaranteed unless the identical host `node.exe` (Node v24.13.0 win32-x64 build) and injection toolchain state are used.
   - **Auditor Provision:** The exact, verified binary artifact (`mediator-native-host.exe`) is bundled directly in the portable audit archive so that independent auditors can inspect the precise PE32+ executable without having to reconstruct the exact Node.js SEA build environment.

---

## 5. Manifest Specification

Chromium and Microsoft Edge Native Messaging Hosts require a JSON manifest registered in the Windows Registry (`HKCU\Software\Google\Chrome\NativeMessagingHosts` and `HKCU\Software\Microsoft\Edge\NativeMessagingHosts`):

```json
{
  "name": "com.mediator.native_host",
  "description": "Mediator Local Chromium Native Messaging Host",
  "path": "%APPDATA%\\Mediator\\native-host\\mediator-native-host.exe",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://abcdefghijklmnopponmlkjihgfedcba/"
  ]
}
```

> [!IMPORTANT]
> **Zero Wildcard Enforcement:**
> The manifest specifies exact 32-character extension IDs. Wildcards (`*` or `chrome-extension://*/*`) are strictly rejected fail-closed during registration and runtime validation.
