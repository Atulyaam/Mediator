# KNOWN LIMITATIONS & OPERATIONAL BOUNDARIES

**Release Candidate:** Mediator `v0.1.0-beta.1`  
**Evaluation Mode:** Review-only V1  
**Security Policy:** S00 `NO-GO-AUTOEXEC` — **BLOCKED**  

---

## 1. Operating System & Privilege Model Limitations

### 1.1 Standard User Process Separation vs Kernel Multi-User Isolation
- **Limitation:** On Windows 11 Home standard user accounts, both `ContainedOrchestrator` and `TrustedHostBroker` run under the same user security token (Medium Integrity Level).
- **Security Boundary Reality:** Operating system process isolation provides separate address spaces, distinct PIDs, and clean environment blocks (stripping host secrets), but does not provide kernel-enforced DACL multi-user sandboxing. A malicious native binary running as the same user could theoretically attach to process memory with Windows debugging APIs.
- **Mitigation:** Untrusted task execution is confined to `MediatorSandbox` (WSL2), and live workspace modifications strictly require cryptographic HMAC-SHA256 signatures, single-use approvals, and TOCTOU base hash verification.

---

## 2. Dependency Management & Toolchain Limitations

### 2.1 Mandatory Network Isolation Blocks Dynamic Downloads
- **Limitation:** Task execution inside `MediatorSandbox` operates under strict Linux network namespace isolation (`unshare --user --net`). Commands such as `npm install <pkg>` or `pip install <pkg>` fail with network unreachable errors (`ENETUNREACH`).
- **Required Workflow:** Dependencies must be resolved and sealed via the trusted 3-stage resolver (`OfflineDependencyResolver`) before task execution begins.

### 2.2 Native C/C++ Extensions Requiring Live Compiles
- **Limitation:** Packages that invoke `node-gyp` or require downloading C++ development headers at install time cannot be compiled offline inside the sandbox.
- **Status:** Unsupported for automated resolution; must be pre-built in wheel archives or pre-compiled into vendor directories.

### 2.3 Unpinned Manifests
- **Limitation:** Node.js projects lacking `package-lock.json` or Python projects lacking pinned `requirements.txt` (`==`) fail closed with `ErrorCode.OFFLINE_DEPENDENCY_MISSING`.

---

## 3. Autonomous Execution & Autopilot Policy

### 3.1 Local Autopilot Strictly Blocked
- **Limitation:** Autonomous loops (where an AI model self-approves, runs tests, and applies live patches repeatedly without human review) are strictly prohibited and fail-closed under S00 `NO-GO-AUTOEXEC`.
- **Enforcement:** Every live workspace modification requires manual diff review and explicit human approval.

---

## 4. Browser Integration & Native Messaging

### 4.1 Independent External Security Audit Pending
- **Limitation:** While internal adversarial test suites (fuzzing, frame limits, origin spoofing) passed 100%, the third-party independent security audit of `mediator-native-host.exe` is recorded as `PENDING_EXTERNAL_REVIEW`.
- **Status:** Release is authorized conditionally for Controlled Personal Beta; broader public release remains blocked.

### 4.2 Single Active Extension Session
- **Limitation:** The native messaging host connects to one active browser extension instance at a time over its authenticated local named pipe. Multiple simultaneous browser tabs running competing task intakes are queued or rejected.

### 4.3 Anthropic Claude Manual Handoff Mode
- **Limitation:** Claude operates strictly in manual clipboard/artifact handoff mode (ADR-013 & ADR-022) to prevent unauthorized web scraping and maintain privacy. Direct automated DOM dispatch is intentionally not supported for Claude.

### 4.4 Provider Web UI Selector Drift
- **Limitation:** Web AI chat providers (OpenAI ChatGPT, Google Gemini, DeepSeek) deploy unannounced UI updates that can alter button `aria-label`s, composer class names, or login wall layouts. While the CDP bridge implements resilient selector fallbacks, significant DOM overhauls may require adapter selector updates.

### 4.5 Loopback Remote Debugging Listener Scope
- **Limitation:** When Chrome or Edge is launched with `--remote-debugging-port=9222`, the listener binds strictly to IPv4 loopback (`127.0.0.1:9222`). While this eliminates WAN/LAN network ingress, any unprivileged local process running under the same Windows user account possesses ambient authority to connect to loopback ports.
- **Mitigation:** The debugging port is limited to testing and IDE subagent operations; test-only browsers are terminated after use, and live workspace modifications remain gated behind explicit human approval and single-use tokens.

---

## 5. Host Scripting, Storage & Installer Limitations

### 5.1 Windows PowerShell 5.1 Character Encoding Constraints
- **Limitation:** Built-in Windows PowerShell 5.1 (`powershell.exe`) defaults to parsing `.ps1` scripts without a UTF-8 BOM using legacy Windows-1252 ANSI encoding. Multi-byte Unicode characters (such as typographic em-dashes `—`, byte sequence `0xE2 0x80 0x94`) are misparsed as `â€”` where byte `0x94` is interpreted as a right double quotation mark, causing script syntax errors during installation.
- **Enforcement & Fix:** All installer and maintenance PowerShell scripts (`scripts/install-windows.ps1`, `scripts/uninstall-windows.ps1`) must strictly maintain pure 7-bit ASCII strings (`--`) or include a UTF-8 BOM.

### 5.2 Windows File-Locking on Atomic Staging Overwrites
- **Limitation:** On Windows NTFS file systems, brief file locks held by antivirus scanners or Windows Search Indexer can cause atomic file renames (`fs.renameSync`) to throw `EPERM: operation not permitted` when overwriting existing staged files.
- **Resolution:** `StageStorage` incorporates a safe unlink and `copyFileSync` fallback with temporary file cleanup. For optimal performance, developers may exclude `%LOCALAPPDATA%\Temp\mediator-*` from aggressive live indexing.

### 5.3 Network-Isolated Environment Audit Tooling Constraints
- **Limitation:** In air-gapped or network-isolated offline development environments, online dependency vulnerability auditing tools (e.g. `npm audit`) that require continuous live connections to public registries fail or hang.
- **Resolution:** Security verification relies on offline machine-readable SBOMs (CycloneDX and SPDX) and cryptographic subresource integrity hashes in `package-lock.json`.
