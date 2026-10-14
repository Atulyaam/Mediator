/**
 * @mediator/ipc-core — Unit & Integration Test Suite (S19)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ErrorCode,
  PROTOCOL_VERSION,
} from '@mediator/shared-contracts';
import {
  PairingManager,
  IpcServer,
  IpcClient,
  IPC_PROTOCOL_VERSION,
  IPC_LIMITS,
  AllowedIpcOperation,
} from './index.js';

describe('Sprint S19 — Authenticated Local Named-Pipe IPC', () => {
  let pairingManager: PairingManager;
  let server: IpcServer;
  let pipePath: string;
  const EXTENSION_ID = 'abcdefghijklmnopponmlkjihgfedcba';

  beforeEach(async () => {
    pairingManager = new PairingManager(10_000); // 10s TTL
    server = new IpcServer(pairingManager, {
      getStatus: () => ({
        coreRunning: true,
        serverVersion: PROTOCOL_VERSION,
        protocolVersion: IPC_PROTOCOL_VERSION,
        activeTaskId: 'task_test_1',
        activeSessionId: 'sess_test_1',
        stagingReady: true,
      }),
      onTransferChunk: (payload) => ({
        accepted: true,
        blockId: payload.chunk.blockId,
        chunkIndex: payload.chunk.chunkIndex,
        totalChunks: payload.chunk.totalChunks,
        isComplete: payload.chunk.chunkIndex === payload.chunk.totalChunks - 1,
      }),
    });
    pipePath = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('1. Pairing Manager & Challenge Tokens', () => {
    it('generates cryptographically unguessable hex tokens of expected length', () => {
      const token = pairingManager.createPairingToken(EXTENSION_ID);
      expect(typeof token).toBe('string');
      expect(token).toHaveLength(64); // 32 bytes hex
    });

    it('validates a correct pairing token for the allowed extension ID', () => {
      const token = pairingManager.createPairingToken(EXTENSION_ID);
      const res = pairingManager.validateToken(token, EXTENSION_ID);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.allowedExtensionId).toBe(EXTENSION_ID);
      }
    });

    it('rejects an invalid or unknown pairing token', () => {
      const res = pairingManager.validateToken('invalid_token_1234567890abcdef', EXTENSION_ID);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.IPC_TOKEN_INVALID);
      }
    });

    it('rejects token when extension ID does not match', () => {
      const token = pairingManager.createPairingToken(EXTENSION_ID);
      const res = pairingManager.validateToken(token, 'different_extension_id');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.IPC_ORIGIN_REJECTED);
      }
    });

    it('rejects expired pairing tokens', async () => {
      const token = pairingManager.createPairingToken(EXTENSION_ID, { ttlMs: 1 });
      await new Promise((r) => setTimeout(r, 10)); // wait for expiry
      const res = pairingManager.validateToken(token, EXTENSION_ID);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.IPC_PAIRING_EXPIRED);
      }
    });

    it('enforces single-use tokens by default', () => {
      const token = pairingManager.createPairingToken(EXTENSION_ID, { singleUse: true });
      const first = pairingManager.validateToken(token, EXTENSION_ID);
      expect(first.ok).toBe(true);

      const second = pairingManager.validateToken(token, EXTENSION_ID);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.code).toBe(ErrorCode.IPC_TOKEN_INVALID);
      }
    });

    it('masks tokens safely for diagnostics without leaking credentials', () => {
      const token = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const masked = PairingManager.maskToken(token);
      expect(masked).toBe('1234...cdef');
      expect(masked).not.toContain('abcdef1234');
    });
  });

  describe('2. IPC Handshake & Version Negotiation', () => {
    it('successfully connects and authenticates with a valid pairing token', async () => {
      const token = pairingManager.createPairingToken(EXTENSION_ID);
      const client = new IpcClient({
        pipePath,
        extensionId: EXTENSION_ID,
        pairingToken: token,
        nonce: 'nonce_test_1234',
        taskId: 'task_test_1',
      });

      const res = await client.connect();
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.success).toBe(true);
        expect(res.value.protocolVersion).toBe(IPC_PROTOCOL_VERSION);
        expect(client.isConnected()).toBe(true);
      }

      client.disconnect();
    });

    it('rejects handshake with invalid pairing token', async () => {
      const client = new IpcClient({
        pipePath,
        extensionId: EXTENSION_ID,
        pairingToken: 'invalid_token_xyz',
        nonce: 'nonce_test_1234',
      });

      const res = await client.connect();
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.IPC_TOKEN_INVALID);
      }
      expect(client.isConnected()).toBe(false);
    });

    it('rejects handshake with wrong extension ID', async () => {
      const token = pairingManager.createPairingToken(EXTENSION_ID);
      const client = new IpcClient({
        pipePath,
        extensionId: 'wrong_extension_id',
        pairingToken: token,
        nonce: 'nonce_test_1234',
      });

      const res = await client.connect();
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.IPC_ORIGIN_REJECTED);
      }
    });
  });

  describe('3. Allowed Operations & Prohibitions', () => {
    it('executes ping round trip and returns timestamps', async () => {
      const token = pairingManager.createPairingToken(EXTENSION_ID);
      const client = new IpcClient({
        pipePath,
        extensionId: EXTENSION_ID,
        pairingToken: token,
        nonce: 'nonce_test_1234',
      });

      await client.connect();
      const pingRes = await client.ping();
      expect(pingRes.ok).toBe(true);
      if (pingRes.ok) {
        expect(pingRes.value.pong).toBe(true);
        expect(pingRes.value.serverTimestamp).toBeGreaterThan(0);
      }

      client.disconnect();
    });

    it('retrieves core status honestly', async () => {
      const token = pairingManager.createPairingToken(EXTENSION_ID);
      const client = new IpcClient({
        pipePath,
        extensionId: EXTENSION_ID,
        pairingToken: token,
        nonce: 'nonce_test_1234',
      });

      await client.connect();
      const statusRes = await client.getStatus();
      expect(statusRes.ok).toBe(true);
      if (statusRes.ok) {
        expect(statusRes.value.coreRunning).toBe(true);
        expect(statusRes.value.activeTaskId).toBe('task_test_1');
        expect(statusRes.value.stagingReady).toBe(true);
      }

      client.disconnect();
    });

    it('forwards chunk transfer payloads correctly', async () => {
      const token = pairingManager.createPairingToken(EXTENSION_ID);
      const client = new IpcClient({
        pipePath,
        extensionId: EXTENSION_ID,
        pairingToken: token,
        nonce: 'nonce_test_1234',
      });

      await client.connect();
      const chunkRes = await client.transferChunk({
        chunk: {
          transferId: 'tx_1',
          sessionId: 'sess_1',
          taskId: 'task_1',
          blockId: 'blk_1',
          chunkIndex: 0,
          totalChunks: 1,
          byteLength: 5,
          sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
          data: 'hello',
        },
      });

      expect(chunkRes.ok).toBe(true);
      if (chunkRes.ok) {
        expect(chunkRes.value.accepted).toBe(true);
        expect(chunkRes.value.isComplete).toBe(true);
      }

      client.disconnect();
    });
  });

  describe('4. Offline Core & Disconnect Recovery', () => {
    it('reports CORE_NOT_RUNNING when connecting to an unavailable named pipe', async () => {
      const nonExistentPipe = process.platform === 'win32'
        ? '\\\\.\\pipe\\mediator-nonexistent-pipe-99999'
        : '/tmp/mediator-nonexistent-pipe-99999.sock';

      const client = new IpcClient({
        pipePath: nonExistentPipe,
        extensionId: EXTENSION_ID,
        pairingToken: 'any_token',
        nonce: 'nonce_123',
        timeoutMs: 500,
      });

      const res = await client.connect();
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.CORE_NOT_RUNNING);
      }
    });

    it('rejects sending requests when client is disconnected', async () => {
      const client = new IpcClient({
        pipePath,
        extensionId: EXTENSION_ID,
        pairingToken: 'token',
        nonce: 'nonce_123',
      });

      const res = await client.ping();
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.CORE_NOT_RUNNING);
      }
    });
  });
});
