# Mediator — Troubleshooting & Diagnostic Guide

This guide provides actionable remediation steps for common issues encountered during setup, provider bridge communication, offline sandbox validation, and workspace application.

---

## 1. Quick Diagnostic Check

Whenever an issue arises, run the authoritative health doctor first:

```powershell
mediator doctor
```

To export a secret-safe, sanitized report for inspection:
```powershell
mediator doctor --export ./mediator-diag.json
```

---

## 2. AI Provider & Browser Extension Issues

### 2.1 "Provider needs sign-in" or Session Expired
- **Symptoms:** Mediator reports `PROVIDER_AUTH_REQUIRED` or fails to receive responses from Google Gemini, ChatGPT, or DeepSeek.
- **Root Cause:** The browser session cookie in your active tab has expired or you are logged out.
- **Remediation:**
  1. Open Chrome or Edge.
  2. Navigate directly to the provider's web application:
     - Gemini: `https://gemini.google.com`
     - ChatGPT: `https://chatgpt.com`
     - DeepSeek: `https://chat.deepseek.com`
  3. Sign in to your account and verify you can submit a prompt interactively.
  4. Return to Mediator and click **Select Provider** or re-submit your task.

### 2.2 Browser Extension Disconnected
- **Symptoms:** Extension icon is grayed out or displays "Core Offline".
- **Root Cause:** Mediator Core is not running on loopback or the pairing token does not match.
- **Remediation:**
  1. Ensure Mediator Core is running: `mediator status`.
  2. Copy your pairing token from the UI header or terminal.
  3. Click the Mediator extension icon in your browser toolbar, paste the token, and click **Connect**.
  4. In `chrome://extensions` or `edge://extensions`, click **Reload** on the Mediator extension.

### 2.3 Chromium Native Messaging Host Not Found
- **Symptoms:** Extension logs show `Specified native messaging host not found`.
- **Root Cause:** Registry key in `HKCU` is missing or points to a non-existent path.
- **Remediation:**
  1. Run the non-admin installer script:
     ```powershell
     powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1
     ```
  2. Verify the registry entry:
     ```powershell
     Get-ItemProperty "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.mediator.native_host"
     ```
  3. Restart Google Chrome / Microsoft Edge.

---

## 3. WSL2 Sandbox & Isolation Issues

### 3.1 "MediatorSandbox distribution not detected"
- **Symptoms:** Offline test validation fails with `SANDBOX_UNAVAILABLE`.
- **Root Cause:** The dedicated WSL2 distribution has not been provisioned.
- **Remediation:**
  1. Run the preparation script:
     ```powershell
     powershell -ExecutionPolicy Bypass -File scripts/prepare-wsl2-sandbox.ps1
     ```
  2. Verify registration:
     ```powershell
     wsl.exe -l -v
     ```
     Ensure `MediatorSandbox` appears in the list with `Version 2`.

### 3.2 WSL2 VHDX Locked or Sandbox Unresponsive
- **Symptoms:** Task execution hangs during sandbox dispatch or reports file lock errors.
- **Root Cause:** Background WSL container processes are frozen.
- **Remediation:**
  Terminate only the dedicated sandbox distribution (preserves all other WSL distros):
  ```powershell
  wsl.exe --terminate MediatorSandbox
  ```

### 3.3 Linux Network Namespace (`CLONE_NEWNET`) Error
- **Symptoms:** Executor reports `unshare: unshare(CLONE_NEWNET) failed: Operation not permitted`.
- **Root Cause:** WSL kernel does not permit user namespaces or isolation helper is missing.
- **Remediation:**
  Re-run `scripts/prepare-wsl2-sandbox.ps1` to re-apply the unshare user namespace configuration.

---

## 4. Offline Toolchains & Missing Dependencies

### 4.1 `OFFLINE_DEPENDENCY_MISSING`
- **Symptoms:** Task validation fails immediately with `OFFLINE_DEPENDENCY_MISSING: Package '<name>' not found in offline bundle`.
- **Root Cause:** Network egress is strictly blocked inside `MediatorSandbox`. Untrusted code cannot fetch packages dynamically from PyPI or npm.
- **Remediation:**
  1. For Python projects: Pre-download required wheel packages outside the untrusted sandbox:
     ```powershell
     pip download -r requirements.txt -d ./wheels/
     ```
  2. Generate a trusted offline manifest:
     ```powershell
     node -e "require('@mediator/recipe-registry').generateOfflineManifest('./wheels')"
     ```
  3. Place verified bundles in `%LOCALAPPDATA%\Mediator\bundles\` or include in project `vendor/` directory.

### 4.2 `BUNDLE_INTEGRITY_MISMATCH` or `BUNDLE_CORRUPTED`
- **Symptoms:** Toolchain bundle import rejected with checksum mismatch.
- **Root Cause:** Archive file was modified or corrupted during transfer.
- **Remediation:**
  Delete the corrupted bundle in `%LOCALAPPDATA%\Mediator\bundles\` and re-import with verified root SHA-256 hash.

---

## 5. Staging, Conflicts & Approval Issues

### 5.1 `WORKSPACE_DIRTY_CONFLICT`
- **Symptoms:** Live apply is rejected with:
  `Apply rejected: Workspace file '<path>' was modified concurrently after proposal staging.`
- **Root Cause:** TOCTOU protection detected that a file was edited externally (in your IDE or git) after Mediator created the shadow stage.
- **Remediation:**
  1. Inspect changes with `git status` or `git diff`.
  2. Either commit/stash your local changes, or reject the outdated stage:
     ```bash
     mediator approval resolve <approvalId> reject
     ```
  3. Re-submit the task or generate a fresh proposal against the current workspace commit.

### 5.2 Stale Approval Token
- **Symptoms:** Live apply fails with `Approval expired or already consumed`.
- **Root Cause:** Human approvals have a bounded freshness window (default 5 minutes) to prevent accidental re-application of stale code.
- **Remediation:**
  Re-stage the proposal and approve via UI or CLI.

---

## 6. Local Autopilot Questions

### 6.1 "Can I enable Local Autopilot for automated execution?"
- **Answer:** **No.** Under the authoritative policy S00 `NO-GO-AUTOEXEC`, Local Autopilot is **strictly BLOCKED** fail-closed.
- Mediator operates exclusively in **Review-only V1 mode**.
- Every file modification requires human review and explicit approval.
- Autopilot will not be enabled until multi-process OS privilege boundaries and kernel-enforced sandboxing are fully verified in future sprints.
