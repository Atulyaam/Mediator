/**
 * @mediator/native-host — Internal Adversarial Security Audit Test Suite (Sprint S49.3)
 *
 * Requirements (S49.3):
 * - Adversarial testing of Chrome/Edge Native Messaging Host protocol layer.
 * - Oversized frames (> 512 KiB / 1 MiB limits).
 * - Truncated, malformed length prefixes and non-JSON payloads.
 * - Deeply nested objects and invalid Unicode / null byte injections.
 * - Spoofed extension origin / unauthorized extension identity rejection.
 * - Prohibited host execution attempts (`cmd.exe`, `shell.exec`, arbitrary commands).
 * - Privilege escalation attempts to directly invoke broker operations from browser message.
 * - Sensitive credential leakage defense in stderr/stdout logs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { ErrorCode } from '@mediator/shared-contracts';
import {
  NativeMessageReader,
  NativeMessageWriter,
  MAX_NATIVE_FRAME_BYTES,
  CHROMIUM_HARD_FRAME_LIMIT,
  NativeHostController,
  type NativeHostConfig,
} from './index.js';

describe('Sprint S49.3 — Chromium Native Messaging Host Security Audit', () => {
  const ALLOWED_EXTENSION_ID = 'abcdefghijklmnopponmlkjihgfedcba';
  const FORGED_EXTENSION_ID = 'maliciousattackerbadextension123';

  let reader: NativeMessageReader;
  let stdoutStream: PassThrough;
  let writer: NativeMessageWriter;
  let controller: NativeHostController;
  let receivedResponses: Array<Record<string, unknown>>;
  let receivedErrors: unknown[];

  const testConfig: NativeHostConfig = {
    allowedExtensionIds: [ALLOWED_EXTENSION_ID],
    pipePath: '\\\\.\\pipe\\mediator-ipc-s49-test',
    defaultPairingToken: 's49-audit-pairing-token-valid-12345',
  };

  beforeEach(() => {
    reader = new NativeMessageReader();
    stdoutStream = new PassThrough();
    writer = new NativeMessageWriter(stdoutStream);
    receivedResponses = [];
    receivedErrors = [];

    // Capture encoded stdout responses from writer
    stdoutStream.on('data', (chunk: Buffer) => {
      let offset = 0;
      while (offset + 4 <= chunk.length) {
        const len = chunk.readUInt32LE(offset);
        if (offset + 4 + len <= chunk.length) {
          const payload = chunk.subarray(offset + 4, offset + 4 + len).toString('utf8');
          try {
            receivedResponses.push(JSON.parse(payload));
          } catch {
            // Ignored
          }
          offset += 4 + len;
        } else {
          break;
        }
      }
    });

    controller = new NativeHostController(testConfig, reader, writer);
    controller.initializeOrigin(`chrome-extension://${ALLOWED_EXTENSION_ID}/`);
  });

  describe('A. Framing & Buffer Boundary Adversarial Tests', () => {
    it('1. rejects oversized frame (> 512 KiB) before buffering memory', () => {
      const errReader = new NativeMessageReader();
      const caughtErrors: unknown[] = [];
      errReader.setErrorListener((err) => caughtErrors.push(err));

      const header = Buffer.alloc(4);
      header.writeUInt32LE(MAX_NATIVE_FRAME_BYTES + 1, 0); // 524,289 bytes
      errReader.pushChunk(header);

      expect(caughtErrors).toHaveLength(1);
      expect((caughtErrors[0] as { code: string }).code).toBe(ErrorCode.NATIVE_FRAME_OVERSIZED);
    });

    it('2. rejects hard Chromium limit violation (> 1 MiB) immediately', () => {
      const errReader = new NativeMessageReader();
      const caughtErrors: unknown[] = [];
      errReader.setErrorListener((err) => caughtErrors.push(err));

      const header = Buffer.alloc(4);
      header.writeUInt32LE(CHROMIUM_HARD_FRAME_LIMIT + 1024, 0); // > 1 MiB
      errReader.pushChunk(header);

      expect(caughtErrors).toHaveLength(1);
      expect((caughtErrors[0] as { code: string }).code).toBe(ErrorCode.NATIVE_FRAME_OVERSIZED);
    });

    it('3. rejects truncated / impossibly short length prefixes (< 2 bytes)', () => {
      const errReader = new NativeMessageReader();
      const caughtErrors: unknown[] = [];
      errReader.setErrorListener((err) => caughtErrors.push(err));

      const header = Buffer.alloc(4);
      header.writeUInt32LE(1, 0); // 1 byte cannot be valid JSON
      errReader.pushChunk(header);

      expect(caughtErrors).toHaveLength(1);
      expect((caughtErrors[0] as { code: string }).code).toBe(ErrorCode.NATIVE_FRAME_MALFORMED);
    });

    it('4. handles malformed non-JSON frame content fail-closed', async () => {
      const rawGarbage = Buffer.from('THIS IS NOT VALID JSON AT ALL {[[[', 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(rawGarbage.length, 0);

      const combined = Buffer.concat([header, rawGarbage]);
      reader.pushChunk(combined);

      await new Promise((r) => setTimeout(r, 50));
      // Controller responds with framing or schema error without crashing
      expect(receivedResponses.length).toBeGreaterThanOrEqual(1);
      expect(receivedResponses[0]?.['success']).toBe(false);
      expect(receivedResponses[0]?.['error']).toBeDefined();
    });

    it('5. handles deeply nested JSON structures safely', async () => {
      // 100 levels of nested objects
      let nestedObj: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 100; i++) {
        nestedObj = { child: nestedObj };
      }

      const frame = NativeMessageWriter.encodeFrame({
        id: 'nested_test',
        type: 'ping',
        payload: nestedObj,
        extensionId: ALLOWED_EXTENSION_ID,
      });

      reader.pushChunk(frame);
      await new Promise((r) => setTimeout(r, 50));

      expect(receivedResponses.length).toBeGreaterThanOrEqual(1);
      expect(receivedResponses[0]?.['success']).toBe(true);
    });

    it('6. safely handles null bytes and unconventional Unicode in payload fields', async () => {
      const strangeStrings = {
        nullBytes: 'hello\x00world\x00evil',
        traversal: '../../../../Windows/System32/calc.exe',
        unicodeAttack: '\uFEFF\u202E\u200Bmalicious',
      };

      const frame = NativeMessageWriter.encodeFrame({
        id: 'unicode_test',
        type: 'ping',
        payload: strangeStrings,
        extensionId: ALLOWED_EXTENSION_ID,
      });

      reader.pushChunk(frame);
      await new Promise((r) => setTimeout(r, 50));

      expect(receivedResponses.length).toBeGreaterThanOrEqual(1);
      expect(receivedResponses[0]?.['success']).toBe(true);
    });
  });

  describe('B. Origin Validation & Identity Spoofing Adversarial Tests', () => {
    it('7. strictly rejects messages from unauthorized or spoofed extension IDs', async () => {
      const maliciousFrame = NativeMessageWriter.encodeFrame({
        id: 'spoof_1',
        type: 'ping',
        extensionId: FORGED_EXTENSION_ID, // Unauthorized
      });

      reader.pushChunk(maliciousFrame);
      await new Promise((r) => setTimeout(r, 50));

      expect(receivedResponses.length).toBe(1);
      const res = receivedResponses[0]!;
      expect(res['success']).toBe(false);
      expect(res['errorCode']).toBe(ErrorCode.IPC_ORIGIN_REJECTED);
    });

    it('8. strictly fails closed if command-line origin initialization was invalid', () => {
      const rogueController = new NativeHostController(testConfig);
      const initSuccess = rogueController.initializeOrigin('chrome-extension://unauthorized_fake_id_12345/');
      expect(initSuccess).toBe(false);
      expect(rogueController.getValidatedExtensionId()).toBeNull();
    });
  });

  describe('C. Privilege Escalation & Command Injection Adversarial Tests', () => {
    it('9. strictly rejects arbitrary shell execution requests fail-closed', async () => {
      const prohibitedShellRequests = [
        { type: 'shell.exec', payload: { cmd: 'cmd.exe /c whoami' } },
        { type: 'exec', payload: { command: 'calc.exe' } },
        { type: 'system', payload: { script: 'powershell -c Get-Process' } },
        { type: 'spawn', payload: { binary: 'bash' } },
      ];

      for (const req of prohibitedShellRequests) {
        receivedResponses = [];
        const frame = NativeMessageWriter.encodeFrame({
          id: `prohibited_${req.type}`,
          ...req,
          extensionId: ALLOWED_EXTENSION_ID,
        });

        reader.pushChunk(frame);
        await new Promise((r) => setTimeout(r, 50));

        expect(receivedResponses.length).toBe(1);
        const res = receivedResponses[0]!;
        expect(res['success']).toBe(false);
        expect(res['errorCode']).toBe(ErrorCode.IPC_OPERATION_PROHIBITED);
      }
    });

    it('10. strictly rejects direct privileged broker operations from browser extension', async () => {
      const brokerBypassAttempts = [
        { type: 'apply_approved_stage', payload: { stageId: 's1' } },
        { type: 'workspace.stage_proposal', payload: { file: 'secret.txt' } },
        { type: 'workspace.apply_approved_stage', payload: { approvalId: 'app-1' } },
        { type: 'broker.dispatch', payload: { op: 'arbitrary' } },
      ];

      for (const req of brokerBypassAttempts) {
        receivedResponses = [];
        const frame = NativeMessageWriter.encodeFrame({
          id: `broker_bypass_${req.type}`,
          ...req,
          extensionId: ALLOWED_EXTENSION_ID,
        });

        reader.pushChunk(frame);
        await new Promise((r) => setTimeout(r, 50));

        expect(receivedResponses.length).toBe(1);
        const res = receivedResponses[0]!;
        expect(res['success']).toBe(false);
        expect(res['errorCode']).toBe(ErrorCode.IPC_OPERATION_PROHIBITED);
      }
    });

    it('11. strictly denies IPC connection when pairing token is missing or invalid', async () => {
      const handshakeWithoutToken = NativeMessageWriter.encodeFrame({
        id: 'no_token_test',
        type: 'handshake',
        pairingToken: '', // Empty
        extensionId: ALLOWED_EXTENSION_ID,
      });

      // Config without default token to test explicit token requirement
      const strictController = new NativeHostController(
        { ...testConfig, defaultPairingToken: undefined },
        reader,
        writer,
      );
      strictController.initializeOrigin(`chrome-extension://${ALLOWED_EXTENSION_ID}/`);

      reader.pushChunk(handshakeWithoutToken);
      await new Promise((r) => setTimeout(r, 50));

      expect(receivedResponses.length).toBe(1);
      const res = receivedResponses[0]!;
      expect(res['success']).toBe(false);
      expect(res['errorCode']).toBe(ErrorCode.IPC_TOKEN_INVALID);
    });
  });

  describe('D. Logging & Diagnostic Secret Redaction Tests', () => {
    it('12. verifies that sensitive tokens and keys are never printed to stderr', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      // Trigger logging with sensitive keywords in parameters
      controller.initializeOrigin(
        `chrome-extension://${ALLOWED_EXTENSION_ID}/?token=SUPER_SECRET_TOKEN_DO_NOT_LEAK`,
      );

      const loggedCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(loggedCalls).not.toContain('SUPER_SECRET_TOKEN_DO_NOT_LEAK');

      stderrSpy.mockRestore();
    });
  });
});
