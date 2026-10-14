# AUTOMATED OFFLINE DEPENDENCY RESOLVER SPECIFICATION & IMPLEMENTATION

**Document Status:** Complete & Verified (Sprint S49.2)  
**System Component:** `@mediator/recipe-registry` (`OfflineDependencyResolver`, `OfflineBundleService`, `DependencyInspector`)  
**Target Environment:** Windows 11 Host (Trusted Prep) -> Dedicated `MediatorSandbox` WSL2 (Offline Execution)  
**Security Invariant:** Mandatory Linux Network Namespace Isolation (`unshare --user --net` Default-Deny)  
**Autopilot Governance:** S00 `NO-GO-AUTOEXEC` — **BLOCKED**

---

## 1. Executive Summary & Problem Statement

In an AI-orchestrated coding platform, granting task-execution code network access (`npm install`, `pip install`, `curl`, `git clone`) introduces severe security risks:
- Malicious packages or typosquatting attacks executing arbitrary code on the host or inside containers.
- Untrusted AI models crafting commands that leak user credentials or source code via dynamic egress.
- Prompt injection instructing package managers to download uncontrolled payloads during testing.

To solve this, Mediator implements an **Automated Offline Dependency Bundle Resolver** that strictly separates the **trusted preparation stage** from the **untrusted execution stage**. Untrusted sandbox execution code runs with zero network connectivity (`ENETUNREACH`), while dependencies are prepared, cryptographically verified, and sealed ahead of time into a managed offline store.

---

## 2. Three-Stage Resolution Architecture

```
+-----------------------------------------------------------------------------------+
| STAGE 1: TRUSTED PREPARATION (Host Environment, Controlled Destination & Policy)  |
|                                                                                   |
|  - Manifest & lockfile inspection (`package-lock.json`, `requirements.txt`)       |
|  - Cryptographic lockfile SHA-256 hash calculation                                |
|  - Dependency download from official registries with strict destination pinning   |
|  - ZERO lifecycle script execution (`--ignore-scripts`, no preinstall/postinstall)|
|  - Secret sanitization: scans content for AWS/GH/SSH credentials with scanContent |
|  - Output: Temporary staging folder (`prep-source/`)                              |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| STAGE 2: BUNDLE VERIFICATION & SEALING (Managed Store: `.mediator/bundles/`)      |
|                                                                                   |
|  - Boundary audit: path traversal (`..`), symlink escapes, DOS/ADS device names   |
|  - Bounded size limits: 10 MiB per file, 150 MiB per bundle, max 10,000 files     |
|  - Generates `.mediator-manifest.json` with per-file SHA-256 and root Merkle hash |
|  - Incomplete import defense: stages to `.incomplete_<bundleId>` before promotion  |
|  - Atomic promotion: renames to final store `<bundleId>` once fully verified      |
|  - Indexed into immutable store ledger (`store-index.json`)                       |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| STAGE 3: OFFLINE EXECUTION PROVISIONING (`MediatorSandbox` WSL2)                  |
|                                                                                   |
|  - Pre-execution check: verifies bundle root hash against stored manifest         |
|  - Copies isolated dependency tree to task staging (`task-staging/node_modules`)  |
|  - Master bundle in store remains immutable (sandbox cannot mutate master cache)  |
|  - Execution dispatched inside Linux network namespace (`unshare --user --net`)   |
|  - Zero network egress allowed: missing packages fail closed with remediation     |
+-----------------------------------------------------------------------------------+
```

---

## 3. Dependency Discovery & Machine-Readable Plan

Before any task execution, `OfflineDependencyResolver.discoverDependencies(workspaceRoot)` inspects workspace files without executing any package managers or shell scripts.

It returns a strongly typed `DependencyPlan`:
```typescript
export interface DependencyPlan {
  readonly projectId: string;
  readonly projectType: 'node' | 'python';
  readonly manifestPath: string;
  readonly lockfilePath?: string | undefined;
  readonly lockfileHash: string;
  readonly runtime: {
    readonly name: string;
    readonly requiredVersion: string;
  };
  readonly status: 'cached' | 'missing' | 'unsupported' | 'tampered' | 'unlocked';
  readonly bundleId?: string | undefined;
  readonly cachedManifest?: ToolchainBundleManifest | undefined;
  readonly missingPackages: ReadonlyArray<string>;
  readonly riskSignals: ReadonlyArray<string>;
  readonly remediation: string;
}
```

### Resolution Status Outcomes

