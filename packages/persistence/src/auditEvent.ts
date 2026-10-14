/**
 * @mediator/persistence — Canonical Audit Event & Hash Chain Computation (S10)
 *
 * Requirements:
 * - Append-only tamper-evident hash chain using SHA-256.
 * - Deterministic, versioned canonical serialization (canonical JSON).
 * - Fixed genesis value: 64 zeros.
 * - Integration with context-security redactor to ensure audit details contain no secrets.
 */

import { createHash } from 'node:crypto';
import { scanContent, redactContent } from '@mediator/context-security';

export function safeRedactString(content: string): string {
  const scan = scanContent(content);
  if (!scan.ok) {
    return '[REDACTED_SCAN_ERROR]';
  }
  return redactContent(content, scan.value).redactedContent;
}

export const AUDIT_GENESIS_HASH = '0'.repeat(64);

export interface CanonicalAuditPayload {
  readonly chainIndex: number;
  readonly eventId: string;
  readonly timestamp: number;
  readonly taskId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly eventType: string;
  readonly actor: string;
  readonly outcome: string;
  readonly details: Record<string, unknown>;
  readonly previousEventHash: string;
}

/**
 * Deterministically serialize a value to canonical JSON.
 * - Object keys sorted alphabetically at every level.
 * - undefined properties omitted.
 * - No whitespace outside strings.
 * - Valid UTF-8 encoding.
 */
export function canonicalStringify(val: unknown): string {
  if (val === null || val === undefined) {
    return 'null';
  }
  if (typeof val === 'boolean' || typeof val === 'number') {
    return JSON.stringify(val);
  }
  if (typeof val === 'string') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map((item) => canonicalStringify(item)).join(',') + ']';
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = (val as Record<string, unknown>)[key];
      if (v !== undefined) {
        parts.push(JSON.stringify(key) + ':' + canonicalStringify(v));
      }
    }
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(String(val));
}

/**
 * Computes the canonical SHA-256 hash of an audit event payload.
 */
export function computeAuditEventHash(payload: CanonicalAuditPayload): string {
  const canonicalJson = canonicalStringify(payload);
  return createHash('sha256').update(Buffer.from(canonicalJson, 'utf8')).digest('hex');
}

/**
 * Recursively redacts strings inside an object using the context-security redactor.
 */
export function sanitizeAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(details)) {
    if (typeof val === 'string') {
      out[key] = safeRedactString(val);
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      out[key] = sanitizeAuditDetails(val as Record<string, unknown>);
    } else if (Array.isArray(val)) {
      const arr = val as readonly unknown[];
      out[key] = arr.map((elem: unknown): unknown => {
        if (typeof elem === 'string') {
          return safeRedactString(elem);
        }
        if (elem && typeof elem === 'object') {
          return sanitizeAuditDetails(elem as Record<string, unknown>);
        }
        return elem;
      });
    } else {
      out[key] = val;
    }
  }
  return out;
}
