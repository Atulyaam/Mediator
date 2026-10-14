# SUPPORTED PLATFORM & ENVIRONMENT MATRIX

**Release Target:** Mediator `v0.1.0-beta.1`  
**Evaluation Mode:** Review-only V1  
**Security Policy:** S00 `NO-GO-AUTOEXEC` — **BLOCKED**  

---

## 1. Operating System & Host Environment

| Platform Component | Minimum Supported Version | Recommended Version | Verification Status | Notes & Constraints |
| :--- | :--- | :--- | :--- | :--- |
| **Windows OS** | Windows 10 Home (Build 19044+) | Windows 11 Home / Pro (Build 26100+) | **VERIFIED** | Standard user execution. No admin elevation required. |
| **WSL2 Subsystem** | WSL2 (Kernel 5.15+) | WSL2 (Kernel 6.6+ / 6.18+) | **VERIFIED** | Virtual Machine Platform feature required. |
| **WSL2 Distribution** | Ubuntu 22.04 LTS (Sandbox base) | Dedicated `MediatorSandbox` distro | **VERIFIED** | Pinned to `MediatorSandbox`; personal distros untouched. |
| **Host Node.js** | Node.js v20.x LTS | Node.js v24.x LTS (Current) | **VERIFIED** | Host-side core, broker worker, and CLI. |
| **Host Python** | Python 3.10+ | Python 3.12+ / 3.14+ | **VERIFIED** | Host runtime for Python scripts and trusted prep. |
| **Chromium Browser** | Chrome 120+ / Edge 120+ | Chrome 130+ / Edge 130+ | **VERIFIED** | Manifest V3 native messaging extension support. |
| **Git for Windows** | Git 2.40+ | Git 2.46+ | **VERIFIED** | Working tree diffing, staging, and hash verification. |

---

## 2. Supported Languages & Project Toolchains

| Language / Framework | Supported Manifest / Lockfile | Pinned Offline Recipes | Sandbox Availability | Constraints |
| :--- | :--- | :--- | :--- | :--- |
| **Python Standard Library** | `unittest` test discover; optional `requirements.txt` | `python.test`, `python.single_test` | **LIVE VERIFIED** in `MediatorSandbox` | Python 3.14+ in sandbox; standard library builtins. |
| **Python Vendor Packages** | `requirements.txt` with pinned versions (`pkg==x.y.z`) | `python.test`, `python.single_test` | **LIVE VERIFIED** via `vendor/` or wheels | Pure Python wheels (`.whl`) or pre-staged bundle. |
| **Node.js (npm)** | `package.json` with `package-lock.json` (v2/v3) | `project.test`, `project.lint`, `project.typecheck` | **LIVE VERIFIED** (Host Node.js assisted) | Pure JS/TS packages; `--ignore-scripts` lifecycle. |
| **Git Repository** | Standard Git working tree | `git.status`, `git.diff` | **LIVE VERIFIED** in `MediatorSandbox` | Standard Git VCS status operations. |

---

## 3. Explicitly Unsupported Toolchains & Configurations

The following configurations are **unsupported for automated execution** and fail closed:

1. **Unpinned Node/Python:** Dependencies declared as `*`, `latest`, or without lockfiles fail closed with `ErrorCode.OFFLINE_DEPENDENCY_MISSING`.
2. **Native C/C++ Extensions Requiring Online Compilation:** `node-gyp`, `cmake`, or `gcc` downloading headers during install.
3. **Dynamic Git/VCS Dependencies:** Packages specifying `git+https://` or private GitHub URLs requiring live SSH/HTTPS authentication.
4. **Compiled Languages Without Guest Toolchains:** Rust (`cargo`), Go (`go test`), Java (`mvn`/`gradle`), Ruby (`bundle`) are currently unsupported until dedicated offline toolchain bundles are provisioned.
5. **Arbitrary Container Environments:** Docker-in-Docker or container pulls inside sandbox tasks.
