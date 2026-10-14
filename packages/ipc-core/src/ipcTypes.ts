/**
 * @mediator/ipc-core — Local Authenticated IPC Types (S19)
 *
 * Requirements:
 * - Local-only named-pipe transport between native host and Mediator core.
 * - Current-user security context; remote clients rejected.
 * - Authenticated handshake using short-lived pairing challenge/token.
 * - Narrow allowlist of registered operations; command execution and policy mutation prohibited.
 * - Frame length validation with bounded buffers.
 */

import { z } from 'zod';
import {
  type ErrorCodeValue,
  PROTOCOL_VERSION,
} from '@mediator/shared-contracts';
import { type TransferChunk } from '@mediator/content-transfer';
import { type CanonicalEnvelope } from '@mediator/protocol';

export const IPC_PROTOCOL_VERSION = PROTOCOL_VERSION;

/** Default Windows Named Pipe prefix */
export const DEFAULT_NAMED_PIPE_PREFIX = '\\\\.\\pipe\\mediator-ipc-';

/** IPC transport boundaries */
export const IPC_LIMITS = {
  /** Maximum single framed IPC message: 512 KiB (conservative for native messaging) */
  maxFrameBytes: 512 * 1024,
  /** Maximum chunk size: 256 KiB */
  maxChunkBytes: 256 * 1024,
  /** Maximum logical transfer ceiling: 8 MiB */
  maxLogicalTransferBytes: 8 * 1024 * 1024,
  /** Maximum concurrent clients */
  maxConcurrentClients: 5,
  /** Handshake timeout: 10 seconds */
  handshakeTimeoutMs: 10_000,
  /** Request timeout: 15 seconds */
  requestTimeoutMs: 15_000,
  /** Pairing token default TTL: 5 minutes */
  pairingTokenTtlMs: 5 * 60 * 1000,
} as const;

/** Allowed operations enum */
export const AllowedIpcOperation = {
  PING: 'mediator.ping',
  GET_STATUS: 'mediator.get_status',
  TRANSFER_CHUNK: 'mediator.transfer_chunk',
  SUBMIT_ENVELOPE: 'mediator.submit_envelope',
  GET_PENDING_ROUND: 'mediator.get_pending_round',
} as const;

export type AllowedIpcOperationValue =
  (typeof AllowedIpcOperation)[keyof typeof AllowedIpcOperation];

export const ALLOWED_IPC_OPERATIONS_SET = new Set<string>(
  Object.values(AllowedIpcOperation),
);

/** Prohibited operation keywords for defense-in-depth */
export const PROHIBITED_OPERATION_KEYWORDS = [
  'shell',
  'exec',
  'run_command',
  'apply_patch',
  'write_workspace',
  'resolve_approval',
  'set_policy',
  'mutate_policy',
  'arbitrary_file',
] as const;

// ─── Handshake ─────────────────────────────────────────────────────────────

export interface IpcHandshakeRequest {
  readonly protocolVersion: string;
  readonly extensionId: string;
  readonly pairingToken: string;
  readonly nonce: string;
  readonly sessionId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly timestamp: number;
}

export interface IpcHandshakeResponse {
  readonly success: boolean;
  readonly protocolVersion: string;
  readonly serverVersion: string;
  readonly negotiatedSessionId?: string | undefined;
  readonly maxFrameBytes: number;
  readonly maxChunkBytes: number;
  readonly error?: string | undefined;
  readonly errorCode?: ErrorCodeValue | undefined;
}

export const IpcHandshakeRequestSchema = z.object({
  protocolVersion: z.string().min(1),
  extensionId: z.string().min(1),
  pairingToken: z.string().min(1),
  nonce: z.string().min(1),
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
  timestamp: z.number().int().positive(),
});

// ─── General Message & Response ───────────────────────────────────────────

export interface IpcMessage<T = unknown> {
  readonly id: string;
  readonly correlationId: string;
  readonly type: string;
  readonly payload: T;
  readonly timestamp: number;
  readonly sessionId?: string | undefined;
  readonly taskId?: string | undefined;
}

export interface IpcResponse<T = unknown> {
  readonly id: string;
  readonly correlationId: string;
  readonly success: boolean;
  readonly data?: T | undefined;
  readonly error?: string | undefined;
  readonly errorCode?: ErrorCodeValue | undefined;
}

export const IpcMessageSchema = z.object({
  id: z.string().min(1),
  correlationId: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown(),
  timestamp: z.number().int().positive(),
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
});

// ─── Operation Payloads & Results ──────────────────────────────────────────

export interface IpcPingPayload {
  readonly timestamp: number;
}

export interface IpcPingResult {
  readonly pong: true;
  readonly clientTimestamp: number;
  readonly serverTimestamp: number;
}

export interface IpcStatusResult {
  readonly coreRunning: true;
  readonly serverVersion: string;
  readonly protocolVersion: string;
  readonly activeTaskId: string | null;
  readonly activeSessionId: string | null;
  readonly activeHandoffId?: string | null | undefined;
  readonly stagingReady: boolean;
}

export interface IpcTransferChunkPayload {
  readonly chunk: TransferChunk;
}

export interface IpcTransferChunkResult {
  readonly accepted: boolean;
  readonly blockId: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly isComplete: boolean;
}

export interface IpcSubmitEnvelopePayload {
  readonly envelope: CanonicalEnvelope;
}

export interface IpcSubmitEnvelopeResult {
  readonly accepted: boolean;
  readonly envelopeStatus: string;
  readonly actionsCount: number;
}

export interface IpcPendingRoundResult {
  readonly hasPendingRound: boolean;
  readonly round?: number | undefined;
  readonly taskId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly nonce?: string | undefined;
  readonly primingText?: string | undefined;
}
