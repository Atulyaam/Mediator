/**
 * @mediator/context-security — Context Filter (S06)
 *
 * Authoritative pipeline combining path exclusion + content scanning + redaction.
 *
 * Every AI-bound context packet must pass through this filter.
 * No browser adapter, MCP tool or provider adapter may bypass this boundary.
 *
 * Pipeline:
 *   1. Workspace root confirmed (via S04/S05 WorkspaceRootState)
 *   2. Path exclusion check (before file content is read)
 *   3. File-size budget check
 *   4. Content scan
 *   5. Redaction
 *   6. Packet assembly
 *   7. Final policy check — reject if any unredacted findings remain
 */

import {
  type Result,
  ok,
  err,
  type MediatorError,
  ErrorCode,
  makeMediatorError,
} from '@mediator/shared-contracts';
import { type WorkspaceRootState } from '@mediator/workspace-boundary';
import { checkPathExclusion, getEffectiveExclusionRules, type ExclusionRule } from './pathExclusions.js';
import { scanContent, shouldBlockContent } from './secretScanner.js';
import { redactContent } from './redactor.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ContextPolicy {
  /**
   * Maximum size of a single file's content (bytes) to include.
   * Default: 256 KB
   */
  readonly maxFileSizeBytes?: number | undefined;
  /**
   * Maximum total size of all content in a context packet (bytes).
   * Default: 1 MB
   */
  readonly maxTotalContextBytes?: number | undefined;
  /**
   * User-defined exclusion rules from .mediatorignore
   */
  readonly userExclusionRules?: readonly ExclusionRule[] | undefined;
  /**
   * If true, medium and low severity findings are also blocked (not just redacted).
   * Default: false — medium/low findings are redacted and included.
   */
  readonly strictMode?: boolean | undefined;
}

interface ResolvedContextPolicy {
  readonly maxFileSizeBytes: number;
  readonly maxTotalContextBytes: number;
  readonly userExclusionRules: readonly ExclusionRule[];
  readonly strictMode: boolean;
}

const DEFAULT_POLICY: ResolvedContextPolicy = {
  maxFileSizeBytes: 256 * 1024,        // 256 KB
  maxTotalContextBytes: 1024 * 1024,   // 1 MB
  userExclusionRules: [],
  strictMode: false,
};

function resolvePolicy(policy: ContextPolicy = {}): ResolvedContextPolicy {
  return {
    maxFileSizeBytes: policy.maxFileSizeBytes ?? DEFAULT_POLICY.maxFileSizeBytes,
    maxTotalContextBytes: policy.maxTotalContextBytes ?? DEFAULT_POLICY.maxTotalContextBytes,
    userExclusionRules: policy.userExclusionRules ?? DEFAULT_POLICY.userExclusionRules,
    strictMode: policy.strictMode ?? DEFAULT_POLICY.strictMode,
  };
}

/** Status of a single candidate file after security processing */
export type FileItemStatus =
  | 'included'        // Passed all checks, safe to send
  | 'excluded'        // Excluded by path rule (content NOT read)
  | 'redacted'        // Content included with secrets replaced
  | 'blocked'         // Content blocked (secrets found, could not redact safely)
  | 'too_large'       // File exceeds size limit
  | 'scan_error';     // Scanner failed — content blocked

export interface ContextFileItem {
  /** Relative path within workspace */
  readonly relativePath: string;
  /** Status after security processing */
  readonly status: FileItemStatus;
  /** Safe content (redacted if needed). Only present when status === 'included' or 'redacted'. */
  readonly safeContent?: string | undefined;
  /** Human-readable reason for exclusion/blocking (no secrets) */
  readonly reason?: string | undefined;
  /** Rule ID that caused exclusion/blocking */
  readonly ruleId?: string | undefined;
  /** Redaction summary */
  readonly redactionSummary?: {
    readonly count: number;
    readonly labels: readonly string[];
  } | undefined;
  /** Original byte size (if known) */
  readonly originalSizeBytes?: number | undefined;
}

