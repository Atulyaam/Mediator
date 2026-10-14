# ADR-029: Offline Toolchain & Dependency Supply Chain Pipeline

**Status:** Accepted  
**Date:** 2026-10-12  
**Context:** Sprint S46 — Offline Toolchain & Dependency Supply Chain  
**Deciders:** Mediator Engineering Architecture Team  
**Governing Policy:** S00 `NO-GO-AUTOEXEC` — Review-only V1 mode active

---

## 1. Context and Problem Statement

Mediator's dedicated execution environment (`MediatorSandbox`) enforces strict network default-deny isolation via Linux network namespaces (`CLONE_NEWNET`). In Sprint S43 and S44, this isolation was certified as complete, successfully blocking public IPv4/IPv6 egress and hypervisor DNS proxy tunnels.

However, modern software development workflows rely heavily on external package repositories (`npmjs.org`, `pypi.org`). Because network access is strictly disabled inside the execution sandbox, tasks requiring uninstalled dependencies fail immediately.

Re-enabling network egress inside the sandbox would recreate critical exfiltration and supply-chain vulnerabilities (TH-04, TH-14). Conversely, running package installers with ambient privileges on the host Windows system would expose user credentials and files (TH-19).

How can Mediator build, lint, and test real-world software projects while keeping the execution sandbox permanently network-isolated?

---

## 2. Decision

We establish an **Offline Toolchain and Dependency Pipeline** consisting of:

1. **Separation of Preparation and Execution:** Dependency acquisition occurs in a trusted, controlled preparation environment outside the untrusted task sandbox. Untrusted task code never performs dynamic network package resolution.
2. **Cryptographic Bundle Manifests (`ToolchainBundleManifest`):** Every dependency bundle is accompanied by a machine-readable manifest recording relative paths, exact byte sizes, per-file SHA-256 hashes, and a canonical root hash over sorted records.
3. **Strict Invariant Validation:**
   - Bundles must not exceed 100 MB or 5,000 files by default.
   - All paths must be relative and lexical-safe (`..` prohibited, no symlink escapes, no Alternate Data Streams, no DOS reserved device names).
   - All files must be scanned for secrets via `@mediator/context-security` before bundle sealing.
4. **Atomic Two-Phase Import:** Bundles are transferred to target staging directories before atomic promotion, preventing interrupted or truncated transfers from becoming trusted.
5. **Fail-Closed Missing Dependency Policy:** Missing dependencies produce typed `OFFLINE_DEPENDENCY_MISSING` errors with concrete manual remediation instructions. Under no circumstances will Mediator fall back to host execution or re-enable sandbox network connectivity.
6. **Native Python Support in `MediatorSandbox`:** `MediatorSandbox` provides Python 3.14+ (`/usr/bin/python3`) and standard library modules (`unittest`), enabling immediate zero-network test execution for Python projects via the pinned `python.test` recipe.

---

## 3. Consequences

### Positive
- **Guaranteed Network Isolation:** Untrusted task code remains 100% offline; zero packet egress, zero DNS tunneling exfiltration.
- **Supply Chain Integrity:** Lockfiles, package digests, and SHA-256 manifests ensure deterministic, reproducible dependencies.
- **Fail-Closed Predictability:** Developers receive clear error messages when dependencies are absent instead of silent network timeouts or unexpected host modifications.
- **Zero Host Intrusion:** No ambient host scripts are run with user privileges on Windows.

### Negative & Limitations
- **Pre-Staging Overhead:** Projects with heavy unbundled dependencies require pre-staging or vendor packaging before validation can run.
- **Node.js Sandbox Distribution Requirement:** In environments where guest Node.js is not pre-installed inside the VHDX, Node/TypeScript projects require either host-assisted execution (with review) or a portable Node.js toolchain bundle.
