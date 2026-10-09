# MEDIATOR — Sprint-Wise Development Plan v1.3

**Purpose:** Build Mediator in small, testable increments for one developer using Antigravity/VS Code.  
**Master source of truth:** `Mediator_Final_Development_Plan.md` (v1.3).  
**Target:** Windows 11, Chrome/Edge, one local workspace, one active task, one provider first.  
**Execution principle:** review-only is always a valid product outcome; automatic command execution is enabled only after a measured security GO decision.  
**Planning unit:** each sprint is one narrow vertical slice, typically a few focused sessions. This is a sizing guide, not a deadline. Extend a sprint instead of bypassing its exit gate.

---

## 1. How to run these sprints

Build exactly one sprint at a time. Do not give the coding agent the whole roadmap and ask it to implement everything. For every sprint:

1. Read the master plan and this sprint's scope.
2. Inspect the current repository and `docs/SPRINT_STATUS.md`; never assume a task is still missing.
3. Write a short checklist before editing. Make only this sprint's changes.
4. Add focused unit/contract tests before integration tests.
5. Run the exact tests and report real exit codes. Never claim a test passed if it did not run.
6. Update `docs/SPRINT_STATUS.md`, `docs/DEBUGGING.md` when a new failure boundary is added, and the relevant architecture decision record (ADR) when a design decision changes.
7. Commit or checkpoint only after reviewing the diff. Never remove unrelated user work.
8. Stop at the exit gate. Do not start the next sprint automatically.

### Definition of Done — every sprint

- Acceptance criteria are demonstrated by tests or a reproducible manual checklist.
- Error paths are tested, not just the happy path.
- No secrets, host credentials, or full unfiltered chat dumps are added to fixtures/logs.
- Module boundaries are preserved; no shortcut around the policy facade.
- Exact files changed, commands run, exit codes, known limitations, and unresolved risks are recorded.
- Any security failure blocks progression.

### V1 scope guardrails

- TypeScript-first. Do not build Rust and TypeScript cores simultaneously.
- No Docker/Podman requirement and no automatic installation of them.
- No arbitrary AI-provided shell commands; no host-shell fallback.
- No outside-workspace file mutation/deletion in v1.
- Keep all AI rounds in the same existing provider conversation. Never silently open a new chat.
- MCP handoff to an IDE agent is pull-based/manual unless a documented supported API proves otherwise; don't advertise automatic IDE-agent execution when there is only a handoff prompt.
- Agent-reported test success is not executor-verified success.
- Do not add a vector database or local LLM in v1.

---

## 2. Sprint map

| Sprint | Small outcome | Depends on |
|---|---|---|
| S00 | Feasibility spike and execution GO/NO-GO | None |
| S01 | Repository scaffold + minimal IDE status panel | S00 |
| S02 | Shared contracts, typed errors, correlation IDs | S01 |
| S03 | Task/session state machine | S02 |
| S04 | Canonical workspace root | S02 |
| S05 | Path containment and Windows edge-case defenses | S04 |
| S06 | Secret scanner and safe context filtering | S04–S05 |
| S07 | Pure policy engine, action enum, protected paths | S02, S05 |
| S08 | Nonce-bound protocol envelope and replay protection | S03, S07 |
| S09 | Safe content-block framing and bounded transfers | S08 |
| S10 | SQLite task/action ledger and audit events | S03, S08 |
| S11 | Compact project/task context engine | S06, S10 |
| S12 | Shadow staging store and source/stage identity | S05, S10 |
| S13 | Patch application, base hashes and conflict detection | S07–S08, S12 |
| S14 | IDE diff panel, approvals and rollback UI | S01, S12–S13 |
| S15 | IDE workspace adapter and incremental project map | S01, S06 |
| S16 | Read-only MCP resources and tools | S02, S10–S11, S15 |
| S17 | MCP handoff UX and untrusted agent-reported evidence | S07, S14, S16 |
| S18 | Browser extension shell and provider fixtures | S02, S08–S09 |
| S19 | Native host + authenticated local IPC | S01–S03, S18 |
| S20 | First provider same-chat adapter | S00, S08–S09, S18–S19 |
| S21 | Executor capability contract and canary tests | S00, S07, S12–S13 |
| S22 | Implement only the Sprint 0-approved execution path | S21 |
| S23 | Fixed recipe registry and dependency/test flow | S07, S10, S21–S22 |
| S24 | Assisted end-to-end loop with evidence authority | S14, S20, S22–S23 |
| S25 | Recovery, loop budgets, context compaction and observability | S10–S11, S19–S24 |
| S26 | Limited Autopilot for low-risk cases | S24–S25 and all security gates |
| S27 | Second provider and bounded web-research adapter | S20, S24–S25 |
| S28 | Release security test, install/uninstall and personal-use release | S00–S27 |

