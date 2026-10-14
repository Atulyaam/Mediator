# Offline Toolchain & Dependency Supply Chain Strategy

**Sprint:** S46  
**Document Status:** Authoritative Architectural Strategy  
**Release Mode:** Review-only V1  
**Target Environment:** Windows 11 Host + `MediatorSandbox` WSL2 (Linux Network Namespaces)

---

## 1. Problem Statement & Release Blocker (TH-20)

In Sprint S43 and S44, Mediator achieved complete network isolation inside `MediatorSandbox` using Linux user and network namespaces (`unshare --user --net`). Outbound IPv4/IPv6 connections and hypervisor DNS proxy tunnels were definitively severed.

However, threat model item **TH-20 (Offline Toolchain & Dependency Supply Chain Gap)** identified this as a release blocker for automated validation:
- Because the sandbox is strictly offline, package managers (`npm install`, `pip install`) fail with `ENETUNREACH`.
- Weakening network isolation to download dependencies would re-open data exfiltration channels (TH-04, TH-14).
- Executing model-suggested package install commands on the Windows host would violate S00 `NO-GO-AUTOEXEC` and ambient authority protections.

To resolve TH-20 safely, Mediator implements a **7-Stage Trusted Offline Dependency Pipeline**.

---

## 2. The 7-Stage Trusted Offline Dependency Pipeline

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Trusted Preparation (Host / Controlled Build Environment)           │
│    - Resolve lockfiles (package-lock.json, requirements.txt)           │
│    - Download pinned packages with hash verification                   │
│    - Lifecycle scripts disabled (e.g. npm --ignore-scripts)            │
└────────────────────────────────────┬───────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. Integrity Validation & Secret Scrubbing                             │
│    - Scan for secrets via @mediator/context-security                   │
│    - Verify package hashes against lockfile integrity digests          │
│    - Check path containment: reject '..', ADS, and DOS device names     │
└────────────────────────────────────┬───────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. Offline Bundling                                                    │
│    - OfflineBundleService creates machine-readable manifest            │
│    - Generate SHA-256 for all files + overall bundle rootHash          │
│    - Enforce bounds: max 100 MB, max 5,000 files, max depth 12         │
└────────────────────────────────────┬───────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4. Controlled Import                                                   │
│    - Atomic transfer via staging directory (.import-staging-<timestamp>)│
│    - Interrupted imports are cleaned up and never become trusted       │
└────────────────────────────────────┬───────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 5. Sandbox Verification                                                │
│    - Sandbox verifies bundle files against manifest rootHash           │
│    - Reject tampering or missing files fail-closed                     │
└────────────────────────────────────┬───────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 6. Offline Execution                                                   │
│    - WslIsolatedExecutor launches approved recipe inside netns         │
│    - Mandatory unshare --user --net --map-root-user --fork --kill-child│
│    - Network access remains completely disabled (zero egress)          │
└────────────────────────────────────┬───────────────────────────────────┘
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 7. Evidence Collection                                                 │
│    - Capture numeric exit codes (0 = pass, nonzero = fail)             │
│    - Output buffer bounding (32 KiB cap) + secret redaction            │
│    - Live Windows workspace tree-hash verification                     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Package Integrity & Supply Chain Controls

### 3.1 Node.js / npm
- **Deterministic Lockfiles:** Projects must supply `package-lock.json` with SHA-512 package integrity digests.
- **Ignore Lifecycle Scripts:** During preparation, `--ignore-scripts` is enforced to prevent execution of untrusted `preinstall`/`postinstall` hooks.
- **Offline Mode:** Toolchains are configured to use `--offline` / `--prefer-offline`.
- **Pre-Execution Inspection:** `DependencyInspector` inspects `package.json` and `node_modules` before recipe invocation. Missing packages trigger `OFFLINE_DEPENDENCY_MISSING` fail-closed.

### 3.2 Python
- **Version Pinned Requirements:** Dependencies in `requirements.txt` must use exact versions (`pkg==1.2.3`).
- **Vendor / Wheel Storage:** Pre-built `.whl` archives or vendor directories are packaged into the bundle with SHA-256 manifests.
- **Standard Library Support:** Pure standard library projects (e.g. `unittest`) require zero external packages and run immediately inside `MediatorSandbox`'s native `/usr/bin/python3`.

---

## 4. Cache & Bundle Integrity Invariants

1. **Immutable Bundles:** Once sealed with a root SHA-256 hash, a bundle cannot be mutated. Any altered file triggers `BUNDLE_INTEGRITY_MISMATCH`.
2. **Path Traversal Defense:** Manifest paths are strictly validated:
   - Must be relative.
   - Forward slashes only.
   - Zero `..` components.
   - Symlinks resolving outside the bundle root are rejected with `BUNDLE_PATH_TRAVERSAL`.
3. **Secret Immunity:** All bundle text content is scanned using `@mediator/context-security` before sealing. Any API token or private key causes bundle creation rejection (`SECRET_DETECTED`).
4. **Interrupted Import Protection:** Staged imports write to `.import-staging-<ts>`. If interrupted or corrupted, the staging directory is purged. Target directories never reference partial bundles.
5. **Fail-Closed on Missing Dependencies:** When a project imports an unbundled dependency, it fails cleanly with actionable guidance. Network egress is never enabled.
