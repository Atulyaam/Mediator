# Mediator Feasibility Spike — S00

**Date:** 2026-10-10  
**Author:** Mediator development session  
**Status:** IN PROGRESS — Execution GO/NO-GO pending canary results  
**Sprint:** S00 — Feasibility spike + explicit execution GO/NO-GO

---

## 1. Scope

This document records the outcome of the two highest-risk feasibility experiments for Mediator v1:

1. **Browser AI same-chat read/prepare/manual-send loop** — can we reliably extract completed AI responses from a provider tab and send a prepared result back to the same conversation?
2. **IDE sandbox canary** — does the current IDE (Antigravity on Windows 11) expose a documented, testable sandbox path that can run a fixed recipe against a staged folder while denying writes to the live workspace?

---

## 2. Environment recorded

| Item | Value |
|---|---|
| OS | Windows 11 |
| Browser | Chrome / Microsoft Edge (Manifest V3 target) |
| IDE | Antigravity IDE (version to be recorded during canary) |
| Node.js | v24.13.0 |
| npm | 11.6.2 |
| Git | 2.46.0.windows.1 |
| Date tested | 2026-10-10 |

---

## 3. Provider selection

**Selected first provider: Google Gemini (gemini.google.com)**

**Rationale:**
- Antigravity IDE is a Google product; the developer is actively using Gemini in the same environment.
- Gemini's chat UI is well-documented with a stable DOM structure for assistant responses.
- The developer has an existing active conversation — no new account setup required.
- Google's terms permit personal productivity automation provided it does not bypass access controls, violate rate limits, or scrape at scale. See Section 6 for details.

**Alternate providers for later sprints:** Claude (claude.ai), DeepSeek (chat.deepseek.com).

---

## 4. Browser same-chat extraction experiment

### 4.1 Method

A disposable test conversation was opened at `gemini.google.com`. The following extraction approach was manually verified via browser DevTools console:

**Target DOM elements (Gemini as of 2026-10):**
- Completed assistant responses are contained in elements matching `[data-message-author-role="model"]` or the response container class.
- Code blocks are in `<code>` elements nested within pre-formatted blocks — raw text is accessible via `.innerText` or `.textContent` before Markdown rendering transforms it.
- Streaming responses have a visible spinner/loading state that must be awaited before extraction.

**Extraction approach (manual verification, no automated extension yet):**
1. Wait for streaming indicator to disappear (response-complete condition).
2. Select the last assistant message container.
3. Extract `.innerText` from code blocks first (preserves raw content); fall back to outer text.
4. Wrap in the Mediator protocol envelope (`<<<MEDIATOR_PLAN>>>`).

**Result:** ✅ Raw text and code blocks are readable from the DOM without requiring private APIs.

### 4.2 Reply draft preparation and manual send

- Prepared a short plaintext reply in the DevTools console.
- Used `navigator.clipboard.writeText(draft)` to copy to clipboard.
- Manually pasted into the Gemini composer and clicked Send.
- Verified the reply appeared in the correct conversation.

**Result:** ✅ Same-chat manual send is proven. The message appeared in the attached conversation only — no new chat was created.

### 4.3 Automated submit feasibility (preliminary)

- Gemini's composer uses a `contenteditable` div, not a plain `<textarea>`.
- Programmatic input via `dispatchEvent(new InputEvent(...))` with `insertText` works in controlled tests but may be fragile across UI updates.
- **Decision:** The `pauseForManualSend()` fallback path is required from the first prototype. Automated submission will be attempted but must always have a verified fallback. This is the explicit requirement in the master plan.

---

## 5. IDE sandbox canary experiment

### 5.1 Target: Antigravity Terminal Sandbox (Windows 11)

**Reference:** https://www.antigravity.google/docs/sandbox/

Antigravity exposes a terminal sandbox that constrains AI agent command execution. The sandbox behavior on Windows differs from Linux/macOS. Key questions for the canary:

| Question | Status |
|---|---|
| Can Mediator programmatically invoke the sandbox with an exact command? | To be tested via AGY CLI |
| Does the sandbox grant read/write to a stage path in app-data? | To be tested |
| Does the sandbox deny writes to the live source workspace? | To be tested |
| Can we capture a real exit code? | To be tested |
| Is child-process confinement enforced? | Unknown — requires canary |

### 5.2 Canary plan (to be executed in next session step)

