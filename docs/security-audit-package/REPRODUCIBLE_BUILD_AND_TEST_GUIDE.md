# Reproducible Build, Test, Install & Uninstall Guide

**Release Candidate Target:** Mediator `v0.1.0-beta.1`  
**Artifact:** `@mediator/native-host` (`mediator-native-host.exe`)  
**Security Policy Invariant:** S00 `NO-GO-AUTOEXEC` — Local Autopilot strictly **`BLOCKED`** fail-closed  

---

## 1. Prerequisites & Environment Setup

Independent reviewers should use a clean Windows 10/11 environment:
- **Operating System:** Windows 10 (Build 19041+) or Windows 11 (Home or Pro)
- **Node.js:** v20+ LTS (Tested on Node v20.18.0 & v24.13.0)
- **npm:** v10+ (Tested on npm 11.6.2)
- **Git:** Git for Windows (v2.40+)
- **Privilege:** Standard user (non-administrative PowerShell session)

---

## 2. Step-by-Step Reproducible Build Instructions

```powershell
# 1. Clone repository and checkout release candidate baseline commit
git clone <repository-url> Mediator
cd Mediator
git checkout c55177400bd399adf05578ad80f8268f1173e371

# 2. Install workspace dependencies
npm install

# 3. Compile all packages via TypeScript Project References
npm run build

# 4. Package standalone native host executable
cd packages/native-host
node ./scripts/buildExecutable.mjs
cd ../..

# 5. Verify the generated executable hash
Get-FileHash -Algorithm SHA256 packages/native-host/dist/mediator-native-host.exe
# Expected Output SHA256: 87FCB9871267E210E80D85CD4241511924227D12913B200EC81098C7D0BCB584
```

---

## 3. Test Execution Instructions

### 3.1 Native Messaging Host Unit & Security Suites
```powershell
# Run the 3 native host suites (32 tests total)
npx vitest run packages/native-host
```
*Expected Result:* 3 test files, 32 passed, 0 failed.

### 3.2 Full Monorepo Regression & Quality Gates
```powershell
# Lint check
npm run lint

# TypeScript typecheck
npm run typecheck

# Full test suite (1,074 tests across 57 suites)
npm test
```
*Expected Result:* All 57 test files passed (100%), 0 errors, 0 warnings.

---

## 4. Installation & Registration Procedure

The Native Messaging Host is installed exclusively into the current user's security context (zero admin elevation required):

```powershell
# Run user-level Windows installer
powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1
```

### Registered Registry Locations:
1. `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.mediator.native_host`
2. `HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.mediator.native_host`

The registry keys point to the manifest file located at:
`%APPDATA%\Mediator\native-host\com.mediator.native_host.json`

---

## 5. Clean Uninstallation Procedure

```powershell
# Run user-level Windows uninstaller
powershell -ExecutionPolicy Bypass -File scripts/uninstall-windows.ps1
```

The script cleanly removes:
1. HKCU registry entries for Chrome and Edge.
2. Manifest and binary files in `%APPDATA%\Mediator\native-host`.
3. Preserves user-created files and personal WSL2 distributions (`Ubuntu`).