Parallel work is optional. If working solo, keep this order so integration failures are easier to isolate.

---

# Phase A — Prove feasibility and establish the foundation

## S00 — Feasibility spike + explicit execution GO/NO-GO

**Goal:** Resolve the two biggest unknowns before building the system around assumptions.

**Tasks**
- [ ] Pick one first provider based on accessible UI and an acceptable interaction approach.
- [ ] In a disposable test conversation, read one completed AI answer and extract raw code/text reliably.
- [ ] Prepare a short result and manually send it into the same conversation; verify it appears in the correct chat.
- [ ] Test the target IDE's documented native sandbox/API/CLI path with a harmless canary project. Record product version, OS, settings, exact process path, effective filesystem/network behavior, exit-code availability, and failure behavior.
- [ ] Decide one outcome: **GO-IDE**, **GO-WSL2** (opt-in, only after separate canary plan passes), or **NO-GO-AUTOEXEC**.
- [ ] Check provider terms/acceptable use for intended UI automation and document what is allowed/uncertain.

**Deliverables:** `docs/FEASIBILITY_SPIKE.md`, `docs/SANDBOX_CAPABILITIES.md`, ADR for first provider, written GO/NO-GO decision.

**Exit gate:** same-chat read/prepare/manual-send proof exists; execution decision is explicit. If no safe executor is proven, product direction becomes review-only + diff + manual IDE-agent handoff. No command execution is built in this sprint.

**Do not proceed if:** the project relies on an undocumented IDE API or sandbox guarantees are inferred rather than tested.

## S01 — Repository scaffold + minimal IDE panel

**Goal:** Create a runnable shell with visible status, not a partially implemented agent.

**Tasks**
- [ ] Create a TypeScript workspace/monorepo with `apps/ide-extension`, `apps/browser-extension`, `apps/cli`, and `packages/*`.
- [ ] Configure formatting, lint, typecheck, unit tests, and CI.
- [ ] Add README, SECURITY, threat model, architecture ADRs, `docs/SPRINT_STATUS.md`, and `docs/DEBUGGING.md`.
- [ ] Implement a minimal IDE panel showing Mediator stopped/running, selected workspace, and detected capabilities (initially mostly unavailable).
- [ ] Add a start/stop command that changes only local app state; it must not run shell commands.

**Exit gate:** clean checkout can install/build/test using documented commands; IDE panel reports accurate status and has no privileged execution path.

## S02 — Shared contracts, typed errors and correlation IDs

**Goal:** Make every module speak the same typed protocol and make failures traceable.

**Tasks**
- [ ] Add shared types for `Task`, `Session`, `Round`, `Action`, `Approval`, `Evidence`, `ExecutorCapability`, and `ProviderIdentity`.
- [ ] Create stable typed error codes such as `PATH_DENIED`, `NONCE_MISMATCH`, `CONVERSATION_MISMATCH`, `CAPABILITY_UNAVAILABLE`, `APPROVAL_REQUIRED`, `TRANSFER_INCOMPLETE`, and `CORE_NOT_RUNNING`.
- [ ] Add `requestId`, `correlationId`, and `taskId` to boundary events.
- [ ] Define protocol version and schema-validation conventions.
- [ ] Add tests for unknown fields, missing required fields, and oversized input.

**Exit gate:** browser/IDE/core packages can import shared contracts; invalid data returns typed errors, not uncaught exceptions or silent coercion.

## S03 — Explicit task/session state machine

**Goal:** Prevent overlapping actions and ambiguous recovery.