| Status | Condition | System Action | Remediation Message |
| :--- | :--- | :--- | :--- |
| `cached` | Lockfile hash matches verified bundle in store | Safe for offline dispatch | "Dependencies verified and cached in managed store. Ready for offline execution." |
| `missing` | Valid lockfile exists, but bundle is not in cache | Blocks execution fail-closed | "Prepare verified offline bundle via trusted host resolver: `mediator bundle prepare --type <type>`." |
| `unlocked` | `package.json` exists without `package-lock.json` | Blocks execution fail-closed | "Generate package-lock.json using `npm install --package-lock-only` before offline execution." |
| `tampered` | Bundle exists in cache but root hash does not match | Purges cache, blocks execution | "Cached dependency bundle failed cryptographic integrity verification. Re-prepare using trusted resolver." |
| `unsupported`| Manifest missing or unsupported runtime | Blocks execution fail-closed | "Ensure project contains package.json (Node.js) or requirements.txt (Python) with pinned dependencies." |

---

## 4. Managed Bundle Store (`.mediator/bundles/`)

The bundle store manages offline dependency caches with the following guarantees:

1. **Deterministic Bundle IDs:** `bundle-${projectType}-${lockfileHash.slice(0, 16)}`. Any alteration to dependencies in `package-lock.json` changes the hash and deterministically switches to a new bundle ID.
2. **Incomplete-Import Defense:** Bundle imports are initially written to `.incomplete_<bundleId>`. If an import is aborted, interrupted, or fails hash verification, it is deleted and never registered in `store-index.json`.
3. **Tamper Detection:** Before every provisioning to a sandbox task, `verifyBundle(storePath, manifest)` recalculates SHA-256 digests. If any byte in the store was modified or corrupted, the resolver rejects the bundle with `ErrorCode.BUNDLE_INTEGRITY_MISMATCH`.
4. **Cache Immutability & Sandbox Isolation:** The sandbox receives a separate copied directory inside its isolated task folder (`node_modules/` or `vendor/`). Modifications made during task execution do not mutate the master bundle in `.mediator/bundles/`.

---

## 5. Verification Test Evidence (Sprint S49.2)

The implementation is verified by `tests/offlineDependencyResolver.test.ts` (8/8 passing) and `tests/offlineToolchain.test.ts` (13/13 passing):

```
 RUN  v1.6.1 C:/Users/Atul2/OneDrive/Desktop/Mediator

 ✓ tests/offlineDependencyResolver.test.ts > Sprint S49.2 — Automated Offline Dependency Bundle Resolver
   ✓ 1. discovers dependencies from an unlocked project and reports missing lockfile
   ✓ 2. discovers missing dependencies when lockfile is present but cache is empty
   ✓ 3. prepares trusted bundle, seals it in managed store, and achieves cached hit
   ✓ 4. invalidates cached bundle when lockfile is modified
   ✓ 5. strictly rejects tampered bundles in cache fail-closed (code: BUNDLE_INTEGRITY_MISMATCH)
   ✓ 6. safely isolates task staging copy: sandbox modifications do NOT mutate master cache
   ✓ 7. cleans up interrupted import and never promotes partial bundle to trusted store
   ✓ 8. strictly fails closed on unsupported project types

 Test Files  1 passed (1)
      Tests  8 passed (8)
```

Combined offline toolchain verification:
```
 ✓ tests/offlineToolchain.test.ts (13 passed)
 ✓ tests/offlineDependencyResolver.test.ts (8 passed)
 Total: 21 passed (0 failed)
```

---

## 6. Supported vs Unsupported Scenarios Matrix

### Currently Supported
- **Node.js (npm):** Lockfile-based resolution (`package-lock.json` v2/v3), pure JavaScript/TypeScript packages, pre-bundled `node_modules` trees, `--ignore-scripts` lifecycle enforcement.
- **Python (pip):** Pinned requirement specifications (`requirements.txt`), pre-staged `vendor/` trees, pure Python wheels (`.whl`) with `.mediator-manifest.json`.

### Unsupported Scenarios (Fail-Closed)
- **Unpinned Node/Python:** Dependencies declared as `*`, `latest`, or unpinned ranges without a lockfile.
- **Native C/C++ Extensions Requiring Online Compilation:** `node-gyp`, `cmake`, or `gcc` invoking online header downloads.
- **Dynamic Git/VCS Dependencies:** Packages specifying `git+https://` or private GitHub URLs requiring live SSH/HTTPS authentication.
- **Arbitrary Container Builds:** Docker-in-Docker or container pulls inside sandbox tasks.
- **Compiled Languages Without Guest Toolchains:** Rust (`cargo`), Go (`go test`), Java (`mvn`), Ruby (`bundle`).
