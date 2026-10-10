/**
 * @mediator/context-security — Secret Scanner (S06)
 *
 * Content-level scanning for recognizable secret patterns.
 *
 * IMPORTANT LIMITATION: This scanner detects known patterns only. Unknown,
 * obfuscated, or custom-format secrets will not be detected. Scan results
 * CANNOT guarantee the absence of secrets in scanned content.
 *
 * Security invariants:
 * - Never include matched secret values in findings, errors, or diagnostics.
 * - Fail closed on malformed input or size limit exceeded.
 * - Apply execution time limits where practical.
 * - Return structured findings containing rule ID, severity, location, and
 *   redaction label — NOT the raw matched value.
 */

import {
  type Result,
  ok,
  err,
  type MediatorError,
  ErrorCode,
  makeMediatorError,
} from '@mediator/shared-contracts';
import { getAllPatterns, type SecretSeverity } from './secretPatterns.js';

// ─── Scan configuration ────────────────────────────────────────────────────

export interface ScanConfig {
  /**
   * Maximum byte length of input to scan.
   * Content exceeding this limit causes the scan to fail closed.
   * Default: 512 KB
   */
  readonly maxInputBytes?: number | undefined;
  /**
   * Maximum execution time in milliseconds.
   * Default: 5000ms (5 seconds)
   */
  readonly maxExecutionMs?: number | undefined;
  /**
   * Limit of findings returned per scan. Prevents very large result sets.
   * Default: 200
   */
  readonly maxFindings?: number | undefined;
  /**
   * Number of bytes of surrounding context to capture in findings for diagnostics.
   * The context excerpt itself must never contain the raw secret value.
   * Default: 60
   */
  readonly contextWindowBytes?: number | undefined;
}

interface ResolvedScanConfig {
  readonly maxInputBytes: number;
  readonly maxExecutionMs: number;
  readonly maxFindings: number;
  readonly contextWindowBytes: number;
}

const SCAN_DEFAULTS: ResolvedScanConfig = {
  maxInputBytes: 512 * 1024, // 512 KB
  maxExecutionMs: 5000,
  maxFindings: 200,
  contextWindowBytes: 60,
};

// ─── Finding types ─────────────────────────────────────────────────────────

export interface ScanFinding {
  /** Rule identifier that triggered the match */
  readonly ruleId: string;
  /** Human-readable description of the rule (safe to include in diagnostics) */
  readonly ruleDescription: string;
  /** Severity level */
  readonly severity: SecretSeverity;
  /**
   * 0-based byte offset in source where match begins.
   * Useful for identifying location without exposing the matched text.
   */
  readonly matchOffset: number;
  /**
   * Length of the matched region in bytes.
   * Combined with offset, allows the caller to redact the region.
   */
  readonly matchLength: number;
  /**
   * Safe label for the redacted output, e.g. '[REDACTED:STRIPE_KEY]'.
   * This is the ONLY reference to the secret content — never the raw value.
   */
  readonly redactionLabel: string;
  /** Whether this finding has been redacted in downstream output */
  redacted: boolean;
}

export interface ScanResult {
  /** Whether any secret patterns were detected */
  readonly secretsDetected: boolean;
  /** Structured findings — NO raw secret values */
  readonly findings: readonly ScanFinding[];
  /** Whether the scan was truncated due to input size or time limits */
  readonly truncated: boolean;
  /** Total input length that was scanned (bytes) */
  readonly scannedBytes: number;
}

// ─── Scanner ───────────────────────────────────────────────────────────────

/**
 * Scan text content for known secret patterns.
 *
 * Returns structured findings with location information and redaction labels.
 * NEVER returns the matched secret value — only offsets and labels.
 *
 * If the content exceeds size limits or cannot be processed safely,
 * returns an error so the caller can fail closed.
 *
 * @param content - Text content to scan (already read via S05 safe I/O)
 * @param config - Optional scan configuration overrides
 */
