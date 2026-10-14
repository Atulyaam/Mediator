/**
 * @mediator/native-host — Chromium Native Messaging Framing (S19)
 *
 * Requirements:
 * - 4-byte little-endian length prefix followed by UTF-8 encoded JSON payload.
 * - Handles arbitrary stream chunk boundaries: single bytes, partial headers, multiple frames per chunk.
 * - Enforces conservative application frame limit (512 KiB) and Chromium hard limit (1 MiB).
 * - Fails safely on oversized, truncated, or malformed frames.
 * - Reserves stdout exclusively for native messaging protocol frames.
 * - Sends sanitized diagnostics to stderr only. Never prints banners or debug text to stdout.
 */

import { Writable } from 'node:stream';
import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
} from '@mediator/shared-contracts';

/** Conservative application frame limit: 512 KiB */
export const MAX_NATIVE_FRAME_BYTES = 512 * 1024;

/** Chromium platform maximum frame limit: 1 MiB */
export const CHROMIUM_HARD_FRAME_LIMIT = 1024 * 1024;

export type MessageCallback = (message: unknown) => void;
export type ErrorCallback = (error: MediatorError) => void;

export class NativeMessageReader {
  private buffer = Buffer.alloc(0);
  private expectedLength: number | null = null;
  private readonly maxFrameBytes: number;
  private onMessage: MessageCallback | null = null;
  private onError: ErrorCallback | null = null;

  constructor(maxFrameBytes: number = MAX_NATIVE_FRAME_BYTES) {
    this.maxFrameBytes = Math.min(maxFrameBytes, CHROMIUM_HARD_FRAME_LIMIT);
  }

  public setMessageListener(callback: MessageCallback): void {
    this.onMessage = callback;
  }

  public setErrorListener(callback: ErrorCallback): void {
    this.onError = callback;
  }

  /**
   * Feed a new buffer chunk from the input stream.
   */
  public pushChunk(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  /**
   * Reset internal buffer state.
   */
  public reset(): void {
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;
  }

  private processBuffer(): void {
    while (this.buffer.length >= 4) {
      if (this.expectedLength === null) {
        this.expectedLength = this.buffer.readUInt32LE(0);

        if (this.expectedLength > this.maxFrameBytes) {
          const frameLen = this.expectedLength;
          this.reset();
          if (this.onError) {
            this.onError(
              makeMediatorError(
                ErrorCode.NATIVE_FRAME_OVERSIZED,
                `Native messaging frame size (${frameLen} bytes) exceeds limit of ${this.maxFrameBytes} bytes`,
              ),
            );
          }
          return;
        }

        if (this.expectedLength < 2) {
          this.reset();
          if (this.onError) {
            this.onError(
              makeMediatorError(
                ErrorCode.NATIVE_FRAME_MALFORMED,
                'Native messaging frame length must be at least 2 bytes (for minimal JSON)',
              ),
            );
          }
          return;
        }
      }

      const totalRequired = 4 + this.expectedLength;
      if (this.buffer.length < totalRequired) {
        // Awaiting remaining chunk bytes
        break;
      }

      const payloadBuf = this.buffer.subarray(4, totalRequired);
      this.buffer = this.buffer.subarray(totalRequired);
      this.expectedLength = null;

      let parsed: unknown;
      try {
        const jsonStr = payloadBuf.toString('utf8');
        parsed = JSON.parse(jsonStr);
      } catch (err: unknown) {
        if (this.onError) {
          this.onError(
            makeMediatorError(
              ErrorCode.NATIVE_FRAME_MALFORMED,
              `Malformed JSON in native messaging payload: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
        continue;
      }

      if (this.onMessage) {
        this.onMessage(parsed);
      }
    }
  }
}

export class NativeMessageWriter {
  private readonly outputStream: Writable;
  private readonly maxFrameBytes: number;

  constructor(
    outputStream: Writable = process.stdout,
    maxFrameBytes: number = MAX_NATIVE_FRAME_BYTES,
  ) {
    this.outputStream = outputStream;
    this.maxFrameBytes = maxFrameBytes;
  }

  /**
   * Encode and write a native messaging protocol frame to the output stream.
   * Format: [4-byte uint32 LE length][UTF-8 JSON string]
   */
  public writeMessage(message: unknown): boolean {
    const jsonStr = JSON.stringify(message);
    const payloadBuf = Buffer.from(jsonStr, 'utf8');

    if (payloadBuf.length > this.maxFrameBytes) {
      throw new Error(
        `Outgoing message exceeds max frame bytes (${payloadBuf.length} > ${this.maxFrameBytes})`,
      );
    }

    const headerBuf = Buffer.alloc(4);
    headerBuf.writeUInt32LE(payloadBuf.length, 0);

    const frame = Buffer.concat([headerBuf, payloadBuf]);
    return this.outputStream.write(frame);
  }

  /**
   * Encode a frame to buffer without writing directly to stream (useful for tests).
   */
  public static encodeFrame(message: unknown): Buffer {
    const jsonStr = JSON.stringify(message);
    const payloadBuf = Buffer.from(jsonStr, 'utf8');
    const headerBuf = Buffer.alloc(4);
    headerBuf.writeUInt32LE(payloadBuf.length, 0);
    return Buffer.concat([headerBuf, payloadBuf]);
  }
}

/**
 * Log sanitized diagnostic output to stderr.
 * Never writes to stdout so the Native Messaging channel remains pure.
 */
export function logSanitizedStderr(
  message: string,
  meta?: Record<string, unknown>,
): void {
  const timestamp = new Date().toISOString();
  // Redact potential inline tokens or query params from message string
  const sanitizedMessage = message.replace(
    /([?&](?:token|secret|key|password|auth)=)[^&\s"']+/gi,
    '$1[REDACTED]',
  );
  let logLine = `[mediator-native-host] ${timestamp} ${sanitizedMessage}`;
  if (meta) {
    try {
      // Redact potential secret keys
      const sanitizedMeta = { ...meta };
      for (const key of Object.keys(sanitizedMeta)) {
        if (/token|secret|key|nonce/i.test(key)) {
          sanitizedMeta[key] = '[REDACTED]';
        }
      }
      logLine += ` ${JSON.stringify(sanitizedMeta)}`;
    } catch {
      // ignore
    }
  }
  process.stderr.write(`${logLine}\n`);
}
