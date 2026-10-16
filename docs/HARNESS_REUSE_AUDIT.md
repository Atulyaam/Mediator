# MEDIATOR — EXISTING HARNESS DEEP INSPECTION & SAFE REUSE AUDIT

**Document Identifier:** `docs/HARNESS_REUSE_AUDIT.md`  
**Audit Date:** October 14, 2026  
**Auditor:** Antigravity Autonomous Systems & Architecture Agent  
**Audit Mode:** READ-ONLY Deep Inspection & Safe Verification  
**Target Systems:**  
1. `Mediator` (`c:\Users\Atul2\OneDrive\Desktop\Mediator`) — Branches: `main`, `release/v0.1.0-rc.1`, `audit/v0.1.0-beta.1.post1`  
2. `Claude Code CLI` reference (`c:\Users\Atul2\OneDrive\Desktop\claude-code-main`) — Version: `2.1.88`  

---

## 1. Executive Summary

This audit conducted an exhaustive, read-only inspection of the existing harness and orchestration components across the Mediator codebase, its active Git worktrees, and the external reference harness available in the workspace (`claude-code-main`).

### Key Audit Findings

1. **Mediator Already Possesses an Advanced, Production-Grade Harness Foundation:**
   Mediator is not an empty prototype. It contains 26 structured monorepo packages, 4 applications, 50 unit/integration test suites, and robust security infrastructure:
   - **Path Security & Workspace Boundary:** Path canonicalization, symlink escape rejection, alternate data stream (`::$DATA`) blocking, and TOCTOU hash protection (`packages/workspace-boundary`).
   - **Context Engine & Secret Sanitization:** Bounded context assembly, project mapping, token estimation, and regex/entropy secret scrubbing (`packages/context-engine`, `packages/context-security`).
   - **Structured Patch Engine & Shadow Staging:** Deterministic search/replace with BOM/newline preservation, conflict detection, unified diff generation, and pre-apply backups (`packages/stage-store`).
   - **Browser-AI Communication & Same-Chat Continuity:** DOM extraction, envelope normalization, and conversation continuity tracking for ChatGPT, Google Gemini, DeepSeek, and Claude (`apps/browser-extension`, `packages/protocol`).
   - **Offline Sandbox Validation:** Real process execution capturing authentic exit codes inside a network-isolated WSL2 sandbox (`CLONE_NEWNET`) with zero Windows host drives mounted (`packages/executor-contract`).
   - **Local Transport & UI Dashboard:** Loopback HTTP + SSE server on port 3300 and a modern glassmorphic dashboard with live event streaming and approval gating (`apps/standalone-ui`, `packages/orchestrator`).

2. **The Guarded Autopilot Engine Has Already Been Built (On `release-candidate`):**
   In the worktree `.worktrees/release-candidate` (`release/v0.1.0-rc.1`, commits `770dd71` & `c8a0a43`), Mediator has already implemented `GuardedAutopilotEngine.ts` (731 lines) under **ADR-031**. This engine:
   - Initializes a dedicated task worktree at `<workspaceRoot>/.mediator/task-worktrees/<taskId>/`.
   - Leaves live workspace files strictly immutable during execution.
   - Executes the automated loop: **Prompt → Ingest Proposal → Stage in Worktree → Validate in Sandbox → Capture Failure Snippet → Corrective Feedback Iteration → Retest**.
   - Enforces hard task budgets (max 5 iterations, 10 min timeout, 3 consecutive failures, 64 KiB diff size).
   - Terminates safely on failure or security violations and stages a verified diff requiring explicit human approval before live workspace application.
   - All 14 tests in `guardedAutopilot.test.ts` pass cleanly (100% pass rate).

3. **The Critical Missing Link:**
   In `packages/orchestrator/src/mediatorCore.ts` (line 1330 on `release-candidate`), `runAutopilotTask()` invokes `guardedAutopilotEngine.runIterationLoop()` without supplying a `providerHandler`. Without this handler, the loop can only validate pre-existing code; it cannot dispatch prompts to the browser extension or AI API to generate iterative code proposals. Wiring this handler to the existing `SameChatManager` / browser-bridge is the single missing link required to achieve a complete, Antigravity-style autonomous coding workflow.

4. **Codebase Clutter & Duplication:**
   The `main` branch contains 27 ad-hoc inspection scripts (4,172 lines of exploratory code) in `scripts/` that were already identified as clutter and deleted in `release/v0.1.0-rc.1`. Furthermore, `main` lacks the `GuardedAutopilotEngine.ts` file present in `release-candidate`.

---

## 2. Repositories and Worktrees Inspected

| Repository / Worktree Path | Git Branch / Commit | State & Content Description |
| :--- | :--- | :--- |
| `C:\Users\Atul2\OneDrive\Desktop\Mediator` | `main` (`e065330`) | Primary development tree. Contains 26 packages, 4 apps, 49 test suites, and 34 scripts in `scripts/` (including 27 exploratory debug scripts). Runs review-only `WorkflowOrchestrator`. |
| `C:\Users\Atul2\OneDrive\Desktop\Mediator\.worktrees\release-candidate` | `release/v0.1.0-rc.1` (`c8a0a43`) | **Authoritative Release Candidate.** Contains `GuardedAutopilotEngine.ts`, `guardedAutopilot.test.ts`, ADR-031, operations guides. 27 exploratory scripts purged (4,172 deletions). Completely clean working tree. |
| `C:\Users\Atul2\OneDrive\Desktop\Mediator\.worktrees\audit-candidate` | `audit/v0.1.0-beta.1.post1` (`228e974`) | Candidate B freeze snapshot. Review-only S00 baseline for external security audit. |
| `C:\Users\Atul2\OneDrive\Desktop\claude-code-main` | Non-git archive (v2.1.88) | Anthropic Claude Code CLI source. Reference for terminal tool-calling loops, context compaction, and file edit tools. |

---

## 3. Existing Harness Architecture

