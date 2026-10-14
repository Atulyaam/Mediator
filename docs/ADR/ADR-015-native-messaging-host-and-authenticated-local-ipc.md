# ADR-015 — Native Messaging Host and Authenticated Local IPC

**Date:** 2026-10-11  
**Status:** ACCEPTED  
**Sprint:** S19  
**Deciders:** Mediator developer

## Context

Sprint S19 bridges the Manifest V3 browser extension (`apps/browser-extension`) to the running local Mediator core without exposing an unauthenticated network surface, local HTTP server, or general-purpose execution API.

Key architectural risks and requirements:
1. **No `.bat` or `.cmd` wrappers:** Windows Chromium Native Messaging executes host binaries directly. Using batch script wrappers exposes command injection risks, process lifecycle ambiguity, and unhandled stdio escaping bugs.
2. **Strict Origin Validation:** The native host must accept connections only from the explicitly configured 32-character Chrome extension ID (`chrome-extension://<id>/`). Wildcards (`*`) must be rejected.
3. **Dedicated Stdio Protocol Framing:** Native messaging uses 4-byte little-endian length-prefixed framing over stdin and stdout. Stdout is strictly reserved for valid frames; logging or diagnostic messages on stdout corrupt the protocol and crash Chrome's host bridge. All diagnostics must be directed to sanitized stderr.
4. **Local-Only Windows Named Pipe IPC:** Core and native host communicate via Windows Named Pipes (`\\.\pipe\mediator-ipc-...`). Remote clients and unauthenticated local processes must be rejected.
5. **Cryptographic Pairing Authentication:** Core generates a 32-byte CSPRNG pairing challenge upon startup. The native host must authenticate with this token using constant-time comparison (`timingSafeEqual`) to prevent timing side-channels. Stale or expired tokens must be rejected.
6. **Bounded Chunk Transfers:** Transfers are sliced into 256 KiB chunks with sequence index, total count, chunk hashes, transfer ID, and an 8 MiB logical ceiling. Replays and oversized frames must be rejected.
7. **Offline Core Honesty:** When Mediator core is not running, the native host reports `CORE_NOT_RUNNING` honestly without hanging or crashing.

## Decision

1. **Packaged Standalone Host Binary (`@mediator/native-host`):**
   - Built as a real Windows executable `mediator-native-host.exe` via Node 24 Single Executable Application (SEA) blob preparation and `postject` injection into a local `node.exe` host.
   - Script `scripts/buildExecutable.mjs` verifies SHA-256 integrity and produces the native binary without batch files.
   - Host manifest `com.mediator.native_host.json` generated pointing directly to the `.exe`.
   - Registration script configures HKCU registry key `Software\Google\Chrome\NativeMessagingHosts\com.mediator.native_host` with zero HKLM or administrator privilege requirements.

2. **Framing & Stdio Channel Isolation (`framing.ts`):**
   - Implements `NativeMessageReader` and `NativeMessageWriter` for 4-byte LE length-prefixed JSON frames.
   - Enforces 512 KiB physical frame ceiling (`MAX_NATIVE_FRAME_BYTES`).
   - Stdout is reserved exclusively for framed JSON packets; stderr is sanitized with token masking for diagnostic logging.

3. **Origin Validation (`originValidator.ts`):**
   - Validates extension ID against `^[a-p]{32}$`.
   - Normalizes and verifies `chrome-extension://<id>/` origins. Rejects wildcards, HTTP/HTTPS origins, and malformed strings.

4. **Authenticated Named Pipe IPC (`@mediator/ipc-core`):**
   - Server (`ipcServer.ts`) listens on `\\.\pipe\mediator-ipc-<id>`.
   - Handshake requires `IPC_PROTOCOL_VERSION` ('1.3'), extension ID match, and valid pairing token.
   - Pairing Manager (`pairingManager.ts`) uses 32-byte CSPRNG tokens, constant-time `timingSafeEqual` checks, and TTL expiration pruning.
   - Allows only an explicit operation allowlist (`mediator.ping`, `mediator.get_status`, `mediator.transfer_chunk`, `mediator.submit_envelope`, `mediator.get_pending_round`). Prohibits execution and policy bypass requests.
   - Handles offline core by reporting `CORE_NOT_RUNNING` to client before disconnecting.

5. **Browser Extension Integration (`nativeBridgeClient.ts`):**
   - Added `"nativeMessaging"` permission to `apps/browser-extension/manifest.json`.
   - `NativeBridgeClient` manages connection state machine: `disconnected`, `pairing-required`, `connected`, `core-unavailable`, `blocked`.
   - Includes test port seam for unit testing without headless browser requirements.

## Consequences

### Positive
- Fully native Windows IPC without open HTTP ports, CORS attack vectors, or external network exposure.
- Real `.exe` binary satisfies Chromium security guidelines without shell wrapper vulnerabilities.
- Cryptographic pairing challenge prevents unauthorized local processes from communicating with Mediator core.
- Chunked transfers enforce strict 256 KiB slicing and 8 MiB ceiling, preventing unbounded memory consumption.

### Neutral / Trade-offs
- Node 24 SEA binary packaging requires a build preparation step (`npm run build:exe`). In non-packaged development/testing, the TypeScript controllers execute directly via port seam and named pipe test doubles.
