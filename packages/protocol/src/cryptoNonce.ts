/**
 * @mediator/protocol — Cryptographic Session Nonce (S08)
 *
 * Requirements:
 * - Generate nonces using cryptographically secure random bytes (Node.js crypto.randomBytes).
 * - Never use Math.random() for security-sensitive nonces.
 * - Nonce is bound to the active local session, task, and conversation identity.
 * - Constant-time comparison to prevent timing side-channel attacks.
 * - Mask nonces in logs, debug bundles, and provider-visible error messages.
 * - AI-provided nonce is NEVER accepted as authoritative; it must match local authoritative nonce.
 */

import { randomBytes, timingSafeEqual } from 'crypto';

export const MIN_NONCE_BYTE_LENGTH = 16;
export const DEFAULT_NONCE_BYTE_LENGTH = 32;

export interface SessionNonceBinding {
  readonly taskId: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly nonce: string;
  readonly createdAt: number;
  readonly rotatedAt?: number;
}

/**
 * Generate a cryptographically secure random nonce.
 * Uses Node.js crypto.randomBytes (CSPRNG). Never uses Math.random().
 */
export function generateCryptoNonce(byteLength: number = DEFAULT_NONCE_BYTE_LENGTH): string {
  const safeLength = Math.max(MIN_NONCE_BYTE_LENGTH, byteLength);
  return randomBytes(safeLength).toString('hex');
}

/**
 * Constant-time comparison between two nonces.
 * Prevents timing attacks when comparing authoritative nonce with received nonce.
 */
export function timingSafeEqualNonce(authoritativeNonce: string, candidateNonce: string): boolean {
  if (typeof authoritativeNonce !== 'string' || typeof candidateNonce !== 'string') {
    return false;
  }
  if (authoritativeNonce.length === 0 || candidateNonce.length === 0) {
    return false;
  }

  const bufA = Buffer.from(authoritativeNonce, 'utf8');
  const bufB = Buffer.from(candidateNonce, 'utf8');

  if (bufA.length !== bufB.length) {
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/**
 * Mask a nonce for safe structured logging or diagnostics.
 * Prevents raw secrets/nonces from leaking into provider messages or debug bundles.
 */
export function maskNonce(nonce: string): string {
  if (!nonce || typeof nonce !== 'string') {
    return '[NONCE_INVALID]';
  }
  if (nonce.length <= 8) {
    return '[NONCE_REDACTED]';
  }
  return `${nonce.slice(0, 4)}...${nonce.slice(-4)}`;
}

/**
 * Create an authoritative session nonce binding.
 */
export function createSessionNonceBinding(
  taskId: string,
  sessionId: string,
  conversationId: string,
  byteLength: number = DEFAULT_NONCE_BYTE_LENGTH,
): SessionNonceBinding {
  return {
    taskId,
    sessionId,
    conversationId,
    nonce: generateCryptoNonce(byteLength),
    createdAt: Date.now(),
  };
}

/**
 * Rotate an existing session nonce binding (e.g. upon session invalidation or conversation rebind).
 */
export function rotateSessionNonce(
  current: SessionNonceBinding,
  newConversationId?: string,
  byteLength: number = DEFAULT_NONCE_BYTE_LENGTH,
): SessionNonceBinding {
  return {
    taskId: current.taskId,
    sessionId: current.sessionId,
    conversationId: newConversationId ?? current.conversationId,
    nonce: generateCryptoNonce(byteLength),
    createdAt: current.createdAt,
    rotatedAt: Date.now(),
  };
}
