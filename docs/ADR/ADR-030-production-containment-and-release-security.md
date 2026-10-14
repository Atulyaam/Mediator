# ADR-030: Production Process Containment, Automated Offline Dependency Resolution, and Release Security Gates

**Status:** Accepted  
**Date:** October 2026  
**Deciders:** Mediator Engineering & Architecture Core  
**Sprint:** S49  

---

## 1. Context

In earlier sprints (S45–S48), Mediator established logical boundaries between task orchestration and host modification (`ContainedOrchestrator` vs `TrustedHostBroker`), verified Linux network namespace isolation in `MediatorSandbox`, and defined offline bundle schemas.

However, several release-critical hardening gaps remained:
1. **Host-Side Containment Gap:** While TypeScript interfaces were distinct, both the orchestrator and broker previously ran in the same Node.js operating system process in prototypes. Memory inspection or inadvertent variable leakage was technically possible.
2. **Offline Dependency Gap:** While offline toolchain execution was verified in WSL2, supported projects required an automated, trusted 3-stage resolver (trusted prep -> bundle verification -> sandbox staging) to avoid either network access during task execution or manual package juggling.
3. **Native Messaging Security & Audit Readiness:** The native messaging bridge connecting browser AI providers to local core required evidence-based fuzzing/adversarial verification and a structured external audit package.
4. **Governance Invariant:** S00 `NO-GO-AUTOEXEC` must remain strictly enforced, with Local Autopilot `BLOCKED`.

---

## 2. Decisions

### 2.1 OS-Level Process Separation via `ProcessIsolatedBrokerTransport`
- The `TrustedHostBroker` is executed in a dedicated, isolated Windows child process (`brokerProcessHost.js`) with a distinct operating system PID and private address space.
- The child process environment block is scrubbed using `cleanseEnvironment()`: developer host secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`) are eliminated.
- Communication is strictly framed over standard input/output anonymous pipes using newline-delimited JSON envelopes.
- All requests require HMAC-SHA256 signatures, single-use nonces, and 30-second timestamp freshness.
- Terminating the broker process fails closed with `ErrorCode.BROKER_UNAVAILABLE`.
- **Honest Boundary Documentation:** We explicitly document that two processes running as the same standard Windows user account share identical security tokens (Medium Integrity Level). Process separation provides memory isolation, distinct PIDs, and clean environment blocks, but kernel-level DACL sandboxing requires AppContainer or separate service accounts.

### 2.2 Three-Stage Automated Offline Dependency Resolver
- We implement `OfflineDependencyResolver` in `@mediator/recipe-registry` with three distinct operational stages:
  1. **Trusted Host Preparation:** Manifest/lockfile inspection, SHA-256 lockfile hashing, trusted package download outside the sandbox namespace, with strict `--ignore-scripts` enforcement and zero lifecycle script execution.
  2. **Bundle Verification & Sealing:** Verifies zero path traversal (`..`), zero symlink escapes, zero ADS/DOS device names, and zero embedded secrets. Staged atomically in `.incomplete_<bundleId>` before promotion to `.mediator/bundles/<bundleId>`.
  3. **Offline Sandbox Execution:** Copies verified dependencies into isolated task staging. The master bundle remains immutable. The task executes inside `MediatorSandbox` under mandatory Linux network namespace isolation (`unshare --user --net`).

### 2.3 Native Messaging Host Security & External Audit Handling
- Comprehensive internal adversarial test suite (`nativeHostSecurityAudit.test.ts`) verifies:
  - Dropping frames > 512 KiB before buffering memory.
  - Rejecting frames with length < 2 bytes.
  - Strict 32-character extension ID allowlist validation (wildcards prohibited).
  - Immediate rejection of shell execution attempts (`cmd.exe`, `powershell.exe`) and direct broker operations.
  - Redaction of inline tokens/secrets in stderr logs.
- In accordance with Gate 4, we do not fabricate an external audit report or reviewer identity. The external audit status is recorded honestly as `PENDING_EXTERNAL_REVIEW`.

### 2.4 Governance & Release Gate Separation
- Gate verdicts are kept strictly independent:
  - **S49 Status:** `CONDITIONAL` (All internal controls verified; external audit pending).
  - **Autopilot State:** `BLOCKED` under S00 `NO-GO-AUTOEXEC`.
  - **Release Authorization:** Controlled Personal Beta is authorized for review-only use; broader public distribution is blocked until independent external audit sign-off.

---

## 3. Consequences

### Positive
- Live workspace files are strictly isolated from the untrusted orchestration layer.
- Task execution environments remain 100% offline while supported projects can obtain dependencies through controlled preparation.
- Master package bundles are protected by SHA-256 Merkle root hashes and cannot be corrupted by task code.
- Native Messaging Host is hardened against malicious web inputs, memory floods, and origin spoofing.
- The project maintains absolute audit honesty without fabricated claims.

### Negative / Trade-Offs
- Spawning a separate child process for the host broker incurs minor stdio IPC serialization overhead (measured < 5ms per request).
- Standard user execution on Windows 11 Home cannot provide kernel-enforced DACL multi-user isolation without admin privilege elevation.
- Dependencies requiring live compilation with dynamic header downloads (`node-gyp`) remain unsupported.

---

## 4. References
- `docs/HOST_PROCESS_CONTAINMENT_IMPLEMENTATION.md`
- `docs/AUTOMATED_OFFLINE_DEPENDENCY_RESOLVER.md`
- `docs/NATIVE_MESSAGING_SECURITY_AUDIT.md`
- `docs/RELEASE_READINESS_MATRIX.md`
- ADR-027, ADR-028, ADR-029