**Tasks**
- [ ] Define states: `IDLE`, `ATTACHED`, `TASK_DEFINED`, `WAITING_FOR_AI`, `VALIDATING`, `STAGING`, `REVIEW_REQUIRED`, `READY_TO_VERIFY`, `EXECUTING`, `SANITIZING`, `RETURNING_TO_SAME_CHAT`, `PAUSED`, `DENIED`, `FAILED_SAFE`, `STOPPED`, `VERIFIED_COMPLETE`.
- [ ] Define allowed transitions in one pure module.
- [ ] Add pause, stop, timeout, failure, and uncertain-action transitions.
- [ ] Enforce one active task in v1.
- [ ] Add transition-table tests, including impossible state changes.

**Exit gate:** no component can directly mutate the state; only the orchestrator calls the transition API. Stop prevents new round scheduling.

---

# Phase B — Workspace safety and policy

## S04 — Canonical workspace root

**Goal:** Establish the only project root Mediator is allowed to operate in.

**Tasks**
- [ ] Read the workspace from the IDE API/CLI, resolve the canonical path, and display it.
- [ ] Require user confirmation on first attach and if the canonical path changes.
- [ ] Keep selected path and canonical resolved path separately for audit.
- [ ] Handle OneDrive-redirected Desktop and unavailable/cloud-placeholder paths by showing a clear status.
- [ ] Do not hard-code `C:\Users\...` sample paths.

**Exit gate:** the workspace root is known and confirmed before any file read/write action. Empty, missing, or unresolved root denies operations.

## S05 — Path containment and Windows edge cases

**Goal:** Prove that path manipulation cannot escape the selected root.

**Tasks**
- [ ] Reject traversal, outside-root absolute paths, alternate data streams, reserved device names, trailing dots/spaces, malformed paths and unsupported special files.
- [ ] Handle case-insensitivity, Unicode normalization, CRLF/LF, BOM and long paths consistently.
- [ ] Resolve symlinks/junctions/reparse points and deny if target crosses root or cannot be verified.
- [ ] Revalidate paths immediately before reads/writes to reduce TOCTOU risk.
- [ ] Test 8.3 aliases and OneDrive/cloud placeholder behavior where the test environment permits.

**Exit gate:** adversarial path tests all deny outside-root access; a skipped platform-specific test is clearly marked unverified, not passed.

## S06 — Secret scanner + context filter

**Goal:** Stop credentials reaching web AI, ordinary logs, or debug bundles.

