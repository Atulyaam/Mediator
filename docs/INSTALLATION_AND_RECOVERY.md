# Mediator — Installation, Maintenance & Recovery Guide

**Target Environment:** Windows 11 (Home / Pro / Enterprise) with WSL2  
**Installation Scope:** Current User (`HKCU`, `%LOCALAPPDATA%\Mediator`) — Zero Administrator Elevation Required  
**Authoritative Security Model:** Review-only V1 with S00 `NO-GO-AUTOEXEC`  

---

## 1. Prerequisites & System Requirements

- **Operating System:** Windows 11 (Build 22000 or newer; tested on Windows 11 26H2).
- **WSL2 Runtime:** Windows Subsystem for Linux 2 enabled.
- **Node.js:** v20.x, v22.x, or v24.x (Active LTS or Current).
- **Web Browser:** Google Chrome (v115+) or Microsoft Edge (v115+) for browser extension bridges.
- **Privilege Model:** Normal Windows user account. Administrative privileges are **not required** and actively discouraged.

---

## 2. Step-by-Step Installation

### Step 2.1 — Clone and Build Mediator
```powershell
# Clone the repository
git clone https://github.com/Atulyaam/Mediator.git
cd Mediator

# Install monorepo dependencies and compile all packages
npm install
npm run build
```

### Step 2.2 — Initialize the Dedicated WSL2 Sandbox
Mediator executes untrusted code strictly inside a dedicated, isolated WSL2 distribution named `MediatorSandbox`. This environment operates under a dedicated Linux network namespace (`unshare --user --net`) with default-deny network egress:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-wsl2-sandbox.ps1
```

**Guarantees:**
- Installs into `%LOCALAPPDATA%\Mediator\wsl\MediatorSandbox\ext4.vhdx`.
- Never touches or modifies your personal `Ubuntu`, `Debian`, or `docker-desktop` distributions.
- Configures `/usr/bin/python3`, `/usr/bin/git`, and isolation helpers.

### Step 2.3 — Register the Native Messaging Host
Register the native messaging host in the Windows Current User registry (`HKCU`) for Chrome and Edge:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1
```

**Guarantees:**
- Writes solely to `HKCU:\Software\Google\Chrome\NativeMessagingHosts` and `HKCU:\Software\Microsoft\Edge\NativeMessagingHosts`.
- Never modifies machine-wide registry settings (`HKLM`).
- Validates the 32-character extension ID and ensures the executable is a compiled binary, strictly rejecting `.bat` or `.cmd` wrappers.

### Step 2.4 — Install the Browser Extension
1. Open Google Chrome or Microsoft Edge.
2. Navigate to `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode** toggle in the top-right corner.
4. Click **Load unpacked** and select `apps/browser-extension` from the Mediator root.
5. Note the generated Extension ID. If different from the default, re-run `scripts/install-windows.ps1 -ExtensionId "<id>"`.

### Step 2.5 — Verify Installation with the Health Doctor
Run the diagnostic setup doctor to verify all components:

```powershell
node apps/cli/dist/index.js doctor
```

All essential checks should show `[READY]`:
- Core Engine, Dedicated WSL2 Sandbox, Network Isolation, Offline Toolchains, Providers, Native Host, and Workspace Scope.

---

## 3. Maintenance & Upgrades

### 3.1 Updating Mediator
To update Mediator to the latest build:
```powershell
git pull origin main
npm run build
node apps/cli/dist/index.js doctor
```

### 3.2 Toolchain Cache Management
Offline toolchains and dependency bundles are stored in `%LOCALAPPDATA%\Mediator\bundles`. Each bundle contains a cryptographic manifest (`.mediator-manifest.json`) with root SHA-256 hashes.
- To inspect bundle cache integrity: run `mediator doctor`.
- Corrupted or interrupted imports are automatically detected and rejected fail-closed.

---

## 4. Crash Recovery & Disaster Recovery

### 4.1 Startup Reconciliation (`OrchestratorRecoveryService`)
If Mediator Core or the host system crashes mid-task, startup reconciliation executes automatically upon daemon restart:
- **In-flight operations:** Durably marked `unknown` or `recovery-required`. Interrupted actions are **never** blindly replayed.
- **Stage Conflicts:** Shadow staging verifies whether live workspace files changed during the outage. Unresolved conflicts require manual resolution.
- **Expired Approvals:** Pending approvals older than their freshness window (default 30 seconds to 5 minutes) are expired and invalidated.
- **Safe Resume:** Resuming an interrupted task requires explicit human confirmation via CLI or UI.

### 4.2 Workspace Backup & Rollback
Before applying any approved stage to your live workspace, Mediator generates an atomic pre-apply backup in:
```
<WorkspaceRoot>/.mediator/backups/<transactionId>/
```

If an error or system crash occurs during the file-writing phase:
1. Locate the backup folder in `<WorkspaceRoot>/.mediator/backups/`.
2. Inspect the original versions of modified files.
3. Restore the original files directly or use git rollback:
```bash
git checkout -- .
```

---

## 5. Safe Uninstallation

Mediator provides clean, safe, and reversible uninstallation that strictly protects your personal files and development environment.

### 5.1 Standard Unregistration (Preserve User Data)
To unregister the native host from Chrome and Edge without removing application files:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/uninstall-windows.ps1
```

### 5.2 Complete Cleanup
To unregister the native host, remove binaries, unregister the dedicated `MediatorSandbox` WSL2 distro, and purge application caches:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/uninstall-windows.ps1 -RemoveFiles -PurgeUserData -UnregisterSandbox
```

### 5.3 Safety Invariants during Uninstall
- **Zero machine-wide changes:** Only `HKCU` registry entries are deleted.
- **Distro isolation:** The uninstaller targets strictly `MediatorSandbox`. It will **NEVER** modify or unregister personal distributions like `Ubuntu`, `Debian`, or `docker-desktop`.
- **Workspaces preserved:** Your git repositories, workspace projects, and personal documents are **NEVER** deleted.