Mediator's harness is architected around the **Review-Only by Default, Guarded Autopilot in Isolation** paradigm:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       STANDALONE UI / CLI CLIENT                            │
│  (apps/standalone-ui: app.js, apiClient.ts; apps/cli: index.ts)             │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Loopback HTTP & SSE (Port 3300)
                                       v
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MEDIATOR CORE                                  │
│  (packages/orchestrator/src/mediatorCore.ts)                                │
│  - Task & Session State Machine                                             │
│  - Provider Selection & Mode Management                                     │
│  - Event Distribution (SSE stream)                                          │
│  - Approval Ledger & Single-Use Tokens                                      │
└──────────────┬───────────────────────────────────────────────┬──────────────┘
               │                                               │
       Autopilot Active                                 Review-Only Mode
               │                                               │
               v                                               v
┌─────────────────────────────┐               ┌───────────────────────────────┐
│   GUARDED AUTOPILOT ENGINE  │               │     WORKFLOW ORCHESTRATOR     │
│ (guardedAutopilotEngine.ts) │               │   (workflowOrchestrator.ts)   │
│ - Isolated Task Worktree:   │               │ - Step-by-step state machine  │
│   .mediator/task-worktrees/ │               │ - Envelope & secret scanning  │
│ - Bounded Iteration Loop    │               │ - Shadow staging              │
│ - Budget Enforcement        │               │ - Manual recipe suggestions   │
└──────────────┬──────────────┘               └───────────────┬───────────────┘
               │                                               │
               v                                               v
┌─────────────────────────────────────────────────────────────────────────────┐
│                            EXECUTION BOUNDARY                               │
│  - WslIsolatedExecutor (packages/executor-contract)                         │
│  - MediatorSandbox (WSL2 dedicated environment)                             │
│  - Linux Network Namespace (CLONE_NEWNET: default-deny egress)             │
│  - Host Windows drives unmounted ([automount] enabled=false)                │
│  - Authentic exit-code capture & process supervision (--kill-child)         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Staged Verified Diff
                                       v
┌─────────────────────────────────────────────────────────────────────────────┐
│                         HUMAN APPROVAL GATE                                 │
│  - User inspects unified diff in Standalone UI                              │
│  - Explicit Approval Token issued & bound to stage payload hash             │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Approved
                                       v
┌─────────────────────────────────────────────────────────────────────────────┐
│                     LIVE WORKSPACE APPLY & ROLLBACK                         │
│  (packages/stage-store/src/applyService.ts)                                 │
│  - Atomic replacement via temporary files on same volume                    │
│  - Pre-apply backups in %APPDATA%/Mediator/backups                          │
│  - Transaction journal in SQLite (ApplyJournal)                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Component Inventory with Exact File Paths

### A. Orchestration & Harness Core (`packages/orchestrator`)

| Component | Exact File Path | Lines | Purpose & Responsibility |
| :--- | :--- | :--- | :--- |
| `MediatorCore` | `packages/orchestrator/src/mediatorCore.ts` | 1,430 | Single source of truth for tasks, workspaces, providers, approvals, and events. |
| `GuardedAutopilotEngine` | `packages/orchestrator/src/guardedAutopilotEngine.ts` | 731 | Isolated task worktree iteration loop, budgets, stop conditions, and sandbox testing. *(in `release-candidate`)* |
| `WorkflowOrchestrator` | `packages/orchestrator/src/workflowOrchestrator.ts` | 1,038 | Step-by-step assisted workflow coordinator under review-only mode. |
| `MediatorHttpServer` | `packages/orchestrator/src/mediatorHttpServer.ts` | 694 | Loopback HTTP server (port 3300) with SSE streaming for cross-interface synchronization. |
| `AutopilotGateEvaluator` | `packages/orchestrator/src/autopilotGate.ts` | 230 | Security policy gate enforcing S00 execution constraints (`NO-GO-AUTOEXEC` vs `GO-GUARDED-AUTOPILOT`). |
| `WorkflowBudgetGuard` | `packages/orchestrator/src/budgetGuard.ts` | 300 | Loop detection, transition counting, and repeated payload hash tripping. |
| `EvidenceAuthorityService`| `packages/orchestrator/src/evidenceAuthority.ts` | 170 | Enforces provenance rules; prevents AI claims from being elevated to verified status. |
| `ContextCompactor` | `packages/orchestrator/src/contextCompactor.ts` | 180 | Trims and summarizes conversation history when token limits are reached. |
| `OrchestratorRecoveryService` | `packages/orchestrator/src/recoveryService.ts` | 320 | State reconciliation, startup crash recovery, and orphaned task cleanup. |
| `DoctorDiagnosticsService` | `packages/orchestrator/src/doctorDiagnosticsService.ts` | 380 | System health, WSL2 status, provider diagnostics, and sanitized debug bundles. |
| `HostContainment` | `packages/orchestrator/src/hostContainment/*` | 850 | `TrustedHostBroker` and `ContainedOrchestrator` isolating untrusted tasks from host authority. |

### B. Staging, Patching & Live Apply (`packages/stage-store`)

| Component | Exact File Path | Lines | Purpose & Responsibility |
| :--- | :--- | :--- | :--- |
| `PatchEngine` | `packages/stage-store/src/patchEngine.ts` | 389 | Hash-aware search/replace patch engine with unique context matching and BOM/CRLF preservation. |
| `PatchValidator` | `packages/stage-store/src/patchValidator.ts` | 200 | Enforces workspace containment, sensitive path exclusions, and input size limits on proposed patches. |
| `StageStore` | `packages/stage-store/src/stageStore.ts` | 280 | Shadow filesystem abstraction backed by SQLite (`stageRepository.ts`, `stageStorage.ts`). |
| `ApplyService` | `packages/stage-store/src/applyService.ts` | 447 | Atomic live workspace patch application, pre-apply backups, and rollback journal. |
| `ApprovalService` | `packages/stage-store/src/approvalService.ts` | 250 | Single-use approval token generation, payload hash binding, and expiration tracking. |
| `ReviewIntakeService` | `packages/stage-store/src/reviewIntakeService.ts` | 220 | Converts raw AI proposal envelopes into formal staged changes. |

### C. Context Engine & Security Boundaries (`packages/context-engine`, `packages/context-security`, `packages/workspace-boundary`)

