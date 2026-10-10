/**
 * @mediator/context-security — Redactor (S06)
 *
 * Redacts sensitive values discovered in content before AI/browser/log emission.
 *
 * Security invariants:
 * - Never store the raw matched secret in the finding, redaction record, or logs.
 * - Handle overlapping matches — no partial secret exposure.
 * - Preserve surrounding non-sensitive context for diagnostics usefulness.
 * - If a block cannot be safely redacted, block the entire block.
 */

import { type ScanFinding, type ScanResult } from './secretScanner.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface RedactionRecord {
  /** Rule ID that triggered this redaction */
  readonly ruleId: string;
  /** The safe label inserted in place of the secret */
  readonly label: string;
  /** Byte offset in the ORIGINAL (pre-redaction) content */
  readonly originalOffset: number;
  /** Length in the ORIGINAL content that was replaced */
  readonly originalLength: number;
}

export interface RedactionResult {
  /** Redacted content — secrets replaced with labels. Never contains raw secrets. */
  readonly redactedContent: string;
  /** Summary of what was redacted (no raw values) */
  readonly redactions: readonly RedactionRecord[];
  /** Whether any redaction was applied */
  readonly wasRedacted: boolean;
  /** Whether the redaction process itself had to block the content entirely */
  readonly blocked: boolean;
  /** Human-readable reason if blocked (no secrets) */
  readonly blockReason?: string | undefined;
}

// ─── Overlap resolution ────────────────────────────────────────────────────

/**
 * Sort and de-overlap findings by offset.
 *
 * When multiple patterns match overlapping regions:
 * - Sort by offset ascending, then by length descending (prefer longer matches).
 * - Greedily select non-overlapping findings.
 * - This ensures no partial secret leaks through overlap gaps.
 */
function resolveOverlaps(findings: readonly ScanFinding[]): ScanFinding[] {
  if (findings.length === 0) return [];

  // Sort: first by offset, then by length descending (take longest match)
  const sorted = [...findings].sort((a, b) => {
    if (a.matchOffset !== b.matchOffset) return a.matchOffset - b.matchOffset;
    return b.matchLength - a.matchLength;
  });

  const resolved: ScanFinding[] = [];
  let lastEnd = -1;

  for (const finding of sorted) {
    const start = finding.matchOffset;
    const end = start + finding.matchLength;

    if (start >= lastEnd) {
      // No overlap — include this finding
      resolved.push(finding);
      lastEnd = end;
    } else if (end > lastEnd) {
      // Partial overlap — this finding extends beyond the previous one.
      // To prevent a partial secret from leaking, we EXTEND the previous
      // redaction by adjusting its effective end. We do this by replacing
      // the last finding with a synthetic one spanning both.
      const prev = resolved[resolved.length - 1];
      if (prev) {
        const extended: ScanFinding = {
          ...prev,
          matchLength: end - prev.matchOffset,
          // Use the higher severity and the label of the extending match
          redactionLabel: finding.severity === 'critical' || prev.severity !== 'critical'
            ? finding.redactionLabel
            : prev.redactionLabel,
          redacted: false,
        };
        resolved[resolved.length - 1] = extended;
        lastEnd = end;
      }
    }
    // Complete containment — skip (already covered by a longer match)
  }

  return resolved;
}

// ─── Core redactor ─────────────────────────────────────────────────────────

/**
 * Redact all secret findings from content.
 *
 * Replaces each matched region with the finding's `redactionLabel`.
 * Overlapping matches are resolved to prevent partial exposure.
 *
 * If redaction cannot be completed safely, returns `blocked: true`.
 *
 * @param content - Original text content
 * @param scanResult - Result from `scanContent()` containing findings
 */
export function redactContent(content: string, scanResult: ScanResult): RedactionResult {
  if (!scanResult.secretsDetected) {
    return {
      redactedContent: content,
      redactions: [],
      wasRedacted: false,
      blocked: false,
    };
  }

  // If scan was truncated, block the entire content — cannot safely redact
  if (scanResult.truncated) {
    return {
      redactedContent: '',
      redactions: [],
      wasRedacted: false,
      blocked: true,
      blockReason: 'Secret scan was incomplete (truncated). Content blocked to prevent partial secret exposure.',
    };
  }

  const resolvedFindings = resolveOverlaps(scanResult.findings);
  const redactions: RedactionRecord[] = [];

  try {
    let result = '';
    let position = 0;

    for (const finding of resolvedFindings) {
      const start = finding.matchOffset;
      const end = start + finding.matchLength;

      // Guard against out-of-bounds
      if (start < 0 || end > content.length || start > content.length) {
        return {
          redactedContent: '',
          redactions: [],
          wasRedacted: false,
          blocked: true,
          blockReason: 'Secret finding offset is out of bounds. Content blocked.',
        };
      }

      // Append content before the match
      result += content.slice(position, start);
      // Append redaction label (NOT the matched content)
      result += finding.redactionLabel;

      redactions.push({
        ruleId: finding.ruleId,
        label: finding.redactionLabel,
        originalOffset: start,
        originalLength: finding.matchLength,
      });

      position = end;
    }

    // Append remaining content after last match
    result += content.slice(position);

    // Mark all findings as redacted
    for (const finding of resolvedFindings) {
      finding.redacted = true;
    }

    return {
      redactedContent: result,
      redactions,
      wasRedacted: redactions.length > 0,
      blocked: false,
    };
  } catch {
    // Any unexpected error during redaction — block the content
    return {
      redactedContent: '',
      redactions: [],
      wasRedacted: false,
      blocked: true,
      blockReason: 'Unexpected error during redaction. Content blocked.',
    };
  }
}

/**
 * Redact terminal output or log excerpts.
 * Returns the safe (redacted) string, or an empty string if blocked.
 *
 * @param output - Raw terminal output string
 * @param scanResult - Scan result for the same content
 */
export function redactTerminalOutput(output: string, scanResult: ScanResult): string {
  const result = redactContent(output, scanResult);
  if (result.blocked) return '[Terminal output blocked: potential secret detected]';
  return result.redactedContent;
}

/**
 * Check that a redacted string does NOT contain any of the original
 * raw secret values. Used in tests to verify redaction completeness.
 *
 * NOTE: This function requires callers to provide the set of test fixture
 * secrets explicitly (never stored internally). It should ONLY be used
 * in tests, not in production code.
 *
 * @param redacted - The redacted output to check
 * @param knownFixtureSecrets - Explicit list of synthetic test secrets to search for
 * @returns Array of fixture secrets found (should be empty if redaction worked)
 */
export function checkNoSecretsLeaked(
  redacted: string,
  knownFixtureSecrets: readonly string[],
): string[] {
  return knownFixtureSecrets.filter(secret => {
    // Only check secrets of reasonable length to avoid false positives
    if (secret.length < 8) return false;
    return redacted.includes(secret);
  });
}
