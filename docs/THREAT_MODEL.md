# Mediator — Threat Model

**Version:** 1.0  
**Date:** 2026-10-10  
**Sprint:** S00  
**Reference:** Mediator_Final_Development_Plan_v1.3.md §5, §7, §10

---

## 1. Assets

| Asset | Sensitivity | Owner |
|---|---|---|
| Live workspace source files | High | User |
| Secret files (.env, .pem, .key, .ssh, etc.) | Critical | User |
| Provider conversation identity / nonce | High | Mediator |
| SQLite task ledger / audit log | High | Mediator |
| Shadow staging store | Medium | Mediator |
| Mediator app-data (summaries, profiles) | Medium | Mediator |
| Native host IPC pipe | High | Mediator |
| Extension ID / pairing token | High | Mediator |

---

## 2. Threat actors

| Actor | Trust level | Access vector |
|---|---|---|
| Web AI (provider) | **Untrusted** | Browser tab DOM / protocol envelope |
| MCP caller (IDE agent) | **Untrusted input** | Local stdio |
| Browser content scripts | **Untrusted context** | Renderer process |
| Native host origin | **Validated** | Extension ID allowlist + version handshake |
| Local Mediator core | **Trusted** | Named pipe with user-SID DACL |
| IDE extension (approved) | **Trusted for approvals** | VS Code Extension API |
| User | **Trusted** | IDE UI, approval dialogs |
| Malware running as same user | **Threat** | Same process space — documented limitation |

---

## 3. Threats and mitigations

### T1 — AI proposes path traversal
- **Attack:** AI includes `../../` or absolute outside-workspace path in a `propose_patch` action
- **Mitigation:** `workspace-boundary` module rejects all traversal, outside-root absolute paths, alternate data streams, device names. Path re-validated immediately before read/write (TOCTOU reduction).
- **Sprint:** S05

### T2 — Stale / replayed protocol envelope
- **Attack:** AI or attacker replays an old plan envelope
- **Mitigation:** Nonce bound per session; monotonic round/sequence; action IDs tracked; `base_state_hash` validated; old envelopes rejected without side effects.
- **Sprint:** S08

### T3 — Secret exfiltration to provider
- **Attack:** Context assembly includes `.env`, `.pem`, or other secret file content
- **Mitigation:** `context-engine` applies secret exclusion patterns before assembling any AI-bound packet. `workspace-boundary` excludes secret paths from reads. Tested with synthetic secret fixtures.
- **Sprint:** S06

### T4 — AI self-approves or MCP self-certifies
- **Attack:** MCP tool call or AI envelope claims approval was granted or tests passed
- **Mitigation:** Approvals resolved only through IDE UI (`approval-ui`). MCP `request_approval` creates a pending request only. `agent-reported` evidence never satisfies verification gates.
- **Sprints:** S07, S17

### T5 — Wrong conversation send
- **Attack:** Mediator sends a result to a different conversation tab
- **Mitigation:** Conversation identity (provider, conversation ID, tab ID, message ID, branch ID) validated on every round. Pause on any identity change. 20+ fixture tests required.
- **Sprint:** S20

### T6 — Malicious IPC client
- **Attack:** Another process connects to the Mediator named pipe
- **Mitigation:** Named pipe DACL limited to current user SID + SYSTEM. Remote clients rejected. Random pipe name. Short-lived challenge/token handshake.
- **Sprint:** S19

### T7 — AI-generated command executed via host shell
- **Attack:** AI proposes an action that resolves to an arbitrary shell command
- **Hard deny:** No host-shell fallback ever. All execution through recipe registry with fixed executable + typed args. No arbitrary text to shell.
- **Sprints:** S07, S23

### T8 — Staging inside live workspace with full write access
- **Attack:** Executor can write to both stage and live source
- **Mitigation:** Stage is under Mediator app-data by default (outside workspace). Executor must prove stage-access + live-source write denial via canary before any execution is enabled.
- **Sprints:** S12, S21

### T9 — Concurrent user edit silently overwritten
- **Attack:** User edits a file while AI is staging a patch; apply-back overwrites it
- **Mitigation:** File watcher + base hash recheck before apply-back. Conflict detected → pause and show conflict to user.
- **Sprint:** S13

### T10 — Malware running as same user
- **Residual risk:** Malware at same privilege level can read the named pipe, access Mediator app data, or inject into the browser process.
- **Honest limitation:** This is outside Mediator's control. Documented here. Mediator reduces attack surface but cannot protect against a fully compromised user session.

---

## 4. Hard denials (always enforced in code)

1. Any file read/write/delete outside the selected workspace (except Mediator app-data)
2. Unrestricted host command execution
3. Host-shell fallback because sandbox is missing
4. Secret access or transmission to provider
5. Changing Mediator security policy from AI output
6. Disabling audit/verification/policy to keep a task running
7. Silent chat switching or silent provider change
8. Arbitrary network access from commands
9. Automatic execution of newly AI-modified install hooks or build scripts
10. Bypassing provider controls, CAPTCHA, or rate limits

---

## 5. Threat model limitations

- Mediator cannot protect against malware running at the same user privilege level.
- Named-pipe security reduces (but does not eliminate) local cross-process exposure.
- Browser extension content scripts run in the renderer; a compromised browser is outside scope.
- Provider ToS compliance is the user's responsibility for their own account.
