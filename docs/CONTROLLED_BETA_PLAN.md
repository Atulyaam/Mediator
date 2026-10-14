# CONTROLLED PERSONAL BETA OPERATIONAL PLAN

**Document Status:** Approved Operational Protocol (Sprint S50.6)  
**Candidate Build Identifier:** `v0.1.0-beta.1`  
**Target Environment:** Windows 11 Home (Standard User), Dedicated `MediatorSandbox` WSL2  
**Security Governance:** S00 `NO-GO-AUTOEXEC` — **BLOCKED**  
**Execution Mode:** Review-only V1 Exclusively  

---

## 1. Pilot Scope & Objectives

The Mediator Controlled Personal Beta is designed to validate real-world coding task workflows under rigorous security constraints before broader distribution.

### Permitted Pilot Scope
- Single developer machine running Windows 11 Home under a standard (non-elevated) user account.
- Repositories using verified toolchains:
  - **Node.js (npm):** Pure JS/TS projects with valid `package-lock.json` v2/v3.
  - **Python (pip):** Python 3.10+ projects with pinned `requirements.txt` or pre-staged vendor directories.
- Coding workflows: Bug fixes, localized refactorings, test authoring, and documentation updates.

### Prohibited Scope (Hard Stop)
- Production workspaces without independent Git version control backups.
- Projects requiring unpinned dynamic network installations during task execution.
- Native C/C++ packages requiring online compilation (`node-gyp`, dynamic headers).
- Unattended autonomous execution or background autopilot operation.

---

## 2. Preflight Health-Check Requirements

Before executing any beta coding task, the user must run the environment health doctor:

```powershell
mediator doctor
```

All mandatory checks must report **`READY`**:
1. `Core Engine`: Running on authenticated local named pipe.
2. `WSL2 Sandbox`: Dedicated `MediatorSandbox` distribution active.
3. `Network Isolation`: Linux user/network namespace (`unshare --user --net`) active and blocking egress.
4. `Offline Toolchains`: Python 3.14+ and Node.js v24 toolchains verified.
5. `Active Workspace Scope`: Target directory selected, confirmed, and writable.
6. `Local Autopilot Policy`: S00 `NO-GO-AUTOEXEC` active; Autopilot status `BLOCKED`.

If any check reports `ACTION_REQUIRED`, follow the human-readable remediation instructions before proceeding.

---

## 3. Workspace Backup Expectations

Although Mediator automatically creates pre-apply backups in `.mediator/backups/<txId>/` before applying approved changes, beta participants must observe:
1. **Clean Git Working Tree:** Always ensure `git status` is clean or commit work before submitting a task.
2. **Dedicated Task Branch:** Work on dedicated Git feature branches (`feature/beta-test-*`).
3. **External Workspace Safeguard:** Never use Mediator on uncommitted files containing sensitive personal secrets or credentials.

---

## 4. Task Submission, Review & Apply Lifecycle

Every task during the beta follows the strict Review-only V1 workflow:

```
[1. Task Submission]
   User submits prompt via CLI (`mediator task submit "..."`) or Standalone UI.
         |
         v
[2. Staging & Diff Generation]
   AI provider generates proposal -> Staged in shadow folder (`.mediator/staging/<stageId>/`).
   Live workspace files remain 100% untouched.
         |
         v
[3. Offline Sandbox Validation]
   Candidate code tested inside `MediatorSandbox` under network isolation (`unshare --user --net`).
   Zero network access is granted.
         |
         v
[4. Human Diff Review]
   User inspects unified diff via Standalone UI or CLI (`mediator stage diff <stageId>`).
         |
         v
[5. Explicit Human Approval]
   User grants approval token via UI button or CLI (`mediator stage approve <approvalId>`).
         |
         v
[6. Atomic Apply & Verification]
   Broker verifies base content hashes match live disk (TOCTOU check).
   Creates pre-apply backup in `.mediator/backups/<txId>/`.
   Applies changes and consumes single-use approval token.
```

---

## 5. Issue Logging & Sanitized Diagnostics

1. **Zero Silent Telemetry:** Mediator transmits zero automated telemetry, background analytics, or diagnostic bundles over the network.
2. **Explicit User Export:** Diagnostic reports are generated only upon explicit user command:
   ```powershell
   mediator doctor --export ./mediator-health.json
   ```
3. **Automated Secret Redaction:** All exported logs and diagnostics are automatically scanned and scrubbed of API keys, AWS credentials, and tokens via `@mediator/context-security`.
4. **Bug Reporting:** Issue logs should be filed in the project tracker referencing the sanitized report and anonymized reproduction steps.

---

## 6. Immediate Stop Conditions & Suspension Protocol

Testing must be **suspended immediately** if any of the following occur:

| Stop Condition | Trigger Event | Immediate Response Action |
| :--- | :--- | :--- |
| **SC-01: Network Egress Detected** | Sandbox process makes successful network call. | Kill `MediatorCore`; check WSL2 `unshare` configuration. |
| **SC-02: Unapproved Workspace Write** | Live file modified without explicit approval. | Halt broker; check `.mediator/backups/`; rollback working tree. |
| **SC-03: Secret Leakage** | API token or credential visible in logs or UI. | Revoke credential immediately; purge `.mediator/logs/`. |
| **SC-04: Host Shell Breakout** | AI output triggers uncontained `cmd.exe` or `powershell.exe`. | Terminate process tree; file Critical security incident. |
| **SC-05: Personal Distro Interference** | Files modified in `Ubuntu` or `docker-desktop`. | Check `CANONICAL_MEDIATOR_SANDBOX_NAME` pinning. |

To cleanly suspend the beta:
```powershell
# Terminate running core and broker processes
Stop-Process -Name mediator-core, mediator-broker, node -ErrorAction SilentlyContinue

# Verify clean workspace state
git status
```
