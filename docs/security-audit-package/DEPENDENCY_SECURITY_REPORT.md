# Dependency Security, License & SBOM Audit Report

**Audit Target:** Mediator `v0.1.0-beta.1` Monorepo Dependencies  
**Report Date:** 2026-10-14T02:06:00+05:30  
**Tooling Environment:** npm v11.6.2 | Node.js v24.13.0 | Windows 11 (win32-x64)  
**Security Policy Invariant:** S00 `NO-GO-AUTOEXEC` remains authoritative  
**Audit Finding Status:** 14 Devtooling Vulnerabilities Documented; 0 Runtime Host Vulnerabilities  

---

## 1. Software Bill of Materials (SBOM)

Two machine-readable SBOM formats were generated directly from the pinned `package-lock.json` manifest:

1. **CycloneDX JSON Format:** [`docs/security-audit-package/sbom.cyclonedx.json`](file:///c:/Users/Atul2/OneDrive/Desktop/Mediator/docs/security-audit-package/sbom.cyclonedx.json) (611 KiB)
   - Specification: CycloneDX v1.5 Schema
   - Coverage: All direct workspace packages, dependencies, and transitive packages.
2. **SPDX JSON Format:** [`docs/security-audit-package/sbom.spdx.json`](file:///c:/Users/Atul2/OneDrive/Desktop/Mediator/docs/security-audit-package/sbom.spdx.json) (738 KiB)
   - Specification: SPDX 2.3 JSON Schema
   - Package count: Complete dependency tree including runtime and build-time packages.

---

## 2. Dependency License Audit

All dependencies across workspace packages were analyzed for permissive licensing conformance:

| Dependency Classification | Common Licenses Found | Permissible for Distribution | Commercial / Personal Use |
|---|---|---|---|
| **Direct Runtime Dependencies** | MIT, ISC, Apache-2.0, BSD-3-Clause | **YES** | Permitted without source disclosure obligation |
| **Development Tooling** | MIT, Apache-2.0, BSD-2-Clause | **YES** | Internal build/test tools only |
| **Copyleft Licenses (GPL/AGPL)**| **0 packages detected** | N/A | Zero contamination detected |

### Primary Runtime Dependencies & Licenses
- `zod` (`v3.25.76`): **MIT License**
- `ws` (`v8.18.0`): **MIT License**

---

## 3. Vulnerability Audit & Empirical Findings

An empirical scan was executed using `npm audit --audit-level=high`:

```
# npm audit report summary
14 vulnerabilities (2 moderate, 10 high, 2 critical)
Affected dependencies: braces, micromatch, fast-glob, globby, @typescript-eslint/*, esbuild, vite, vite-node, vitest, tinypool
```

### 3.1 Detailed Vulnerability Breakdown

| Package | Severity | Advisory / CVE | Introduced Via | Production Impact |
|---|---|---|---|---|
| **`tinypool`** `<=2.1.1` | **Critical** | GHSA-5gmw-xhrv-c9v3<br>GHSA-85c8-ppgw-ccpr | `vitest` (Dev tooling) | **None.** Used strictly in test harness execution; never bundled into runtime binary. |
| **`braces`** `*` | **High** | GHSA-vfj7-8cjw-p6xm | `@typescript-eslint/parser` (Dev tooling via globby) | **None.** Static analysis AST parser dependency; never bundled into runtime binary. |
| **`esbuild`** `<=0.24.2` | **Moderate** | GHSA-67mh-4wv8-2f99 | `vite` / `vitest` dev server | **None.** Dev server feature; mediator-native-host uses esbuild CLI bundling only, no live dev server. |

### 3.2 Audit Policy & Non-Suppression Commitment

In accordance with Sprint S53 release candidate integrity principles:
1. **No Silent Upgrades:** Dependencies were **NOT** forcibly modified via `npm audit fix --force` during candidate freeze, as upgrading `@typescript-eslint/parser` to `8.71.2` constitutes a breaking change that risks AST linting instability.
2. **Zero Runtime Impact:** The production artifact `mediator-native-host.exe` bundles only `@mediator/shared-contracts`, `@mediator/ipc-core`, and `zod`. It contains **zero** runtime dependencies on `vitest`, `tinypool`, or `@typescript-eslint`.
3. **Auditor Action Item:** Independent auditors are asked to evaluate whether updating devtooling (`vitest` 3.x / `@typescript-eslint` 8.x) should be scheduled for a post-audit development sprint.

---

## 4. Supply Chain Protections & Isolation Controls

1. **Pinned Lockfile:** Every package version in `package-lock.json` is pinned with exact SHA-512 cryptographic subresource integrity hashes.
2. **Network-Isolated Build & Execution:** Untrusted tasks and offline toolchain recipes execute under strict Linux network namespace isolation (`CLONE_NEWNET`), preventing runtime network fetching.
3. **Offline Dependency Resolver:** Mediator's `OfflineDependencyResolver` bundles and seals packages in `.mediator/bundles/` prior to sandbox execution.
4. **No Dynamic In-Band Installs:** Dynamic `npm install` inside task execution is strictly denied fail-closed (`ENETUNREACH`).
