# ADR-011 — IDE Workspace Adapter & Incremental Project Map

**Date:** 2026-10-11  
**Status:** ACCEPTED  
**Sprint:** S15  
**Deciders:** Mediator developer

## Context

Sprint S15 requires typed adapters for supported IDE capabilities (VS Code and Antigravity) and an incremental project map pipeline.

Key security and architectural requirements:
1. Typed capability contracts separating what the IDE can actually provide from what the core wants to know.
2. Distinct compatibility matrices for VS Code and Antigravity—no assumption that shared VS Code ancestry implies identical capability availability.
3. Unsupported or unverified capabilities must return truthful typed states (`supported`, `unavailable`, `permission_denied`, `not_yet_verified`).
4. Editor selection context must be strictly opt-in; no implicit transmission of sensitive open editor text.
5. All file paths and diagnostics must be validated through S05 workspace containment and S06 secret exclusions.
6. Incremental project map must update on file events without rescanning unchanged repository content.
7. Absolute zero shell command execution and zero live file mutations.

## Decision

1. **Typed Authoritative Capability Contract:**
   - Extended `@mediator/shared-contracts` with authoritative `IdeCapabilityMatrix`, `IdeCapabilityReport`, and product metadata interfaces.
   - Reused canonical `CapabilityStatus` (`supported`, `unavailable`, `permission_denied`, `not_yet_verified`, `unknown`, `disabled`).

2. **Dedicated Modular Adapters:**
   - Implemented `@mediator/ide-adapter-vscode` (`VsCodeWorkspaceAdapter`) leveraging VS Code extension APIs (`vscode.git`, `languages.getDiagnostics`, `commands.executeCommand`, `workspace.createFileSystemWatcher`).
   - Implemented `@mediator/ide-adapter-antigravity` (`AntigravityWorkspaceAdapter`) recognizing Antigravity runtime specifics while honestly reporting unverified capabilities.
   - Untested or mocked IDE features are marked `not_yet_verified` rather than claiming production readiness.

3. **Opt-in Editor & Selection Context:**
   - Editor selection and active document collection requires explicit user opt-in (`allowEditorContext: true`).
   - Selected text requires secondary consent (`allowSelectedText: true`).
   - Content is bound by size limits and scanned for secrets (`scanContent`); secrets are redacted (`redactContent`) before entering context packets.

4. **Incremental Project Map Management:**
   - Implemented `IncrementalProjectMapManager` in `@mediator/context-engine` wrapping bounded file updates (`updateProjectMapIncremental`).
   - Handles file creation, modification, deletion, and rename events with serialization queue to eliminate race conditions.
   - Staging directories and AppData paths are explicitly excluded (`isStagingOrAppDataPath`).
   - File system watcher errors mark map freshness as `stale` with structured reasons.

5. **Strict Non-Execution Policy:**
   - Test discovery discovers candidate test files and framework commands via metadata inspection only; zero commands or tests are executed.
   - Git status uses public IDE APIs without invoking host `git` or shell binaries.

## Consequences

- Full fidelity between IDE runtime reality and Mediator capability queries.
- Zero credential leakage from editor buffers or hidden secret files.
- High-efficiency incremental context updates without excessive disk I/O.
- Safe, non-mutating integration with developer environments.