**Tasks**
- [ ] Add baseline secret patterns: `.env*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `id_rsa`, `id_ed25519`, `.ssh/`, `.npmrc`, `.pypirc`, `.netrc`, `.aws/`, `.docker/config.json`, `.kube/config`, `.git/config`, `*.tfstate`, `terraform.tfvars`, `credentials.json`, `service-account*.json`, `appsettings.*.json`, `*.kdbx`.
- [ ] Add user-defined patterns and `.mediatorignore` support for context collection only.
- [ ] Redact matching values in terminal output, diagnostics, logs, context packets, crash bundles and exports.
- [ ] Add synthetic secret fixtures and test that they never leave the local boundary.
- [ ] Provide a preview of files/context that would be sent before first real run.

**Exit gate:** tests assert exact fixture secrets do not appear in output packets or logs. A path ignore never overrides access policy.

## S07 — Pure policy engine + action registry

**Goal:** Centralize all allow/deny decisions before any mutation or executor action.

**Tasks**
- [ ] Define action enum: `get_task_brief`, `get_relevant_context`, `list_staged_changes`, `get_diff`, `read_file`, `search_text`, `propose_patch`, `request_more_context`, `request_approval`, `submit_agent_report`, `pause_task`, `get_capabilities`, `apply_patch_to_stage`, `run_recipe`, `apply_staged_changes`, `rollback_checkpoint`.
- [ ] Define risk levels and hard denies in code.
- [ ] Add protected path matcher for package/lock files, scripts, hooks, workflows, IDE tasks, devcontainer files, test hooks, and Mediator security settings.
- [ ] Deny outside-workspace mutation/deletion in v1; no one-time exception.
- [ ] Add deterministic table-driven tests for every action x permission/risk combination.

**Exit gate:** every browser/MCP/IDE request routes through one policy facade; there is no alternate path to perform a protected action.

---

# Phase C — Protocol, local state and context

## S08 — Nonce-bound protocol envelope

**Goal:** Reject copied, stale, malformed or cross-conversation proposals.

**Tasks**
- [ ] Require `protocol_version`, `task_id`, `session_id`, `nonce`, `round`, `sequence`, `action_id`, provider/conversation identity, stable message/branch identity where available, `base_state_hash`, `actions`, and one canonical status enum.
- [ ] Generate a cryptographically random nonce for each attached session.
- [ ] Track consumed action IDs; reject duplicate sequence, stale round, wrong nonce, wrong base hash and wrong conversation/branch.
- [ ] Define statuses as `continue`, `await_user`, or `complete`; don't accept competing completion signals.
- [ ] Add replay, tampering and wrong-session tests.

**Exit gate:** all stale/replayed/mismatched packets reject without side effects.

## S09 — Content-block framing and payload limits

**Goal:** Carry source code safely without giant escaped JSON payloads.

**Tasks**
- [ ] Define manifest-plus-body format: small JSON manifest and separately delimited file body blocks.
- [ ] Add generated delimiters, explicit encoding, byte length, per-block hash and whole-payload hash.
- [ ] Set file, plan, context, and total-transfer caps.
- [ ] Define `request_more_context` with topic/path hints and budget; reapply path/secret filters on every response.
- [ ] Parse incomplete chunks into temporary buffers only; don't stage until complete length/hash validation passes.

**Exit gate:** partial, reordered, duplicate, oversized, bad-hash and delimiter-confusion test cases all reject safely.

## S10 — SQLite task ledger + audit events

**Goal:** Persist progress and recover without repeating unknown actions.

**Tasks**
- [ ] Add SQLite migrations for tasks, sessions, rounds, actions, approvals, evidence, context summaries, and audit events.
- [ ] Make action status transitions append-only in the ledger.
- [ ] Store recipe/payload/diff hashes, approvals, exit codes and timestamps; never store secrets or full page dumps by default.
- [ ] Add tamper-evident previous-event hash linkage.
- [ ] Add startup recovery that classifies in-flight actions as `unknown` until reconciled.

**Exit gate:** restart restores task/session state and never blindly replays an in-flight action.

## S11 — Compact context engine + project memory

**Goal:** Send only the context needed for the next AI decision.

**Tasks**
- [ ] Build an incremental project map from metadata, IDE symbols and allowed files; skip ignored/secret paths.
- [ ] Store goal, acceptance criteria, last round, changed files, test evidence, blockers, decisions and next action.
- [ ] Assemble token/byte-budgeted packets using state deltas, relevant diffs and exact error excerpts.
- [ ] Add omission markers and a `request_more_context` response flow.
- [ ] Add view/edit/clear/export for local summaries; don't clone the full web conversation.

**Exit gate:** fixtures prove context stays under budgets, omits secrets, and does not resend unchanged whole-repository content by default.

---

# Phase D — Safe staging and approval UX

## S12 — Shadow staging store

**Goal:** Keep AI edits separate from the live project until the user approves them.

**Tasks**
- [ ] Use Mediator app-data shadow copy as default; Git worktree is optional, not default.
- [ ] Record source-root identity, staged-root identity, base hashes and staged hashes.
- [ ] Exclude the stage from project indexing/context collection.
- [ ] Define `STAGE_ACCESS_UNVERIFIED` unless the selected executor can access stage while denying writes to source.
- [ ] Do not put staging inside the original workspace and then run with the whole original workspace accessible.

**Exit gate:** staging tests show no writes to live files. The path/capability relation is explicit; if no executor can safely see stage, execution stays disabled.

## S13 — Patch application and conflict detection

**Goal:** Apply changes only to the staging copy, with reproducible bases.

**Tasks**
- [ ] Implement structured search/replace or another exact patch format using unique context and expected base hash.
- [ ] Reject ambiguous matches or stale base files.
- [ ] Handle text encoding/newlines without unintended whole-file rewrites.
- [ ] Detect live workspace changes after the task starts and mark conflicts.
- [ ] Add tests for create/edit/delete/rename proposal; destructive operations remain manual-only.

**Exit gate:** all patch operations mutate stage only; a conflict never silently overwrites the user's edit.

## S14 — IDE diff panel + local approval UI

**Goal:** Give the user a trustworthy control surface before apply/execute.

**Tasks**
- [ ] Show changed paths, diff, protected-path warnings, risk level and base-hash conflict status.
- [ ] Implement Approve once, Deny, Pause, Stop and Rollback actions.
- [ ] Bind approval to a specific action ID + payload hash + scope + expiry (120 seconds default).
- [ ] Resolve approvals only in the trusted Mediator/IDE UI, never via browser AI or MCP.
- [ ] Implement transactional/recoverable apply-back only after approved diff; retain rollback checkpoint.

**Exit gate:** MCP/AI cannot approve itself; expired or modified payload approval is rejected; rollback preserves unrelated user changes.

---

# Phase E — IDE tools and MCP handoff

## S15 — IDE workspace adapter

**Goal:** Use the IDE for project-aware context instead of dumping files.

**Tasks**
- [ ] Read workspace path, Git status, diagnostics and language-server symbols where supported.
- [ ] Add test discovery and selected editor/selection context only after user opt-in.
- [ ] Version and capability-test VS Code and Antigravity separately.
- [ ] Return `CAPABILITY_UNAVAILABLE` for unsupported API calls rather than fabricated data.

**Exit gate:** adapter contract tests cover available/unavailable capabilities and return stable typed responses.

## S16 — Read-only MCP context server

**Goal:** Allow supported IDE agents to retrieve safe context.

**Tasks**
- [ ] Implement read resources for task brief, project rules, acceptance criteria, changed files, verification status and relevant context.
- [ ] Implement read tools for capabilities, task brief, relevant context, staged changes and diff.
- [ ] Use local stdio transport where supported; don't expose public network listener.
- [ ] Validate caller/session ID, schema, path, payload size and expiry on every request.
- [ ] Add tests proving MCP cannot read excluded secrets or access outside paths.

**Exit gate:** MCP is read-only and cannot invoke commands, mutate policy or resolve approvals.

## S17 — MCP handoff UX + evidence provenance

**Goal:** Make pull-based IDE agent behavior honest and safe.

**Tasks**
- [ ] Add “Prepare IDE Agent Handoff” which generates a bounded prompt: call `mediator.get_task_brief`, inspect relevant diff, perform only the stated task and report evidence.
- [ ] Add copy prompt, handoff ID, “Waiting for IDE agent”, “Paste/ingest report”, “Cancel handoff” controls.
- [ ] Agent-reported outputs are marked `agent-reported`; they never pass verification gates.
- [ ] Approval requests from MCP create pending requests; only trusted UI resolves them.
- [ ] Add caller/session/handoff validation and audit logs.

**Exit gate:** documentation/UI never claims MCP can push execution into the IDE agent automatically. Agent cannot self-approve or self-certify tests.

---

# Phase F — Browser, Native Messaging and same-chat integration

## S18 — Browser extension shell + provider fixtures

**Goal:** Test the browser side independently from local execution.

**Tasks**
- [ ] Create Manifest V3 extension with an explicit Attach/Detach action and visible provider/tab status.
- [ ] Define provider adapter interface and mocked DOM fixtures.
- [ ] Detect supported page, streaming/incomplete state, and obvious login/navigation changes.
- [ ] Store no long-lived secret or API credential in content scripts.
- [ ] Add manual-send workflow using a prepared message draft.

**Exit gate:** fixture tests demonstrate correct extraction and safe pause on unknown page state. No filesystem or shell permissions exist in the browser extension.

## S19 — Native host + local IPC

**Goal:** Bridge browser to the running core without exposing a general local API.

**Tasks**
- [ ] Register a real `.exe` native host; test Node SEA/packaging stability and keep documented fallback packaging decision. Never rely on a `.bat` wrapper.
- [ ] Validate exact extension ID/origin, schema, version handshake, request rate, session and payload size.
- [ ] Use a Windows named pipe with DACL limited to current-user SID and SYSTEM; reject remote clients; use random pipe name and a short-lived pairing challenge/token.
- [ ] Reserve stdout for Native Messaging frames; send sanitized diagnostics to stderr.
- [ ] Chunk transfers at 256 KiB with transfer ID, index/count, hashes, ACK/backpressure, expiry, cancellation and an 8 MiB default logical ceiling.
- [ ] Test service worker sleep/restart, host/core restart, lost ACK, duplicate requests and core-not-running behavior.

**Exit gate:** wrong origin, bad token, oversized/incomplete/replayed transfer and remote IPC attempts reject. No partial payload is accepted as a plan.

## S20 — First provider same-chat adapter

**Goal:** Complete a read-and-reply round trip without command execution.

**Tasks**
- [ ] Track provider, tab, conversation ID/URL and latest message/branch identity where available.
- [ ] Wait for response-complete, extract raw text/code blocks and parse protocol envelope.
- [ ] Use a priming message with session nonce and ping/pong conformance test.
- [ ] Prepare reply draft and insert/submit only when tested; verify acceptance. Keep manual click-to-send fallback.
- [ ] Pause on edits/regeneration, branch switch, tab switch, login page, DOM drift or uncertain identity.

**Exit gate:** 20+ recorded/mock cases either continue in the same chat or pause safely. No case silently creates a new chat or sends to another conversation.

---

# Phase G — Execution capability and test recipes

## S21 — Executor capability schema + canary harness

**Goal:** Make every claimed sandbox guarantee evidence-backed.

**Tasks**
- [ ] Implement per-field values for filesystem read/write, source denial, secrets, executable/args, child processes, network, timeout, output, CPU/memory and cancellation.
- [ ] Each field contains `value`, `enforcedBy: mediator | ide | unknown`, and `evidenceRef`.
- [ ] `unknown` always counts as false for required guarantees.
- [ ] Build harmless canary tests: stage is readable, source is not writable, outside path denied, network policy observed, exit code captured, timeout/cancel behavior verified.
- [ ] Generate a human-readable capability report with active IDE/product version and settings.

**Exit gate:** a documentation citation alone cannot turn a capability green; runtime canary evidence is required.

## S22 — Implement only the approved executor path

**Goal:** Implement exactly the GO decision from S00.

**GO-IDE tasks**
- [ ] Implement only the documented tested IDE API/CLI path for a fixed recipe.
- [ ] Confirm the executor sees staging but cannot mutate the original source.
- [ ] Never assume the IDE agent's sandbox covers Mediator's custom process or MCP server.

**GO-WSL2 tasks**
- [ ] User opts in; set up a dedicated WSL2 distro and restricted user.
- [ ] Disable Windows automount/interop/inherited Windows PATH where supported; no host credentials/profiles.
- [ ] Transfer a validated stage archive into Linux filesystem; reject traversal/symlink archive entries; don't mount broad Windows drives.
- [ ] Prove network rules, process cancellation, source isolation and exact exit-code collection.

**NO-GO-AUTOEXEC tasks**
- [ ] Do not implement a runner. Add clear Review-only/manual handoff status and safe command suggestions.

**Exit gate:** only the chosen path exists in code; any failed canary disables automatic execution. No fallback to an untested runner or host shell.

## S23 — Hash-pinned recipe registry + dependencies

**Goal:** Let the user run known checks safely without allowing AI to invent executable commands.

**Tasks**
- [ ] Implement recipe IDs such as `project.test`, `project.lint`, `project.typecheck`, `project.build`, `project.single_test`, and safe `git.status`/`git.diff`.
- [ ] Pin recipe version/hash, executable, allowed args, cwd, environment policy, time/output budget and executor requirements.
- [ ] AI cannot control executable path, shell operators, mounts, network mode or sandbox flags.
- [ ] Separate dependency provision from test execution; validate manifest/lockfile and package risk signals.
- [ ] Provide synthetic `.env.test`; don't copy secrets. If required dependencies/network are absent, mark checks `blocked/not-run`.

**Exit gate:** recipe policy is tested with malicious flags/path input; unverified dependency scripts never run automatically.

---

# Phase H — Full loop and advanced automation

## S24 — Assisted end-to-end loop

**Goal:** Connect browser proposal, staging, approvals, safe verification and same-chat feedback.

**Tasks**
- [ ] Implement: completed AI response → protocol validation → policy decision → stage diff → trusted approval → verified executor/manual handoff → result sanitization → same-chat result.
- [ ] Keep evidence kinds separate: `executor-verified`, `ide-diagnostic-observed`, `agent-reported`, `user-verified`.
- [ ] Only trusted executor evidence can satisfy automated command checks; agent reports are informational.
- [ ] Verify user approval is bound to the exact payload hash and has not expired.
- [ ] Stop on wrong chat, stale hash, missing capability, secret hit, unknown action, repeated failure or budget limit.

**Exit gate:** 10 controlled test-repo tasks complete in the approved mode. Zero wrong-chat sends, outside-root access, unapproved commands, false verified labels, approval bypasses or secret leaks.

## S25 — Recovery, loop guard, observability and context compaction

**Goal:** Make restarts and long tasks predictable and easy to debug.

**Tasks**
- [ ] On restart, reconcile browser conversation identity, action ledger, staged hashes and pending approvals.
- [ ] Never replay an action with unknown status; query/inspect it or pause for the user.
- [ ] Add maximum rounds, runtime, actions, output bytes and repeated-error stop.
- [ ] Compact local task summary after each accepted round; send state delta rather than whole logs/repo.
- [ ] Add redacted debug bundle, correlation-ID timeline and context-size/repetition indicators.

**Exit gate:** crash/stop/restart tests never duplicate an action or lose the fact that execution status is unknown; debug bundle contains no synthetic secrets.

## S26 — Limited Autopilot (only if all gates pass)

**Goal:** Automate only proven low-risk operations.

**Tasks**
- [ ] Add opt-in policy profile with small iteration/time/output budgets.
- [ ] Allow auto-stage/apply only small ordinary text-file changes that are not protected and have no conflicts.
- [ ] Run only approved, hash-pinned recipes through the verified executor.
- [ ] Keep scripts, dependency changes, lockfiles, network, deletes/renames, protected files and ambiguous diffs manual.
- [ ] Any capability loss or uncertainty switches to Assisted/Review-only immediately.

**Exit gate:** adversarial tests show Autopilot cannot change its own policy, bypass approvals, run untrusted commands, or continue after sandbox failure. If previous gates fail, mark this sprint deferred.

## S27 — Second provider + optional bounded research

**Goal:** Expand carefully without breaking the proven adapter.

**Tasks**
- [ ] Add a second provider using the same adapter contract and same-chat identity rules.
- [ ] Re-run contract/fixture suites; keep manual send available.
- [ ] Perform provider terms/acceptable-use review and implement rate-limit-aware backoff.
- [ ] If web retrieval is needed, use HTTPS allowlisted sources, block private/loopback/metadata hosts, validate redirects, record URL/access date, and pass only short evidence excerpts.
- [ ] Keep API mode separate and opt-in; never silently migrate a browser conversation to API context.

**Exit gate:** supported providers never send to a wrong chat; web content is treated as untrusted evidence, not executable instruction. Third provider can be a later sprint if time is limited.

## S28 — Security hardening, install/uninstall and release

**Goal:** Ship a usable personal-use build with honest limits.

**Tasks**
- [ ] Run full path, secret, nonce, transfer, IPC, approval, MCP, staging, evidence, sandbox, recovery and provider-identity suites.
- [ ] Test extension install/uninstall and native host registration/unregistration; handle stale entries safely.
- [ ] Document extension ID/origin pinning, supported IDE/provider versions, execution GO/NO-GO result, install, recovery and data clearing.
- [ ] Verify audit hash-chain and privacy/retention controls.
- [ ] Prepare known-limitations and troubleshooting guide; don't claim support for untested IDEs.

**Exit gate:** every release blocker in the master plan is closed. If sandbox execution is not proven, release as Review-only rather than weakening controls.

---

## 3. Modular architecture and debugging rules

Keep modules independently testable with narrow public APIs:

```text
apps/
  ide-extension/       # IDE UI, approvals, diff, workspace capability adapter
  browser-extension/   # provider-page observation and user-facing controls only
  cli/                 # start/stop/status/diagnostics; no arbitrary command runner
