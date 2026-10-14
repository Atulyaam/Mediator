# Mediator — Debugging Guide

**Sprint:** S00+  
**Maintained by:** Update after each sprint that adds a new failure boundary.

---

## 1. Module debugging contract

Every module must:
- Export typed errors with stable error codes (e.g., `PATH_OUTSIDE_ROOT`, `NONCE_MISMATCH`)
- Attach `taskId`, `sessionId`, `correlationId`, `actionId` to all cross-module events
- Log structured JSON events: `{ severity, module, correlationId, taskId, roundId, actionId, duration, result }`
- Never log: nonces, tokens, secrets, raw provider HTML, full conversation bodies
- Have unit tests at its public API boundary

---

## 2. Known failure boundaries (updated per sprint)

| Sprint | Module | Failure type | Error code | How to detect |
|---|---|---|---|---|
| S00 | — | Sandbox canary UNKNOWN | `SANDBOX_UNVERIFIED` | SANDBOX_CAPABILITIES.md all fields = unknown |
| S00 | — | Provider DOM extraction unverified | — | Extension not deployed; manual DevTools verification only |
| S04 | `workspace-boundary` | Unconfirmed or unresolved root | `WORKSPACE_CONFIRMATION_REQUIRED`, `WORKSPACE_UNRESOLVED` | User must confirm canonical path via CLI or IDE modal |
| S04 | `workspace-boundary` | Mismatched IDE vs CLI root | `WORKSPACE_MISMATCH` | Clear disagreeing option; do not silently guess root |
| S05 | `workspace-boundary` | Traversal or escaping link | `PATH_TRAVERSAL`, `PATH_SYMLINK_ESCAPE`, `PATH_OUTSIDE_ROOT` | Target resolves outside canonical root; check symlink/junction targets |
| S05 | `workspace-boundary` | Reserved device or ADS | `PATH_RESERVED_DEVICE`, `PATH_ALTERNATE_DATA_STREAM`, `PATH_MALFORMED` | Illegal Windows syntax, ADS colons, or CON/NUL/COM/LPT device names |
| S05 | `workspace-boundary` | TOCTOU path race | `PATH_DENIED`, `PATH_SYMLINK_ESCAPE` | Target changed identity or was swapped between validation and use |
| S06 | `context-security` | Mandatory sensitive path exclusion | `PATH_EXCLUDED` (disposition `excluded`) | Target matches default exclusion glob (.env*, *.key, id_rsa, etc.); rejected before reading |
| S06 | `context-security` | Critical/high secret detected | `disposition: blocked` / `safeToSend: false` | Content contains recognizable secret pattern that cannot be safely sent |
| S06 | `context-security` | Content size budget exceeded | `OVERSIZED_INPUT` | File or total packet size exceeds configured budget limit |
| S06 | `context-security` | Malformed encoding / lone surrogates | `SCHEMA_INVALID` | Non-UTF-16 surrogate pairs detected; scanner fails closed |
| S06 | `context-security` | Unconfirmed root for context packet | `WORKSPACE_CONFIRMATION_REQUIRED`, `WORKSPACE_UNRESOLVED` | buildSafeContextPacket requires confirmed, resolved workspace root |
| S07 | `policy-engine` | Unknown action ID | `SCHEMA_INVALID` (`UNKNOWN_ACTION`) | Action ID not in canonical 16-action registry |
| S07 | `policy-engine` | Protected path auto-apply attempted | `PATH_PROTECTED` (`PROTECTED_PATH_CANNOT_AUTO_APPLY`) | Action touches protected path; requires explicit manual review/approval |
| S07 | `policy-engine` | Review-only mode execution attempted | `ACTION_DENIED` (`REVIEW_ONLY_MODE_BLOCKS_EXECUTION`) | Automated recipe execution disabled in Review-only mode (ADR-002) |
| S07 | `policy-engine` | Live workspace mutation attempted | `APPROVAL_REQUIRED` (`REVIEW_ONLY_MODE_BLOCKS_MUTATION`) | Live mutation requires manual user approval in Review-only mode |
| S07 | `policy-engine` | Arbitrary shell command injection | `SCHEMA_INVALID` (`ARBITRARY_COMMAND_DENIED`) | Shell command injection or raw command text detected in recipe parameters |
| S07 | `policy-engine` | Untrusted caller approval attempt | `ACTION_DENIED` (`CALLER_UNAUTHORIZED_FOR_APPROVAL`) | MCP/agent/browser tried to self-resolve approval; only trusted UI allowed |
| S07 | `policy-engine` | Policy tampering flag injected | `SCHEMA_INVALID` (`POLICY_TAMPERING_ATTEMPT`) | Caller tried to pass policyOverride, bypass, or grantAll flags |
| S07 | `policy-engine` | Missing executor capability | `CAPABILITY_UNAVAILABLE` (`CAPABILITY_MISSING`) | Executor has not passed canary verification; recipe run rejected |
| S08 | `protocol` | Nonce mismatch / spoofing attempt | `NONCE_MISMATCH` | Authoritative session nonce does not match candidate; candidate rejected in constant time |
| S08 | `protocol` | Task / Session / Provider identity drift | `TASK_MISMATCH`, `SESSION_MISMATCH`, `CONVERSATION_MISMATCH` | Proposal attributes mismatch active attached local session; rejected before policy |
| S08 | `protocol` | Stale round / duplicate sequence / out-of-order | `ROUND_STALE`, `SEQUENCE_DUPLICATE`, `SEQUENCE_OUT_OF_ORDER` | Non-monotonic proposal packet rejected; state remains unadvanced |
| S08 | `protocol` | Reused action ID | `ACTION_ID_DUPLICATE` | Action ID was already consumed in active session scope or repeated in envelope |
| S08 | `protocol` | Packet replay | `PACKET_ALREADY_CONSUMED` | Exact payload packet was already processed and committed |
| S08 | `protocol` | Stale base state hash | `BASE_STATE_HASH_MISMATCH` | Proposal base state hash does not match expected state hash |
| S08 | `protocol` | Conflicting completion signal | `CONFLICTING_COMPLETION_SIGNAL` | Action attempted to override completion (e.g. 'complete' action); canonical status required |
| S08 | `protocol` | Browser prompt edit / branch switch / regeneration | `IDENTITY_UNCERTAIN` | User altered conversation in browser; automatic processing paused until user reattaches |
| S09 | `content-transfer` | Byte length mismatch / truncation | `TRANSFER_INCOMPLETE` | Exact UTF-8 byte length of body block does not match manifest byteLength |
| S09 | `content-transfer` | Cryptographic checksum failure | `TRANSFER_HASH_MISMATCH` | Computed SHA-256 hash does not match declared manifest hash |
| S09 | `content-transfer` | Malformed / missing block framing | `TRANSFER_INCOMPLETE` | Missing closing delimiter tag (e.g. `<<<END_MEDIATOR_FILE>>>`) or corrupt boundaries |
| S09 | `content-transfer` | Missing referenced content block | `CONTENT_BLOCK_MISSING` | Proposal action references block ID that is not present in framed body payload |
| S09 | `content-transfer` | Cross-session chunk injection | `SESSION_MISMATCH` | Transport chunk session ID does not match active transfer session |
| S09 | `content-transfer` | Conflicting chunk tampering | `TAMPERING_DETECTED` | Duplicate chunk index delivered with conflicting content or checksum |
| S09 | `content-transfer` | Native Messaging / payload size cap | `OVERSIZED_INPUT` | Chunk > 256 KB, block > 2 MB, or total transfer > 10 MB exceeded transport bounds |
| S09 | `content-transfer` | Transfer timeout | `TRANSFER_INCOMPLETE` (`EXPIRED`) | Partial transfer exceeded timeout without all chunks received; buffers purged |
| S09 | `content-transfer` | Invalid request_more_context paths | `PATH_OUTSIDE_ROOT`, `PATH_PROTECTED` | Topic/path hints target escaping paths (`../`), absolute paths, or secret patterns |
| S11 | `context-engine` | Unsafe or unconfirmed workspace root | `UNSAFE_WORKSPACE_ROOT` | Project map scan requested without resolved & confirmed canonical root state |
| S11 | `context-engine` | Secret file access attempted during scan | `CONTEXT_EXCLUSION_DENIED` | Pre-read exclusion blocked sensitive path (.env*, *.key) during context gathering |
| S11 | `context-engine` | Serialized context exceeds UTF-8 budget | `BUDGET_EXCEEDED` | Mandatory task goal or essential rules exceed max byte budget; fails closed |
| S11 | `context-engine` | Rule attempts security override | `RULE_VALIDATION_FAILED` | Rule text attempts to disable secret scanning, bypass policy, or grant unrestricted exec |
| S11 | `context-engine` | Requested file cannot be safely read | `FILE_UNAVAILABLE` | File missing, locked, symlink escaping, or unreadable; recorded as unavailable |
| S11 | `context-engine` | Stored summary corrupted or non-object | `INVALID_SUMMARY_PAYLOAD` | Corrupt JSON in SQLite summary column; safely handled without throwing |
| S11 | `context-engine` | Memory clear attempted without confirmation | `MEMORY_CLEAR_CONFIRMATION_REQUIRED` | Caller called clearTaskMemory with confirmed !== true; rejected without side effects |
| S12 | `stage-store` | Stale expected base hash | `STAGE_BASE_HASH_STALE` | Expected base hash does not match current live source hash |
| S12 | `stage-store` | Live workspace file modified/deleted after staging | `STAGE_CONFLICT` | Live file was modified, deleted, or recreated after staging; never auto-rebases |
| S12 | `stage-store` | Path traversal, device name, or ADS in proposal | `PATH_TRAVERSAL`, `PATH_OUTSIDE_ROOT` | Proposal path contains '..', leading slashes, Windows device names, or ADS colons |
| S12 | `stage-store` | Sensitive file or secret pattern staged | `PATH_EXCLUDED`, `SECRET_DETECTED` | Proposal matches mandatory secret exclusion (.env*, *.key) or contains secret pattern |
| S12 | `stage-store` | Mismatched or corrupt checkpoint rollback | `CHECKPOINT_MISMATCH`, `STAGE_CORRUPTED` | Checkpoint belongs to another task/stage, or restored file hash fails verification |
| S12 | `stage-store` | Discard stage without explicit confirmation | `CONFIRMATION_REQUIRED` | discardStage called without confirmed === true; aborted with zero storage deletion |
| S13 | `stage-store` | Search text not found in target file | `PATCH_ZERO_MATCHES` | Patch search chunk not matched; patch rejected fail-closed |
| S13 | `stage-store` | Multiple matches found for unique context | `PATCH_AMBIGUOUS_MATCH` | Ambiguous match without allowMultiple: true; rejected fail-closed |
| S13 | `stage-store` | Live source modified/deleted since base snapshot | `PATCH_CONFLICT` | Source changed on live disk; conflict flagged; no silent rebase |
| S13 | `stage-store` | Stale expected base hash or staged revision | `PATCH_BASE_HASH_MISMATCH`, `PATCH_STAGE_HASH_MISMATCH` | Base/staged content changed concurrently; rejected fail-closed |
| S13 | `stage-store` | Secret-bearing patch payload | `PATCH_SECRET_DETECTED`, `PATCH_EXCLUDED` | Patch introduces API key/token or touches excluded sensitive file |
| S13 | `stage-store` | Concurrent patch update on same path | `PATCH_CONCURRENCY_LOCKED` | In-flight patch holding path lock; concurrent update rejected |
| S14 | `stage-store` | Approval expired (TTL elapsed, default 120s) | `APPROVAL_EXPIRED` | User did not approve within 120s; approval invalid; re-review required |
| S14 | `stage-store` | Approval payload tampered or paths changed | `APPROVAL_TAMPERED` | Action payload hash mismatch at apply time; rejected fail-closed |
| S14 | `stage-store` | Untrusted caller (AI/MCP) resolution attempt | `APPROVAL_CALLER_UNAUTHORIZED` | Non-UI caller attempted resolveApproval; only trusted local UI permitted |
| S14 | `stage-store` | Replayed or already consumed approval | `APPROVAL_ALREADY_CONSUMED` | Approval token was already applied; single-use rule enforced |
| S14 | `stage-store` | Live conflict detected right before apply write | `APPLY_CONFLICT` | Source file modified on disk after approval; apply aborted cleanly |
| S14 | `stage-store` | Intervening user edit during rollback | `RECOVERY_REQUIRED` | Live file hash differs from Mediator post-apply hash; rollback refuses to overwrite |
| S15 | `context-engine` | Workspace multi-root selection ambiguous | `WORKSPACE_SELECTION_REQUIRED` | Multiple workspace folders without confirmed primary selection |
| S16 | `mcp-server` | Mutation or shell attempt via MCP | `MCP_MUTATION_PROHIBITED` | Any attempt to invoke mutations, shell commands, or approval resolutions via MCP |
| S16 | `mcp-server` | Cross-task / cross-session scope request | `UNAUTHORIZED_TASK_SCOPE` | Request references task/session not matching active session record |
| S17 | `stage-store` | Stale or expired handoff report submission | `HANDOFF_EXPIRED`, `HANDOFF_CANCELLED` | Agent report submitted after handoff TTL (default 15m) or after operator cancellation |
| S17 | `stage-store` | Malformed or oversized agent report | `REPORT_SCHEMA_INVALID`, `REPORT_OVERSIZED` | Report fails Zod schema, nesting depth, or exceeds 64 KB raw payload limit |
| S17 | `stage-store` | Review request payload hash mismatch | `REVIEW_REQUEST_PAYLOAD_TAMPERED` | Action/stage payload hash changed after review was requested; invalidated |
| S17 | `stage-store` | Untrusted caller resolves review request | `ACTION_DENIED` (`CALLER_UNAUTHORIZED`) | Non-trusted caller (MCP/AI) attempted resolution; only trusted local UI permitted |
| S17 | `stage-store` | Self-attested verification elevation attempt | `EVIDENCE_LEVEL_UNCHANGED` | Agent report claims 'verified: true'; provenance remains strictly agent-reported |
| S18 | `browser-ext` | Unsupported page domain | `PAGE_UNSUPPORTED` | Attempted attach on non-Gemini page; safe pause triggered |
| S18 | `browser-ext` | Auth / login wall detected | `LOGIN_OR_AUTH_REQUIRED` | Login prompt detected; extraction safely paused |
| S18 | `browser-ext` | Extraction attempted while streaming | `RESPONSE_STREAMING` | Provider response actively streaming; extraction deferred until completion |
| S18 | `browser-ext` | Unknown / mutated DOM structure | `PAGE_STRUCTURE_UNKNOWN` | Selectors missing or ambiguous; fails closed with safe pause reason |
| S18 | `browser-ext` | Prepared draft exceeds size limit | `DRAFT_REJECTED_OVERSIZED` | Draft exceeds 8 KB bound; rejected before composer insertion |
| S19 | `native-host` | Native messaging frame oversized | `OVERSIZED_INPUT` | Message exceeds 512 KiB frame limit; fails closed |
| S19 | `native-host` | Origin validation failed | `ORIGIN_UNAUTHORIZED` | Chrome extension origin is not allowed 32-char hex ID |
| S19 | `native-host` | Named pipe client rejected | `CONNECTION_REJECTED` | Non-local or remote client attempted connection to local pipe |
| S19 | `native-host` | Core offline / unreachable | `CORE_NOT_RUNNING` | Native host cannot reach local Mediator core; reported honestly |
| S20 | `same-chat` | Navigation to different conversation URL | `CONVERSATION_MISMATCH` | User navigated chat tab away from bound conversation URL |
| S20 | `same-chat` | Nonce mismatch in candidate extraction | `NONCE_MISMATCH` | Session nonce does not match candidate proposal; rejected |
| S20 | `same-chat` | Provider response actively streaming | `RESPONSE_STREAMING` | Assistant response is streaming; wait for completion |
| S20 | `same-chat` | Duplicate proposal submission | `SUBMISSION_DUPLICATE` | Identical draft already submitted; prevents replay loops |
| S21 | `executor-contract` | Capability unknown / unverified | `CAPABILITY_UNAVAILABLE` | Mandatory capability has status unknown; evaluates to false; blocks execution |
| S21 | `executor-contract` | Stale capability evidence | `CAPABILITY_EVIDENCE_STALE` | Evidence age exceeds 24h TTL; fresh canary run required |
| S21 | `executor-contract` | Capability evidence scope mismatch | `CAPABILITY_EVIDENCE_MISMATCH` | Evidence belongs to different executor, version, stage, or workspace; rejected |
| S21 | `executor-contract` | Canary verification boundary failure | `CANARY_VERIFICATION_FAILED` | Synthetic canary detected boundary breach (source write, outside root, secret leakage) |
| S22 | `executor-contract` | Automatic execution unavailable under S00 | `EXECUTION_UNAVAILABLE` | S00 decision is NO-GO-AUTOEXEC; automatic runner disabled; manual recipe suggestions returned |
| S22 | `executor-contract` | Untrusted command or shell injection | `UNTRUSTED_COMMAND_REJECTED` | Raw executable path or shell operators (`&&`, `;`, `\|`, etc.) passed; rejected fail-closed |
| S22 | `executor-contract` | Execution blocked by policy or conflict | `EXECUTION_BLOCKED` | Request missing approval, modified payload hash, or stage conflict |
| S23 | `recipe-registry` | Unknown recipe ID | `RECIPE_UNKNOWN` | Requested recipe not in fixed 7-item canonical registry |
| S23 | `recipe-registry` | Tampered recipe definition | `RECIPE_TAMPERED` | Recomputed SHA-256 hash does not match pinned definition hash |
| S23 | `recipe-registry` | Shell injection or invalid argument | `RECIPE_ARGUMENTS_INVALID` | Request contains shell operators (`;&|`$><`), unapproved flags, or invalid types |
| S23 | `recipe-registry` | Path traversal or outside root | `RECIPE_PATH_OUTSIDE_ROOT` | Target path contains `..` or escapes canonical workspace root |
| S23 | `recipe-registry` | Disallowed environment override | `RECIPE_ENVIRONMENT_DISALLOWED` | Request attempts injecting non-allowlisted env vars or process overrides |
| S23 | `recipe-registry` | Missing dependencies | `RECIPE_DEPENDENCY_MISSING` | Required dependencies not present in `node_modules`; auto-install is forbidden |
| S23 | `recipe-registry` | Dangerous lifecycle script risk | `DEPENDENCY_RISK_DETECTED` | Manifest contains suspicious script patterns (curl, wget, eval, etc.) |
| S24 | `orchestrator` | Illegal workflow state transition | `WORKFLOW_TRANSITION_DISALLOWED` | Workflow transition attempted from invalid source state; fails closed |
| S24 | `orchestrator` | Workflow resource budget exceeded | `WORKFLOW_BUDGET_EXCEEDED` | Task exceeded rounds cap, transitions cap, or feedback size limit |
| S24 | `orchestrator` | Repeated no-progress loop detected | `WORKFLOW_LOOP_DETECTED` | Identical payload state repeated >= 3 times without progression |
| S24 | `orchestrator` | Secret detected in proposal block | `SECRET_DETECTED` | Context security scanner flags sensitive token/key in incoming envelope |
| S24 | `orchestrator` | Conversation / provider mismatch | `CONVERSATION_MISMATCH` | Incoming envelope belongs to different conversation or provider tab |
| S25 | `orchestrator` | Startup reconciliation required | `RECOVERY_RECONCILIATION_REQUIRED` | Startup detected unverified state or dirty stage; safe resume paused |
| S25 | `orchestrator` | In-flight action outcome unknown | `RECOVERY_ACTION_UNKNOWN` | In-flight action outcome unestablished; marked unknown and never replayed |
| S25 | `orchestrator` | Resume disallowed fail-closed | `RECOVERY_RESUME_DISALLOWED` | Resume attempted with unresolved unknown action, dirty stage, or expired approval |
| S25 | `orchestrator` | Debug bundle export refused | `DEBUG_BUNDLE_EXPORT_REFUSED` | Export attempted without explicit user confirmation or unredacted secret found |
| S25 | `orchestrator` | Debug bundle oversized | `DEBUG_BUNDLE_OVERSIZED` | Bundle exceeds maximum 512 KiB limit; export refused |
| S26 | `orchestrator` | Autopilot disabled under NO-GO | `AUTOPILOT_DISABLED` | Attempted execution under NO-GO-AUTOEXEC; profile remains inactive |
| S26 | `orchestrator` | Autopilot prerequisites unfulfilled | `AUTOPILOT_DEFERRED` | Mandatory capabilities unknown; Outcome B enforced |
| S26 | `orchestrator` | Autopilot capability revoked | `AUTOPILOT_CAPABILITY_REVOKED` | Secret detected, conflict emerged, or budget tripped; profile instantly revoked |
| S26 | `orchestrator` | Autopilot policy disallowed | `AUTOPILOT_POLICY_DISALLOWED` | Protected path, delete, rename, or dependency script blocked from auto-apply |

---

### Startup Reconciliation & No-Replay Invariants (S25)

- **Authoritative Reconciliation on Startup:** Every restart or native-host reconnect reconciles active tasks, stage status, approval records, conversation binding, and capability freshness via `OrchestratorRecoveryService`.
- **In-Flight Action Outcome Never Replayed:** If an action's completion cannot be independently proven, it is marked `unknown`/`recovery-required` in the authoritative action ledger. Commands, recipes, browser messages, and patches are NEVER re-executed or re-sent on startup.
- **Fail-Closed Safe Resume:** The `validateSafeResume()` barrier prevents resuming when unknown actions remain unacknowledged, live conflicts exist, approvals have expired or been consumed, or the active browser conversation ID has drifted.
- **Persistent Budget Accounting:** `WorkflowBudgetGuard` counters (rounds, transitions, actions, input bytes, duration, repeated errors) are exported and imported across restarts so crashing or restarting cannot reset or evade budget limits.
- **Loop Guards:** Configurable caps trip the workflow when repeated errors (>= 3 identical messages) or total task duration (30 min) are exceeded.
- **Context Compaction & Privacy Indicators:** Compaction produces bounded state summaries preserving goals, criteria, decisions, and blockers, while retaining critical uncertainty and security blocks. Indicators track bytes, estimated tokens, omitted excerpts, and repetition ratios without leaking raw project content.
- **Redacted Debug Bundle:** Local bundle generation capped at 512 KiB, running automated regex-based secret scanning. Requires explicit user authorization before export, and aborts fail-closed if redaction verification fails.
- **Observability Timeline:** `CorrelationTimelineService` logs structured, secret-sanitized events with correlation IDs across envelopes, policies, staging, approvals, recovery, and budgets.

### Autopilot Gate Review & Fail-Closed Revocation (S26)

- **Outcome B Enforced (DEFERRED):** Under the authoritative S00 decision (`NO-GO-AUTOEXEC`), three mandatory capabilities remain unknown (`process.childProcessesConfined`, `network.networkDefaultDeny`, `limits.capturesRealExitCode`). Autopilot is strictly marked `DEFERRED` with `eligible: false`.
- **Zero Command Runners:** No automated runner, execution loop, or background process is instantiated or permitted to run under `NO-GO-AUTOEXEC`.
- **Zero Auto-Apply on Live Workspace:** Shadow staging remains strictly isolated; patches are never automatically applied back to the live workspace without manual approval.
- **User Opt-in Insufficient:** User preference or UI toggles cannot bypass capability or policy gates. An opt-in without verified capabilities fails closed with `AUTOPILOT_DEFERRED`.
- **Inactive Descriptive Low-Risk Profile:** `CANONICAL_AUTOPILOT_LOW_RISK_PROFILE` defines strict constraints (small text diffs <= 4 KiB, no deletes/renames, non-protected paths, no scripts), but is defined with `active: false`.
- **Instant Revocation:** Any capability degradation, secret detection, budget exhaustion, or stage conflict triggers immediate revocation of eligibility.

---

### Fixed Recipe Registry & Hash Pinning Invariants (S23)

- **Closed Recipe Set:** Only 7 canonical recipe IDs are recognized (`project.test`, `project.lint`, `project.typecheck`, `project.build`, `project.single_test`, `git.status`, `git.diff`). AI cannot author, inject, or register arbitrary recipes.
- **Deterministic SHA-256 Hash Pinning:** Every recipe definition is canonically serialized with keys sorted recursively and hashed. Any difference between definition content and pinned hash triggers `RECIPE_TAMPERED`.
- **Strict Argument & Injection Rejection:** Shell metacharacters (`;&|`$><`), command substitutions, raw executable paths, path traversals (`..`), and excluded secret paths are rejected fail-closed.
- **Non-Executable Under NO-GO:** Under `NO-GO-AUTOEXEC`, no recipe can run automatically. All validated recipes produce safe CLI snippets labeled `MANUAL EXECUTION ONLY — NOT RUN OR VERIFIED BY MEDIATOR`.
- **Static Dependency Inspection:** `DependencyInspector` reads `package.json` and lockfiles using bounded streams. It never launches `npm`, `node`, or package lifecycle scripts. Missing dependencies result in `dependencies-unavailable` without automatic installation.
- **Isolated Synthetic `.env.test`:** Synthetic test environments are generated exclusively from isolated constants with zero real secrets copied, and validated via secret scanner.