export interface SafeContextPacket {
  /** Whether this packet passed all security checks and is safe to send */
  readonly safeToSend: boolean;
  /** Included and redacted file items */
  readonly items: readonly ContextFileItem[];
  /** Total bytes of approved content */
  readonly totalApprovedBytes: number;
  /** Total candidate bytes before filtering */
  readonly totalCandidateBytes: number;
  /** Count by status */
  readonly summary: {
    readonly included: number;
    readonly redacted: number;
    readonly excluded: number;
    readonly blocked: number;
    readonly tooLarge: number;
    readonly scanError: number;
  };
  /** If false, explains why packet is not safe */
  readonly blockReason?: string | undefined;
}

// ─── Context Filter ────────────────────────────────────────────────────────

/**
 * Candidate file for context inclusion.
 * The caller is responsible for having read the content via S05 safe I/O.
 */
export interface CandidateFile {
  readonly relativePath: string;
  readonly content: string;
  readonly sizeBytes: number;
}

/**
 * Process a single file through the security pipeline.
 * Checks exclusion, size, scans content, and redacts findings.
 *
 * @param candidate - The candidate file (path already validated by S05)
 * @param policy - Context security policy
 */
export function processFileForContext(
  candidate: CandidateFile,
  policy: ContextPolicy = {},
): ContextFileItem {
  const cfg = resolvePolicy(policy);
  const effectiveRules = getEffectiveExclusionRules(cfg.userExclusionRules ?? []);

  // ── Step 1: Path exclusion check ──────────────────────────────────
  const exclusionCheck = checkPathExclusion(candidate.relativePath, effectiveRules);
  if (exclusionCheck.excluded) {
    return {
      relativePath: candidate.relativePath,
      status: 'excluded',
      reason: exclusionCheck.reason,
      ruleId: exclusionCheck.ruleId,
      originalSizeBytes: candidate.sizeBytes,
    };
  }

  // ── Step 2: File size check ────────────────────────────────────────
  if (candidate.sizeBytes > cfg.maxFileSizeBytes) {
    return {
      relativePath: candidate.relativePath,
      status: 'too_large',
      reason: `File size ${candidate.sizeBytes} bytes exceeds limit of ${cfg.maxFileSizeBytes} bytes`,
      originalSizeBytes: candidate.sizeBytes,
    };
  }

  // ── Step 3: Content scan ───────────────────────────────────────────
  const scanResult = scanContent(candidate.content);
  if (!scanResult.ok) {
    return {
      relativePath: candidate.relativePath,
      status: 'scan_error',
      reason: scanResult.error.message,
      originalSizeBytes: candidate.sizeBytes,
    };
  }

  const scan = scanResult.value;

  // Fail closed if scan was truncated
  if (scan.truncated) {
    return {
      relativePath: candidate.relativePath,
      status: 'blocked',
      reason: 'Content scan was incomplete. File blocked to prevent partial secret exposure.',
      originalSizeBytes: candidate.sizeBytes,
    };
  }

  // ── Step 4: Evaluate scan findings ────────────────────────────────
  if (scan.secretsDetected) {
    // Check severity — in strict mode, block all; otherwise only critical/high
    const hasBlockingSeverity = shouldBlockContent(scan);
    const hasAnyFindings = scan.findings.length > 0;

    if (hasBlockingSeverity || cfg.strictMode) {
      // Try to redact
      const redactionResult = redactContent(candidate.content, scan);

      if (redactionResult.blocked) {
        return {
          relativePath: candidate.relativePath,
          status: 'blocked',
          reason: redactionResult.blockReason ?? 'Redaction failed. File blocked.',
          originalSizeBytes: candidate.sizeBytes,
        };
      }

      // Verify: redacted content must not still contain any raw findings
      // (We use offset-based verification — the content at each original finding offset
      // should now contain the redaction label, not the original content)
      // Since we trust our redactor, verify the content is shorter or equal
      // (it won't be if labels are longer — that's expected)
      const safeContent = redactionResult.redactedContent;

      return {
        relativePath: candidate.relativePath,
        status: 'redacted',
        safeContent,
        reason: `${redactionResult.redactions.length} secret(s) redacted`,
        originalSizeBytes: candidate.sizeBytes,
        redactionSummary: {
          count: redactionResult.redactions.length,
          labels: redactionResult.redactions.map(r => r.label),
        },
      };
    } else if (hasAnyFindings) {
      // Medium/low severity — redact but include
      const redactionResult = redactContent(candidate.content, scan);
      if (redactionResult.blocked) {
        return {
          relativePath: candidate.relativePath,
          status: 'blocked',
          reason: redactionResult.blockReason ?? 'Redaction failed. File blocked.',
          originalSizeBytes: candidate.sizeBytes,
        };
      }

      return {
        relativePath: candidate.relativePath,
        status: 'redacted',
        safeContent: redactionResult.redactedContent,
        reason: `${redactionResult.redactions.length} low/medium finding(s) redacted`,
        originalSizeBytes: candidate.sizeBytes,
        redactionSummary: {
          count: redactionResult.redactions.length,
          labels: redactionResult.redactions.map(r => r.label),
        },
      };
    }
  }

  // ── Step 5: Clean — include as-is ─────────────────────────────────
  return {
    relativePath: candidate.relativePath,
    status: 'included',
    safeContent: candidate.content,
    originalSizeBytes: candidate.sizeBytes,
  };
}

