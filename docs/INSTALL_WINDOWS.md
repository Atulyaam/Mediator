# Mediator — Windows 11 Installation & Operations Guide

**Target OS:** Windows 11 (x64)  
**Execution Scope:** Current User (`HKEY_CURRENT_USER`), Zero Administrator Elevation  
**Release Mode:** Review-Only V1 (Personal Use)  

---

## 1. System Requirements

- **Operating System:** Windows 11 (Build 22000 or later)
- **Node.js:** v20.12.0+ (Tested on v24.13.0)
- **Browser:** Google Chrome (v120+) or Microsoft Edge (v120+)
- **IDE:** Antigravity IDE or Visual Studio Code (v1.85+)
- **Privileges:** Standard user account (**No Administrator / UAC prompt required**)

---

## 2. Directory Layout & Storage

Mediator adheres to standard Windows application conventions. All files are isolated to your user profile:

| Component | Filesystem / Registry Location | Description |
|---|---|---|
| **Native Host Binary** | `%LOCALAPPDATA%\Mediator\native-host\mediator-native-host.exe` | Standalone packaged executable (Node SEA) |
| **Manifest** | `%LOCALAPPDATA%\Mediator\native-host\com.mediator.native_host.json` | Chromium native messaging host manifest |
| **Chrome Registry** | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mediator.native_host` | Points to the host manifest |
| **Edge Registry** | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.mediator.native_host` | Points to the host manifest |
| **Task & Audit DB** | `%LOCALAPPDATA%\Mediator\mediator.db` | Local SQLite task ledger and tamper-evident audit log |
| **Shadow Staging** | `%LOCALAPPDATA%\Mediator\staging\` | Isolated directory where AI patches are staged before review |
| **Your Projects** | `C:\Users\<user>\Projects\...` | **100% untouched until you explicitly click Approve** |

---

## 3. Building From Source

Open PowerShell in the Mediator repository root:

```powershell
# 1. Install dependencies
npm install

# 2. Compile TypeScript packages and apps
npm run build

# 3. Verify all tests pass
npm test
```

---

## 4. Browser Extension Setup

1. Open your browser and navigate to the Extensions page:
   - **Google Chrome:** `chrome://extensions`
   - **Microsoft Edge:** `edge://extensions`
2. Enable **Developer mode** (toggle in top-right or left sidebar).
3. Click **Load unpacked** and select the folder:
   `apps/browser-extension`
4. Copy the 32-character extension ID shown on the card (e.g., `abcdefghijklmnopabcdefghijklmnop`).

---

## 5. Installing the Native Messaging Host

Run the idempotent PowerShell installer with your extension ID:

```powershell
.\scripts\install-windows.ps1 -ExtensionId "YOUR_32_CHAR_EXTENSION_ID"
```

### Installation Verification

You can verify the registry keys and manifest with PowerShell:

```powershell
# Check Chrome registration
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mediator.native_host" /ve

# Check Edge registration
reg query "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.mediator.native_host" /ve

# Check host manifest content
Get-Content "$env:LOCALAPPDATA\Mediator\native-host\com.mediator.native_host.json"
```

The output should show the manifest path pointing to `%LOCALAPPDATA%\Mediator\native-host\com.mediator.native_host.json`, with `allowed_origins` set to `chrome-extension://YOUR_EXTENSION_ID/`.

---

## 6. Starting Mediator Services

To start the Mediator core service and IDE bridge:

```powershell
# Start local IPC bridge & MCP server
node packages/cli/dist/index.js start
```

Alternatively, open your workspace folder in Antigravity IDE or VS Code with the Mediator extension enabled (`apps/ide-extension`).

---

## 7. Operational Workflow (Review-Only V1)

Mediator connects your active browser AI conversation with your local project:

1. **Attach to Conversation:**
   - Navigate to Google Gemini (`gemini.google.com`) or OpenAI ChatGPT (`chatgpt.com`).
   - Open your project conversation. Mediator observes the active thread and establishes a secure session nonce.
2. **AI Proposes a Plan:**
   - The AI responds with structured code patches inside a `<<<MEDIATOR_PLAN>>>` envelope.
3. **Shadow Staging:**
   - Mediator extracts the envelope, scans for secrets, checks path containment, and applies changes **only to the shadow staging directory**.
   - Your live workspace remains completely unaltered.
4. **Interactive Review in IDE:**
   - Open the Mediator review panel in your IDE.
   - Inspect the file-by-file diffs, conflict status, and policy warnings.
5. **Human Approval:**
   - Click **Approve** to transactionally apply the staged patch to your live project.
   - Or click **Reject** / **Rollback** to discard the staged changes.
6. **Recipe Suggestions:**
   - If the AI suggests running tests, typechecks, or builds, Mediator generates a copyable command labeled `MANUAL EXECUTION ONLY`.
   - Run the command in your terminal when you are ready. Under the S00 `NO-GO-AUTOEXEC` policy, Mediator will never execute shell commands automatically.

---

## 8. Data Privacy & Clearing User Data

Mediator does not collect telemetry or transmit workspace contents outside your machine.

### Clearing Local Session & Staging Data
To purge all task data, staged files, context summaries, and approvals while preserving the append-only audit trail:

```powershell
# Via PowerShell retention utility
node -e "
  const { DatabaseConnection } = require('./packages/persistence');
  const { DataRetentionManager } = require('./packages/persistence/dist/dataRetention');
  const db = new DatabaseConnection();
  const manager = new DataRetentionManager(db);
  manager.clearAllUserData();
  console.log('User data successfully cleared.');
"
```

---

## 9. Uninstallation

To cleanly remove Mediator from your system without affecting your project code:

```powershell
# Standard uninstall (removes registry keys and native messaging registration)
.\scripts\uninstall-windows.ps1

# Full uninstall (removes registry keys and deletes native-host folder in AppData)
.\scripts\uninstall-windows.ps1 -RemoveFiles

# Full wipe (removes registry keys, native-host folder, and purges all task/session data)
.\scripts\uninstall-windows.ps1 -RemoveFiles -PurgeUserData
```

---

## 10. Troubleshooting

### Extension Shows "CORE_NOT_RUNNING"
- Ensure Mediator core is running locally via `node packages/cli/dist/index.js start` or the IDE extension.
- Verify named pipe connectivity: `\\.\pipe\mediator-ipc`.

### Extension Shows "Disconnected from native host"
- Verify that `com.mediator.native_host.json` contains your exact 32-character extension ID.
- Verify the `path` in the JSON manifest points to an existing `mediator-native-host.exe`.
- Test running the native host binary directly from terminal to ensure no missing DLLs:
  ```powershell
  & "$env:LOCALAPPDATA\Mediator\native-host\mediator-native-host.exe" --version
  ```

### Staging Conflict Detected
- If you edit a file locally in your IDE while the AI is drafting a patch, Mediator detects the base hash divergence and marks the stage as conflicting.
- Resolve by refreshing context in the chat or discarding the stale staged changes.
