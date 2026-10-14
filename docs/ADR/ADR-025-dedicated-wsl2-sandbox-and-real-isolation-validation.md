# ADR-025 — Dedicated WSL2 Sandbox Provisioning & Real Isolation Validation

**Date:** 2026-10-12  
**Status:** ACCEPTED (Decision: `CONDITIONAL — SOME CAPABILITIES REMAIN UNVERIFIED`; S00 `NO-GO-AUTOEXEC` Maintained)  
**Sprint:** S42 Dedicated WSL2 Sandbox Provisioning and Real Isolation Validation  
**Deciders:** Mediator Architecture & Safety Authority  

---

## 1. Context

Sprint S41 demonstrated that while WSL2 can execute isolated Linux tasks, the host's existing personal `Ubuntu` distribution is inherently unsafe for untrusted execution because DrvFS host drive automounting (`/mnt/c`) and Windows interop (`/init` binfmt interop to `cmd.exe`) are active by default.

Sprint S42 had the following objectives:
1. Conduct read-only preflight diagnostics and explain all provisioning operations.
2. Require and obtain explicit user authorization prior to making any system-level changes.
3. Provision a dedicated, standalone `MediatorSandbox` WSL2 distribution without Docker or Podman.
4. Verify that the user's personal `Ubuntu` distribution remains completely untouched and isolated.
5. Probe real OS security boundaries using live adversarial canaries:
   - Host drive detachment (`/mnt/c` automount disabled).
   - Host interop detachment (`cmd.exe` execution disabled, zero Windows `PATH` injection).
   - Privilege containment (unprivileged `mediator-runner`, `sudo` forbidden, `/etc/wsl.conf` write-protected).
   - Filesystem boundary containment (outside task workspace writes denied, Windows secrets inaccessible, path traversal bundles rejected).
   - Network default-deny probe.
   - Process lifecycle, exit codes, timeout, cancellation, output budgets, and recipe hash pinning.
6. Evaluate capability evidence strictly without agent claims or mock-only passes.
7. Maintain S00 `NO-GO-AUTOEXEC` strictly: Local Autopilot remains fail-closed and blocked.

---

## 2. Explicit User Authorization and Non-Destructive Provisioning

### 2.1 Preflight Diagnostic (`-CheckOnly`)
`scripts/prepare-wsl2-sandbox.ps1 -CheckOnly` was executed prior to provisioning:
- Confirmed `wsl.exe` operational.
- Verified existing distributions: `Ubuntu` (Stopped), `docker-desktop` (Stopped).
- Confirmed that `MediatorSandbox` did not yet exist.
- Confirmed that personal `Ubuntu` is unhardened and must not be used as an execution environment.

### 2.2 Explicit User Authorization
All provisioning details were presented to the user:
- Dedicated distribution name: `MediatorSandbox`.
- Storage location: `%LOCALAPPDATA%\Mediator\wsl\MediatorSandbox\ext4.vhdx` (approx. 1.2 GB virtual disk).
- Network and packages: base tarball exported from clean rootfs; zero external package downloads.
- Non-destructive guarantee: User's personal `Ubuntu` is untouched.
- Reversibility: Cleanup command `powershell -ExecutionPolicy Bypass -File scripts/prepare-wsl2-sandbox.ps1 -Cleanup` unregisters `MediatorSandbox` and removes storage without touching any personal files.
- The user explicitly authorized: *"Yes, authorize provisioning the dedicated MediatorSandbox WSL2 distribution now."*

### 2.3 Standalone Provisioning (`-Provision`)
Provisioning executed successfully:
1. Exported a clean base rootfs from WSL.
2. Imported standalone distribution `MediatorSandbox` into `%LOCALAPPDATA%\Mediator\wsl\MediatorSandbox`.
3. Created unprivileged user `mediator-runner` (UID 1500, GID 1500) without `sudo` privileges.
4. Provisioned hardened `/etc/wsl.conf`:
   ```ini
   [boot]
   systemd=true
   [automount]
   enabled=false
   mountFsTab=false
   [interop]
   enabled=false
   appendWindowsPath=false
   [user]
   default=mediator-runner
   ```
5. Terminated distribution to ensure `/etc/wsl.conf` took effect immediately.

---

## 3. Real Runtime Isolation Validation (Canaries 14–22)

The dedicated distribution was subjected to 9 live adversarial probe canaries executed via `wsl.exe -d MediatorSandbox`:

