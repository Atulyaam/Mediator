/**
 * @mediator/native-host — Unit & Integration Test Suite (S19)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { ErrorCode } from '@mediator/shared-contracts';
import {
  NativeMessageReader,
  NativeMessageWriter,
  MAX_NATIVE_FRAME_BYTES,
  OriginValidator,
  generateHostManifest,
  generateInstallRegistryScript,
  generateUninstallRegistryScript,
  NativeHostController,
} from './index.js';

describe('Sprint S19 — Chromium Native Messaging Host', () => {
  const TEST_EXTENSION_ID = 'abcdefghijklmnopponmlkjihgfedcba';

  describe('1. Chromium Native Messaging Framing', () => {
    it('correctly reads and decodes a complete native frame', () => {
      const reader = new NativeMessageReader();
      const messages: unknown[] = [];
      reader.setMessageListener((msg) => messages.push(msg));

      const payload = { action: 'test', value: 42 };
      const frameBuf = NativeMessageWriter.encodeFrame(payload);

      reader.pushChunk(frameBuf);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(payload);
    });

    it('correctly reads a frame arriving across multiple fragmented chunks', () => {
      const reader = new NativeMessageReader();
      const messages: unknown[] = [];
      reader.setMessageListener((msg) => messages.push(msg));

      const payload = { greeting: 'hello from mediator bridge', seq: 1 };
      const frameBuf = NativeMessageWriter.encodeFrame(payload);

      // Split into 3 arbitrary chunks: 2 bytes, 5 bytes, and the rest
      const chunk1 = frameBuf.subarray(0, 2);
      const chunk2 = frameBuf.subarray(2, 7);
      const chunk3 = frameBuf.subarray(7);

      reader.pushChunk(chunk1);
      expect(messages).toHaveLength(0); // Not enough data yet

      reader.pushChunk(chunk2);
      expect(messages).toHaveLength(0); // Still incomplete

      reader.pushChunk(chunk3);
      expect(messages).toHaveLength(1); // Complete frame
      expect(messages[0]).toEqual(payload);
    });

    it('correctly decodes multiple frames delivered together in a single chunk', () => {
      const reader = new NativeMessageReader();
      const messages: unknown[] = [];
      reader.setMessageListener((msg) => messages.push(msg));

      const frame1 = NativeMessageWriter.encodeFrame({ id: 1, text: 'first' });
      const frame2 = NativeMessageWriter.encodeFrame({ id: 2, text: 'second' });
      const combined = Buffer.concat([frame1, frame2]);

      reader.pushChunk(combined);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ id: 1, text: 'first' });
      expect(messages[1]).toEqual({ id: 2, text: 'second' });
    });

    it('rejects oversized native frames exceeding the configured maximum bound', () => {
      const reader = new NativeMessageReader(1024); // 1 KB bound for test
      const errors: unknown[] = [];
      reader.setErrorListener((err) => errors.push(err));

      // Create header claiming 2048 bytes
      const header = Buffer.alloc(4);
      header.writeUInt32LE(2048, 0);

      reader.pushChunk(header);

      expect(errors).toHaveLength(1);
      expect((errors[0] as { code: string }).code).toBe(ErrorCode.NATIVE_FRAME_OVERSIZED);
    });

    it('rejects malformed length headers (< 2 bytes)', () => {
      const reader = new NativeMessageReader();
      const errors: unknown[] = [];
      reader.setErrorListener((err) => errors.push(err));

      const header = Buffer.alloc(4);
      header.writeUInt32LE(1, 0); // 1 byte cannot be valid JSON

      reader.pushChunk(header);

      expect(errors).toHaveLength(1);
      expect((errors[0] as { code: string }).code).toBe(ErrorCode.NATIVE_FRAME_MALFORMED);
    });

    it('rejects invalid JSON payloads safely without crashing', () => {
      const reader = new NativeMessageReader();
      const errors: unknown[] = [];
      reader.setErrorListener((err) => errors.push(err));

      const badJson = Buffer.from('{not-valid-json', 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(badJson.length, 0);

      reader.pushChunk(Buffer.concat([header, badJson]));

      expect(errors).toHaveLength(1);
      expect((errors[0] as { code: string }).code).toBe(ErrorCode.NATIVE_FRAME_MALFORMED);
    });

    it('writes encoded frames cleanly to the output stream', () => {
      const stream = new PassThrough();
      const writer = new NativeMessageWriter(stream);

      writer.writeMessage({ hello: 'world' });
      const written = stream.read() as Buffer;

      expect(written).not.toBeNull();
      const length = written.readUInt32LE(0);
      const content = written.subarray(4, 4 + length).toString('utf8');
      expect(JSON.parse(content)).toEqual({ hello: 'world' });
    });
  });

  describe('2. Extension Identity & Origin Validation', () => {
    let validator: OriginValidator;

    beforeEach(() => {
      validator = new OriginValidator([TEST_EXTENSION_ID]);
    });

    it('validates a correct Chromium chrome-extension:// origin argument', () => {
      const res = validator.validateOrigin(`chrome-extension://${TEST_EXTENSION_ID}/`);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe(TEST_EXTENSION_ID);
      }
    });

    it('rejects an origin with an unauthorized extension ID', () => {
      const res = validator.validateOrigin('chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.IPC_ORIGIN_REJECTED);
      }
    });

    it('rejects wildcard origins (*)', () => {
      const res = validator.validateOrigin('chrome-extension://*');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.IPC_ORIGIN_REJECTED);
      }
    });

    it('rejects malformed origin schemes (e.g. http:// or file://)', () => {
      const res = validator.validateOrigin(`http://localhost:3000/${TEST_EXTENSION_ID}`);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.IPC_ORIGIN_REJECTED);
      }
    });
  });

  describe('3. Native Host Controller & Routing', () => {
    it('answers ping honestly when core is disconnected', async () => {
      const reader = new NativeMessageReader();
      const stream = new PassThrough();
      const writer = new NativeMessageWriter(stream);

      const controller = new NativeHostController(
        {
          allowedExtensionIds: [TEST_EXTENSION_ID],
          pipePath: '\\\\.\\pipe\\nonexistent-pipe',
        },
        reader,
        writer,
      );

      controller.initializeOrigin(`chrome-extension://${TEST_EXTENSION_ID}/`);

      await controller.handleIncomingMessage({
        id: 'req_1',
        type: 'ping',
        extensionId: TEST_EXTENSION_ID,
      });

      const responseBuf = stream.read() as Buffer;
      expect(responseBuf).not.toBeNull();
      const length = responseBuf.readUInt32LE(0);
      const parsed = JSON.parse(responseBuf.subarray(4, 4 + length).toString('utf8'));

      expect(parsed.success).toBe(true);
      expect(parsed.data.pong).toBe(true);
      expect(parsed.data.hostRunning).toBe(true);
      expect(parsed.data.coreConnected).toBe(false);
    });

    it('rejects requests from unauthorized extension IDs', async () => {
      const stream = new PassThrough();
      const writer = new NativeMessageWriter(stream);

      const controller = new NativeHostController(
        {
          allowedExtensionIds: [TEST_EXTENSION_ID],
          pipePath: '\\\\.\\pipe\\nonexistent-pipe',
        },
        new NativeMessageReader(),
        writer,
      );

      await controller.handleIncomingMessage({
        id: 'req_unauth',
        type: 'ping',
        extensionId: 'unauthorized_extension_id_000000',
      });

      const responseBuf = stream.read() as Buffer;
      const length = responseBuf.readUInt32LE(0);
      const parsed = JSON.parse(responseBuf.subarray(4, 4 + length).toString('utf8'));

      expect(parsed.success).toBe(false);
      expect(parsed.errorCode).toBe(ErrorCode.IPC_ORIGIN_REJECTED);
    });

    it('rejects prohibited operations (e.g. run_command or shell)', async () => {
      const stream = new PassThrough();
      const writer = new NativeMessageWriter(stream);

      const controller = new NativeHostController(
        {
          allowedExtensionIds: [TEST_EXTENSION_ID],
          pipePath: '\\\\.\\pipe\\nonexistent-pipe',
        },
        new NativeMessageReader(),
        writer,
      );

      controller.initializeOrigin(`chrome-extension://${TEST_EXTENSION_ID}/`);

      await controller.handleIncomingMessage({
        id: 'req_shell',
        type: 'run_command',
        extensionId: TEST_EXTENSION_ID,
        payload: { command: 'dir' },
      });

      const responseBuf = stream.read() as Buffer;
      const length = responseBuf.readUInt32LE(0);
      const parsed = JSON.parse(responseBuf.subarray(4, 4 + length).toString('utf8'));

      expect(parsed.success).toBe(false);
      expect(parsed.errorCode).toBe(ErrorCode.IPC_OPERATION_PROHIBITED);
    });
  });

  describe('4. Manifest & Reversible HKCU Registration', () => {
    it('generates a valid Native Messaging host manifest for a real .exe', () => {
      const manifestRes = generateHostManifest({
        executablePath: 'C:\\Program Files\\Mediator\\mediator-host.exe',
        allowedExtensionIds: [TEST_EXTENSION_ID],
      });

      expect(manifestRes.ok).toBe(true);
      if (manifestRes.ok) {
        expect(manifestRes.value.name).toBe('com.mediator.native_host');
        expect(manifestRes.value.type).toBe('stdio');
        expect(manifestRes.value.allowed_origins).toContain(
          `chrome-extension://${TEST_EXTENSION_ID}/`,
        );
      }
    });

    it('strictly rejects batch files (.bat or .cmd) as the native host executable', () => {
      const batRes = generateHostManifest({
        executablePath: 'C:\\Mediator\\run_host.bat',
        allowedExtensionIds: [TEST_EXTENSION_ID],
      });
      expect(batRes.ok).toBe(false);
      if (!batRes.ok) {
        expect(batRes.error.code).toBe(ErrorCode.NATIVE_HOST_NOT_INSTALLED);
        expect(batRes.error.message).toContain('Prohibited executable extension');
      }

      const cmdRes = generateHostManifest({
        executablePath: 'C:\\Mediator\\run_host.cmd',
        allowedExtensionIds: [TEST_EXTENSION_ID],
      });
      expect(cmdRes.ok).toBe(false);
    });

    it('generates PowerShell registry scripts that target current-user HKCU only', () => {
      const installScript = generateInstallRegistryScript('C:\\Mediator\\com.mediator.native_host.json');
      expect(installScript).toContain('HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.mediator.native_host');
      expect(installScript).toContain('HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.mediator.native_host');
      expect(installScript).not.toContain('HKLM:'); // Invariant: no HKLM modification

      const uninstallScript = generateUninstallRegistryScript();
      expect(uninstallScript).toContain('Remove-Item -Path $chromeKey');
      expect(uninstallScript).not.toContain('HKLM:');
    });
  });
});
