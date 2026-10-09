# Security Policy

## Scope

Mediator is a personal-use local tool. It is not a network service and does not have a public attack surface. This document covers the security design and how to report issues if you share this tool with others.

## Design principles

- **Fail-closed:** unknown capability = disabled; missing proof = no execution
- **No host-shell fallback:** AI text is never passed to a shell
- **Secret redaction:** `.env`, `.pem`, `.key`, `.ssh/`, `.aws/`, and 15+ other patterns are excluded from all AI-bound context
- **Workspace boundary:** strict path containment — no outside-workspace mutation in v1
- **Approval required:** protected paths, dependency changes, and any risk-elevated action require explicit user approval through the IDE UI only
- **Same-chat constraint:** Mediator never silently creates a new conversation

## Reporting an issue

If you find a security issue (path traversal bypass, secret leak, approval bypass, IPC vulnerability), please document it in `docs/THREAT_MODEL.md` and do not commit reproduction steps with real credentials.

## Hard denials

The following are permanently denied in code (not configurable from AI output or MCP):

1. File read/write/delete outside the selected workspace
2. Unrestricted host command execution
3. Host-shell fallback
4. Secret transmission to any provider
5. AI-controlled security policy changes
6. Disabling audit/verification/policy to keep a task running
7. Silent conversation/provider switching
8. Arbitrary network access from commands
9. Auto-execution of newly AI-modified install hooks or build scripts
10. Bypassing provider controls, CAPTCHA, or rate limits

## Known limitations

- Mediator cannot protect against malware running at the same user privilege level
- Named-pipe security reduces (but does not eliminate) cross-process exposure for same-user processes
- Browser extension content scripts run in the renderer process — a compromised browser is outside scope

## Version

Aligned with: `Mediator_Final_Development_Plan_v1.3.md`