packages/
  contracts/            # shared schemas, protocol types, typed errors
  orchestrator/         # state machine; coordinates modules
  policy-engine/        # allow/deny, risks, protected paths, approvals check
  workspace-boundary/   # canonical paths, containment, secret path rules
  staging-store/        # shadow project, patches, hashes, conflict detection
  context-engine/       # project map, summaries, budgets, redaction
  provider-adapters/    # provider-specific DOM/composer logic
  mcp-server/           # narrow resources/tools, handoff records, agent reports
  native-host/          # Native Messaging framing and IPC authentication
  executor-contract/    # capability schema, evidence, recipe invocation contract
  audit-store/          # SQLite ledger, event chain, recovery
```

### Dependency directions

- Provider adapters may call contracts and orchestrator ports; they must not access filesystem, IPC internals, or executor directly.
- MCP server may call the policy/orchestrator facade; it must not invoke a shell or resolve approvals.
- IDE extension calls documented IDE APIs and Mediator ports; it may resolve approval only through the trusted local approval service.
- Workspace/staging modules never import browser DOM code.
- Executor code receives a validated recipe, not arbitrary command text or AI prose.
- The orchestrator is the only component allowed to advance the task state machine.
- Security hard-deny rules live in code and tests, not only in prompts/docs.

### Debugging contract for every module

Each module exports typed errors, attaches `taskId`/`correlationId`, logs concise structured events with redaction, has unit tests at its public boundary, and documents capability assumptions. Don't log raw conversation bodies by default. A debug bundle is opt-in and redacted.

---

## 4. Standard prompt to give Antigravity for one sprint

Copy this template, replace sprint number/title, and run it once per sprint:

> You are implementing Mediator under `Mediator_Final_Development_Plan.md` (v1.3). Treat that master plan and this sprint plan as the source of truth. Read the current sprint section, `docs/SPRINT_STATUS.md`, `docs/THREAT_MODEL.md`, and relevant module documentation before editing.
>
> **Current sprint:** S[NN] — [TITLE].
>
> First inspect the repository and report what is already implemented, missing, failing, or inconsistent. Then create a short checklist. Implement only this sprint. Add unit/contract tests at the same time. Do not start the next sprint automatically.
>
> **Security invariants:** no Docker dependency; no arbitrary AI text executed by a shell; no host-shell fallback; strict workspace boundary; protected paths never auto-apply; no external workspace mutation; same provider conversation across rounds; nonce/round/sequence/conversation identity validated; MCP is not a sandbox and cannot self-approve; agent-reported results never become executor-verified; unknown executor capabilities are false; commands run only through the Sprint 0-approved path.
>
> Keep modules independent; use public interfaces, typed errors and correlation IDs. Do not bypass `policy-engine`. Do not delete or overwrite unrelated user files. If a required capability or API is unavailable, report it rather than inventing one.
>
> Run in-scope tests only. Report exact commands and exit codes, files changed, test results, security checks, known limits and unverified assumptions. Update `docs/SPRINT_STATUS.md` and `docs/DEBUGGING.md` where appropriate. Do not mark this sprint complete if any acceptance criterion or security gate fails.

---

## 5. `docs/SPRINT_STATUS.md` template

```markdown
# Sprint Status

- Master spec: Mediator_Final_Development_Plan.md v1.3
- Current sprint: S00 — Feasibility spike
- Status: NOT_STARTED | IN_PROGRESS | BLOCKED | PASS
- Provider / IDE / OS versions:
- Execution GO/NO-GO:

## Implemented
- ...

## Commands and tests actually run
| Command | Exit code | Result | Evidence |
|---|---:|---|---|

## Security tests
- ...

## Changed files
- ...

## Known limitations / unverified assumptions
- ...

## Decisions / ADRs
- ...

## Next sprint
- ...
```

Only mark PASS when all exit gates pass and test results are recorded. A blocked sandbox is a legitimate NO-GO, not a reason to bypass security.

---

## 6. First three actions

1. Place `Mediator_Final_Development_Plan.md` and this sprint plan at the root of the repository.
2. Start **S00 only**. Run the same-chat browser spike and write the sandbox GO/NO-GO report.
3. After S00 passes its exit gate, start S01. Continue one sprint at a time.

**Final rule:** small sprints should reduce uncertainty. Each sprint delivers one independently tested capability, and each security-sensitive capability earns activation through evidence. The goal is a working Mediator that is honest about what it can safely automate—not an unsafe Autopilot assembled quickly.