| Component | Exact File Path | Lines | Purpose & Responsibility |
| :--- | :--- | :--- | :--- |
| `ContextAssembler` | `packages/context-engine/src/contextAssembler.ts` | 425 | Assembles bounded context packets with relevance ranking, token estimation, and omission markers. |
| `ProjectMapService` | `packages/context-engine/src/projectMap.ts` | 450 | Scans workspace structure, builds compact file hierarchy, and extracts key project manifests. |
| `SecretScanner` | `packages/context-security/src/secretScanner.ts` | 310 | Scans proposed content and context for API keys, tokens, and private keys using regex and Shannon entropy. |
| `PathContainment` | `packages/workspace-boundary/src/pathContainment.ts` | 340 | Strictly validates that paths resolve inside the workspace root; blocks `..`, junctions, and symlink escapes. |

### D. Provider Core & Browser Communication (`packages/provider-core`, `apps/browser-extension`, `packages/protocol`, `packages/native-host`, `packages/ipc-core`)

| Component | Exact File Path | Lines | Purpose & Responsibility |
| :--- | :--- | :--- | :--- |
| `SameChatManager` | `apps/browser-extension/src/sameChatManager.ts` | 679 | Maintains conversation continuity in the same browser tab; prevents duplicate submissions and tab drift. |
| `ChatGPTAdapter` | `apps/browser-extension/src/chatgptProviderAdapter.ts` | 569 | DOM observer for ChatGPT (DOM extraction, streaming detection, ProseMirror input automation). |
| `GeminiAdapter` | `apps/browser-extension/src/geminiProviderAdapter.ts` | 520 | DOM observer for Google Gemini web interface. |
| `DeepSeekAdapter` | `apps/browser-extension/src/deepseekProviderAdapter.ts` | 490 | DOM observer for DeepSeek web interface. |
| `ClaudeAdapter` | `apps/browser-extension/src/claudeProviderAdapter.ts` | 310 | Manual handoff and observation adapter for Claude.ai. |
| `ProtocolValidator` | `packages/protocol/src/protocolValidator.ts` | 170 | Validates structured protocol envelopes and verifies nonces and sequence numbers. |
| `EnvelopeTypes` | `packages/protocol/src/envelopeTypes.ts` | 360 | Zod schema and parser for canonical `<<<MEDIATOR_PLAN>>>` and JSON envelopes. |
| `NativeHostController` | `packages/native-host/src/nativeHostController.ts` | 368 | Chrome Native Messaging host bridging browser extension to desktop Named Pipe IPC. |
| `IpcServer` | `packages/ipc-core/src/ipcServer.ts` | 557 | Authenticated Named Pipe IPC server enforcing current-user DACL security. |

### E. Sandbox & Execution Engines (`packages/executor-contract`, `packages/recipe-registry`)

| Component | Exact File Path | Lines | Purpose & Responsibility |
| :--- | :--- | :--- | :--- |
| `WslIsolatedExecutor` | `packages/executor-contract/src/wslIsolatedExecutor.ts` | 410 | Executes recipes inside `MediatorSandbox` WSL2 environment with `unshare --net` network denial. |
| `RecipeRegistryService` | `packages/recipe-registry/src/recipeRegistry.ts` | 260 | Registry of immutable, SHA-256 hash-pinned recipes (`project.test`, `python.test`, `project.lint`). |
| `OfflineBundleService` | `packages/recipe-registry/src/offlineToolchain/offlineBundleService.ts` | 310 | Offline toolchain and dependency resolver ensuring builds succeed without internet access. |

### F. User Interfaces (`apps/standalone-ui`, `apps/cli`)

| Component | Exact File Path | Lines | Purpose & Responsibility |
| :--- | :--- | :--- | :--- |
| `StandaloneUI App` | `apps/standalone-ui/app.js` | 1,450 | Single-page dashboard logic (tasks, diffs, approvals, autopilot toggle, event stream). |
| `ApiClient` | `apps/standalone-ui/src/apiClient.ts` | 360 | Hardened HTTP/SSE client handling 204 No Content, empty bodies, and port discovery. |
| `Dashboard View` | `apps/standalone-ui/index.html` & `styles.css` | 1,800 | Glassmorphic dark UI with responsive sidebar, diff viewers, and diagnostic modals. |
| `Mediator CLI` | `apps/cli/src/index.ts` | 350 | Command-line interface (`mediator start`, `mediator task`, `mediator approval`). |

---

## 5. Reuse Classification Matrix

Every component has been evaluated against the intended Antigravity-style autonomous coding workflow:

