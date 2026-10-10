/**
 * @mediator/content-transfer — Transfer Types & Limits (S09)
 *
 * Requirements:
 * - Manifest-plus-body format for safe content-block framing without giant escaped JSON.
 * - Bounded chunk transfers respecting Native Messaging limits with safe margins.
 * - Conservative transfer limits and timeouts.
 */

import { z } from 'zod';

export const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;

export interface ContentBlockManifest {
  readonly transferId: string;
  readonly blockId: string;
  readonly actionId: string;
  readonly path?: string | undefined;
  readonly encoding: 'utf-8';
  readonly byteLength: number;
  readonly sha256: string;
  readonly delimiter?: string | undefined;
}

export interface TransferLimits {
  /** Conservative maximum chunk size respecting Native Messaging transport limits (256 KB) */
  readonly maxChunkBytes: number;
  /** Maximum single block content size (2 MB) */
  readonly maxBlockBytes: number;
  /** Maximum total transfer payload size (10 MB) */
  readonly maxTotalTransferBytes: number;
  /** Maximum plan manifest size (1 MB) */
  readonly maxManifestBytes: number;
  /** Maximum number of chunks allowed per block transfer */
  readonly maxChunks: number;
  /** Maximum number of blocks in a transfer */
  readonly maxBlocks: number;
  /** Transfer timeout in milliseconds before discarding incomplete transfers */
  readonly timeoutMs: number;
}

export const DEFAULT_TRANSFER_LIMITS: TransferLimits = {
  maxChunkBytes: 256 * 1024, // 256 KB
  maxBlockBytes: 2 * 1024 * 1024, // 2 MB
  maxTotalTransferBytes: 10 * 1024 * 1024, // 10 MB
  maxManifestBytes: 1024 * 1024, // 1 MB
  maxChunks: 100,
  maxBlocks: 20,
  timeoutMs: 30_000, // 30s
};

export interface TransferChunk {
  readonly transferId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly blockId: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly data: string;
}

export const TransferState = {
  RECEIVING: 'RECEIVING',
  VALIDATING: 'VALIDATING',
  COMPLETE: 'COMPLETE',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export type TransferStateValue = (typeof TransferState)[keyof typeof TransferState];

export interface ParsedContentBlock {
  readonly transferId: string;
  readonly blockId: string;
  readonly actionId: string;
  readonly path?: string | undefined;
  readonly encoding: 'utf-8';
  readonly byteLength: number;
  readonly sha256: string;
  readonly content: string;
}

// ─── Zod Schemas ───────────────────────────────────────────────────────────

export const ContentBlockManifestSchema = z.object({
  transferId: z.string().min(1, 'transferId is required'),
  blockId: z.string().min(1, 'blockId is required'),
  actionId: z.string().min(1, 'actionId is required'),
  path: z.string().optional(),
  encoding: z.literal('utf-8'),
  byteLength: z.number().int().nonnegative('byteLength must be non-negative integer'),
  sha256: z.string().regex(/^(sha256:)?[a-f0-9]{64}$/i, 'Must be valid SHA-256 hash'),
  delimiter: z.string().optional(),
});

export const TransferChunkSchema = z.object({
  transferId: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  blockId: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  totalChunks: z.number().int().positive(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^(sha256:)?[a-f0-9]{64}$/i),
  data: z.string(),
});
