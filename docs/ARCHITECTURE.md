# Mediator — Architecture Overview

**Version:** 1.0 (S00)  
**Reference:** Mediator_Final_Development_Plan_v1.3.md §15, §16, §19

---

## 1. Core principles

1. **Fail-closed** — unknown capability = disabled; missing proof = no execution
2. **Modular** — each package owns a narrow, independently testable surface with a typed public API
3. **TypeScript-first** — one language throughout; no Rust core in v1
4. **Local-first** — no cloud backend, no telemetry by default
5. **Pull-based MCP** — MCP server is read-only; IDE agent cannot push commands or self-approve
6. **Review-only default** — automatic execution requires a proven, canary-verified executor

---

## 2. Component overview

```
apps/
  browser-extension/     Provider UI observation, manual send fallback, Attach/Detach
  ide-extension/         Diff panel, approval UI, status panel, workspace adapter
  cli/                   start/stop/status/diagnostics — no arbitrary command runner

packages/
  shared-contracts/      Protocol types, Zod schemas, typed error codes, version constants
  task-domain/           State machine: IDLE → VERIFIED_COMPLETE (pure, no side effects)
  policy-engine/         Allow/deny, risk levels, protected paths, approval rules
  workspace-boundary/    Canonical root, path containment, secret path rules, hashes
  stage-store/           Shadow copy (app-data), patch application, conflict detection
  context-engine/        Project map, memory summaries, relevance ranking, redaction
  orchestrator/          Coordinates modules; only component that advances state machine
  provider-adapters/
    provider-gemini/     Gemini DOM extraction, conversation identity, reply send
  browser-bridge/        Tab state, Native Messaging client, chunked transfer
  native-host/           Origin allowlist, framed stdin/stdout, IPC transport
  ipc-core/              Named-pipe server (current-user DACL), message dispatch
  ide-adapter-vscode/    Public VS Code Extension API: workspace, diagnostics, diff
  ide-adapter-antigravity/ Documented Antigravity/MCP/CLI integration points
  mcp-server/            Narrow resources/tools (read-only), caller validation
  executor-contract/     Capability schema, evidence types, recipe invocation contract
  executor-ide-native/   STUB — pending GO-IDE canary
  executor-wsl2/         STUB — pending user opt-in + canary
  recipe-registry/       Immutable recipes, hash-pinned, fixed args
  audit-store/           SQLite append-only event log with hash chain
  approval-ui/           Pending approval display and resolution (IDE UI only)
  diagnostics-ui/        Health/capability dashboard, safe debug bundle
```

---

## 3. Dependency directions (enforced by import-graph tests)

```
browser-extension  → shared-contracts, provider-adapters, browser-bridge
ide-extension      → shared-contracts, ide-adapters, approval-ui, diagnostics-ui
cli                → orchestrator, shared-contracts, diagnostics-ui
native-host        → shared-contracts, ipc client only
mcp-server         → shared-contracts, policy facade, context/stage facade
orchestrator       → task-domain, policy-engine, context-engine, stage-store,
                     executor-contract, audit-store, adapter interfaces
executor adapters  → executor-contract, OS/IDE integration only
provider adapters  → shared-contracts, browser DOM only
policy-engine      → shared-contracts (pure — no filesystem, no network)
```

**Forbidden directions:**
- Provider adapters → filesystem writes or executor
- MCP → host-shell functions or `resolve_approval`
- UI → policy bypass
- Executor adapters → browser DOM
- Audit → unredacted secrets
- `policy-engine` → any impure module

---

## 4. State machine summary

```
IDLE
 └─ ATTACHED
     └─ TASK_DEFINED
         └─ WAITING_FOR_AI
             └─ VALIDATING
                 └─ STAGING
                     ├─ REVIEW_REQUIRED          (user sees diff, approves/denies)
                     └─ READY_TO_VERIFY
                         ├─ EXECUTING            (only if verified executor available)
                         │   └─ SANITIZING
                         │       └─ RETURNING_TO_SAME_CHAT
                         │           └─ WAITING_FOR_AI  (next round)
                         └─ HANDOFF_PROMPT_READY (manual IDE-agent path)
                             └─ WAITING_FOR_USER_SUBMISSION
                                 └─ AGENT_REPORT_RECEIVED
                                     └─ WAITING_FOR_AI

Any state → PAUSED | DENIED | FAILED_SAFE | STOPPED
                                 └─ VERIFIED_COMPLETE (or USER_ACCEPTED_UNVERIFIED)
```

---

## 5. Protocol envelope summary

Every AI response must be wrapped in:
```
<<<MEDIATOR_PLAN>>>
{ "protocol_version": "1.3", "task_id": "...", "session_id": "...",
  "nonce": "...", "round": N, "sequence": N, "conversation": {...},
  "base_state_hash": "sha256:...", "status": "continue|await_user|proposed_complete",
  "actions": [...], "content_blocks": [...] }
<<<MEDIATOR_FILE id="..." bytes="N" sha256="...>>>
<file content>
<<<END_MEDIATOR_FILE_id>>>
<<<END_MEDIATOR_PLAN>>>
```

Validated fields: nonce, round, sequence, action IDs, base hash, conversation identity, content block byte lengths and SHA-256 hashes.

---

## 6. Evidence levels

| Level | Description | Can satisfy verification gate? |
|---|---|---|
| `mediator-executor-verified` | Mediator ran a recipe via verified executor; captured exit code | ✅ Yes |
| `trusted-ide-api-verified` | Tested IDE API adapter returned verified result | ✅ Yes |
| `ide-diagnostic-observed` | IDE API returned diagnostics | Diagnostic criteria only |
| `agent-reported` | IDE/web AI narrative says something ran | ❌ No |
| `manual-result-reported` | User pasted output | ❌ No |
| `user-accepted-unverified` | User explicitly accepted unverified work | Marked unverified |