| Component Name & Path | Classification | Evidence & Existing Tests | Fit / Non-Fit Rationale | Integration Requirement | Scope |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `GuardedAutopilotEngine` (`packages/orchestrator/src/guardedAutopilotEngine.ts`) | **REUSE AFTER A TARGETED FIX** | Verified by 14 passing tests in `guardedAutopilot.test.ts` on `release-candidate`. | Solves isolated worktree execution, iteration budgets, and sandbox testing. Non-fit: currently missing from `main` and lacks `providerHandler` connection in `mediatorCore.ts`. | Port from `release-candidate` to `main`; wire `providerHandler` to `MediatorCore`. | Small |
| `WslIsolatedExecutor` (`packages/executor-contract/src/wslIsolatedExecutor.ts`) | **REUSE AS-IS** | Verified by `wslSandboxCanaries.test.ts` and `guardedAutopilot.test.ts`. | Confined execution, authentic exit codes, 100% network isolation (`CLONE_NEWNET`). Fits perfectly. | None; use existing interface. | Zero |
| `PatchEngine` (`packages/stage-store/src/patchEngine.ts`) | **REUSE AS-IS** | 100% pass in `patchEngine.test.ts`. | Handles exact context search/replace, BOM/newline preservation, and rejects ambiguous patches. Better than Claude Code's string replacer. | None. | Zero |
| `PatchValidator` (`packages/stage-store/src/patchValidator.ts`) | **REUSE AS-IS** | Verified in `patchEngine.test.ts` and `stageStore.test.ts`. | Validates workspace containment, size limits, and blocks protected security paths (`.git`, `.env`). | None. | Zero |
| `ApplyService` (`packages/stage-store/src/applyService.ts`) | **REUSE AS-IS** | Verified in `applyService.test.ts` and `e2eWorkflowIntegration.test.ts`. | Atomic file replacements on same volume, pre-apply backups, and rollback journal. High reliability. | None. | Zero |
| `ApprovalService` (`packages/stage-store/src/approvalService.ts`) | **REUSE AS-IS** | Verified across all E2E integration suites. | Generates single-use approval tokens bound to stage payload hashes. | None. | Zero |
| `PathContainment` (`packages/workspace-boundary/src/pathContainment.ts`) | **REUSE AS-IS** | 155 tests passing in `pathContainment.test.ts`. | Rejects Windows traversal, junction escapes, alternate data streams (`::$DATA`), and DOS devices. | None. | Zero |
| `SecretScanner` (`packages/context-security/src/secretScanner.ts`) | **REUSE AS-IS** | Verified in `contextSecurity.test.ts`. | Scans proposed content for API keys, tokens, and private keys. | None. | Zero |
| `ContextAssembler` (`packages/context-engine/src/contextAssembler.ts`) | **REUSE WITH A SMALL ADAPTER** | Verified in `contextEngine.test.ts`. | Assembles bounded context packets, project maps, and test failure excerpts with token estimation. | Add prompt template formatter for planning vs build turns. | Small |
| `SameChatManager` (`apps/browser-extension/src/sameChatManager.ts`) | **REUSE WITH A SMALL ADAPTER** | Verified in `sameChatAdapter.test.ts`. | Maintains conversation identity, message tracking, and prevents duplicate submissions. | Provide callback wrapper adapting `SameChatManager.sendDraft()` to `providerHandler`. | Medium |
| `ChatGPT / Gemini / DeepSeek Adapters` (`apps/browser-extension/src/*ProviderAdapter.ts`) | **REUSE AS-IS** | Verified in `providerConformance.test.ts`. | DOM observation, streaming completion detection, and input automation for logged-in AI websites. | None; adapters are already conforming. | Zero |
| `NativeHostController` & `IpcServer` (`packages/native-host`, `packages/ipc-core`) | **REUSE AS-IS** | Verified in `nativeHost.test.ts` and `ipcCore.test.ts`. | Secure length-prefixed stdin/stdout framing to Named Pipe IPC with origin validation. | None. | Zero |
| `MediatorHttpServer` (`packages/orchestrator/src/mediatorHttpServer.ts`) | **REUSE AS-IS** | Verified by 20 tests in `standaloneUi.test.ts`. | Port 3300 loopback HTTP + SSE server; authenticated with pairing token. | None. | Zero |
| `StandaloneUI` (`apps/standalone-ui/app.js`, `apiClient.ts`) | **REUSE WITH A SMALL ADAPTER** | 20 passing tests in `standaloneUi.test.ts`. | Renders dashboard, diff preview, task log, approvals, and autopilot toggle. | Wire Autopilot Start button to `POST /api/tasks/:id/autopilot/run`. | Small |
| `RecipeRegistryService` (`packages/recipe-registry/src/recipeRegistry.ts`) | **REUSE AS-IS** | Verified in `recipeRegistry.test.ts`. | Cryptographically pinned recipe definitions (`python.test`, `project.test`). | None. | Zero |
| `WorkflowOrchestrator` (`packages/orchestrator/src/workflowOrchestrator.ts`) | **REFACTOR / CONSOLIDATE** | 15 passing tests in `workflowOrchestrator.test.ts`. | Heavy overlap with `GuardedAutopilotEngine`; operates in review-only mode. | Consolidate state machine transitions into `GuardedAutopilotEngine` or make it the manual-mode delegate. | Medium |
| `MCP Server` (`packages/mcp-server`) | **NOT NEEDED FOR CURRENT MVP** | Tested in `mcpServer.test.ts`. | Narrow read-only MCP resources for IDEs. Irrelevant to standalone browser-AI autopilot. | Defer until external IDE integration is required. | Zero |
| `IDE Extension` (`apps/ide-extension`) | **NOT NEEDED FOR CURRENT MVP** | Tested in `diffPanelController.test.ts`. | VS Code webview extension. The standalone UI is the primary target interface. | Defer. | Zero |
| `27 Live Inspection Scripts` (`scripts/check-*.mjs`, `scripts/inspect-*.mjs`) | **REPLACE ONLY IF NECESSARY (DELETE)** | Unmaintained ad-hoc scripts from earlier sprints; already purged in `release-candidate`. | Clutters repository, causes maintenance drag, and creates confusion. | Delete from `main` to match `release-candidate`. | Small |

---

## 6. Important Code Paths and Interface Contracts

### 1. Task Intake & Isolated Worktree Initialization
```
User Input in UI -> POST /api/tasks
  -> MediatorCore.createTask({ prompt, providerId, mode })
  -> MediatorCore.runAutopilotTask(taskId)
  -> GuardedAutopilotEngine.initializeTaskWorktree(taskId)
     - Creates: <workspaceRoot>/.mediator/task-worktrees/<taskId>/
     - Copies base project files (excluding .git, node_modules, .mediator)
     - Validates S00 decision === 'GO-GUARDED-AUTOPILOT'
```

### 2. Autonomous Iteration Loop (`runIterationLoop`)
```
While (iterations < maxIterations && !aborted):
  1. Call providerHandler(prompt, iteration, lastFailureSnippet)
     -> Browser Extension / Provider Adapter submits prompt to AI
     -> AI responds with protocol envelope <<<MEDIATOR_PLAN>>>
  2. Parse & Validate Proposal:
     -> PatchValidator.validatePatchProposal()
     -> PathContainment.validateContainedPath()
  3. Stage Proposal in Worktree ONLY:
     -> GuardedAutopilotEngine.stageProposalInWorktree(taskId, path, content)
     -> Writes to: .mediator/task-worktrees/<taskId>/<path>
     -> Live workspace remains 100% UNTOUCHED
  4. Sandbox Validation:
     -> WslIsolatedExecutor.executeRecipe({ recipeId: 'project.test', isolateNetwork: true })
     -> Captures authentic exit code, stdout, stderr inside MediatorSandbox
  5. Convergence Check:
     -> If exitCode === 0:
          Status = 'completed', StopReason = 'SUCCESS'
          Compute final verified diff against live workspace
          Emit 'autopilot:completed' event to UI
          BREAK
     -> Else:
          consecutiveFailures += 1
          lastFailureSnippet = stderr || stdout
          If consecutiveFailures >= maxConsecutiveFailures:
            Status = 'stopped', StopReason = 'CONSECUTIVE_FAILURES_EXCEEDED'
            BREAK
```

