# ADR-021 — Security Hardening, Windows 11 Installation & Personal-Use Release

**Date:** 2026-10-11  
**Status:** ACCEPTED  
**Sprint:** S28  
**Deciders:** Mediator Architect  

## Context

Mediator is a Windows 11-native, local-first bridge connecting browser AI conversations with a local workspace via shadow staging, policy enforcement, cryptographic approvals, and assisted workflow loops. Following the completion of the multi-provider integration (S27), Sprint S28 brings the system to its final planned personal-use release milestone.

Sprint S28 addresses three foundational operational requirements:
1. Hardened end-to-end security defenses against adversarial AI behavior, path traversal, secret exfiltration, command injection, and SSRF.
2. Idempotent Windows 11 installation and uninstallation without requiring Administrator privileges.
3. User privacy controls and data retention lifecycle management while maintaining the tamper-evident integrity of the audit ledger.

## Decisions

### 1. Current-User Scope Windows Installation (`HKCU`)
- **Zero Elevation Required:** Installation operates strictly within the Current User (`HKEY_CURRENT_USER`) registry hive and `%LOCALAPPDATA%\Mediator`. Administrative elevation (`runas`, UAC) is forbidden.
- **Chrome & Edge Registry Registration:**
  - `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mediator.native_host`
  - `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.mediator.native_host`
- **Prohibition of Batch Wrappers:** Windows `.bat` and `.cmd` script files are prohibited as native messaging host executables due to cmd.exe argument parsing vulnerabilities and shell escape risks. Only packaged standalone binary executables (`mediator-native-host.exe`, built via Node Single Executable Application blob injection) are permitted.
- **Strict Extension ID Validation:** Extension IDs must match `^[a-p]{32}$` (standard Chromium Web Store / developer unpacked 32-character ID). Wildcards and arbitrary strings are rejected.
- **Atomic Operations & Rollback:** PowerShell installation script (`scripts/install-windows.ps1`) verifies binary existence, creates manifests, writes registry keys, and performs automated rollback of created files and registry entries upon any failure.

### 2. Clean Uninstallation & Workspace Isolation
- **Deregistration:** `scripts/uninstall-windows.ps1` idempotently removes registry keys for Chrome and Edge native messaging hosts.
- **Workspace Protection:** Uninstallation never touches, modifies, or deletes the user's live source code workspaces.
- **Optional Full Purge:** The `-RemoveFiles` flag removes `%LOCALAPPDATA%\Mediator\native-host`, and `-PurgeUserData` triggers the `DataRetentionManager` to clear local databases while leaving source repositories intact.

### 3. User Data Retention & Privacy Controls (`DataRetentionManager`)
- **Zero Cloud / Zero Telemetry:** Mediator stores all state locally in SQLite (`%LOCALAPPDATA%\Mediator\mediator.db`). Zero telemetry or background phone-home mechanisms exist.
- **Topological Cascading Purge:** Purging task or session data cascades across relational tables in strict topological order (`staged_files`, `stages`, `apply_transactions`, `review_requests`, `handoffs`, `evidence`, `context_summaries`, `approvals`, `actions`, `rounds`, `sessions`, `tasks`).
- **Audit Ledger Immutability:** SQLite triggers prevent `UPDATE` or `DELETE` on `audit_events`. Data purges append a cryptographically hashed, redaction-safe event (`user_data_purged` or `all_user_data_cleared`) to the hash chain, proving data was cleared without exposing raw cleared secrets.
- **Configurable Retention:** Supports TTL-based pruning for tasks and sessions older than a specified duration (e.g., 30 days).

### 4. Adversarial Security Defenses
- **Workspace Boundary & NTFS Protection:** Strict rejection of relative traversal (`..`), Alternate Data Streams (`:stream`), DOS device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`), UNC network paths (`\\server\share`), and non-existent ancestors.
- **Secret Scanning & Redaction:** Pre-read exclusion and overlap-safe token redaction across all AI-bound context packets, diff previews, and generated test environments (`.env.test`). Zero raw secret tokens in logs or envelopes.
- **Recipe Definition Integrity:** Authoritative registry of 7 pinned recipe IDs with deterministic SHA-256 canonical hashing. Strict rejection of shell metacharacters (`&&`, `;`, `|`, `$()`, `` ` ``) and unauthorized arguments.
- **Approval Cryptographic Binding:** Approval tokens bound to SHA-256 payload hashes, single-use consumption, and 120-second TTL expiry. Agent-reported claims are strictly rejected as verification evidence.
- **Native Host & Local IPC Defense:** Origin verification, 512 KiB frame caps, CSPRNG pairing tokens (32 bytes / 256 bits), and constant-time `timingSafeEqual` authentication.
- **Bounded Web Research Defense:** HTTPS-only, hostname allowlist, RFC1918/loopback/cloud metadata SSRF blocking, inert framing, and zero command execution.

### 5. Personal-Use Release Model: Review-Only V1
- **Preservation of S00 Decision:** S00 canonical decision (`NO-GO-AUTOEXEC`) remains active and binding.
- **S26 Autopilot Status:** Retained as `DEFERRED (Outcome B)` fail-closed. Autopilot capability gates reject auto-execution because process isolation, network deny, and real exit code capture remain unverified without a dedicated sandbox container.
- **Assisted Workflow & Review-Only:** The system operates in Review-Only mode with assisted same-chat workflow loops: AI proposes patches → staged in shadow copy → human reviews diff in IDE → human approves → transactional apply-back. Recipes generate copyable instructions for manual terminal execution.

## Consequences

- Mediator provides a completely safe, local-first pair-programming bridge on Windows 11 with zero administrative footprint.
- Developers can install, update, and uninstall the native bridge with standard user privileges.
- User privacy and workspace source integrity are guaranteed by construction through shadow staging and fail-closed security gates.
- Personal-use release baseline is established with 100% test pass rate across all 36 test suites (800 tests).