### Assisted Workflow Orchestration & Evidence Authority Invariants (S24)

- **Assisted, Not Autopilot:** Orchestration proceeds through bounded explicit transitions (`idle` to `completed`). The system never executes actions autonomously or in an infinite loop.
- **Resource Budgets & Loop Guard:** Configurable caps prevent runaway tasks: max 5 AI rounds per task, max 30 state transitions, max 8 KiB feedback body. Repeated state-hash detections (>= 3) pause or fail the workflow with `WORKFLOW_LOOP_DETECTED`.
- **Honest Evidence Provenance:** Four strictly separated evidence categories: `executor-verified`, `ide-diagnostic-observed`, `user-verified`, and `agent-reported`. Agent claims cannot satisfy verification gates or self-elevate. Under `NO-GO-AUTOEXEC`, `executor-verified` count is strictly 0.
- **Same-Chat Continuity & Explicit Confirmation:** Feedback messages are strictly bound to the active provider and conversation ID. Prepares drafts in state `awaiting-send-confirmation`. Transmission requires explicit user confirmation.
- **10 Controlled Test-Repo Task Scenarios:**
  1. *Task 1 (Clean Patch Proposal):* Simple valid patch stages cleanly, diff ready, awaiting approval.
  2. *Task 2 (Malformed Envelope):* Invalid envelope fails schema validation; transitions to `failed`.
  3. *Task 3 (Stale Base Hash Conflict):* Stale base state hash rejected; transitions to `failed` or `conflicted`.
  4. *Task 4 (Secret-Bearing Proposal):* Patch block containing sensitive tokens blocked by secret scanner.
  5. *Task 5 (Protected Path Review):* Patch touching protected path requires explicit trusted approval.
  6. *Task 6 (Unknown Action / Unregistered Recipe):* Unregistered recipe ID rejected with `RECIPE_UNKNOWN`.
  7. *Task 7 (Expired Approval / Hash Mismatch):* Expired approval token fails application with `APPROVAL_EXPIRED`.
  8. *Task 8 (Missing Capability / Review-Only Handoff):* Missing execution capabilities produce manual handoff.
  9. *Task 9 (Agent-Reported Verification Claim):* AI claiming all tests passed remains `agent-reported` without elevating to `executor-verified`.
  10. *Task 10 (Same-Chat Mismatch / Safe Pause):* Conversation or tab ID change pauses safely without sending feedback.