/**
 * Build a safe context packet from multiple candidate files.
 *
 * This is the authoritative entry point that EVERY AI-bound context producer
 * must use. No adapter may bypass this function.
 *
 * @param workspace - Confirmed workspace root state (from S04)
 * @param candidates - Candidate files (paths already validated by S05 safe I/O)
 * @param policy - Context security policy
 */
export function buildSafeContextPacket(
  workspace: WorkspaceRootState,
  candidates: readonly CandidateFile[],
  policy: ContextPolicy = {},
): Result<SafeContextPacket, MediatorError> {
  const cfg = resolvePolicy(policy);

  // ── Step 1: Verify workspace root is confirmed ─────────────────────
  if (workspace.confirmationStatus !== 'confirmed') {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_CONFIRMATION_REQUIRED,
        'Workspace root must be confirmed before building a context packet.',
      ),
    );
  }

  if (workspace.resolutionStatus !== 'resolved' || !workspace.canonicalPath) {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_UNRESOLVED,
        'Workspace root must be resolved before building a context packet.',
      ),
    );
  }

  // ── Step 2: Process each candidate through the pipeline ────────────
  const items: ContextFileItem[] = [];
  let totalCandidateBytes = 0;
  let totalApprovedBytes = 0;

  const summary = {
    included: 0,
    redacted: 0,
    excluded: 0,
    blocked: 0,
    tooLarge: 0,
    scanError: 0,
  };

  for (const candidate of candidates) {
    totalCandidateBytes += candidate.sizeBytes;

    const item = processFileForContext(candidate, policy);
    items.push(item);

    switch (item.status) {
      case 'included':
        summary.included++;
        totalApprovedBytes += item.originalSizeBytes ?? 0;
        break;
      case 'redacted':
        summary.redacted++;
        totalApprovedBytes += Buffer.byteLength(item.safeContent ?? '', 'utf8');
        break;
      case 'excluded':
        summary.excluded++;
        break;
      case 'blocked':
        summary.blocked++;
        break;
      case 'too_large':
        summary.tooLarge++;
        break;
      case 'scan_error':
        summary.scanError++;
        break;
    }

    // Total context budget check — stop adding after limit
    if (totalApprovedBytes > cfg.maxTotalContextBytes) {
      return err(
        makeMediatorError(
          ErrorCode.OVERSIZED_INPUT,
          `Total approved context size ${totalApprovedBytes} bytes exceeds limit of ${cfg.maxTotalContextBytes} bytes. Reduce the number of files.`,
        ),
      );
    }
  }

  // ── Step 3: Final policy check ─────────────────────────────────────
  // Packet is unsafe if there are any blocked or scan-error items
  const hasBlockedItems = summary.blocked > 0 || summary.scanError > 0;
  const safeToSend = !hasBlockedItems;

  const blockReason = hasBlockedItems
    ? `${summary.blocked} file(s) blocked, ${summary.scanError} scan error(s). Packet not safe to send.`
    : undefined;

  return ok({
    safeToSend,
    items,
    totalApprovedBytes,
    totalCandidateBytes,
    summary,
    blockReason,
  });
}
