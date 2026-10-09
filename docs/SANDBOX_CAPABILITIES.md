# Sandbox Capabilities — S00 Canary Results

**Date:** 2026-10-10  
**Sprint:** S00  
**Status:** PARTIAL — canary script prepared, results pending execution

---

## 1. IDE: Antigravity on Windows 11

### 1.1 Documentation review

| Capability | Documented? | Source |
|---|---|---|
| Terminal sandbox exists | Yes | https://www.antigravity.google/docs/sandbox/ |
| Windows platform sandbox behavior | Platform-specific notes present | Antigravity docs |
| Third-party programmatic invocation API | **Not found** | — |
| Custom stage-root mounting | **Not documented** | — |
| Exit code capture from third-party tools | **Not documented** | — |
| Network policy enforcement | Agent-context only | Antigravity docs |

### 1.2 Canary test design

**Purpose:** Determine whether Mediator (as a CLI/extension process) can invoke the Antigravity terminal sandbox with:
- A fixed recipe (e.g., `npx tsc --noEmit`)
- A custom working directory pointing to a stage path in app-data
- Denial of writes to the live source workspace
- Capture of the real exit code

**Canary structure:**
```
%TEMP%\mediator-canary\
  stage\
    tsconfig.json        ← minimal valid config
    src\canary.ts        ← valid TS file
  source-sentinel\
    sentinel.txt         ← must NOT be accessible from the executor
```

**Canary recipe:** `tsc --noEmit` targeting the stage directory only.

**Expected results if GO-IDE is valid:**
- Exit code 0 captured by Mediator
- `source-sentinel\sentinel.txt` is inaccessible from within the execution context
- Stage files are readable and writable by the recipe

### 1.3 Canary execution results

```
Status: PENDING — canary to be run in next session step
```

> **Note:** Until canary results are recorded here with real exit codes and actual verification, the sandbox capability for IDE-native execution is classified as UNKNOWN. UNKNOWN = false for all required guarantees.

---

## 2. Capability matrix (current state)

Every field below uses the enforcement schema from the master plan: `value`, `enforcedBy: mediator | ide | unknown`, `evidenceRef`.

| Capability | Value | Enforced By | Evidence |
|---|---|---|---|
| Stage root readable by executor | unknown | unknown | canary-pending |
| Stage root writable by executor | unknown | unknown | canary-pending |
| Live workspace NOT writable | unknown | unknown | canary-pending |
| Fixed executable/args enforced | false | unknown | no-api-found |
| Child-process confinement | unknown | unknown | canary-pending |
| Network default-deny | unknown | unknown | canary-pending |
| Timeout enforcement | false | unknown | no-api-found |
| Output byte cap | false | mediator | policy-1 (planned) |
| Real exit code captured | unknown | unknown | canary-pending |
| Cancellation supported | unknown | unknown | canary-pending |

**Summary:** All fields are currently `unknown` pending canary execution. Per master plan, unknown = false. Automatic execution is therefore **disabled**.

---

## 3. WSL2 executor assessment

| Prerequisite | Status |
|---|---|
| User has opted in to WSL2 executor | No — not yet requested |
| WSL2 installed and distro available | Unknown |
| Dedicated distro (not default) | Required |
| Non-root user in distro | Required |
| Windows automount disabled | Required |
| Network isolation proven | Required |
| Canary pass | Not run |

**Status:** DEFERRED. WSL2 executor is not built in S00. It remains a future option after user opt-in and canary pass.

---

## 4. GO/NO-GO per executor

| Executor path | Decision | Reason |
|---|---|---|
| IDE-native (Antigravity terminal sandbox) | **NO-GO** | No documented programmatic invocation API found for third-party tools with custom stage root. Canary cannot be run via this path without a supported API. |
| WSL2 | **DEFERRED** | Not opted in. |
| Review-only / manual handoff | **GO** | Safe, honest, useful. Mediator provides full diff + approval + handoff UX without automatic execution. |

---

## 5. Effective execution mode for V1

**REVIEW-ONLY MODE ACTIVE**

Mediator will:
- ✅ Extract AI proposals from the same chat
- ✅ Validate protocol envelopes
- ✅ Apply proposals to the shadow staging store
- ✅ Show file-by-file diffs and protected-path warnings
- ✅ Allow user to manually approve and apply changes
- ✅ Prepare IDE-agent handoff prompts (pull-based, manual)
- ✅ Send sanitized result summaries back to the same chat
- ❌ NOT automatically run test/lint/build commands
- ❌ NOT execute any recipe without a proven executor

This is recorded as the official Sprint 0 GO/NO-GO outcome.
