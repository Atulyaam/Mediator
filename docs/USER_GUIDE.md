# Mediator — User Guide (Review-Only V1)

Welcome to **Mediator**, the autonomous coding orchestration platform designed for real-world software engineering tasks with rigorous host security, cryptographic staging, and offline Linux network namespace isolation.

Mediator operates strictly in **Review-only V1 mode**. Local Autopilot remains **BLOCKED** fail-closed under policy S00 `NO-GO-AUTOEXEC`. Every proposed live workspace modification requires human review and explicit approval.

---

## 1. Quick Start Workflow

### 1.1 Start Mediator Core Daemon
Mediator runs as a local background daemon binding strictly to loopback (`127.0.0.1`):

```bash
# Start the Mediator Core server with Standalone UI
npm run dev
# Or start via CLI
mediator status
```

The daemon provides:
- Loopback HTTP API and SSE event stream authenticated with `X-Mediator-Token`.
- Standalone web dashboard at `http://127.0.0.1:<port>/?token=pair_...`.

### 1.2 Verify Environment Health
Run the diagnostic setup doctor to ensure your Windows 11 environment, dedicated `MediatorSandbox` WSL2 distribution, offline toolchains, and browser extensions are ready:

```bash
mediator doctor
```

Output highlights:
- `[READY]` Mediator Core Engine (v0.0.1)
- `[READY]` Dedicated WSL2 Sandbox (`MediatorSandbox`)
- `[READY]` Sandbox Network Isolation (`CLONE_NEWNET` default-deny)
- `[READY]` Offline Toolchain & Dependency Cache (Python 3.14+ & Node.js)
- `[READY]` AI Providers (Gemini, ChatGPT, DeepSeek, Claude)
- `[READY]` Active Workspace Scope
- `[READY]` Local Autopilot Security Policy (`BLOCKED — S00 NO-GO-AUTOEXEC`)

---

## 2. Supported Project Types & Toolchains

Mediator supports offline execution of linting, typechecking, and testing in the isolated `MediatorSandbox` environment with zero network egress:

| Project Type | Supported Recipes | Runtime / Toolchain | Offline Strategy |
|---|---|---|---|
| **Python** | `python.test`, `python.single_test` | Python 3.14+ (`/usr/bin/python3`) | Standard library or verified wheel archives in `.mediator/bundles/` with SHA-256 manifests. |
| **Node.js / TypeScript** | `project.test`, `project.lint`, `project.typecheck`, `project.build` | Node.js & npm (Host-assisted / in-distro) | Pre-packaged `node_modules` bundles with verified lockfile integrity. |
| **Git Repositories** | `git.status`, `git.diff` | Git 2.46+ (`/usr/bin/git`) | Read-only workspace inspection. |

> [!NOTE]
> If a project requires unbundled dependencies, execution fails closed with `OFFLINE_DEPENDENCY_MISSING`. Untrusted tasks are never granted dynamic network access.

---

## 3. Working with AI Providers

Mediator supports multiple top-tier AI providers without exposing API keys or requiring paid enterprise subscriptions for browser accounts:

### 3.1 Google Gemini
- **Mode:** Browser Bridge (Active Tab).
- **Setup:** Open Chrome or Edge, navigate to `gemini.google.com`, and sign in. The Mediator extension automatically synchronizes conversation turns.

### 3.2 OpenAI ChatGPT
- **Mode:** Browser Bridge (Active Tab).
- **Setup:** Open Chrome or Edge, navigate to `chatgpt.com`, and sign in. The extension captures structured patches directly from the chat DOM.

### 3.3 DeepSeek
- **Mode:** Browser Bridge (Active Tab).
- **Setup:** Open Chrome or Edge, navigate to `chat.deepseek.com`, and sign in. DOM observation automatically streams response envelopes to Core.

### 3.4 Anthropic Claude
- **Mode:** Manual Handoff or Official API.
- **Setup:** Copy prompt envelopes to `claude.ai` and paste responses back, or configure an official Anthropic API key in configuration settings.

To switch providers via CLI:
```bash
mediator providers select gemini
mediator providers select openai
mediator providers select deepseek
```

---

## 4. End-to-End Coding Task Lifecycle

Mediator manages every coding request through a strictly audited 9-stage lifecycle:

```
[Task Intake] ➔ [Provider Conversation] ➔ [Proposal Parsing] ➔ [Shadow Staging]
      ➔ [Offline Sandbox Validation] ➔ [Iterative Feedback] ➔ [Final Human Review]
      ➔ [Explicit Approved Apply] ➔ [Completion & Audit]
```

### Stage 1: Create a Coding Task
Create a task in the Standalone UI or via CLI:
```bash
mediator task create "Fix off-by-one error in calculateTax helper" --workspace="C:\Users\Atul2\Projects\MyStore" --confirm
```

### Stage 2: Capture Provider Proposal
The selected AI provider produces a patch envelope. The proposal is automatically parsed and bounds-checked. Path traversal attempts (e.g. `../../etc/shadow`) are rejected fail-closed.

### Stage 3: Shadow Staging
Patches are staged into shadow storage (`%LOCALAPPDATA%\Mediator\staging\<taskId>`) with SHA-256 base hashes bound to your current workspace commit.

### Stage 4: Offline Sandbox Validation
Mediator dispatches the recipe to `MediatorSandbox` using Linux network namespace isolation (`unshare --user --net`):
```bash
mediator task validate <taskId> python.test
```
Real exit codes and test logs are captured without network egress.

### Stage 5: Final Human Review
Inspect the staged diff and real test validation outputs:
```bash
mediator stage diff <stageId>
```
In the UI dashboard, view added, removed, and modified lines with conflict status badges.

### Stage 6: Explicit Approved Apply
Under Review-only V1 policy, live workspace writes strictly require an explicit human approval token:
```bash
# Resolve approval
mediator approval resolve <approvalId> approve

# Apply changes to live workspace
mediator stage apply <stageId> <approvalId>
```

Before applying, Mediator performs:
1. **TOCTOU Workspace Verification:** Verifies no live files were edited since staging.
2. **Pre-Apply Atomic Backup:** Creates an instant snapshot in `.mediator/backups/<txId>`.
3. **HMAC Signature Check:** Cryptographically verifies the broker command.

---

## 5. System Health, Diagnostics & Logs

### 5.1 Run Health Doctor
```bash
mediator doctor
```

### 5.2 Export Sanitized Diagnostic Report
When troubleshooting or requesting support, export a sanitized diagnostic report without leaking sensitive tokens or file contents:
```bash
mediator doctor --export ./my-diagnostics.json
```

### 5.3 Inspect Real-Time Audit Ledger
```bash
mediator logs
```

---

## 6. Safety & Security Invariants

1. **Local Autopilot is strictly BLOCKED** fail-closed under S00 `NO-GO-AUTOEXEC`.
2. All live workspace modifications require manual review and explicit approval.
3. Untrusted task code executes exclusively within the dedicated `MediatorSandbox` WSL2 distribution with Linux network default-deny (`CLONE_NEWNET`).
4. Windows host shell execution (`cmd.exe`, `powershell.exe`) of untrusted task code is completely prohibited.
5. All operations run within the Current User scope (HKCU, `%LOCALAPPDATA%`), requiring zero administrative elevation.