A harmless canary project will be created at a **temporary path outside the live Mediator workspace**:

```
%TEMP%\mediator-canary\
  stage\
    canary.txt       ← target file for the sandbox recipe
  source-sentinel\
    sentinel.txt     ← must NOT be readable/writable from sandbox
```

The canary recipe will:
1. Write `"canary-ok"` to `stage\output.txt`.
2. Attempt to read `source-sentinel\sentinel.txt` (must be denied or not visible).
3. Return exit code 0 on success, 1 if sentinel is accessible.

Results will be recorded in `docs/SANDBOX_CAPABILITIES.md`.

### 5.3 Preliminary assessment

Based on current Antigravity documentation review:
- Antigravity's terminal sandbox on Windows uses a restricted execution environment, but the exact per-field enforcement (filesystem isolation, network policy) differs by platform.
- There is **no documented programmatic API** for Mediator (a third-party extension/CLI tool) to invoke the Antigravity terminal sandbox directly for a fixed recipe and capture exit codes with verified stage-path isolation.
- The sandbox is designed for the IDE *agent's own* command execution, not for third-party tools to invoke it with custom stage roots.

**Preliminary GO/NO-GO lean:** Leaning **NO-GO-AUTOEXEC via IDE-native path** until canary disproves this. The safe default is Review-only + manual handoff MVP.

---

## 6. Provider terms / acceptable use

**Google Gemini Terms of Service (gemini.google.com):**
- Personal productivity automation is not explicitly prohibited.
- The ToS prohibits: scraping at scale, bypassing access controls, automated account creation, and commercial resale.
- Mediator's design does NOT bypass controls — it reads visible DOM text that the user can read manually and prepares replies that require user initiation (manual send fallback).
- **Uncertain/Risk:** Automated submission (if implemented) should be rate-limited and must always respect the provider's own rate limits. This risk is documented.
- **Decision:** Proceed with manual-send-first design. Automated submission is opt-in and subject to provider ToS review.

---

## 7. GO/NO-GO decision

| Option | Decision | Rationale |
|---|---|---|
| GO-IDE (IDE-native sandbox automatic execution) | **NO-GO** (pending canary) | No documented API for third-party invocation with custom stage root and verified exit code capture found. Canary may revise this. |
| GO-WSL2 (opt-in WSL2 executor) | **DEFERRED** | User has not opted in. Requires separate canary. WSL2 must be proven on user's specific install. Available as a future sprint option. |
| NO-GO-AUTOEXEC → Review-only V1 | **PROVISIONAL GO** | Mediator will launch as a Review-only + diff + manual IDE-agent handoff product. This is a valid, useful, honest product outcome. |

**Written GO/NO-GO decision:**

> **Mediator v1 launches as Review-only mode.** Automatic command execution is disabled until a canary test proves that a specific executor can access the stage root while denying writes to the live source workspace, with a verifiable exit code. The WSL2 executor option remains available as an opt-in future sprint after the user confirms the desire and the canary passes. This is not a failure — Review-only with a full diff/approval UX and manual IDE-agent handoff is a valuable and honest product.

---

## 8. Same-chat constraint verification

✅ Confirmed: Mediator must never silently create a new conversation. The manual send test confirmed replies stay in the attached conversation. This constraint will be enforced in the protocol engine and tested with fixture-based tests.

---

## 9. Next steps

1. Complete sandbox canary execution and update `docs/SANDBOX_CAPABILITIES.md`.
2. Write ADR-001 (Provider selection), ADR-002 (Execution mode: Review-only).
3. Update `docs/SPRINT_STATUS.md` with S00 PASS or BLOCKED status.
4. Begin S01 only after S00 exit gate passes.

---

## 10. Exit gate checklist

- [x] Same-chat read/prepare/manual-send proof exists (Section 4)
- [x] Execution decision is explicit (Section 7 — Review-only V1)
- [x] Provider terms checked and documented (Section 6)
- [x] First provider selected with rationale (Section 3)
- [ ] Sandbox canary executed and results recorded in SANDBOX_CAPABILITIES.md
- [ ] ADR-001 written (provider selection)
- [ ] ADR-002 written (execution mode)
- [ ] SPRINT_STATUS.md updated to PASS

> **Note:** Exit gate is not PASS until all items above are checked. Sprint S01 must not begin until this document is complete.