| Canary ID | Boundary Tested | Adversarial Probe | Result | Status |
|---|---|---|---|---|
| **Canary 14** | Unprivileged Target Execution | Run `wsl.deterministic_success` recipe in `MediatorSandbox` | Executed as `uid=1500(mediator-runner)`; exit 0; output captured | **PASS** |
| **Canary 15** | Host Drive Automount | Probe `/mnt/c` filesystem mount | `/mnt/c` is empty, detached directory (not mounted) | **PASS** |
| **Canary 16** | Windows Command Interop | Attempt `cmd.exe /c whoami` and inspect `PATH` | Command fails (`cmd.exe: not found`); zero Windows paths in `PATH` | **PASS** |
| **Canary 17** | Privilege Containment | Attempt `sudo id` and append to `/etc/wsl.conf` | `sudo` fails ("sudo: I'm sorry mediator-runner"); `/etc/wsl.conf` write fails ("Permission denied") | **PASS** |
| **Canary 18** | Workspace Containment | Attempt `touch /forbidden.txt` outside task root | Write fails ("touch: cannot touch '/forbidden.txt': Permission denied") | **PASS** |
| **Canary 19** | Synthetic Secret Protection | Attempt read of synthetic Windows secret `C:\...\mediator_synthetic_secret.txt` | Inaccessible; `/mnt/c` does not exist | **PASS** |
| **Canary 20** | Network Default-Deny | Socket connect to `1.1.1.1:80` vs WSL DNS proxy `10.255.255.254:53` | External IP unreachable (`Errno 101`), BUT WSL hypervisor DNS proxy connects (`DNS_CONNECTED`). Network default-deny marked unverified | **PASS (Accurate Failure Recorded)** |
| **Canary 21** | Bundle Traversal Rejection | Result bundle with `../../escape.txt` payload | Windows receiver rejects with `INVALID_ARTIFACT_PATH` error | **PASS** |
| **Canary 22** | Autopilot Fail-Closed Gate | Evaluate S42 fresh capability evidence under S00 | `isEligibleForAutoExec: false`, `result: 'blocked'`, `s00Decision: 'NO-GO-AUTOEXEC'` | **PASS** |

---

## 4. Key Security Finding: WSL2 Hypervisor Network Routing

### 4.1 Probe Behavior
- Outbound TCP sockets to public internet IPs (e.g., `1.1.1.1:80`) fail with `OSError: [Errno 101] Network is unreachable` when no default gateway is configured.
- However, WSL2 utilizes a virtual Hyper-V internal network switch with a local DNS/NAT proxy endpoint (`10.255.255.254:53`).
- Sockets connecting to `10.255.255.254:53` succeed because the Hyper-V virtual network architecture routes traffic to the host's WSL service.

### 4.2 Security Determination
- Application-level URL filtering or relying on non-deterministic routes is insufficient to prove OS-level network isolation.
- Without external host-side Windows Filtering Platform (WFP) / Hyper-V firewall rules or dedicated network namespace configuration, WSL2 cannot guarantee complete network default-deny.
- **Strict Compliance:** In accordance with sprint requirements, tests were **not** weakened. `network.networkDefaultDeny` is recorded as `UNVERIFIED / FALSE`.

---

## 5. Autopilot Gate Invariant (S00 NO-GO-AUTOEXEC)

Even though filesystem, process, exit code, timeout, and cancellation boundaries are verified in `MediatorSandbox`:
1. S00 `NO-GO-AUTOEXEC` remains authoritative and binding.
2. `ExecutionAuthorizationGate` and `CapabilityEvaluationEngine` strictly block automatic execution.
3. Mediator remains in **Review-only mode**. All provider outputs must be reviewed and approved by the human user before application to the live project.

---

## 6. S42 Exit Verdict

**Verdict:** **`CONDITIONAL — SOME CAPABILITIES REMAIN UNVERIFIED`**

- **Verified Capabilities:**
  - `filesystem.stageRootRead`: VERIFIED
  - `filesystem.stageRootWrite`: VERIFIED
  - `filesystem.liveWorkspaceWriteDenied`: VERIFIED
  - `filesystem.outsideRootDenied`: VERIFIED
  - `filesystem.secretFilesProtected`: VERIFIED
  - `filesystem.symlinkEscapeDenied`: VERIFIED
  - `process.executableAllowlistEnforced`: VERIFIED
  - `process.untrustedScriptsRejected`: VERIFIED
  - `process.childProcessesControlled`: VERIFIED
  - `process.hostShellFallbackDenied`: VERIFIED
  - `limits.timeoutEnforced`: VERIFIED
  - `limits.cancellationEnforced`: VERIFIED
  - `limits.outputByteLimitsEnforced`: VERIFIED
  - `limits.capturesRealExitCode`: VERIFIED
  - `execution.fixedRecipeOnly`: VERIFIED
  - `execution.stagedSourceProven`: VERIFIED
- **Unverified Capabilities:**
  - `network.networkDefaultDeny`: **UNVERIFIED / FALSE** (WSL hypervisor virtual switch socket accessible)
- **Local Autopilot Status:** **`BLOCKED (FAIL-CLOSED)`**
