# Supported Projects Matrix — Offline Toolchain & Execution Capabilities

**Authoritative Specification for Mediator S46+**  
**Release Mode:** Review-only V1  
**Sandbox Environment:** Dedicated `MediatorSandbox` WSL2 Distribution  
**Network Invariant:** Mandatory Linux Network Namespace Isolation (`unshare --user --net`) Default-Deny  
**Autopilot Governance:** S00 `NO-GO-AUTOEXEC` — **BLOCKED**

---

## 1. Executive Summary

Mediator provides offline build, lint, and test validation for supported projects inside an isolated Linux environment without granting untrusted task code network access. Because the execution sandbox operates under mandatory network isolation, dynamic dependency resolution (`npm install`, `pip install`, `curl`, `git clone`) is intentionally prohibited and blocked at the Linux network namespace boundary (`ENETUNREACH`).

Dependencies must be provided either via verified pre-bundled offline caches, vendor directories, or standard library runtimes.

---

## 2. Supported Project Matrix

| Project Type | Supported Runtime | Supported Test / Lint Recipes | Manifest / Lockfile Requirements | Offline Package Format | Sandbox Availability Status | Resource Limits |
|---|---|---|---|---|---|---|
| **Python Standard Library** | Python 3.14+ (`/usr/bin/python3`) | `python.test` (`unittest discover`), `python.single_test` (`unittest <file>`) | `unittest` test suites; optional `requirements.txt` | Standard library built-in modules | **LIVE VERIFIED** in `MediatorSandbox` | Timeout: 60s<br>Max Output: 1 MiB<br>Max Files: 5,000 |
| **Python Offline Vendor** | Python 3.14+ (`/usr/bin/python3`) | `python.test`, `python.single_test` | `requirements.txt` with pinned versions (`pkg==x.y.z`) | `vendor/` tree or `wheels/` archive with `.mediator-manifest.json` | **LIVE VERIFIED** with pre-staged bundle | Timeout: 60s<br>Max Output: 1 MiB<br>Max Files: 5,000 |
| **Node.js / npm** | Node.js v24.x (Host) | `project.test` (`npm test`), `project.lint` (`npm run lint`), `project.typecheck` (`npx tsc --noEmit`), `project.single_test` | `package.json`, `package-lock.json` | `node_modules` pre-packaged bundle with SHA-256 manifest | **CONDITIONAL / HOST-ASSISTED** (Host Node.js available; guest node requires offline runtime bundle import) | Timeout: 60s<br>Max Output: 1 MiB<br>Max Files: 10,000 |
| **Git / VCS** | Git 2.46+ (`/usr/bin/git`) | `git.status`, `git.diff` | Clean Git working directory | N/A (Standard tool) | **LIVE VERIFIED** in `MediatorSandbox` | Timeout: 10s<br>Max Output: 1 MiB |

---

## 3. Toolchain Executables and Recipe Definitions

### 3.1 Python (`python.test`, `python.single_test`)
- **Executable:** `/usr/bin/python3`
- **Default Arguments:**
  - `python.test`: `['-m', 'unittest', 'discover']`
  - `python.single_test`: `['-m', 'unittest', '<test_file.py>']`
- **Environment Allowlist:** `PYTHONUNBUFFERED`, `CI`
- **Network Isolation:** Mandatory Linux user & network namespace (`CLONE_NEWUSER`, `CLONE_NEWNET`).
- **Missing Dependency Behavior:** If a test module imports an uninstalled third-party package, `unittest` fails with `ModuleNotFoundError`. Mediator captures the real exit code 1, reports `OFFLINE_DEPENDENCY_MISSING`, and provides clear remediation instructions without attempting network egress.

### 3.2 Node.js (`project.test`, `project.lint`, `project.typecheck`, `project.build`)
- **Executable:** `npm` / `npx`
- **Default Arguments:**
  - `project.test`: `['test']`
  - `project.lint`: `['run', 'lint']`
  - `project.typecheck`: `['run', 'typecheck']`
  - `project.build`: `['run', 'build']`
- **Environment Allowlist:** `NODE_ENV`, `CI`
- **Offline Dependency Requirement:** `node_modules` directory pre-populated from a verified lockfile. Dynamic `npm install` is blocked.
- **Missing Dependency Behavior:** If `node_modules` or a declared package is missing, `DependencyInspector` fails closed with `OFFLINE_DEPENDENCY_MISSING` and prevents execution attempt.

---

## 4. Known Unsupported Configurations & Dependency Types

The following configurations are explicitly unsupported for automated offline execution and fail closed:

1. **Native C/C++ Extensions Requiring Online Compilation:** Packages requiring `node-gyp` or `gcc` to download headers during installation.
2. **Dynamic Git Dependencies:** Dependencies declared as `git+https://...` or `github:...` that require network cloning at install time.
3. **Unbundled Container Images / Docker in Docker:** Arbitrary container pulls or Docker socket mounts inside the sandbox.
4. **Arbitrary Shell Setup Scripts:** Setup commands (`curl | sh`, `wget`, `npm preinstall` executing arbitrary binaries) are detected and blocked by `DependencyInspector`.
5. **Languages without Installed Guest Toolchains:** Rust (`cargo`), Go (`go test`), Java (`mvn`/`gradle`), Ruby (`bundle`) are currently unsupported until dedicated offline toolchain bundles are provisioned.

---

## 5. Security & Boundary Guarantees

1. **Zero Host Execution of Untrusted Task Code:** Task code is never executed directly in the Windows host shell.
2. **Zero Network Egress:** All task executions are confined to `unshare --user --net`, blocking direct IPv4/IPv6 packets and hypervisor DNS proxy tunnels.
3. **Immutable Recipe Hashes:** Every recipe definition is pinned with a SHA-256 hash. Definition tampering triggers `RECIPE_TAMPERED`.
4. **Live Workspace Immutability:** Pre/post SHA-256 tree hashes verify that live Windows source code is never modified by offline task execution.
5. **Fail-Closed Missing Dependencies:** When an offline dependency is missing, the system emits `OFFLINE_DEPENDENCY_MISSING` with actionable instructions rather than falling back to an unisolated host runner or attempting network download.
