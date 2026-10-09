# Mediator

**Personal AI-to-workspace bridge — TypeScript-first, local-first, fail-closed**

Mediator connects your existing browser AI conversation (Gemini, Claude, etc.) to your local coding workspace in Antigravity IDE or VS Code. It applies changes only to a shadow staging copy, shows you a file-by-file diff, and lets you approve before anything touches your real project.

---

## What it does

- 🔗 **Attaches to one specific browser conversation** — not a new chat, not an API call
- 📋 **Extracts AI proposals** — validates them against a typed protocol envelope
- 🧱 **Stages changes in a shadow copy** — your live workspace is never touched without approval
- 🔍 **Shows diffs + warnings** — protected paths, conflict alerts, risk level
- ✅ **Requires your approval** — approve once, deny, pause, stop, or rollback
- 📤 **Sends sanitized results back to the same chat** — keeps the AI loop going
- 🔒 **Never runs arbitrary commands** — Review-only by default; execution requires a proven sandbox

---

## Current status

**V1: Review-only mode** — Sprint 0 (Feasibility) completed. See `docs/SPRINT_STATUS.md`.

Automatic command execution is disabled until a verified executor sandbox is proven via canary test. This is an honest, useful product outcome — not a limitation of the design.

---

## Architecture

TypeScript monorepo with strict module boundaries. See `docs/ARCHITECTURE.md`.

```
apps/browser-extension     # Provider page observation + manual send
apps/ide-extension         # Diff panel, approvals, status
apps/cli                   # start/stop/status
packages/                  # 20 bounded modules (contracts, policy, staging, etc.)
```

---

## Getting started (development)

```powershell
# Requires Node.js >= 20 and npm >= 10
npm install
npm run build
npm run test
npm run typecheck
```

---

## Security

See `SECURITY.md` and `docs/THREAT_MODEL.md`.

Mediator is designed for personal use on a single developer workstation. It does not have a cloud backend, does not send telemetry, and stores all data locally.

---

## Sprint map

See `Mediator_Sprint_Wise_Development_Plan_v1.3.md` for the full sprint-by-sprint roadmap (S00–S28).

---

## License

Personal use. Not yet released publicly. Do not publish until permissions and privacy are documented per `docs/SPRINT_STATUS.md` S28 exit gate.
