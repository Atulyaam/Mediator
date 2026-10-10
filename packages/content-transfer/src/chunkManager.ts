/**
 * @mediator/content-transfer — Bounded Chunk Manager (S09)
 *
 * Requirements:
 * - Manages bounded chunks across Native Messaging transport (<= 256 KB per chunk).
 * - Stores partial data in temporary buffers ONLY (never touches staging).
 * - Per-chunk and whole-payload SHA-256 integrity validation.
 * - Deterministic duplicate, out-of-order, and conflicting chunk behavior.
 * - Strict session isolation: cross-session chunks are rejected immediately.
 * - Automatic timeout and incomplete transfer cleanup.
 */

import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
} from '@mediator/shared-contracts';
import {
  type ContentBlockManifest,
  type TransferChunk,
  type ParsedContentBlock,
  type TransferLimits,
  DEFAULT_TRANSFER_LIMITS,
} from './transferTypes.js';
import { computeSha256, normalizeSha256, validateBlockIntegrity } from './contentBlockParser.js';
import { TransferStateMachine } from './transferStateMachine.js';

interface InFlightBlockTransfer {
  readonly manifest: ContentBlockManifest;
  readonly stateMachine: TransferStateMachine;
  readonly receivedChunks: Map<number, TransferChunk>;
  totalChunksExpected: number | null;
  cumulativeBytes: number;
}

export class ChunkTransferManager {
  private readonly transfers = new Map<string, InFlightBlockTransfer>();
  private readonly limits: TransferLimits;

  constructor(limits: TransferLimits = DEFAULT_TRANSFER_LIMITS) {
    this.limits = limits;
  }

  /**
   * Start a new tracked block transfer.
   */
  public startTransfer(
    manifest: ContentBlockManifest,
    sessionId: string,
    taskId: string,
  ): Result<TransferStateMachine, MediatorError> {
    if (this.transfers.has(manifest.blockId)) {
      const existing = this.transfers.get(manifest.blockId)!;
      if (!existing.stateMachine.isTerminal()) {
        return err(
          makeMediatorError(
            ErrorCode.CONTENT_BLOCK_DUPLICATE,
            `Transfer for block '${manifest.blockId}' is already in progress.`,
            { actionId: manifest.actionId },
          ),
        );
      }
    }

    const stateMachine = new TransferStateMachine(
      manifest.transferId,
      sessionId,
      taskId,
      this.limits.timeoutMs,
    );

    this.transfers.set(manifest.blockId, {
      manifest,
      stateMachine,
      receivedChunks: new Map<number, TransferChunk>(),
      totalChunksExpected: null,
      cumulativeBytes: 0,
    });

    return ok(stateMachine);
  }