### 3. Human Review & Live Promotion
```
UI receives SSE event 'approval:created' with verified unified diff
  -> User reviews diff in Staging & Diffs panel
  -> User clicks "Approve & Apply" -> POST /api/approvals/:id/resolve
  -> POST /api/stages/:id/apply
  -> MediatorCore.applyApprovedStage(stageId, approvalId)
  -> ApplyService.applyToWorkspace():
     - Validates approval token & payload hash
     - Creates pre-apply backup in %APPDATA%/Mediator/backups
     - Atomically writes files to live workspace
     - Records transaction in SQLite journal
     - Marks approval token 'consumed' (single-use invariant)
```

---

## 7. Existing Test Coverage and Limitations

### Verified Passing Test Suites
Targeted execution of non-destructive test suites confirmed robust behavior:
- `workflowOrchestrator.test.ts`: **15 passed, 0 failed** (Budget guard, replay guard, secret detection, 10 controlled scenarios).
- `guardedAutopilot.test.ts`: **14 passed, 0 failed** (Policy boundary, worktree isolation, traversal defense, budget limits, mock convergence).
- `standaloneUi.test.ts`: **20 passed, 0 failed** (API client, 204 No Content, HTML/JSON error isolation, pairing token handshake, workspace switching).

### Test Coverage Limitations
1. **Mocked Provider Responses in Unit Tests:** All automated tests use static JSON fixtures or mock handlers (`fixtures/chatgptFixtures.ts`, etc.). While DOM extraction logic is thoroughly unit-tested against captured HTML fixtures, tests do not test live network interaction with AI websites.
2. **WSL2 Environment Dependency:** Sandbox validation tests require a provisioned `MediatorSandbox` WSL2 instance. In environments without WSL2, executor tests fall back to canaries or skip actual Linux process launches.
3. **End-to-End Browser-to-Autopilot Gap:** There is currently no automated test that exercises the full chain from browser extension DOM click, through native messaging, into `GuardedAutopilotEngine`, and back to the browser for iteration 2.

---

## 8. Duplicate Systems and Unnecessary Complexity

1. **`WorkflowOrchestrator.ts` vs `GuardedAutopilotEngine.ts`:**
   - Both maintain an iteration state, transition log, and budget counter.
   - `WorkflowOrchestrator` is strictly review-only (stops at every step).
   - `GuardedAutopilotEngine` implements the true iterative loop inside an isolated worktree.
   - **Resolution:** Retain `GuardedAutopilotEngine` as the authoritative execution engine; make `WorkflowOrchestrator` delegate to it or restrict `WorkflowOrchestrator` to manual step-by-step handoffs.

2. **`MediatorCore` vs `hostContainment/containedOrchestrator.ts`:**
   - S45 introduced a two-tier `TrustedHostBroker` and `ContainedOrchestrator` pattern to protect the Windows host process.
   - While architecturally sound for multi-tenant containment, it introduces redundant layers of proxying for local single-user execution.
   - **Resolution:** Keep `TrustedHostBroker` for live workspace writes (`applyApprovedStage`), but let `GuardedAutopilotEngine` manage the task worktree directly.

3. **27 Ad-Hoc Scripts in `Mediator/scripts/`:**
   - Files like `check-chatgpt-dom.mjs`, `debug-chatgpt-submit.mjs`, `inspect-chatgpt-hierarchy.mjs`, `test-real-chatgpt.mjs`, etc. were exploratory tools used during early sprints.
   - They were already removed in `release/v0.1.0-rc.1` (4,172 deletions) but remain in `main`.
   - **Resolution:** Purge all 27 exploratory scripts from `main`.

4. **Claude Code CLI vs Mediator Patching:**
   - `claude-code-main` contains `FileEditTool` and `FileWriteTool`.
   - Mediator already contains `packages/stage-store/src/patchEngine.ts` and `patchValidator.ts`.
   - Mediator's patch engine is safer for Mediator because it validates workspace containment, detects BOM/CRLF, and integrates with shadow staging and TOCTOU rollback journals.
   - **Resolution:** Do NOT replace Mediator's patch engine with Claude Code's tools. Reuse Mediator's `PatchEngine` as-is.

---

## 9. Missing Capabilities and Confirmed Defects

1. **Defect: `mediatorCore.runAutopilotTask` Lacks `providerHandler` Connection:**
   In `packages/orchestrator/src/mediatorCore.ts` (lines 1330–1334), `runAutopilotTask` calls `runIterationLoop` without passing `providerHandler`. It must be connected to a provider dispatch service (browser extension bridge or API client) so the engine can solicit new code proposals when validation fails.
2. **Defect: Branch Divergence (`main` vs `release-candidate`):**
   `GuardedAutopilotEngine.ts` exists on `release/v0.1.0-rc.1` but has not been merged into `main`. `main` still has S00 `NO-GO-AUTOEXEC` hardcoded as the default with no worktree isolation engine.
3. **Missing Capability: Planning vs Implementation Two-Phase Prompting:**
   Currently, Autopilot takes a single prompt string. In an Antigravity-style workflow, task execution requires two distinct phases:
   - **Phase 1 (Plan):** The model produces an implementation plan with acceptance criteria.
   - **Phase 2 (Build & Test Loop):** The model receives the approved plan and generates structured file edits iteratively until tests pass.
4. **Minor Limitation: Error Snippet Truncation:**
   In `guardedAutopilotEngine.ts` (line 493), `stdoutSnippet` and `stderrSnippet` are truncated to 500 characters. For verbose test suites (e.g. Vitest or Jest), 500 characters often captures only the stack trace footer and cuts off the actual assertion failure. This should be increased to 2,000–4,000 characters.

---

## 10. Security and Reliability Risks Relevant to Reuse

1. **Live Workspace Immutability:**
   Guarded Autopilot guarantees that the developer's live working tree is never touched during AI iterations. All operations occur in `.mediator/task-worktrees/<taskId>`. This completely eliminates the risk of an AI hallucination corrupting the active repository.
