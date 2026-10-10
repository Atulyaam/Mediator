/**
 * @mediator/policy-engine — Policy Types (S07)
 *
 * Defines the canonical policy decision model, caller identities,
 * policy configurations, and evaluation contexts.
 *
 * Pure data types — no filesystem, network, or execution dependencies.
 */

import { type WorkspaceRootState } from '@mediator/workspace-boundary';
import { type Task, type Session, type EvidenceLevelValue } from '@mediator/shared-contracts';

// ─── Canonical Decision Model ──────────────────────────────────────────────

export type PolicyDecisionType = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'UNSUPPORTED';

export const PolicyReasonCode = {
  // Allow
  OK: 'OK',

  // Workspace / Boundary denials
  WORKSPACE_UNCONFIRMED: 'WORKSPACE_UNCONFIRMED',
  WORKSPACE_UNRESOLVED: 'WORKSPACE_UNRESOLVED',
  PATH_OUTSIDE_WORKSPACE: 'PATH_OUTSIDE_WORKSPACE',
  PATH_EXCLUDED_SECRET: 'PATH_EXCLUDED_SECRET',

  // Secret denials
  CONTENT_SECRET_DETECTED: 'CONTENT_SECRET_DETECTED',
  CONTENT_SCAN_FAILED: 'CONTENT_SCAN_FAILED',

  // Protected paths
  PROTECTED_PATH_REQUIRES_APPROVAL: 'PROTECTED_PATH_REQUIRES_APPROVAL',
  PROTECTED_PATH_CANNOT_AUTO_APPLY: 'PROTECTED_PATH_CANNOT_AUTO_APPLY',

  // Review-only / Execution denials
  REVIEW_ONLY_MODE_BLOCKS_MUTATION: 'REVIEW_ONLY_MODE_BLOCKS_MUTATION',
  REVIEW_ONLY_MODE_BLOCKS_EXECUTION: 'REVIEW_ONLY_MODE_BLOCKS_EXECUTION',
  ARBITRARY_COMMAND_DENIED: 'ARBITRARY_COMMAND_DENIED',
  EXECUTOR_UNAVAILABLE: 'EXECUTOR_UNAVAILABLE',
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',

  // Schema & Action validation
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  TASK_STATE_INVALID: 'TASK_STATE_INVALID',
  TASK_ID_MISMATCH: 'TASK_ID_MISMATCH',
  POLICY_TAMPERING_ATTEMPT: 'POLICY_TAMPERING_ATTEMPT',
  UNSUPPORTED_ACTION: 'UNSUPPORTED_ACTION',

  // Approvals
  CALLER_UNAUTHORIZED_FOR_APPROVAL: 'CALLER_UNAUTHORIZED_FOR_APPROVAL',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  APPROVAL_ALREADY_RESOLVED: 'APPROVAL_ALREADY_RESOLVED',
  APPROVAL_PAYLOAD_MISMATCH: 'APPROVAL_PAYLOAD_MISMATCH',
} as const;

export type PolicyReasonCode = (typeof PolicyReasonCode)[keyof typeof PolicyReasonCode];

export interface PolicyDecision {
  /** The high-level verdict */
  readonly decision: PolicyDecisionType;
  /** Typed, stable reason code */
  readonly reasonCode: PolicyReasonCode;
  /** Stable action ID evaluated */
  readonly actionId: string;
  /** Tracing correlation ID */
  readonly correlationId: string;
  /** Rule IDs that triggered or contributed to this decision */
  readonly applicableRuleIds: readonly string[];
  /** Safe explanation for users and diagnostics (NEVER contains secrets) */
  readonly explanation: string;
  /** Created or referenced approval ID if decision is REQUIRE_APPROVAL or approval requested */
  readonly approvalId?: string | undefined;
  /** Structured safe metadata (no secrets or arbitrary content) */
  readonly details?: Record<string, unknown> | undefined;
}

// ─── Caller Identity ───────────────────────────────────────────────────────

export type CallerType = 'ide' | 'browser' | 'cli' | 'mcp' | 'agent' | 'core';

export interface CallerIdentity {
  /** The source component calling the policy engine */
  readonly type: CallerType;
  /** Optional identifier for the caller instance */
  readonly id?: string | undefined;
  /**
   * Whether this caller represents authenticated user UI interactions.
   * Only trusted UI callers (e.g. IDE UI / CLI explicit user confirmations)
   * may resolve pending approval requests.
   */
  readonly isTrustedUI?: boolean | undefined;
}

// ─── Execution Mode & Policy Configuration ─────────────────────────────────

export type ExecutionMode = 'review_only' | 'assisted' | 'autopilot';

export interface PolicyConfig {
  /**
   * Execution mode. Default: 'review_only' (ADR-002).
   * In review_only, automatic execution and live-workspace mutations are prohibited.
   */
  readonly executionMode: ExecutionMode;
  /** Whether live filesystem mutations are permitted without individual approval */
  readonly allowLiveMutation: boolean;
  /** Whether recipe runs are permitted through verified executor */
  readonly allowRecipeExecution: boolean;
  /** Whether protected paths mandate approval before any live application */
  readonly requireApprovalForProtectedPaths: boolean;
  /** Custom user-defined protected path patterns */
  readonly customProtectedPatterns?: readonly string[] | undefined;
  /** Timeout for pending approvals in milliseconds (default: 300_000 = 5 minutes) */
  readonly approvalTimeoutMs: number;
  /** Strict mode: fails closed on any uncertainty */
  readonly strictMode: boolean;
}

// ─── Approvals ─────────────────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PendingApprovalRequest {
  readonly approvalId: string;
  readonly taskId: string;
  readonly actionId: string;
  readonly targetPaths: readonly string[];
  readonly changeHash: string;
  readonly decision: PolicyDecisionType;
  readonly reason: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  status: ApprovalStatus;
  resolvedAt?: number | undefined;
  resolvedBy?: string | undefined;
  consumed?: boolean | undefined;
}

// ─── Action Request ────────────────────────────────────────────────────────

export interface ActionRequest<T = Record<string, unknown>> {
  /** Action ID (must be one of the 16 canonical actions) */
  readonly actionId: string;
  /** Correlation ID for tracing */
  readonly correlationId: string;
  /** Who is requesting this action */
  readonly caller: CallerIdentity;
  /** Action-specific parameters */
  readonly parameters: T;
}

// ─── Policy Evaluation Context ─────────────────────────────────────────────

export interface PolicyEvaluationContext {
  /** Current canonical workspace root state (from S04/S05) */
  readonly workspace: WorkspaceRootState;
  /** Active task (if action requires an active task) */
  readonly task?: Task | undefined;
  /** Active session */
  readonly session?: Session | undefined;
  /** Currently active pending approvals */
  readonly pendingApprovals?: readonly PendingApprovalRequest[] | undefined;
  /** Known executor capabilities (e.g. 'canary.verified', 'host.shell') */
  readonly capabilities?: ReadonlyMap<string, boolean> | undefined;
  /** Active evidence register (for verifying claims) */
  readonly recordedEvidence?: ReadonlyArray<{ id: string; level: EvidenceLevelValue }> | undefined;
}
