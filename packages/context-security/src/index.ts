/**
 * @mediator/context-security
 *
 * Sprint S06 — Secret Scanner & Context Filter
 *
 * Provides a reusable, modular security layer that prevents secrets from
 * entering AI-bound context packets, browser messages, logs, and diagnostics.
 *
 * Core invariant: No context or output packet may leave the local trust
 * boundary until it has passed exclusion, scanning, redaction, size-limit,
 * and policy checks.
 *
 * Module boundaries:
 * - secretPatterns.ts  — Pattern registry (detectable secret formats)
 * - pathExclusions.ts  — Path-level exclusion rules (.mediatorignore)
 * - secretScanner.ts   — Content-level scanning (findings, no raw values)
 * - redactor.ts        — Redaction engine (overlap-safe, fail-closed)
 * - contextFilter.ts   — Authoritative pipeline: buildSafeContextPacket()
 * - contextPreview.ts  — Safe IDE preview API
 *
 * DETECTION LIMITATION: Pattern-based scanning cannot identify all secrets.
 * Unknown or obfuscated secrets will not be detected.
 */

// ── Pattern registry ──────────────────────────────────────────────────────
export {
  DEFAULT_SECRET_PATTERNS,
  addCustomPattern,
  removeCustomPattern,
  getAllPatterns,
  resetCustomPatterns,
  type SecretPatternRule,
  type SecretSeverity,
} from './secretPatterns.js';

// ── Path exclusions ───────────────────────────────────────────────────────
export {
  MANDATORY_EXCLUSIONS,
  checkPathExclusion,
  isPathExcluded,
  getEffectiveExclusionRules,
  parseMediatorIgnore,
  isRelativePathSafe,
  globToRegex,
  normalizePathForExclusion,
  type ExclusionRule,
  type ExclusionResult,
} from './pathExclusions.js';

// ── Secret scanner ────────────────────────────────────────────────────────
export {
  scanContent,
  scanTerminalOutput,
  shouldBlockContent,
  type ScanConfig,
  type ScanFinding,
  type ScanResult,
} from './secretScanner.js';

// ── Redactor ──────────────────────────────────────────────────────────────
export {
  redactContent,
  redactTerminalOutput,
  checkNoSecretsLeaked,
  type RedactionRecord,
  type RedactionResult,
} from './redactor.js';

// ── Context filter ────────────────────────────────────────────────────────
export {
  buildSafeContextPacket,
  processFileForContext,
  type CandidateFile,
  type ContextPolicy,
  type ContextFileItem,
  type FileItemStatus,
  type SafeContextPacket,
} from './contextFilter.js';

// ── Context preview ───────────────────────────────────────────────────────
export {
  buildContextPreview,
  formatContextPreview,
  type ContextPreview,
  type FilePreviewEntry,
} from './contextPreview.js';
