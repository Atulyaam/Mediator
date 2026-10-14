/**
 * @mediator/ipc-core — Pairing Manager (S19)
 *
 * Requirements:
 * - Cryptographically secure pairing tokens using CSPRNG (crypto.randomBytes). Never Math.random().
 * - Constant-time comparison via timingSafeEqual.
 * - Single-use or short-lived session-bound tokens with strict TTL.
 * - Token masking for diagnostics and logs.
 * - Safe invalidation and revocation.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
} from '@mediator/shared-contracts';
import { IPC_LIMITS } from './ipcTypes.js';

export interface PairingRecord {
  readonly token: string;
  readonly allowedExtensionId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly singleUse: boolean;
  used: boolean;
  readonly sessionId?: string | undefined;
  readonly taskId?: string | undefined;
}

export class PairingManager {
  private readonly tokens = new Map<string, PairingRecord>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs: number = IPC_LIMITS.pairingTokenTtlMs) {
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Generate and store a new short-lived pairing challenge token.
   */
  public createPairingToken(
    allowedExtensionId: string,
    options?: {
      readonly ttlMs?: number | undefined;
      readonly singleUse?: boolean | undefined;
      readonly sessionId?: string | undefined;
      readonly taskId?: string | undefined;
    },
  ): string {
    const rawBytes = randomBytes(32);
    const token = rawBytes.toString('hex');
    const now = Date.now();
    const ttl = options?.ttlMs ?? this.defaultTtlMs;

    this.tokens.set(token, {
      token,
      allowedExtensionId,
      createdAt: now,
      expiresAt: now + ttl,
      singleUse: options?.singleUse ?? true,
      used: false,
      sessionId: options?.sessionId,
      taskId: options?.taskId,
    });

    return token;
  }

  /**
   * Validate a presented pairing token against expected extension identity.
   * Uses timingSafeEqual to avoid timing side-channels.
   */
  public validateToken(
    candidateToken: string,
    extensionId: string,
  ): Result<PairingRecord, MediatorError> {
    if (!candidateToken || typeof candidateToken !== 'string') {
      return err(
        makeMediatorError(
          ErrorCode.IPC_TOKEN_INVALID,
          'Pairing token is missing or malformed',
        ),
      );
    }

    // Constant-time candidate comparison against known tokens
    let matchedRecord: PairingRecord | null = null;
    const candidateBuf = Buffer.from(candidateToken, 'utf8');

    for (const [storedToken, record] of this.tokens.entries()) {
      const storedBuf = Buffer.from(storedToken, 'utf8');
      if (candidateBuf.length === storedBuf.length) {
        if (timingSafeEqual(candidateBuf, storedBuf)) {
          matchedRecord = record;
          break;
        }
      }
    }

    if (!matchedRecord) {
      return err(
        makeMediatorError(
          ErrorCode.IPC_TOKEN_INVALID,
          'Pairing token was not recognized or has been revoked',
        ),
      );
    }

    const now = Date.now();
    if (now > matchedRecord.expiresAt) {
      this.tokens.delete(matchedRecord.token);
      return err(
        makeMediatorError(
          ErrorCode.IPC_PAIRING_EXPIRED,
          'Pairing token has expired',
        ),
      );
    }

    if (matchedRecord.singleUse && matchedRecord.used) {
      this.tokens.delete(matchedRecord.token);
      return err(
        makeMediatorError(
          ErrorCode.IPC_TOKEN_INVALID,
          'Single-use pairing token has already been consumed',
        ),
      );
    }

    // Origin/extension check
    if (matchedRecord.allowedExtensionId !== extensionId) {
      return err(
        makeMediatorError(
          ErrorCode.IPC_ORIGIN_REJECTED,
          `Pairing token extension mismatch: expected ${matchedRecord.allowedExtensionId}, received ${extensionId}`,
        ),
      );
    }

    matchedRecord.used = true;
    if (matchedRecord.singleUse) {
      this.tokens.delete(matchedRecord.token);
    }

    return ok(matchedRecord);
  }

  /**
   * Revoke a token explicitly.
   */
  public revokeToken(token: string): boolean {
    return this.tokens.delete(token);
  }

  /**
   * Revoke all active tokens.
   */
  public revokeAll(): void {
    this.tokens.clear();
  }

  /**
   * Mask a token for safe logging without leaking credentials.
   */
  public static maskToken(token: string): string {
    if (!token || typeof token !== 'string') return '[TOKEN_INVALID]';
    if (token.length <= 8) return '[TOKEN_REDACTED]';
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [token, record] of this.tokens.entries()) {
      if (now > record.expiresAt) {
        this.tokens.delete(token);
      }
    }
  }
}