2. **Network Egress Boundary:**
   `MediatorSandbox` executes with `CLONE_NEWNET`. Untrusted code generated by AI cannot exfiltrate environment variables, source code, or credentials to external servers during test execution.
3. **Path Traversal & Windows Specifics:**
   Mediator's path validation explicitly tests and blocks NTFS Alternate Data Streams (`file.ts::$DATA`), 8.3 short filename bypasses (`PROGRA~1`), Windows junction points, and reserved DOS device names (`NUL`, `CON`, `PRN`, `AUX`).
4. **TOCTOU Hash Verification:**
   Before applying approved changes to the live workspace, `ApplyService` recalculates the SHA-256 hash of the live files. If the developer edited the file in their editor while the AI was working, the apply operation aborts fail-closed, preventing silent overwrite of human edits.

---

## 11. Recommended Integration Architecture

To establish an Antigravity-style autonomous coding workflow in Mediator, integrate the existing verified components as follows:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          STANDALONE UI DASHBOARD                            │
│  - Operator inputs: "Build a calculator with responsive UI & unit tests"    │
│  - Selects provider: ChatGPT / Gemini / DeepSeek / Claude                   │
│  - Toggles: "Local Autopilot: ON" -> Clicks "Start Autopilot Task"          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ POST /api/tasks (with autopilot: true)
                                       v
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MEDIATOR CORE                                  │
│  1. S00 Decision set to 'GO-GUARDED-AUTOPILOT'                              │
│  2. Creates TaskRecord(status: 'running')                                   │
│  3. Invokes GuardedAutopilotEngine.runIterationLoop()                       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                │                                             │
                v                                             v
┌───────────────────────────────┐           ┌─────────────────────────────────┐
│     PHASE 1: PLANNING         │           │   PHASE 2: GUARDED BUILD LOOP   │
│ - Generates Planning Prompt   │           │ - Worktree: .mediator/task-worktrees│
│ - Sends to selected provider  │           │ - Applies patch via PatchEngine │
│ - Ingests Plan envelope       │           │ - Runs test in MediatorSandbox  │
│ - Emits Plan to UI event log  │           │ - If fail: extract stderr snippet│
│                               │           │ - Sends corrective prompt to AI │
│                               │           │ - Loops up to max 5 iterations  │
└───────────────────────────────┘           └────────────────┬────────────────┘
                                                             │
                                                             v Exit Code 0 (SUCCESS)
┌─────────────────────────────────────────────────────────────────────────────┐
│                           VERIFIED DIFF & APPROVAL                          │
│  - GuardedAutopilotEngine computes clean diff between worktree and live repo│
│  - Generates ApprovalRecord with single-use token                           │
│  - Emits 'approval:created' and 'autopilot:completed' to UI                 │
│  - Developer inspects diff in UI -> clicks "Approve & Apply"                │
│  - ApplyService creates backup & atomically writes to live workspace        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 12. Minimal Implementation Order

To make the actual Standalone UI workflow functional with minimal risk and maximum reuse:

1. **Step 1: Merge `GuardedAutopilotEngine` into `main`**
   - Copy `packages/orchestrator/src/guardedAutopilotEngine.ts` and `guardedAutopilot.test.ts` from `release/v0.1.0-rc.1` into `main`.
   - Update `packages/orchestrator/src/mediatorCore.ts` to include `runAutopilotTask` and `setS00Decision('GO-GUARDED-AUTOPILOT')`.
   - Verify tests pass: `npx vitest run packages/orchestrator/src/guardedAutopilot.test.ts`.

2. **Step 2: Connect `providerHandler` in `mediatorCore.ts`**
   - Create a thin bridge adapter (`AutopilotProviderBridge`) that maps `providerHandler(prompt, iteration, failureSnippet)` to:
     - For Browser AI: `SameChatManager.prepareDraft()` -> dispatch to active browser tab -> await response envelope.
     - For API providers: `UnifiedProviderRegistry.getAdapter(providerId).sendPrompt()`.

3. **Step 3: Enhance Failure Snippet Capture**
   - Increase `stdoutSnippet` and `stderrSnippet` budget in `guardedAutopilotEngine.ts` from 500 to 2,500 characters to ensure full assertion failures and stack traces are captured.

4. **Step 4: Connect Standalone UI Autopilot Control**
   - In `apps/standalone-ui/app.js`, wire the "Start Autopilot" button to call `apiClient.request('POST', '/api/tasks', { prompt, autopilot: true })`.
   - Display real-time iteration reports in the task history panel as SSE events arrive.

5. **Step 5: Purge Obsolete Scripts from `main`**
   - Delete the 27 exploratory scripts from `scripts/` to match the clean state of `release-candidate`.

---

## 13. Calculator End-to-End Acceptance Criteria

### Example Task:
> *"Build a calculator with a responsive UI, keyboard support, calculation history and unit tests."*

### End-to-End Execution Flow & Acceptance Criteria:

