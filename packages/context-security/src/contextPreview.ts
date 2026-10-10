/**
 * @mediator/context-security — Context Preview (S06)
 *
 * Safe preview API showing what would be included/excluded/redacted
 * without emitting any secret values in the preview output.
 */

import { type WorkspaceRootState } from '@mediator/workspace-boundary';
import {
  type CandidateFile,
  type ContextPolicy,
  type ContextFileItem,
  buildSafeContextPacket,
} from './contextFilter.js';
import { type Result } from '@mediator/shared-contracts';
import { type MediatorError } from '@mediator/shared-contracts';

// ─── Preview types ─────────────────────────────────────────────────────────

export interface FilePreviewEntry {
  /** Relative path within workspace */
  readonly relativePath: string;
  /** What would happen to this file */
  readonly disposition: 'included' | 'excluded' | 'redacted' | 'blocked' | 'too_large' | 'scan_error';
  /** Safe reason for exclusion or blocking (no secrets) */
  readonly reason?: string | undefined;
  /** Rule that triggered exclusion (if applicable) */
  readonly ruleId?: string | undefined;
  /** Number of secrets that would be redacted */
  readonly redactionCount?: number | undefined;
  /** Safe labels that would appear in redacted output */
  readonly redactionLabels?: readonly string[] | undefined;
  /** Original file size in bytes */
  readonly sizeBytes: number;
}

export interface ContextPreview {
  /** Whether the packet would be safe to send */
  readonly safeToSend: boolean;
  /** Per-file preview entries */
  readonly files: readonly FilePreviewEntry[];
  /** Total bytes across all candidate files */
  readonly totalCandidateBytes: number;
  /** Total bytes that would be approved (included + redacted) */
  readonly totalApprovedBytes: number;
  /** Breakdown by disposition */
  readonly counts: {
    readonly included: number;
    readonly excluded: number;
    readonly redacted: number;
    readonly blocked: number;
    readonly tooLarge: number;
    readonly scanError: number;
  };
  /** Whether the preview found any uncertainty or skipped content */
  readonly hasUncertainty: boolean;
  /** Human-readable explanation if packet is not safe to send */
  readonly blockReason?: string | undefined;
  /** Detection limitation notice — always included */
  readonly detectionLimitation: string;
}

// ─── Preview API ───────────────────────────────────────────────────────────

const DETECTION_LIMITATION_NOTICE =
  'NOTICE: Secret detection is pattern-based and cannot identify all secrets. ' +
  'Unknown, obfuscated, or custom-format secrets will not be detected. ' +
  'This preview is NOT a guarantee of complete secret removal.';

/**
 * Build a context preview showing what would happen without actually sending content.
 *
 * Shows:
 * - Which files would be included
 * - Which files would be excluded (and why, safely)
 * - Which blocks would be redacted (labels only, never secret values)
 * - Byte counts
 * - Whether the packet would be safe to send
 * - Detection limitations
 *
 * @param workspace - Current workspace state
 * @param candidates - Candidate files to preview
 * @param policy - Context security policy
 */
export function buildContextPreview(
  workspace: WorkspaceRootState,
  candidates: readonly CandidateFile[],
  policy: ContextPolicy = {},
): Result<ContextPreview, MediatorError> {
  // Build the actual packet (same logic — preview IS the authoritative result)
  const packetResult = buildSafeContextPacket(workspace, candidates, policy);

  if (!packetResult.ok) {
    // Even errors are shown safely in preview
    const preview: ContextPreview = {
      safeToSend: false,
      files: candidates.map(c => ({
        relativePath: c.relativePath,
        disposition: 'blocked',
        reason: 'Packet-level error prevented processing',
        sizeBytes: c.sizeBytes,
      })),
      totalCandidateBytes: candidates.reduce((s, c) => s + c.sizeBytes, 0),
      totalApprovedBytes: 0,
      counts: {
        included: 0,
        excluded: 0,
        redacted: 0,
        blocked: candidates.length,
        tooLarge: 0,
        scanError: 0,
      },
      hasUncertainty: true,
      blockReason: packetResult.error.message,
      detectionLimitation: DETECTION_LIMITATION_NOTICE,
    };
    return { ok: true, value: preview };
  }

  const packet = packetResult.value;

  const files: FilePreviewEntry[] = packet.items.map((item: ContextFileItem) => ({
    relativePath: item.relativePath,
    disposition: item.status,
    reason: item.reason,
    ruleId: item.ruleId,
    redactionCount: item.redactionSummary?.count,
    redactionLabels: item.redactionSummary?.labels,
    sizeBytes: item.originalSizeBytes ?? 0,
  }));

  const preview: ContextPreview = {
    safeToSend: packet.safeToSend,
    files,
    totalCandidateBytes: packet.totalCandidateBytes,
    totalApprovedBytes: packet.totalApprovedBytes,
    counts: {
      included: packet.summary.included,
      excluded: packet.summary.excluded,
      redacted: packet.summary.redacted,
      blocked: packet.summary.blocked,
      tooLarge: packet.summary.tooLarge,
      scanError: packet.summary.scanError,
    },
    hasUncertainty: packet.summary.scanError > 0 || packet.summary.blocked > 0,
    blockReason: packet.blockReason,
    detectionLimitation: DETECTION_LIMITATION_NOTICE,
  };

  return { ok: true, value: preview };
}

/**
 * Format a preview as a human-readable text summary (safe for display in IDE panel).
 * Never displays secret values — only labels, counts, and reasons.
 */
export function formatContextPreview(preview: ContextPreview): string {
  const lines: string[] = [
    '═══ Mediator Context Preview ══════════════════════════════',
    `Safe to send: ${preview.safeToSend ? '✓ YES' : '✗ NO'}`,
    '',
    `Candidate bytes:  ${preview.totalCandidateBytes.toLocaleString()}`,
    `Approved bytes:   ${preview.totalApprovedBytes.toLocaleString()}`,
    '',
    `Files:  ${preview.counts.included} included │ ${preview.counts.redacted} redacted │ ` +
      `${preview.counts.excluded} excluded │ ${preview.counts.blocked} blocked │ ` +
      `${preview.counts.tooLarge} too large │ ${preview.counts.scanError} scan errors`,
    '',
    '─── File details ────────────────────────────────────────────',
  ];

  for (const file of preview.files) {
    const icon =
      file.disposition === 'included' ? '✓' :
      file.disposition === 'redacted' ? '◈' :
      file.disposition === 'excluded' ? '○' :
      file.disposition === 'blocked' ? '✗' :
      file.disposition === 'too_large' ? '⊘' : '!';

    const suffix = file.reason ? ` — ${file.reason}` : '';
    const redactInfo = file.redactionLabels && file.redactionLabels.length > 0
      ? ` [${file.redactionLabels.join(', ')}]`
      : '';

    lines.push(`  ${icon} ${file.relativePath}${suffix}${redactInfo}`);
  }

  if (preview.blockReason) {
    lines.push('');
    lines.push(`⚠ BLOCKED: ${preview.blockReason}`);
  }

  lines.push('');
  lines.push(`⚠ ${preview.detectionLimitation}`);
  lines.push('═══════════════════════════════════════════════════════════');

  return lines.join('\n');
}