function resolveScanConfig(config?: ScanConfig): ResolvedScanConfig {
  return {
    maxInputBytes: config?.maxInputBytes ?? SCAN_DEFAULTS.maxInputBytes,
    maxExecutionMs: config?.maxExecutionMs ?? SCAN_DEFAULTS.maxExecutionMs,
    maxFindings: config?.maxFindings ?? SCAN_DEFAULTS.maxFindings,
    contextWindowBytes: config?.contextWindowBytes ?? SCAN_DEFAULTS.contextWindowBytes,
  };
}

export function scanContent(
  content: string,
  config?: ScanConfig,
): Result<ScanResult, MediatorError> {
  const cfg = resolveScanConfig(config);
  const startTime = Date.now();

  // ── Guard: input size ──────────────────────────────────────────────
  const inputBytes = Buffer.byteLength(content, 'utf8');
  if (inputBytes > cfg.maxInputBytes) {
    return err(
      makeMediatorError(
        ErrorCode.OVERSIZED_INPUT,
        `Content exceeds scan size limit (${inputBytes} bytes > ${cfg.maxInputBytes} bytes). Content blocked.`,
      ),
    );
  }

  // ── Guard: malformed/unsupported encoding ──────────────────────────
  // The string must be valid UTF-16 (JS native). Check for lone surrogates.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content)) {
    return err(
      makeMediatorError(
        ErrorCode.SCHEMA_INVALID,
        'Content contains invalid Unicode surrogate pairs. Content blocked.',
      ),
    );
  }

  const patterns = getAllPatterns();
  const findings: ScanFinding[] = [];
  let truncated = false;

  // ── Pattern matching ────────────────────────────────────────────────
  for (const rule of patterns) {
    // Check time limit
    if (Date.now() - startTime > cfg.maxExecutionMs) {
      truncated = true;
      break;
    }

    // Check findings limit
    if (findings.length >= cfg.maxFindings) {
      truncated = true;
      break;
    }

    try {
      // Reset stateful regex before each use
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
      let match: RegExpExecArray | null;

      while ((match = regex.exec(content)) !== null) {
        // Time check inside inner loop too
        if (Date.now() - startTime > cfg.maxExecutionMs) {
          truncated = true;
          break;
        }

        if (findings.length >= cfg.maxFindings) {
          truncated = true;
          break;
        }

        // CRITICAL: Do NOT store match[0] (the raw matched text) anywhere
        const matchOffset = match.index;
        const matchLength = match[0].length;

        findings.push({
          ruleId: rule.id,
          ruleDescription: rule.description,
          severity: rule.severity,
          matchOffset,
          matchLength,
          redactionLabel: rule.redactionLabel,
          redacted: false,
        });

        // Prevent infinite loop on zero-length matches
        if (matchLength === 0) {
          regex.lastIndex++;
        }
      }
    } catch {
      // Pattern threw (e.g. catastrophic backtracking timeout) — fail closed
      truncated = true;
      break;
    }

    if (truncated) break;
  }

  return ok({
    secretsDetected: findings.length > 0,
    findings,
    truncated,
    scannedBytes: inputBytes,
  });
}

/**
 * Scan bounded terminal output or log excerpts for secrets.
 * Applies a smaller default size limit appropriate for log snippets.
 *
 * @param output - Terminal output or log excerpt string
 */
export function scanTerminalOutput(
  output: string,
): Result<ScanResult, MediatorError> {
  return scanContent(output, {
    maxInputBytes: 64 * 1024, // 64 KB limit for terminal output
    maxExecutionMs: 2000,
  });
}

/**
 * Determine overall block status for a scan result.
 * If any critical or high-severity secrets were detected, block the content.
 * Returns true if content should be BLOCKED from transmission.
 */
export function shouldBlockContent(result: ScanResult): boolean {
  if (result.truncated) return true; // Fail closed on incomplete scans
  for (const finding of result.findings) {
    if (finding.severity === 'critical' || finding.severity === 'high') {
      return true;
    }
  }
  return false;
}
