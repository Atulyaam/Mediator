/**
 * @mediator/policy-engine
 *
 * Sprint S07 — Pure Policy Engine & Action Registry
 *
 * Centralizes all allow/deny/require-approval decisions before any mutation
 * or executor action can take place.
 *
 * Invariants:
 * - Pure function evaluation: evaluateAction() has no side effects.
 * - Review-only mode (V1 ADR-002) blocks arbitrary execution and live mutation.
 * - Protected paths require manual user approval before apply.
 * - Unconfirmed roots, outside-workspace paths, and secret paths fail closed.
 * - Approval requests cannot approve themselves.
 * - Agent reports are strictly informational (agent-reported).
 */

// ── Policy Types & Errors ──────────────────────────────────────────────────
export {
  type PolicyDecisionType,
  type PolicyReasonCode,
  PolicyReasonCode as PolicyReasons,
  type PolicyDecision,
  type CallerType,
  type CallerIdentity,
  type ExecutionMode,
  type PolicyConfig,
  type ApprovalStatus,
  type PendingApprovalRequest,
  type ActionRequest,
  type PolicyEvaluationContext,
} from './policyTypes.js';

export {
  mapReasonCodeToErrorCode,
  policyDecisionToError,
} from './policyErrors.js';

// ── Canonical Action Registry ──────────────────────────────────────────────
export {
  CanonicalActionId,
  type CanonicalActionIdValue,
  CANONICAL_ACTION_IDS,
  type ActionEffectFlags,
  type ActionDefinition,
  ACTION_REGISTRY,
  getActionDefinition,
  isCanonicalActionId,
} from './actionRegistry.js';

// ── Protected Paths ────────────────────────────────────────────────────────
export {
  type ProtectedPathRule,
  type ProtectedPathMatch,
  DEFAULT_PROTECTED_PATH_RULES,
  normalizePathForProtection,
  isProtectedPath,
} from './protectedPaths.js';

// ── Approval Management ────────────────────────────────────────────────────
export {
  type CreateApprovalParams,
  type ResolveApprovalParams,
  type ResolveApprovalResult,
  type ConsumeApprovalResult,
  ApprovalStore,
} from './approvalManager.js';

// ── Evidence Classification ────────────────────────────────────────────────
export {
  type ClassifiedEvidence,
  classifyEvidence,
} from './evidenceClassifier.js';

// ── Policy Defaults ────────────────────────────────────────────────────────
export {
  DEFAULT_POLICY_CONFIG,
  resolvePolicyConfig,
} from './policyDefaults.js';

// ── Authoritative Evaluator ────────────────────────────────────────────────
export {
  evaluateAction,
} from './policyEvaluator.js';