| Step # | Workflow Stage | Expected Behavior & Verification Criteria | Authoritative Component |
| :--- | :--- | :--- | :--- |
| **Step 1** | **Task Intake** | Operator enters prompt in Standalone UI, selects Google Gemini, and toggles Autopilot ON. UI submits `POST /api/tasks`. Core returns HTTP 201 with authoritative `taskId`. | `StandaloneUI` -> `MediatorHttpServer` -> `MediatorCore` |
| **Step 2** | **Worktree Isolation** | Core invokes `initializeTaskWorktree(taskId)`. Directory `<workspaceRoot>/.mediator/task-worktrees/<taskId>/` is created containing cloned project base files. Live files remain clean. | `GuardedAutopilotEngine` |
| **Step 3** | **Planning Prompt** | Core constructs planning prompt using `ContextAssembler`. Prompt includes task requirements and project structure. Dispatched to attached Gemini browser tab. | `ContextAssembler` -> `SameChatManager` |
| **Step 4** | **Plan Capture** | Gemini responds with structured plan outlining calculator components (`Calculator.ts`, `CalculatorUI.html`, `calculator.test.ts`). Protocol validator confirms valid envelope and emits plan to UI. | `GeminiProviderAdapter` -> `ProtocolValidator` |
| **Step 5** | **Build Turn 1** | Autopilot automatically requests code implementation. Gemini produces file blocks for calculator logic and test suite. | `GuardedAutopilotEngine` -> `SameChatManager` |
| **Step 6** | **Staging in Isolation** | `PatchEngine` validates paths and writes proposed files strictly inside `.mediator/task-worktrees/<taskId>/`. Live workspace is NOT modified. | `PatchEngine` -> `PathContainment` |
| **Step 7** | **Sandbox Test Execution** | `WslIsolatedExecutor` executes `project.test` recipe inside `MediatorSandbox` with `unshare --net`. Test fails due to a deliberate off-by-one error or syntax flaw. Exit code: `1`. | `WslIsolatedExecutor` |
| **Step 8** | **Corrective Feedback** | Engine captures exit code 1 and stderr failure trace. Formats corrective prompt: *"Test failed with AssertionError in test_history(). Fix the calculation history logic."* | `GuardedAutopilotEngine` |
| **Step 9** | **Build Turn 2 (Fix)** | Corrective prompt sent to same Gemini conversation. Model returns corrected `Calculator.ts`. Proposed fix is staged into task worktree. | `SameChatManager` -> `PatchEngine` |
| **Step 10** | **Retest & Convergence** | Sandbox re-executes `project.test`. All calculator tests pass. Exit code: `0`. Engine records convergence in 2 iterations (well within 5-iteration budget). Status: `completed`. | `GuardedAutopilotEngine` -> `WslIsolatedExecutor` |
| **Step 11** | **Diff Review in UI** | Engine computes unified diff between task worktree and live workspace. Registers `ApprovalRecord`. UI updates with green status, displays full unified diff and test summary. | `GuardedAutopilotEngine` -> `StandaloneUI` |
| **Step 12** | **Human Approval & Apply** | Developer reviews diff and clicks "Approve & Apply". `ApplyService` verifies SHA-256 base hashes, creates backup in `%APPDATA%/Mediator/backups`, and atomically applies calculator files to live workspace. | `ApprovalService` -> `ApplyService` |

---

## 14. Unverified Claims and Remaining Questions

1. **Provider DOM Stability:**
   While all 4 provider adapters have conforming unit tests with frozen fixtures, live browser interfaces (especially ChatGPT and Claude.ai) undergo frequent UI updates. Real live-session verification requires human observation to confirm that recent DOM tweaks by OpenAI/Anthropic have not shifted button selectors.
2. **Offline Toolchain Pre-Seeding:**
   The offline sandbox enforces default-deny network egress. For project-specific dependencies (e.g. npm packages like `mathjs`), the dependencies must already exist in the workspace `node_modules` or be pre-seeded in the offline bundle cache. Dynamic `npm install` inside the sandbox fails by design.
3. **WSL2 Prerequisite:**
   The sandbox requires WSL2 and a provisioned `MediatorSandbox` distro. On systems where WSL2 is not installed, the engine must gracefully fall back to generating manual copyable terminal commands for the developer.

---

## 15. Complete File & Folder Disposition List

### A. FILES & FOLDERS TO USE (RETAIN & REUSE)

#### 1. Core Orchestration & Execution
- `packages/orchestrator/src/guardedAutopilotEngine.ts` *(Port from `release-candidate` to `main`)* — Authoritative task worktree iteration loop.
- `packages/orchestrator/src/mediatorCore.ts` — Authoritative task, provider, workspace, and approval state machine.
- `packages/orchestrator/src/mediatorHttpServer.ts` — Loopback HTTP (port 3300) and SSE real-time event server.
- `packages/orchestrator/src/autopilotGate.ts` — Security policy evaluator and execution gate.
- `packages/orchestrator/src/budgetGuard.ts` — Transition budgets and loop tripping guards.
- `packages/orchestrator/src/recoveryService.ts` — Process crash recovery and task reconciliation.
- `packages/orchestrator/src/doctorDiagnosticsService.ts` — Health diagnostics and sanitized debug bundles.
- `packages/executor-contract/src/wslIsolatedExecutor.ts` — WSL2 sandbox process runner with network denial.
- `packages/recipe-registry/src/recipeRegistry.ts` — Cryptographically pinned test/lint recipes.

#### 2. Staging, Patching & Live Workspace Protection
- `packages/stage-store/src/patchEngine.ts` — Hash-aware search/replace with BOM/CRLF preservation.
- `packages/stage-store/src/patchValidator.ts` — Path containment, size limits, and protected path checks.
- `packages/stage-store/src/applyService.ts` — Atomic live workspace application with pre-apply backups.
- `packages/stage-store/src/approvalService.ts` — Single-use approval tokens bound to payload hashes.
- `packages/stage-store/src/stageStore.ts` — SQLite-backed shadow staging storage.
- `packages/workspace-boundary/src/pathContainment.ts` — Strict workspace boundary and traversal defense.
- `packages/context-security/src/secretScanner.ts` — Regex and entropy secret detector.

#### 3. Browser Extension & Provider Communication
- `apps/browser-extension/src/sameChatManager.ts` — Authoritative same-chat continuity manager.
- `apps/browser-extension/src/chatgptProviderAdapter.ts` — OpenAI ChatGPT DOM adapter.
- `apps/browser-extension/src/geminiProviderAdapter.ts` — Google Gemini DOM adapter.
- `apps/browser-extension/src/deepseekProviderAdapter.ts` — DeepSeek DOM adapter.
- `apps/browser-extension/src/claudeProviderAdapter.ts` — Claude.ai DOM and manual handoff adapter.
- `packages/protocol/src/protocolValidator.ts` & `envelopeTypes.ts` — Protocol envelope parser and schema.
- `packages/native-host/src/nativeHostController.ts` & `framing.ts` — Chrome Native Messaging host.
- `packages/ipc-core/src/ipcServer.ts` & `ipcClient.ts` — Authenticated Named Pipe IPC.

#### 4. User Interface & Context
- `apps/standalone-ui/app.js` & `src/apiClient.ts` — Dashboard application and hardened API client.
- `apps/standalone-ui/index.html` & `styles.css` — Modern dark glassmorphic responsive UI.
- `packages/context-engine/src/contextAssembler.ts` — Bounded context packet builder.
- `packages/context-engine/src/projectMap.ts` — Project structure and manifest summarizer.

---

### B. FILES & FOLDERS TO DELETE / CONSOLIDATE

