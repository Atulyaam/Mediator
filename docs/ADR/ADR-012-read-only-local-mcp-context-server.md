# ADR-012 — Read-Only Local MCP Context Server

**Date:** 2026-10-11  
**Status:** ACCEPTED  
**Sprint:** S16  
**Deciders:** Mediator developer

## Context

Sprint S16 requires exposing safe, structured Mediator context to supported IDE agents via the Model Context Protocol (MCP) while retaining Mediator's policy and security boundaries.

Key security and architectural requirements:
1. Strictly read-only local MCP context server communicating over standard I/O (`stdio`).
2. Absolute prohibition against mutations: zero command execution, zero live file mutations, zero stage alterations, zero approval resolutions, and zero policy modifications.
3. Strict task/session scope authorization: clients cannot request data belonging to other tasks or sessions.
4. Resources and read tools must reuse S11 context engine and S12 stage store without building duplicate context assemblers.
5. All outputs must enforce S06 secret exclusions, pattern scanning, redaction, and bounded byte limits.
6. Public network listeners, unauthenticated HTTP ports, or shell command execution interfaces are forbidden.
7. Caller-controlled strings (e.g. `"role": "trusted"`, `"approved": true`) must never elevate privilege.

## Decision

1. **Local Stdio Transport & Clean Protocol Architecture:**
   - Implemented `@mediator/mcp-server` over local `stdio` using structured JSON-RPC 2.0 framing.
   - Decoupled transport framing (`McpStdioTransport`) from protocol dispatching (`McpServer`), security filtering (`McpSecurityFilter`), and domain handlers (`McpResourceHandlers`, `McpToolHandlers`).
   - Zero open network sockets or external ports.

2. **Read-Only Resource & Tool Surface:**
   - Exposes 5 standard read-only resources:
     - `mediator://task/current`: Task goal, state, criteria, round numbers, and blockers.
     - `mediator://project/rules`: Bounded project rules from `.mediator/rules.md`.
     - `mediator://project/context`: Compact context packet assembled by S11 context engine.
     - `mediator://stage/changes`: Bounded list of staged changes for active task.
     - `mediator://verification/status`: Evidence items and verification counts.
   - Exposes 5 narrow read-only tools:
     - `mediator.get_capabilities`: Current IDE adapter capabilities and product info.
     - `mediator.get_task_brief`: Authoritative brief for the active task.
     - `mediator.get_relevant_context`: Byte-budgeted relevant context from S11 engine.
     - `mediator.get_staged_changes`: Staged file proposals and conflict status from S12 stage store.
     - `mediator.get_diff`: Isolated diff preview for proposed changes.

3. **Strict Mutation Prohibition & Fail-Closed Gate:**
   - `McpSecurityFilter.checkOperationAllowed` unconditionally denies any attempt to invoke mutation tools, execute commands, apply diffs, resolve approvals, modify policy, or manipulate live workspace files with `ErrorCode.MCP_MUTATION_PROHIBITED`.
   - Caller claims of elevated roles (`role: "trusted"`, `approved: true`) are ignored.

4. **Rigorous Task Scope & Workspace Validation:**
   - All tool and resource invocations require `taskId` and `sessionId` validating active session state in `TaskRepository`.
   - Invalid, stale, or mismatched scopes fail closed with `UNAUTHORIZED_TASK_SCOPE`.
   - Workspace paths must be contained within canonical root (`validateContainedPath`) and free of mandatory exclusions (`checkPathExclusion`).

5. **Sanitization, Redaction & Output Bounding:**
   - All outputs pass through `McpSecurityFilter.sanitizeAndBoundOutput` ensuring responses do not exceed `MAX_MCP_RESPONSE_BYTES` (64 KB).
   - Content is scanned by S06 pattern scanner; credentials and keys are automatically redacted.

## Consequences

- IDE agents can pull safe, compact, high-fidelity task and project context without human copy-pasting.
- Mediator remains the authoritative policy boundary: MCP clients can read established state but cannot alter project files, bypass approvals, or execute shell commands.
- Transparent audit logging records all MCP tool/resource requests with correlation IDs and redaction.