  /**
   * Append a received chunk to an in-flight block transfer.
   * Validates per-chunk integrity, bounds, duplicates, and session isolation.
   */
  public appendChunk(
    chunk: TransferChunk,
  ): Result<ParsedContentBlock | null, MediatorError> {
    const inFlight = this.transfers.get(chunk.blockId);
    if (!inFlight) {
      return err(
        makeMediatorError(
          ErrorCode.CONTENT_BLOCK_MISSING,
          `No active transfer found for block ID '${chunk.blockId}'. Start transfer first.`,
          { sessionId: chunk.sessionId, taskId: chunk.taskId },
        ),
      );
    }

    const sm = inFlight.stateMachine;

    // Check if transfer expired or cancelled
    if (sm.isTerminal()) {
      return err(
        makeMediatorError(
          ErrorCode.TRANSFER_INCOMPLETE,
          `Cannot append chunk: transfer is in terminal state '${sm.getState()}' (${sm.getFailureReason() ?? 'terminated'}).`,
          { sessionId: chunk.sessionId, taskId: chunk.taskId },
        ),
      );
    }

    // 1. Session Isolation Invariant
    if (chunk.sessionId !== sm.sessionId) {
      sm.transitionToRejected('Cross-session chunk injection attempt');
      return err(
        makeMediatorError(
          ErrorCode.SESSION_MISMATCH,
          `Chunk session mismatch: expected '${sm.sessionId}', received '${chunk.sessionId}'. Cross-session chunks are rejected.`,
          { sessionId: chunk.sessionId, taskId: chunk.taskId },
        ),
      );
    }

    // 2. Task Isolation Invariant
    if (chunk.taskId !== sm.taskId) {
      sm.transitionToRejected('Cross-task chunk injection attempt');
      return err(
        makeMediatorError(
          ErrorCode.TASK_MISMATCH,
          `Chunk task mismatch: expected '${sm.taskId}', received '${chunk.taskId}'.`,
          { sessionId: chunk.sessionId, taskId: chunk.taskId },
        ),
      );
    }

    // 3. Chunk size limit (Native Messaging safe margin)
    const chunkBytes = Buffer.byteLength(chunk.data, 'utf8');
    if (chunkBytes > this.limits.maxChunkBytes) {
      sm.transitionToRejected('Chunk size exceeded Native Messaging safe limit');
      return err(
        makeMediatorError(
          ErrorCode.OVERSIZED_INPUT,
          `Chunk ${chunk.chunkIndex} exceeds maximum allowed chunk size of ${this.limits.maxChunkBytes} bytes (actual: ${chunkBytes} bytes).`,
          { detail: { chunkBytes, maxAllowed: this.limits.maxChunkBytes } },
        ),
      );
    }

    // 4. Per-chunk integrity check (SHA-256)
    const actualChunkHash = computeSha256(chunk.data);
    const expectedChunkHash = normalizeSha256(chunk.sha256);
    if (actualChunkHash !== expectedChunkHash) {
      sm.transitionToRejected('Chunk cryptographic checksum mismatch');
      return err(
        makeMediatorError(
          ErrorCode.TRANSFER_HASH_MISMATCH,
          `Chunk ${chunk.chunkIndex} checksum mismatch: data has been tampered or corrupted in transport.`,
          { detail: { chunkIndex: chunk.chunkIndex } },
        ),
      );
    }

    // 5. Total chunks consistency & bounds
    if (chunk.totalChunks <= 0 || chunk.totalChunks > this.limits.maxChunks) {
      sm.transitionToRejected('totalChunks exceeds allowable limit');
      return err(
        makeMediatorError(
          ErrorCode.OVERSIZED_INPUT,
          `totalChunks ${chunk.totalChunks} is outside allowed range [1, ${this.limits.maxChunks}].`,
        ),
      );
    }

    if (inFlight.totalChunksExpected === null) {
      inFlight.totalChunksExpected = chunk.totalChunks;
    } else if (inFlight.totalChunksExpected !== chunk.totalChunks) {
      sm.transitionToRejected('Conflicting totalChunks declared');
      return err(
        makeMediatorError(
          ErrorCode.SCHEMA_INVALID,
          `Conflicting totalChunks in transfer: previously declared ${inFlight.totalChunksExpected}, received ${chunk.totalChunks}.`,
        ),
      );
    }

    // 6. Chunk Index bounds
    if (chunk.chunkIndex < 0 || chunk.chunkIndex >= inFlight.totalChunksExpected) {
      sm.transitionToRejected('chunkIndex out of bounds');
      return err(
        makeMediatorError(
          ErrorCode.SEQUENCE_OUT_OF_ORDER,
          `Chunk index ${chunk.chunkIndex} is out of bounds for total chunks ${inFlight.totalChunksExpected}.`,
        ),
      );
    }

    // 7. Duplicate & Conflicting Chunk Handling
    if (inFlight.receivedChunks.has(chunk.chunkIndex)) {
      const existing = inFlight.receivedChunks.get(chunk.chunkIndex)!;
      if (existing.data === chunk.data && existing.sha256 === chunk.sha256) {
        // Idempotent duplicate: ignore safely without double-counting bytes
        return ok(null);
      } else {
        // Conflicting duplicate chunk -> Tampering detected!
        sm.transitionToRejected('Conflicting duplicate chunk received');
        return err(
          makeMediatorError(
            ErrorCode.TAMPERING_DETECTED,
            `Conflicting content received for chunk ${chunk.chunkIndex}. Transfer rejected.`,
          ),
        );
      }
    }

    // 8. Cumulative memory budget check
    inFlight.cumulativeBytes += chunkBytes;
    if (inFlight.cumulativeBytes > this.limits.maxBlockBytes) {
      sm.transitionToRejected('Cumulative transfer exceeded maxBlockBytes');
      return err(
        makeMediatorError(
          ErrorCode.OVERSIZED_INPUT,
          `Cumulative transfer bytes (${inFlight.cumulativeBytes}) exceeded maxBlockBytes limit (${this.limits.maxBlockBytes}).`,
        ),
      );
    }

    // Store chunk in temporary in-memory buffer
    inFlight.receivedChunks.set(chunk.chunkIndex, chunk);

    // 9. Completion Check
    if (inFlight.receivedChunks.size === inFlight.totalChunksExpected) {
      // All chunks present! Transition to VALIDATING
      const valRes = sm.transitionToValidating();
      if (!valRes.ok) return err(valRes.error);

      // Reassemble chunks deterministically in sequential order [0..totalChunks-1]
      const assembledParts: string[] = [];
      for (let i = 0; i < inFlight.totalChunksExpected; i++) {
        const c = inFlight.receivedChunks.get(i);
        if (!c) {
          sm.transitionToRejected(`Missing chunk ${i}`);
          return err(
            makeMediatorError(
              ErrorCode.TRANSFER_INCOMPLETE,
              `Missing chunk ${i} during reassembly.`,
            ),
          );
        }
        assembledParts.push(c.data);
      }
      const fullContent = assembledParts.join('');

      // Validate assembled block against manifest
      const validation = validateBlockIntegrity(inFlight.manifest, fullContent, this.limits);
      if (!validation.ok) {
        sm.transitionToRejected(validation.error.message);
        return err(validation.error);
      }

      // Transition to COMPLETE
      const compRes = sm.transitionToComplete();
      if (!compRes.ok) return err(compRes.error);

      return ok(validation.value);
    }

    // Transfer still receiving chunks
    return ok(null);
  }

  /**
   * Cancel an in-flight transfer and clean up its buffer.
   */
  public cancelTransfer(blockId: string, reason = 'Transfer cancelled'): void {
    const inFlight = this.transfers.get(blockId);
    if (inFlight) {
      inFlight.stateMachine.transitionToCancelled(reason);
      this.transfers.delete(blockId);
    }
  }

  /**
   * Clean up expired or terminated transfers.
   */
  public pruneTransfers(): number {
    let pruned = 0;
    for (const [blockId, inFlight] of this.transfers.entries()) {
      if (inFlight.stateMachine.isTerminal()) {
        this.transfers.delete(blockId);
        pruned++;
      }
    }
    return pruned;
  }
}