### Executor Capability Schema & Evaluation Invariants (S21)

- **Rule of Unknowns:** Any security capability field with `value: 'unknown'` unconditionally evaluates as `false` for every required security guarantee. A capability is never assumed to be secure based on documentation or assertions alone.
- **Strict Evidence Provenance:** Only `runtime-canary` evidence can satisfy runtime verification gates. `documentation-only`, `mock-only`, `agent-reported`, or `ide-reported` claims are rejected by `CapabilityEvaluationEngine`.
- **Scope & Identity Binding:** Capability observations must match the exact executor ID, executor version, stage ID, and canonical workspace root. Mismatches result in `CAPABILITY_EVIDENCE_MISMATCH`.
- **Evidence Freshness:** Evidence older than configured TTL (default 24 hours) is treated as expired and rejected with `CAPABILITY_EVIDENCE_STALE`.
- **Zero Live Workspace Mutation:** The runtime canary harness executes all boundary checks against synthetic isolated fixtures. Pre- and post-test SHA-256 tree hashes verify zero mutations to live workspace files.

### Approved Execution Path & Review-Only Mode Invariants (S22)

- **S00 Decision Supremacy:** The execution path is governed strictly by the authoritative S00 decision (`NO-GO-AUTOEXEC`). Automatic execution cannot be enabled by compiling code, passing mock tests, or modifying UI settings.
- **Review-Only Execution Service:** Under `NO-GO-AUTOEXEC`, `ReviewOnlyExecutionService` returns typed status `execution-unavailable` and error code `EXECUTION_UNAVAILABLE`. No subprocess or runner is instantiated.
- **Untrusted Command Rejection:** Raw executable paths, scripts, and shell operators (`&&`, `;`, `\|`, `$(`, `` ` ``) are unconditionally rejected with `UNTRUSTED_COMMAND_REJECTED`. No host-shell fallback (CMD, PowerShell, bash) exists.
- **Copyable Manual Recipe Suggestions:** For approved recipes, safe manual CLI snippets are formatted for operator execution with an explicit disclaimer that manual execution is unverified by Mediator.
- **Common Authorization Gate:** Before generating any recipe suggestion or evaluating execution, S00 decision, capability freshness, payload hash, and workspace identity are revalidated.

### MCP Handoff & Evidence Provenance Invariants (S17)

- **Manual Pull-Based Transfer:** Instructions are prepared as bounded prompts (<= 16 KB) for the human user to copy into their IDE agent chat. Mediator never auto-pushes or claims an automated connection.
- **Untrusted Agent Claims:** Ingested reports are untrusted content (`AgentReportSchema`). Claims such as `verified: true`, `approved: true`, or `testsPassed: true` are recorded as agent claims, but provenance is strictly frozen at `agent-reported`. Self-attested reports cannot satisfy verification gates or change approval state.
- **Discrepancy Reporting:** All claimed file changes are compared with authoritative staged diffs. Any claimed path that is not staged, or any staged file omitted from the report, produces a discrepancy record.
- **Request-Only MCP Review Intake:** MCP tool `mediator.request_review` only creates a `PendingReviewRequest` (`status: pending-review`). It cannot authorize, execute, or resolve approvals.
- **Payload-Hash Binding & Human-Only Resolution:** Any modification to the underlying payload hash invalidates the review request. Only trusted local UI callers (`isTrustedUI: true`) can resolve review requests.

### Browser Extension Shell & Provider Adapter Invariants (S18)

- **Permission Minimization:** Manifest V3 extension requests only `activeTab` and `storage`. Zero filesystem, shell, cookie, history, debugger, or native-messaging permissions.
- **Honest Connection State:** Native host IPC belongs to S19; the extension UI explicitly reports core connection as `Disconnected` in S18.
- **Streaming & Navigation Guardrails:** The provider adapter inspects dynamic indicators; extraction is blocked while responses stream. URL navigation or tab switches invalidate active state and trigger a safe pause.
- **Manual Draft Review:** Message drafts are bounded (<= 8 KB) and presented to the user for explicit confirmation before insertion. A copy fallback is provided if composer detection is ambiguous.
- **Synthetic Fixture Coverage:** 10 sanitized, synthetic mock DOM fixtures validate completed, code-block, streaming, auth, navigation, and unknown DOM states without real credentials or network calls.

### Staged Patch Engine & Conflict Invariants (S13)

- **Zero Live Modification:** Every patch operation (create, modify, delete-proposed, rename-proposed) modifies only shadow staging in app-data. Live workspace files remain 100% bit-for-bit unchanged.
- **Exact-Match Requirement:** Unique context search/replace fails closed on zero or multiple matches unless explicit multi-match is authorized.
- **Fail-Closed Conflict Detection:** Live deletions, modifications, unexpected additions, and rename collisions are durably recorded; the engine never auto-rebases or silently replaces base hashes.
- **Encoding & Line-Ending Fidelity:** Preserves CRLF vs. LF line endings, UTF-8 BOM, and trailing newlines across all patch operations without silent mutation.
- **Batch Atomicity:** Multi-file patch proposals are staged to a checkpoint savepoint; any single patch failure reverts the staging store back to its prior state.

### Trusted Approval & Transactional Apply-Back Invariants (S14)

- **Cryptographic Action Binding:** Approvals are cryptographically bound to a SHA-256 payload hash summarizing all target paths, operations, expected base hashes, and staged hashes.
- **120-Second Default TTL:** Pending approvals expire automatically after 120 seconds. Expired approvals cannot be applied.
- **Trusted Local UI Only:** Only caller identities with `isTrustedUI: true` can resolve approval requests. Untrusted AI, MCP, and browser agents are restricted to review-only.
- **Safe Preflight & Atomic Replace:** Apply preflight verifies clean conflict-free state, creates backups in `%APPDATA%\Mediator\backups\`, writes to temporary files on the same filesystem volume, and performs atomic rename.
- **Never Overwrite User Edits on Rollback:** If a user edits a file after Mediator writes it, rollback detects the hash difference and flags `recovery_required` rather than clobbering the user's changes.
- **Durable SQLite Journaling:** All transactions and item operations are tracked in `apply_transactions` and `apply_transaction_items` for crash recovery and auditability.

### Content-Block Framing & Bounded Transfer Invariants (S09)

- **Separation of Framing from Staging:** Parsing, chunk reassembly, and integrity validation occur strictly in memory buffers before any proposal or content reaches the staging store.
- **Zero Normalization Invariant:** Raw file body content is never trimmed, whitespace-normalized, or silently repaired prior to byte length and SHA-256 checksum validation.
- **Native Messaging Transport Margin:** Internal chunk sizes are bounded to 256 KB, well below the Chromium 1 MB IPC limit, with strict per-chunk and whole-payload checksumming.
- **Fail-Closed State Machine:** Incomplete or corrupted transfers transition to terminal `REJECTED`, `EXPIRED`, or `CANCELLED` states and are permanently purged without side effects.
- **Context Request Safeguards:** All `request_more_context` hints re-traverse path containment (S04/S05) and mandatory secret exclusions (S06) before processing.

### Protocol Envelope & Replay Guard Invariants (S08)

- **Untrusted Nonce Invariant:** A valid cryptographic nonce binds the envelope to the active session and prevents replays, but does NOT authorize action execution. Every action must still pass the S07 policy evaluator.
- **Constant-Time Comparison:** Nonces are compared using `timingSafeEqual` to eliminate timing side-channel attacks. Nonces are never leaked in ordinary logs, debug bundles, or error messages.
- **Fail-Closed State Invariance:** Validation failures NEVER advance expected sequences, update rounds, or consume action IDs. Replays cannot bypass validation through failure side-effects.
- **Browser Drift Defense:** Any prompt edit, branch switch, conversation switch, or answer regeneration in the browser marks the session identity-uncertain and pauses processing. Safe reattachment is required.
- **Zero Conflicting Completion Signals:** Task completion is expressed solely via canonical envelope status (`continue`, `await_user`, `complete` / `proposed_complete`). Separate complete actions are rejected.

### Policy Engine & Action Registry Invariants (S07)

- **Pure Evaluation Boundary:** `evaluateAction(request, context, policyConfig)` has zero side effects and returns deterministic decisions (`ALLOW`, `DENY`, `REQUIRE_APPROVAL`, `UNSUPPORTED`).
- **Canonical 16 Actions Only:** Exactly 16 action IDs are supported. Unknown actions, unexpected fields, or missing parameters fail closed.
- **Protected-Path Review Gating:** Manifests, lockfiles, CI/CD workflows, Git hooks, scripts, and security configs can be staged but NEVER auto-applied to live files.
- **Strict Approval Separation:** Request creation is separate from resolution. Only authenticated user UI flows (IDE UI / CLI confirmation) can approve requests. Agents and MCP tools can never approve their own requests.
- **Zero Evidence Escalation:** Unverified agent claims remain `agent-reported` and can never satisfy automated verification gates.
- **Review-Only V1 Mode (ADR-002):** Automatic execution and unapproved live mutations are hard-denied by default.

### Windows-Specific Path Security Limitations (S05)

- **Reparse Point Inspection:** Deep Win32 tag inspection (`IO_REPARSE_TAG_MOUNT_POINT` vs cloud placeholders) requires native Win32 APIs not in standard Node.js. Node's `realpathSync.native` resolves junctions/symlinks; where physical resolution delta cannot prove containment, the path is rejected or classified as `unknown`.
- **Short Names (8.3):** Resolved to canonical long names via `realpathSync.native`. Escapes via short-name aliases are rejected by canonical prefix defense.
- **Elevation for Symlink Creation:** Creating symlinks on Windows without Developer Mode requires administrative privileges. Test suite uses mock adapter to guarantee deterministic testing across all environments.

### Secret Detection Limitations & Safeguards (S06)

- **Pattern Matching Limits:** Scanner detects known high-signal patterns (keys, tokens, auth headers, connection strings). It cannot detect custom-formatted, obfuscated, or low-entropy secrets. This is a defense-in-depth layer, NOT a universal secret-detection guarantee.
- **Fail-Closed Policy:** Truncated scans, timeout, lone surrogate pairs, or oversized input immediately block the affected content.
- **Zero Raw Secret Emission:** Matched secret substrings are never stored in `ScanFinding`, `RedactionRecord`, error objects, logs, or previews. Downstream outputs are verified using synthetic fixtures.
- **Pre-Read Exclusion:** Excluded sensitive paths (`.env*`, `*.pem`, `id_rsa`, `.ssh/**`, `.aws/**`, etc.) are blocked before file content is read from disk.
- **User Ignore Rules:** `.mediatorignore` can add context exclusions but can never bypass mandatory security exclusions or S04/S05 workspace boundary controls.


---

## 3. Debug bundle

> Not yet implemented. Will be added in S25 (observability sprint).

A safe debug bundle will contain:
- Redacted configuration summary
- Version matrix (IDE, Node, provider, extension)
- Sanitized structured logs (no secrets, no raw page HTML)
- Failing test metadata and capability evidence
- Preview before export

---

## 4. Diagnostics view

> Not yet implemented. Will be added in S01 (IDE panel) and expanded in S25.

Will show: one row per module with status, version, last healthy check, active adapter, capability result, recent error code.

---

## 5. Common issues

| Issue | Likely cause | Fix |
|---|---|---|
| `CORE_NOT_RUNNING` | Mediator core process not started | Run `npx mediator start` or use IDE command palette |
| `NONCE_MISMATCH` | Stale or replayed protocol envelope | Re-attach the conversation; generate a new session nonce |
| `CONVERSATION_CHANGED` | Tab switched, conversation regenerated, or branch changed | Re-attach and confirm conversation identity |
| `DATABASE_UNAVAILABLE` | SQLite database file locked, closed, or path inaccessible | Check application permissions on AppData; verify disk space |
| `AUDIT_INTEGRITY_COMPROMISED` | Audit event tampered, reordered, or deleted | Re-verify audit hash chain; investigate unauthorized file edits |
| `CONSTRAINT_VIOLATION` | Duplicate action ID or foreign key violation | Enforces single-use action IDs; action was already consumed |

---

## 6. Persistence & SQLite Ledger Debugging (S10)

### Database Location Policy
- **Windows:** `%APPDATA%\Mediator\data\mediator.db`
- **macOS:** `~/Library/Application Support/Mediator/data/mediator.db`
- **Linux:** `~/.local/share/mediator/mediator.db`
- **Permissions:** Directories are created with user-only permissions (`0o700` mode) where supported by OS filesystem. AI-selected paths are strictly forbidden.
- **Engine:** Built-in Node.js `node:sqlite` (`DatabaseSync`). Zero external native compiler or prebuilt binary dependencies.
- **Connection Configuration:**
  - `PRAGMA foreign_keys = ON;`
  - `PRAGMA journal_mode = WAL;` (write-ahead logging for concurrency and atomicity)
  - `PRAGMA synchronous = NORMAL;`
  - `PRAGMA busy_timeout = 5000;`

### Schema Overview (Version 1)
- `tasks`: Task lifecycle, acceptance criteria references, completion status, metadata.
- `sessions`: Session tracking, provider identity, `nonce_hash` (raw cryptographic nonces are NEVER stored in plaintext), recovery status.
- `rounds`: Round numbers, sequence bounds, state hashes, start/completion times.
- `actions`: Single-use action IDs, canonical payload hashes, redacted parameters (`parameters_safe`), policy decisions, execution status.
- `approvals`: Single-use approval requests, change hashes, requesting caller, status (`pending`, `approved`, `denied`, `expired`, `consumed`), authenticated resolution.
- `evidence`: Strict preservation of evidence levels (`agent-reported`, `mediator-observed`, `executor-verified`); agent claims are never elevated.
- `context_summaries`: Bounded (<=64 KB), redacted task summaries. Never stores raw conversation bodies or .env contents.
- `audit_events`: Append-only, tamper-evident SHA-256 event chain.

### Audit Hash-Chain Verification
- **Genesis Hash:** Fixed 64 zeros (`0000000000000000000000000000000000000000000000000000000000000000`).
- **Canonical Serialization:** Deterministic recursive key sorting, UTF-8 buffer hashing.
- **Verification:** `auditRepo.verifyChain()` validates strictly monotonic chain indices, previous-hash linkage, and canonical payload checksums.
- **Immutability Triggers:** SQLite triggers `prevent_audit_update` and `prevent_audit_delete` abort direct SQL modifications.
- **Security Limitation:** The local hash chain provides cryptographic tamper-evidence against application-layer corruption. It cannot prevent an operating-system process with raw write access from replacing the entire database file.

### Crash Recovery & Uncertainty Invariant
- **Core Invariant:** "After a restart, Mediator must not assume that an action with an uncertain outcome completed successfully, and it must never blindly replay that action."
- **In-Flight Action Quarantine:** Actions in status `proposed` or `executing` upon crash are marked `uncertain`.
- **Task Pausing:** Tasks in `VALIDATING`, `STAGING`, `EXECUTING`, `SANITIZING` are transitioned to `TaskState.PAUSED` with status `reconciliation_required`.
- **Session Reattachment:** Active sessions are marked `reconciliation_required` and require safe user reattachment.
- **Replay Protection Continuity:** All previously consumed action IDs and highest sequences are loaded from SQLite into `ReplayGuard` on startup, preventing replayed actions across application restarts.

---

## 7. Context Engine & Project Memory Debugging (S11)

### Diagnostic Correlation & Module Errors
Context engine errors are strictly typed as `ContextEngineError` instances, providing:
- `code`: Stable string enum (`PROJECT_MAP_SCAN_FAILED`, `UNSAFE_WORKSPACE_ROOT`, `CONTEXT_EXCLUSION_DENIED`, `BUDGET_EXCEEDED`, `PERSISTENCE_FAILED`, `PROTOCOL_VALIDATION_FAILED`, `SUMMARY_RECOVERY_FAILED`, `RULE_VALIDATION_FAILED`, `FILE_UNAVAILABLE`, `INVALID_SUMMARY_PAYLOAD`, `TASK_NOT_FOUND`, `MEMORY_CLEAR_CONFIRMATION_REQUIRED`).
- `correlationId`: Bound across request lifecycle.
- `taskId`: Bound to active Mediator task.
- `details`: Structured diagnostics without raw secrets, unredacted tokens, or full conversation history.

### Core Context Engine Invariants
1. **Minimization Invariant:** The web AI's existing conversation remains the primary reasoning context. Mediator never sends full repository dumps, entire files when snippets suffice, or duplicate unchanged content.
2. **Containment & Exclusion Invariant:** No file path can enter the project map or context packet without passing S04/S05 workspace containment (`validateContainedPath`) and S06 mandatory sensitive path exclusions (`checkPathExclusion`). Excluded secret files (`.env*`, `*.pem`, `id_rsa`) are skipped before disk reading.
3. **Secret Redaction Invariant:** Every context item string passes through `safeRedactString()` prior to final packet construction. Recognizable API keys, tokens, and credentials are redacted into `[REDACTED:...]` markers.
4. **Evidence Provenance Invariant:** Untrusted agent claims in `evidence.agentReported` (such as "all tests pass" or "implementation complete") are strictly segregated and NEVER classified as `evidence.executorVerified`.
5. **Exact UTF-8 Budget Enforcement:** Packet budgets are calculated using exact serialized byte size (`Buffer.byteLength(json, 'utf8')`). If mandatory task goal or essential rules exceed the budget, the assembler fails closed with `BUDGET_EXCEEDED` rather than emitting truncated or syntactically corrupt JSON.
6. **Approximate Token Labeling:** Token metrics are heuristic estimates based on character count ratios and are explicitly annotated with `isApproximateTokenCount: true`. Mediator never claims exact token counts without a provider tokenizer.
7. **Rule Security Policy Separation:** Project rules parsed from `.mediator/rules.md` cannot override core security invariants (such as disabling secret scanners, bypassing policy evaluators, or granting unrestricted execution). AI-proposed rules remain in `proposed` state until explicitly approved by the user.
8. **Audit Chain Protection on Memory Clearing:** Calling `clearTaskMemory()` clears only optional project memory and rolling summaries for the specific task; it NEVER deletes, alters, or resets the append-only SQLite audit log.

---

## 8. Shadow Staging Store Debugging (S12)

### Diagnostic Correlation & Module Errors
Staging operations throw strongly-typed `StageError` instances with error codes:
- `STAGE_NOT_FOUND`: Referenced stage or staged file does not exist.
- `STAGE_ALREADY_EXISTS`: Stage ID collision in persistence.
- `TASK_MISMATCH`: Stage or checkpoint belongs to a different task.
- `STAGE_STATUS_INVALID`: Operation attempted on discarded or inactive stage.
- `UNSAFE_WORKSPACE_ROOT`: Workspace root is unconfirmed or unresolved.
- `PATH_TRAVERSAL` / `PATH_OUTSIDE_ROOT`: Attempted escaping via `..`, absolute path, device name, or ADS colon.
- `PATH_EXCLUDED` / `SECRET_DETECTED`: Attempted staging of sensitive files (`.env*`, `*.pem`, `id_rsa`) or content with secrets.
- `OVERSIZED_INPUT`: Proposed content exceeds per-file limit (2 MB default).
- `STAGE_BASE_HASH_STALE`: Declared `expectedBaseHash` does not match current live source hash.
- `STAGE_CONFLICT`: Live file was modified, deleted, or recreated after staging.
- `CHECKPOINT_NOT_FOUND` / `CHECKPOINT_MISMATCH`: Checkpoint ID missing or bound to different task/stage.
- `STAGE_CORRUPTED`: Physical staged file missing or restored hash mismatch.
- `CONFIRMATION_REQUIRED`: `discardStage` called without explicit confirmation (`confirmed: true`).
- `STORAGE_ACCESS_DENIED`: Filesystem permission error accessing shadow staging directory.

### Core Shadow Staging Invariants
1. **Physical Isolation Invariant:** Proposed file modifications reside exclusively in Mediator application data (`%APPDATA%\Mediator\staging\<taskId>\<stageId>\files`). They are NEVER placed inside or alongside the live workspace.
2. **Zero Live Mutation Invariant:** No staging, diffing, checkpointing, rollback, or discard operation may modify, rename, delete, or create any file in the live workspace root. All live file hashes must remain 100% identical.
3. **No Silent Rebase Invariant:** When a live file is modified, deleted, or created after staging, Mediator reports `STAGE_CONFLICT` with a descriptive reason. Mediator NEVER silently updates base hashes or auto-rebases conflicting changes.
4. **Verified Rollback Invariant:** Rollback restores only shadow staged files in staging storage. Rollback is not marked successful until every restored file's SHA-256 hash has been verified against the checkpoint snapshot.
5. **Sandbox Capability Transparency:** The staging store reports `sandboxAccessibility: 'unknown'` and `liveWorkspaceMutationEnabled: false`. Command execution remains disabled; no host-shell fallback or unverified sandbox assumption is made.

---

## 9. IDE Workspace Adapter & Incremental Project Map Debugging (S15)

### Diagnostic Correlation & Module Errors
Adapter and incremental map operations throw or return strongly-typed `MediatorError` objects:
- `CAPABILITY_UNAVAILABLE`: The requested capability (Git status, diagnostics, symbols) is not supported by the runtime or missing its required IDE extension.
- `CAPABILITY_PERMISSION_DENIED`: Operation requested without required consent (e.g., active editor selection context queried when user has not opted in).
- `WORKSPACE_NOT_FOUND`: No active workspace folder is open or configured in the IDE.
- `WORKSPACE_ROOT_AMBIGUOUS`: Multi-root workspace detected without explicit canonical root confirmation.
- `WORKSPACE_MISMATCH`: Incremental map event or adapter operation attempted against a mismatched workspace root.
- `ACTION_DENIED`: Target file path is outside the canonical workspace boundary (S05) or matches mandatory secret exclusions (S06).

### Core Adapter & Incremental Map Invariants
1. **Truthful Capability Reporting Invariant:** An IDE capability is never reported as `supported` simply because an API interface exists. Real runtime probes determine actual availability. Antigravity and VS Code have distinct capability profiles and do not share unverified assumptions.
2. **Zero Shell Execution Invariant:** Test discovery and Git status detection never execute shell commands (`git`, `npm`, `vitest`, `pytest`). All metadata is extracted from project files (`package.json`, `Cargo.toml`) or IDE public APIs. Discovered tests are never marked as "passed" or "verified".
3. **Opt-In Editor Context Invariant:** Active editor document path, cursor position, and selected text are NEVER collected or transmitted without explicit, user-configured opt-in (`allowEditorContext: true`). Selected text requires secondary consent (`allowSelectedText: true`). All collected text passes through S06 secret scanning and redaction.
4. **Boundary & Exclusion Invariant:** The incremental project map never indexes `.git`, dependency directories (`node_modules`), build artifacts (`dist`, `build`, `out`), or Mediator AppData staging folders (`isStagingOrAppDataPath`).
5. **Atomic Serialization Invariant:** File system watcher events (`create`, `modify`, `delete`) are processed through an asynchronous serialization queue in `IncrementalProjectMapManager`, preventing race conditions during concurrent file events. Watcher errors transition map freshness to `stale` with clear error reasons.

---

## 10. Read-Only MCP Context Server Debugging (S16)

### Diagnostic Correlation & Protocol Error Codes
MCP server requests return standard JSON-RPC 2.0 error responses with typed codes:
- `-32700 (PARSE_ERROR)`: Invalid JSON payload received over stdio transport.
- `-32600 (INVALID_REQUEST)`: Missing `jsonrpc: "2.0"` header or malformed envelope.
- `-32601 (METHOD_NOT_FOUND)`: Unregistered or unsupported JSON-RPC method.
- `-32602 (INVALID_PARAMS)`: Tool or resource arguments failed Zod schema validation.
- `-32001 (UNAUTHORIZED_TASK_SCOPE)`: `taskId` or `sessionId` does not match active authorized task state.
- `-32002 (MCP_MUTATION_PROHIBITED)`: Attempted invocation of forbidden tools (file modification, command execution, approval resolution, policy changes).
- `-32003 (OVERSIZED_PAYLOAD)`: Output exceeds `MAX_MCP_RESPONSE_BYTES` (64 KB).
- `-32004 (RESOURCE_NOT_FOUND)`: Requested MCP resource URI is unknown.
- `-32005 (CAPABILITY_UNAVAILABLE)`: Underlying IDE capability is not supported in the active runtime.

### Core MCP Server Invariants
1. **Strict Read-Only Invariant:** MCP context server is strictly pull-based and read-only. It exposes zero mutation tools and rejects any request to execute recipes, modify live files, alter stage content, approve diffs, or edit policy. Caller claims of elevated roles (`role: "trusted"`, `approved: true`) are unconditionally ignored.
2. **Local Stdio Transport Invariant:** Server communicates exclusively over local `stdio`. No HTTP listener, TCP socket, or public network endpoint is ever created.
3. **Scope Authorization Invariant:** Every resource and tool request must supply valid `taskId` and `sessionId` corresponding to an active session in `TaskRepository`. Cross-task or cross-session queries are rejected fail-closed.
---

## 11. Native Messaging Host & Authenticated Local IPC Debugging (S19)

### Diagnostic Correlation & Protocol Error Codes
Native host and local IPC operations produce typed `MediatorError` codes:
- `CORE_NOT_RUNNING`: Local Mediator core named pipe is unavailable or offline. Native host reports this honestly without hanging.
- `IPC_ORIGIN_REJECTED`: Chrome extension origin does not match the strict 32-character extension ID (`^[a-p]{32}$`). Wildcards rejected.
- `IPC_TOKEN_INVALID`: CSPRNG pairing token does not match active core token.
- `IPC_PAIRING_EXPIRED`: Pairing challenge exceeded its 60-second time-to-live.
- `NATIVE_FRAME_OVERSIZED`: Incoming or outgoing stdio frame exceeds physical ceiling (512 KiB).
- `NATIVE_FRAME_MALFORMED`: 4-byte LE length prefix is corrupt or indicates negative/oversized length.
- `IPC_OPERATION_PROHIBITED`: Requested operation is not in the allowed operations allowlist (`mediator.ping`, `mediator.get_status`, `mediator.transfer_chunk`, `mediator.submit_envelope`, `mediator.get_pending_round`).
- `TRANSFER_HASH_MISMATCH`: 256 KiB chunk SHA-256 does not match chunk metadata.
- `TRANSFER_INCOMPLETE`: Chunk transfer stream interrupted or missing chunks.

### Core Native Host & Local IPC Invariants
1. **Real Binary Invariant:** Native host is a compiled `.exe` (`mediator-native-host.exe`) packaged via Node 24 SEA. Batch files (`.bat`, `.cmd`) and shell wrappers are strictly forbidden.
2. **Stdout Protocol Purity:** Stdout is reserved 100% for 4-byte LE framed JSON packets. Diagnostic and error logging is routed to stderr with token masking.
3. **Local-Only Windows Named Pipe:** Named pipe server (`\\.\pipe\mediator-ipc-...`) accepts only local connections from the current user SID and SYSTEM. Remote clients are rejected.
4. **Constant-Time Authentication:** Pairing token comparison uses `crypto.timingSafeEqual` to eliminate timing side-channel attacks. Expired or invalid tokens fail closed.
5. **Bounded Chunk Transfers:** Transfers are sliced into 256 KiB chunks with sequence index, total count, chunk hashes, transfer ID, and an 8 MiB logical ceiling.

---

## 12. First Provider Same-Chat Adapter Debugging (S20)

### Diagnostic Correlation & Adapter Error Codes
Same-chat adapter and Google Gemini provider operations produce typed `MediatorError` codes:
- `CONVERSATION_MISMATCH`: Proposal or envelope conversation ID does not match the attached conversation.
- `NONCE_MISMATCH`: Received envelope nonce does not match authoritative active session nonce.
- `RESPONSE_STREAMING`: Assistant response is actively streaming; incomplete text cannot be extracted as complete.
- `PAGE_STRUCTURE_UNKNOWN`: Page DOM structure diverged from tested Gemini selectors. Loop pauses safely.
- `SUBMISSION_UNCERTAIN`: Composer text was not cleared or user message was not rendered in conversation DOM after submit.
- `SUBMISSION_DUPLICATE`: Attempted re-submission of an already-submitted draft ID.
- `OVERSIZED_INPUT`: Prepared draft exceeds maximum size limit (8 KB).
- `PROTOCOL_VERSION_UNSUPPORTED`: Envelope protocol version does not match authoritative `PROTOCOL_VERSION` ('1.3').
- `TASK_MISMATCH` / `SESSION_MISMATCH`: Proposal does not match active task or session ID.

### Core Same-Chat Adapter Invariants
1. **Same-Chat Continuity Invariant:** A task loop never silently opens a new chat or creates a competing conversation. All rounds remain bound to the attached conversation ID (`/app/<id>`).
2. **Cryptographic Nonce Binding Invariant:** Every proposal envelope must echo the active session nonce via constant-time comparison (`timingSafeEqualNonce`). Tampered or stale nonces are rejected fail-closed.
3. **Human Confirmation Invariant:** Prepared message drafts are NEVER auto-submitted upon preparation. Explicit human confirmation (`confirmAndSubmit`) is required before sending.
4. **Safe Pause Invariant:** Tab switches, chat navigation, branch divergence, message edits, response regeneration, login walls, and DOM layout drift trigger immediate safe pauses (`checkContinuity`).
5. **Submission Observation Invariant:** Acceptance into the conversation DOM is verified by inspecting composer clearing and user message rendering. On failure, state transitions to `submission-uncertain` with fallback copy text.

---

## 13. Windows Execution Sandbox & Autopilot Gate Debugging (S40)

### Diagnostic Correlation & Autopilot Error Codes
Executor and Autopilot evaluation operations produce typed `MediatorError` codes:
- `EXECUTION_UNAVAILABLE`: Execution requested while Review-only mode is active under S00 `NO-GO-AUTOEXEC`.
- `EXECUTION_BLOCKED`: Execution rejected because required sandbox capability gates failed or were not satisfied.
- `AUTOPILOT_DEFERRED`: Autopilot toggle requested while prerequisite capability evidence is incomplete, unverified, or missing.
- `SECURITY_VIOLATION`: Execution request violated sandbox boundary (e.g. attempting to run directly in live workspace, argument shell metacharacters detected, or hash mismatch).
- `RECIPE_TAMPERED`: Canonical recipe definition hash mismatch. Execution refused before process spawn.
- `UNTRUSTED_COMMAND_REJECTED`: Raw shell command or unverified executable passed outside pinned canonical recipe registry.

### Core Windows 11 Sandbox Invariants & Diagnostics
1. **Authoritative NO-GO Fail-Closed Invariant:** Under S00 `NO-GO-AUTOEXEC`, Autopilot remains strictly `BLOCKED` (`canRun: false`). No automatic code execution or live workspace mutation is ever initiated by Mediator.
2. **Missing Capability Isolation:** On Windows 11 Home (Single Language editions):
   - `network.networkDefaultDeny`: Unverified / blocked. Standard non-elevated user processes have unrestricted outbound network socket access. Windows Sandbox is not available on Home editions.
   - `process.childProcessesConfined`: Unverified / blocked. While process-tree termination (`taskkill /pid <PID> /T /F`) cleans up standard children, Win32 Job Object kernel assignment (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) is required to prevent detached process escape.
3. **Live Source Workspace Integrity:** The live project directory is never passed as the working directory (`cwd`) of an executor. Staging is performed in an isolated shadow directory, and pre/post SHA-256 tree hashes guarantee zero live workspace mutation.
4. **Context Output Sanitization:** All captured stdout and stderr streams are bounded by physical size limits (32 KiB) and processed through `scanContent` and `redactTerminalOutput` before being displayed in UI, logs, or returned to AI provider conversations.

---

### S41 WSL2 Isolated Executor Diagnostics & Boundary Invariants

#### Error Codes & Failure States
- `DISTRIBUTION_UNAVAILABLE`: The dedicated `MediatorSandbox` distribution has not yet been provisioned or is stopped/unresponsive.
- `SECURITY_VIOLATION`: An execution request targeted an unhardened distribution (e.g. default `Ubuntu` with host drive automounting and Windows interop enabled) without explicit test canary authorization, or attempted to execute outside the isolated task root.
- `RECIPE_TAMPERED`: Hash mismatch between requested recipe definition and canonical pinned SHA-256 hash.

#### Prevention vs. Detection Diagnostic Standard (S40 Correction)
A security canary must only PASS when the intended security property is successfully enforced:
- **Policy Denial:** Prohibits launching execution in unauthorized directories. (PASS)
- **OS Write Prevention:** Enforces kernel/hypervisor boundaries preventing unauthorized writes. (FAILED on ambient OS; pending `MediatorSandbox` provisioning)
- **Tamper Detection:** Post-hoc tree-hash comparison detects file modification. (PASS, but does NOT satisfy prevention requirements)
- **Contradiction Rejection:** `CapabilityEvaluationEngine` automatically rejects any evidence claiming `value: true` if accompanied by reports of integrity breaches or post-hoc restoration.

#### WSL2 Sandbox Diagnostics & Verification
Run the non-destructive discovery and diagnostic script:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-wsl2-sandbox.ps1 -CheckOnly
```

To test WSL2 canaries directly without modifying the user's default distribution:
```powershell
npx vitest run packages/executor-contract/src/wslSandboxCanaries.test.ts
```

#### Process Tree Termination Diagnostic
When spawning `wsl.exe` on Windows, standard POSIX signals (`SIGKILL`/`SIGTERM`) do not reliably propagate through the Win32-to-WSL subsystem barrier. `WslIsolatedExecutor` explicitly uses `taskkill /pid <PID> /T /F` on Windows to cleanly and forcefully terminate the `wsl.exe` host process and its corresponding guest workload.

#### Autopilot Status Invariant
S00 remains strictly `NO-GO-AUTOEXEC`. Local Autopilot remains `BLOCKED` fail-closed.

---

### S42 Dedicated WSL2 Sandbox Diagnostics & Troubleshooting

#### Provisioning Lifecycle & Commands
The dedicated `MediatorSandbox` distribution is managed entirely via `scripts/prepare-wsl2-sandbox.ps1`:

1. **Non-destructive Check:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/prepare-wsl2-sandbox.ps1 -CheckOnly
   ```
   Checks WSL2 availability, distribution presence, user configuration, and reports hardening status without changing any system state.

2. **Provisioning (Requires Explicit Authorization):**
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/prepare-wsl2-sandbox.ps1 -Provision
   ```
   Creates dedicated `MediatorSandbox` at `%LOCALAPPDATA%\Mediator\wsl\MediatorSandbox\ext4.vhdx`. Creates unprivileged user `mediator-runner` (UID 1500) and configures hardened `/etc/wsl.conf`.

3. **Complete Cleanup & Removal:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/prepare-wsl2-sandbox.ps1 -Cleanup
   ```
   Unregisters `MediatorSandbox` and deletes the `%LOCALAPPDATA%\Mediator\wsl\MediatorSandbox` directory. Preserves the user's personal `Ubuntu` and projects untouched.

#### Distribution Hardening Verification
Verify the dedicated distribution's runtime configuration directly:
```powershell
# Verify user identity is unprivileged UID 1500
wsl.exe -d MediatorSandbox id
# Expected: uid=1500(mediator-runner) gid=1500(mediator-runner)

# Verify /mnt/c automount is absent
wsl.exe -d MediatorSandbox -- ls -la /mnt/c
# Expected: total 0 (empty, detached directory)

# Verify Windows interop is disabled
wsl.exe -d MediatorSandbox -- which cmd.exe
# Expected: exit code 1 (cmd.exe not found)

# Verify sudo is unavailable
wsl.exe -d MediatorSandbox -- sudo id
# Expected: exit code 1 (sudo fails)
```

#### WSL2 Hypervisor Network Routing & Proxy Diagnostic
WSL2 attaches virtual machines to a virtual Hyper-V internal network switch:
- External public internet traffic (e.g. `1.1.1.1:80`) is blocked when default routes are dropped.
- However, the WSL2 hypervisor routes traffic to the host's WSL DNS proxy (`10.255.255.254:53`).
- Because guest sockets can connect to the host's DNS proxy endpoint, `network.networkDefaultDeny` cannot be certified as true at the OS boundary without namespace isolation.
- Diagnostic probe (without isolation):
  ```powershell
  wsl.exe -d MediatorSandbox python3 -c "import socket; s = socket.socket(); s.settimeout(1); s.connect(('10.255.255.254', 53)); print('DNS_CONNECTED')"
  ```
- Any unexpected connection must cause `network.networkDefaultDeny` to remain **UNVERIFIED / FALSE**. Do not weaken tests.

---

### S43 Network Egress Isolation & Network Namespace Diagnostics

#### Root Cause of the DNS Proxy Endpoint (`10.255.255.254:53`)
- `10.255.255.254/32` is configured as a secondary IP address alias on the Linux loopback (`lo`) interface inside the WSL2 VM.
- The host Windows WSL virtualization service intercepts traffic to port 53 and proxies DNS queries recursively through the host Windows network.
- Proved vector: `socket.gethostbyname('example.com')` succeeded and returned public IP `172.66.147.243`.
- An untrusted script could use DNS tunneling (e.g., base64-encoded subdomains) to exfiltrate secret data through DNS query packets.

#### Enforcement Architecture: Linux Network Namespaces (`CLONE_NEWNET`)
`WslIsolatedExecutor` wraps untrusted task commands inside:
```bash
unshare --user --net --map-root-user --fork --kill-child -- <executable> <args...>
```

Diagnostic checks for network namespace enforcement:
1. **Network Interface Inspection:**
   ```powershell
   wsl.exe -d MediatorSandbox unshare --user --net --map-root-user ip link
   ```
   *Expected output:* Only a down `lo` interface; `eth0` is completely absent.
2. **Loopback IP Alias Verification:**
   ```powershell
   wsl.exe -d MediatorSandbox unshare --user --net --map-root-user ip addr
   ```
   *Expected output:* `10.255.255.254` is absent.
3. **Outbound IPv4 TCP/UDP Socket Probe:**
   ```powershell
   wsl.exe -d MediatorSandbox unshare --user --net --map-root-user python3 -c "import socket; s = socket.socket(); s.connect(('1.1.1.1', 80))"
   ```
   *Expected output:* `OSError: [Errno 101] Network is unreachable`.
4. **DNS Proxy Reachability Probe:**
   ```powershell
   wsl.exe -d MediatorSandbox unshare --user --net --map-root-user python3 -c "import socket; s = socket.socket(); s.connect(('10.255.255.254', 53))"
   ```
   *Expected output:* `OSError: [Errno 101] Network is unreachable`.
5. **DNS Query Probe:**
   ```powershell
   wsl.exe -d MediatorSandbox unshare --user --net --map-root-user python3 -c "import socket; socket.gethostbyname('example.com')"
   ```
   *Expected output:* `socket.gaierror: [Errno -3] Temporary failure in name resolution`.
6. **Namespace Escape / Anti-Tampering Check:**
   ```powershell
   wsl.exe -d MediatorSandbox unshare --user --net --map-root-user nsenter -t 1 -n ip link
   ```
   *Expected output:* `nsenter: failed to parse pid '1'` or `Permission denied` / `Operation not permitted`.

#### Error Code Reference
- `ENETUNREACH` (Linux errno 101): "Network is unreachable" — indicates that the kernel has no route or active interface for the destination. This is the expected and required failure code for blocked network probes.
- `EADDRNOTAVAIL` (Linux errno 99): "Cannot assign requested address" — indicates that the requested address family (e.g., IPv6) has no valid local interface binding.
- `EAI_AGAIN` (Linux errno -3): "Temporary failure in name resolution" — returned by `getaddrinfo` when all configured nameservers are unreachable.

#### Capability Evaluator & Autopilot Invariant
- With Canaries 23–31 verified, `network.networkDefaultDeny` is certified as `true` (enforced by `host`).
- **Autopilot Invariant:** In accordance with S00 `NO-GO-AUTOEXEC`, Local Autopilot remains strictly `BLOCKED` (`canRun: false`). No automated local execution is enabled. Mediator remains in Review-only mode.