#### 1. Obsolete & Ad-Hoc Scripts in `Mediator/scripts/` (27 files — already deleted in `release-candidate`):
- `scripts/check-chatgpt-dom.mjs` — One-off exploratory DOM probe.
- `scripts/check-gemini-response.mjs` — One-off response checker.
- `scripts/check-provider-auth.mjs` — Ad-hoc auth checker.
- `scripts/debug-chatgpt-submit.mjs` — One-off submit debugger.
- `scripts/fetch-saved-conv.mjs` — Temporary test script.
- `scripts/inspect-active-conv.mjs` — Ad-hoc conversation inspector.
- `scripts/inspect-chatgpt-composer.mjs` — Temporary composer probe.
- `scripts/inspect-chatgpt-conv.mjs` — Temporary conversation probe.
- `scripts/inspect-chatgpt-dom.mjs` — Ad-hoc DOM dump.
- `scripts/inspect-chatgpt-hierarchy.mjs` — Temporary hierarchy probe.
- `scripts/inspect-chatgpt-main.mjs` — Temporary main probe.
- `scripts/inspect-gemini.mjs` — Ad-hoc Gemini probe.
- `scripts/inspect-pre-hierarchy.mjs` — Temporary hierarchy probe.
- `scripts/probe-providers.mjs` — One-off provider prober.
- `scripts/run-gemini-deepseek-live-acceptance.mjs` — 833-line ad-hoc live script replaced by Vitest suites.
- `scripts/run-live-provider-acceptance.mjs` — 718-line ad-hoc live script replaced by Vitest suites.
- `scripts/run-phase5-trial.mjs` — 410-line trial script.
- `scripts/test-browser-cdp.mjs` — Ad-hoc CDP test.
- `scripts/test-chatgpt-prosemirror.mjs` — ProseMirror test script.
- `scripts/test-chatgpt-requestsubmit.mjs` — Temporary submit test.
- `scripts/test-deepseek-auth.mjs` — DeepSeek auth probe.
- `scripts/test-gemini-dispatch.mjs` — Gemini dispatch probe.
- `scripts/test-gemini-input.mjs` — Gemini input probe.
- `scripts/test-live-chatgpt-coding-fix.mjs` — Temporary coding fix probe.
- `scripts/test-real-chatgpt.mjs` — Ad-hoc ChatGPT script.
- `scripts/verify-chatgpt-live-session.mjs` — Session verify script.
- `scripts/verify-phase4.mjs` — Phase 4 legacy test script.

#### 2. Deferred / Non-MVP Modules (Retain but do not load for MVP Autopilot):
- `packages/mcp-server/` — Read-only MCP server (not needed for standalone UI workflow).
- `apps/ide-extension/` — VS Code webview extension (standalone UI is the primary interface).
- `packages/ide-adapter-vscode/` & `packages/ide-adapter-antigravity/` — IDE integration adapters.
- `packages/executor-ide-native/` — Stub executor.

---

## 16. Final Answers to Mandated Questions

### 1. What existing harness code should Mediator reuse immediately?
Mediator should immediately reuse **`GuardedAutopilotEngine`** (from `release-candidate`), **`WslIsolatedExecutor`**, **`PatchEngine`**, **`PatchValidator`**, **`ApplyService`**, **`ApprovalService`**, **`PathContainment`**, **`SameChatManager`**, **`ChatGPT/Gemini/DeepSeek Adapters`**, **`MediatorHttpServer`**, and the **`Standalone UI` (`app.js` + `apiClient.ts`)**.

### 2. What can remain completely unchanged?
The security boundary (`packages/workspace-boundary`), the secret scanner (`packages/context-security`), the patch engine (`packages/stage-store/src/patchEngine.ts`), the live apply and rollback service (`packages/stage-store/src/applyService.ts`), the Named Pipe IPC layer (`packages/ipc-core`), the Native Messaging host (`packages/native-host`), the recipe definitions (`packages/recipe-registry`), and the loopback HTTP server (`packages/orchestrator/src/mediatorHttpServer.ts`) can remain **100% unchanged**.

### 3. What requires only a thin adapter?
`apps/browser-extension/src/sameChatManager.ts` and `apps/standalone-ui/app.js` need thin adapters:
- A wrapper in Mediator Core adapting `SameChatManager.sendDraft()` to `providerHandler`.
- A button handler in `app.js` connecting "Start Autopilot" to `POST /api/tasks/:id/autopilot/run`.

### 4. What needs a targeted fix before use?
`packages/orchestrator/src/mediatorCore.ts`: `runAutopilotTask()` must be updated to pass the active provider dispatch handler (`providerHandler`) into `GuardedAutopilotEngine.runIterationLoop()`.

### 5. Which existing systems are duplicative?
- `WorkflowOrchestrator.ts` duplicates state transitions and budgets already handled by `GuardedAutopilotEngine.ts`.
- The 27 ad-hoc probe scripts in `scripts/` duplicate existing Vitest acceptance suites and clutter the workspace.

### 6. What is the smallest set of changes needed to make the actual Standalone UI workflow work?
1. Port `GuardedAutopilotEngine.ts` and `ADR-031` from `release/v0.1.0-rc.1` into `main`.
2. Connect `providerHandler` in `mediatorCore.ts` to dispatch prompts via the browser extension bridge.
3. Wire the "Start Autopilot" button in `apps/standalone-ui/app.js` to trigger `POST /api/tasks/:id/autopilot/run`.

### 7. What should not be rebuilt from scratch?
Do NOT rebuild:
- The patch engine or diff generator (Mediator's `PatchEngine` and `generateUnifiedDiff` are already robust).
- The sandbox runner (`WslIsolatedExecutor` already enforces `CLONE_NEWNET` and authentic exit-code capture).
- The browser DOM extraction adapters (ChatGPT, Gemini, and DeepSeek adapters already handle streaming, login walls, and draft injection).
- The Standalone UI (the UI is already responsive, styled with modern glassmorphism, and wired to SSE events).

### 8. What evidence is still missing before the harness can be trusted for real Autopilot tasks?
A live end-to-end trial confirming that the active browser tab receives the prompt, the model's response envelope is captured without DOM selector drift, and the resulting diff passes human review before live promotion.
