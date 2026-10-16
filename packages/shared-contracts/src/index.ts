/**
 * @mediator/shared-contracts
 *
 * Foundational protocol types, Zod schemas, typed error codes, and version constants.
 * This package has NO filesystem writes, NO network access, NO process execution.
 * It is a pure type/validation library importable by all other packages.
 */

import { z } from 'zod';

// ─── Protocol version ──────────────────────────────────────────────────────

export const PROTOCOL_VERSION = '1.3';
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// ─── Stable error codes ────────────────────────────────────────────────────

export const ErrorCode = {
  // Path / workspace boundary
  PATH_DENIED: 'PATH_DENIED',
  PATH_OUTSIDE_ROOT: 'PATH_OUTSIDE_ROOT',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  PATH_ALTERNATE_DATA_STREAM: 'PATH_ALTERNATE_DATA_STREAM',
  PATH_RESERVED_DEVICE: 'PATH_RESERVED_DEVICE',
  PATH_MALFORMED: 'PATH_MALFORMED',
  PATH_SYMLINK_ESCAPE: 'PATH_SYMLINK_ESCAPE',
  PATH_CLOUD_PLACEHOLDER: 'PATH_CLOUD_PLACEHOLDER',
  PATH_EXCLUDED: 'PATH_EXCLUDED',
  WORKSPACE_ROOT_UNCONFIRMED: 'WORKSPACE_ROOT_UNCONFIRMED',
  WORKSPACE_NOT_SELECTED: 'WORKSPACE_NOT_SELECTED',
  WORKSPACE_UNRESOLVED: 'WORKSPACE_UNRESOLVED',
  WORKSPACE_CONFIRMATION_REQUIRED: 'WORKSPACE_CONFIRMATION_REQUIRED',
  WORKSPACE_CONFIRMATION_DENIED: 'WORKSPACE_CONFIRMATION_DENIED',
  WORKSPACE_CHANGED: 'WORKSPACE_CHANGED',
  WORKSPACE_UNAVAILABLE: 'WORKSPACE_UNAVAILABLE',
  WORKSPACE_MISMATCH: 'WORKSPACE_MISMATCH',
  WORKSPACE_MULTIPLE_ROOTS: 'WORKSPACE_MULTIPLE_ROOTS',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  WORKSPACE_ROOT_AMBIGUOUS: 'WORKSPACE_ROOT_AMBIGUOUS',

  // Protocol / session
  NONCE_MISMATCH: 'NONCE_MISMATCH',
  SESSION_MISMATCH: 'SESSION_MISMATCH',
  TASK_MISMATCH: 'TASK_MISMATCH',
  ROUND_STALE: 'ROUND_STALE',
  SEQUENCE_DUPLICATE: 'SEQUENCE_DUPLICATE',
  SEQUENCE_OUT_OF_ORDER: 'SEQUENCE_OUT_OF_ORDER',
  ACTION_ID_DUPLICATE: 'ACTION_ID_DUPLICATE',
  PACKET_ALREADY_CONSUMED: 'PACKET_ALREADY_CONSUMED',
  CONVERSATION_CHANGED: 'CONVERSATION_CHANGED',
  CONVERSATION_MISMATCH: 'CONVERSATION_MISMATCH',
  BRANCH_MISMATCH: 'BRANCH_MISMATCH',
  MESSAGE_ID_MISMATCH: 'MESSAGE_ID_MISMATCH',
  IDENTITY_UNCERTAIN: 'IDENTITY_UNCERTAIN',
  BASE_STATE_HASH_MISMATCH: 'BASE_STATE_HASH_MISMATCH',
  STATUS_INVALID: 'STATUS_INVALID',
  CONFLICTING_COMPLETION_SIGNAL: 'CONFLICTING_COMPLETION_SIGNAL',
  TAMPERING_DETECTED: 'TAMPERING_DETECTED',
  TRANSFER_INCOMPLETE: 'TRANSFER_INCOMPLETE',
  TRANSFER_HASH_MISMATCH: 'TRANSFER_HASH_MISMATCH',
  ENVELOPE_EXPIRED: 'ENVELOPE_EXPIRED',
  PROTOCOL_VERSION_UNSUPPORTED: 'PROTOCOL_VERSION_UNSUPPORTED',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  OVERSIZED_INPUT: 'OVERSIZED_INPUT',
  CONTENT_BLOCK_MISSING: 'CONTENT_BLOCK_MISSING',
  CONTENT_BLOCK_DUPLICATE: 'CONTENT_BLOCK_DUPLICATE',

  // Policy / permissions
  ACTION_DENIED: 'ACTION_DENIED',
  ACTION_NOT_FOUND: 'ACTION_NOT_FOUND',
  PATH_PROTECTED: 'PATH_PROTECTED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_PAYLOAD_MISMATCH: 'APPROVAL_PAYLOAD_MISMATCH',

  // Execution / executor / capability (S21, S22)
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  CAPABILITY_PERMISSION_DENIED: 'CAPABILITY_PERMISSION_DENIED',
  SANDBOX_UNVERIFIED: 'SANDBOX_UNVERIFIED',
  EXECUTOR_NOT_CONFIGURED: 'EXECUTOR_NOT_CONFIGURED',
  RECIPE_NOT_FOUND: 'RECIPE_NOT_FOUND',
  RECIPE_HASH_MISMATCH: 'RECIPE_HASH_MISMATCH',
  EXECUTION_UNAVAILABLE: 'EXECUTION_UNAVAILABLE',
  EXECUTION_BLOCKED: 'EXECUTION_BLOCKED',
  CAPABILITY_EVIDENCE_STALE: 'CAPABILITY_EVIDENCE_STALE',
  CAPABILITY_EVIDENCE_MISMATCH: 'CAPABILITY_EVIDENCE_MISMATCH',
  CANARY_VERIFICATION_FAILED: 'CANARY_VERIFICATION_FAILED',
  UNTRUSTED_COMMAND_REJECTED: 'UNTRUSTED_COMMAND_REJECTED',

  // Recipes & Dependency Flow (S23)
  RECIPE_UNKNOWN: 'RECIPE_UNKNOWN',
  RECIPE_ARGUMENTS_INVALID: 'RECIPE_ARGUMENTS_INVALID',
  RECIPE_PATH_OUTSIDE_ROOT: 'RECIPE_PATH_OUTSIDE_ROOT',
  RECIPE_ENVIRONMENT_DISALLOWED: 'RECIPE_ENVIRONMENT_DISALLOWED',
  RECIPE_DEPENDENCY_MISSING: 'RECIPE_DEPENDENCY_MISSING',
  RECIPE_EXECUTION_BLOCKED: 'RECIPE_EXECUTION_BLOCKED',
  RECIPE_TAMPERED: 'RECIPE_TAMPERED',
  DEPENDENCY_RISK_DETECTED: 'DEPENDENCY_RISK_DETECTED',
  TASK_SCOPE_MISMATCH: 'TASK_SCOPE_MISMATCH',
  SESSION_INVALID: 'SESSION_INVALID',
  PATH_EXCLUDED_BY_RULE: 'PATH_EXCLUDED_BY_RULE',
  SECRET_DETECTED_IN_OUTPUT: 'SECRET_DETECTED_IN_OUTPUT',

  // Assisted End-to-End Loop & Orchestration (S24)
  WORKFLOW_STATE_INVALID: 'WORKFLOW_STATE_INVALID',
  WORKFLOW_TRANSITION_DISALLOWED: 'WORKFLOW_TRANSITION_DISALLOWED',
  WORKFLOW_BUDGET_EXCEEDED: 'WORKFLOW_BUDGET_EXCEEDED',
  WORKFLOW_LOOP_DETECTED: 'WORKFLOW_LOOP_DETECTED',

  // Recovery, Loop Guard & Observability (S25)
  RECOVERY_RECONCILIATION_REQUIRED: 'RECOVERY_RECONCILIATION_REQUIRED',
  RECOVERY_ACTION_UNKNOWN: 'RECOVERY_ACTION_UNKNOWN',
  RECOVERY_RESUME_DISALLOWED: 'RECOVERY_RESUME_DISALLOWED',
  DEBUG_BUNDLE_EXPORT_REFUSED: 'DEBUG_BUNDLE_EXPORT_REFUSED',
  DEBUG_BUNDLE_OVERSIZED: 'DEBUG_BUNDLE_OVERSIZED',

  // Autopilot Gate & Execution (S26 / ADR-031)
  AUTOPILOT_DISABLED: 'AUTOPILOT_DISABLED',
  AUTOPILOT_DEFERRED: 'AUTOPILOT_DEFERRED',
  AUTOPILOT_CAPABILITY_REVOKED: 'AUTOPILOT_CAPABILITY_REVOKED',
  AUTOPILOT_POLICY_DISALLOWED: 'AUTOPILOT_POLICY_DISALLOWED',
  AUTOPILOT_STOP_SECURITY_VIOLATION: 'AUTOPILOT_STOP_SECURITY_VIOLATION',
  AUTOPILOT_BUDGET_EXHAUSTED: 'AUTOPILOT_BUDGET_EXHAUSTED',
  AUTOPILOT_WORKTREE_ISOLATION_FAILED: 'AUTOPILOT_WORKTREE_ISOLATION_FAILED',
  AUTOPILOT_ITERATION_FAILED: 'AUTOPILOT_ITERATION_FAILED',

  // MCP / Scope
  MCP_MUTATION_PROHIBITED: 'MCP_MUTATION_PROHIBITED',
  UNAUTHORIZED_TASK_SCOPE: 'UNAUTHORIZED_TASK_SCOPE',

  // Staging
  STAGE_BASE_HASH_STALE: 'STAGE_BASE_HASH_STALE',
  STAGE_CONFLICT: 'STAGE_CONFLICT',
  STAGE_PATCH_AMBIGUOUS: 'STAGE_PATCH_AMBIGUOUS',
  STAGE_NOT_FOUND: 'STAGE_NOT_FOUND',

  // Core / IPC (S19)
  CORE_NOT_RUNNING: 'CORE_NOT_RUNNING',
  IPC_ORIGIN_REJECTED: 'IPC_ORIGIN_REJECTED',
  IPC_TOKEN_INVALID: 'IPC_TOKEN_INVALID',
  IPC_RATE_LIMIT: 'IPC_RATE_LIMIT',
  IPC_HANDSHAKE_FAILED: 'IPC_HANDSHAKE_FAILED',
  IPC_PAIRING_EXPIRED: 'IPC_PAIRING_EXPIRED',
  IPC_CONNECTION_CLOSED: 'IPC_CONNECTION_CLOSED',
  IPC_OPERATION_PROHIBITED: 'IPC_OPERATION_PROHIBITED',
  IPC_DEADLINE_EXCEEDED: 'IPC_DEADLINE_EXCEEDED',
  NATIVE_HOST_NOT_INSTALLED: 'NATIVE_HOST_NOT_INSTALLED',
  NATIVE_FRAME_OVERSIZED: 'NATIVE_FRAME_OVERSIZED',
  NATIVE_FRAME_MALFORMED: 'NATIVE_FRAME_MALFORMED',

  // Provider / Same-Chat (S20)
  SUBMISSION_UNCERTAIN: 'SUBMISSION_UNCERTAIN',
  SUBMISSION_DUPLICATE: 'SUBMISSION_DUPLICATE',
  PAGE_STRUCTURE_UNKNOWN: 'PAGE_STRUCTURE_UNKNOWN',
  RESPONSE_STREAMING: 'RESPONSE_STREAMING',
  PROVIDER_PAGE_UNSUPPORTED: 'PROVIDER_PAGE_UNSUPPORTED',

  // Evidence / verification
  AGENT_REPORT_UNVERIFIED: 'AGENT_REPORT_UNVERIFIED',
  EVIDENCE_INSUFFICIENT: 'EVIDENCE_INSUFFICIENT',

  // State machine
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  TASK_ALREADY_ACTIVE: 'TASK_ALREADY_ACTIVE',

  // Handoff & Report (S17)
  HANDOFF_NOT_FOUND: 'HANDOFF_NOT_FOUND',
  HANDOFF_EXPIRED: 'HANDOFF_EXPIRED',
  HANDOFF_CANCELLED: 'HANDOFF_CANCELLED',
  HANDOFF_STALE: 'HANDOFF_STALE',
  HANDOFF_TASK_MISMATCH: 'HANDOFF_TASK_MISMATCH',
  REPORT_SCHEMA_INVALID: 'REPORT_SCHEMA_INVALID',
  REPORT_OVERSIZED: 'REPORT_OVERSIZED',
  REPORT_DISCREPANCY_DETECTED: 'REPORT_DISCREPANCY_DETECTED',
  REVIEW_REQUEST_NOT_FOUND: 'REVIEW_REQUEST_NOT_FOUND',
  REVIEW_REQUEST_EXPIRED: 'REVIEW_REQUEST_EXPIRED',
  REVIEW_REQUEST_INVALIDATED: 'REVIEW_REQUEST_INVALIDATED',
  REVIEW_REQUEST_ALREADY_RESOLVED: 'REVIEW_REQUEST_ALREADY_RESOLVED',

  // Multi-Provider & Two-Mode Architecture (S29-S32)
  PROVIDER_UNKNOWN: 'PROVIDER_UNKNOWN',
  PROVIDER_MODE_UNSUPPORTED: 'PROVIDER_MODE_UNSUPPORTED',
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  PROVIDER_CREDENTIAL_MISSING: 'PROVIDER_CREDENTIAL_MISSING',
  PROVIDER_CREDENTIAL_INVALID: 'PROVIDER_CREDENTIAL_INVALID',
  PROVIDER_SWITCH_NOT_ALLOWED: 'PROVIDER_SWITCH_NOT_ALLOWED',
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_OUTAGE: 'PROVIDER_OUTAGE',
  PROVIDER_MODEL_UNSUPPORTED: 'PROVIDER_MODEL_UNSUPPORTED',
  PROVIDER_MALFORMED_RESPONSE: 'PROVIDER_MALFORMED_RESPONSE',
  PROVIDER_OVERSIZED_RESPONSE: 'PROVIDER_OVERSIZED_RESPONSE',
  PROVIDER_SESSION_MISMATCH: 'PROVIDER_SESSION_MISMATCH',
  PROVIDER_CANCELLED: 'PROVIDER_CANCELLED',
  PROVIDER_API_UNAVAILABLE: 'PROVIDER_API_UNAVAILABLE',
  PROVIDER_REQUEST_INVALID: 'PROVIDER_REQUEST_INVALID',

  // General
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SECRET_DETECTED: 'SECRET_DETECTED',

  // Offline Toolchain & Dependency Supply Chain (S46)
  TOOLCHAIN_UNAVAILABLE: 'TOOLCHAIN_UNAVAILABLE',
  BUNDLE_INTEGRITY_MISMATCH: 'BUNDLE_INTEGRITY_MISMATCH',
  BUNDLE_PATH_TRAVERSAL: 'BUNDLE_PATH_TRAVERSAL',
  BUNDLE_CORRUPTED: 'BUNDLE_CORRUPTED',
  BUNDLE_OVERSIZED: 'BUNDLE_OVERSIZED',
  BUNDLE_MANIFEST_INVALID: 'BUNDLE_MANIFEST_INVALID',
  OFFLINE_DEPENDENCY_MISSING: 'OFFLINE_DEPENDENCY_MISSING',

  // Diagnostics & System Health (S48)
  DIAGNOSTICS_FAILED: 'DIAGNOSTICS_FAILED',
  DIAGNOSTIC_EXPORT_REFUSED: 'DIAGNOSTIC_EXPORT_REFUSED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ─── Typed error ───────────────────────────────────────────────────────────

export interface MediatorError {
  readonly code: ErrorCodeValue;
  readonly message: string;
  readonly taskId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly actionId?: string | undefined;
  readonly detail?: Record<string, unknown> | undefined;
}

export function makeMediatorError(
  code: ErrorCodeValue,
  message: string,
  context?: Omit<MediatorError, 'code' | 'message'>,
): MediatorError {
  return { code, message, ...context };
}

// ─── Result type ───────────────────────────────────────────────────────────

export type Result<T, E = MediatorError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ─── Correlation / tracing IDs ─────────────────────────────────────────────

export interface CorrelationContext {
  readonly requestId?: string | undefined;
  readonly taskId: string;
  readonly sessionId: string;
  readonly roundId?: string | undefined;
  readonly correlationId: string;
  readonly actionId?: string | undefined;
}

// ─── Boundary event ────────────────────────────────────────────────────────

export interface BoundaryEvent<T = unknown> {
  readonly eventId: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly taskId: string;
  readonly sessionId?: string | undefined;
  readonly timestamp: number;
  readonly source: 'ide' | 'browser' | 'cli' | 'mcp' | 'core';
  readonly type: string;
  readonly payload: T;
}

// ─── Task / session states ─────────────────────────────────────────────────

export const TaskState = {
  IDLE: 'IDLE',
  ATTACHED: 'ATTACHED',
  TASK_DEFINED: 'TASK_DEFINED',
  WAITING_FOR_AI: 'WAITING_FOR_AI',
  VALIDATING: 'VALIDATING',
  STAGING: 'STAGING',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  READY_TO_VERIFY: 'READY_TO_VERIFY',
  EXECUTING: 'EXECUTING',
  SANITIZING: 'SANITIZING',
  RETURNING_TO_SAME_CHAT: 'RETURNING_TO_SAME_CHAT',
  HANDOFF_PROMPT_READY: 'HANDOFF_PROMPT_READY',
  WAITING_FOR_USER_SUBMISSION: 'WAITING_FOR_USER_SUBMISSION',
  AGENT_REPORT_RECEIVED: 'AGENT_REPORT_RECEIVED',
  PAUSED: 'PAUSED',
  DENIED: 'DENIED',
  FAILED_SAFE: 'FAILED_SAFE',
  STOPPED: 'STOPPED',
  VERIFIED_COMPLETE: 'VERIFIED_COMPLETE',
  USER_ACCEPTED_UNVERIFIED: 'USER_ACCEPTED_UNVERIFIED',
} as const;

export type TaskStateValue = (typeof TaskState)[keyof typeof TaskState];

// ─── Evidence levels ───────────────────────────────────────────────────────

export const EvidenceLevel = {
  MEDIATOR_EXECUTOR_VERIFIED: 'mediator-executor-verified',
  TRUSTED_IDE_API_VERIFIED: 'trusted-ide-api-verified',
  IDE_DIAGNOSTIC_OBSERVED: 'ide-diagnostic-observed',
  AGENT_REPORTED: 'agent-reported',
  USER_VERIFIED: 'user-verified',
  MANUAL_RESULT_REPORTED: 'manual-result-reported',
  USER_ACCEPTED_UNVERIFIED: 'user-accepted-unverified',
} as const;

export type EvidenceLevelValue = (typeof EvidenceLevel)[keyof typeof EvidenceLevel];

export const VERIFICATION_GATE_LEVELS = new Set<EvidenceLevelValue>([
  EvidenceLevel.MEDIATOR_EXECUTOR_VERIFIED,
  EvidenceLevel.TRUSTED_IDE_API_VERIFIED,
]);

/** Returns true only if the evidence level can satisfy an automated verification gate */
export function canSatisfyVerificationGate(level: EvidenceLevelValue): boolean {
  return VERIFICATION_GATE_LEVELS.has(level);
}

// ─── Protocol action types ─────────────────────────────────────────────────

export const ActionType = {
  LIST_FILES: 'list_files',
  READ_FILE: 'read_file',
  SEARCH_TEXT: 'search_text',
  GET_DIAGNOSTICS: 'get_diagnostics',
  GET_DIFF: 'get_diff',
  REQUEST_MORE_CONTEXT: 'request_more_context',
  PROPOSE_PATCH: 'propose_patch',
  REQUEST_RECIPE_RUN: 'request_recipe_run',
  REQUEST_DEPENDENCY_CHANGE: 'request_dependency_change',
  REQUEST_NETWORK_ACCESS: 'request_network_access',
  REQUEST_DELETE: 'request_delete',
  REQUEST_RENAME: 'request_rename',
  ASK_USER: 'ask_user',
  REPORT_PROGRESS: 'report_progress',
} as const;

export type ActionTypeValue = (typeof ActionType)[keyof typeof ActionType];

/** Actions that ALWAYS require manual user review — never auto-applied */
export const MANUAL_REVIEW_REQUIRED_ACTIONS = new Set<ActionTypeValue>([
  ActionType.REQUEST_RECIPE_RUN,
  ActionType.REQUEST_DEPENDENCY_CHANGE,
  ActionType.REQUEST_NETWORK_ACCESS,
  ActionType.REQUEST_DELETE,
  ActionType.REQUEST_RENAME,
]);

// ─── Protocol envelope status ──────────────────────────────────────────────

export const EnvelopeStatus = {
  CONTINUE: 'continue',
  AWAIT_USER: 'await_user',
  COMPLETE: 'complete',
  PROPOSED_COMPLETE: 'proposed_complete',
} as const;

export type EnvelopeStatusValue = (typeof EnvelopeStatus)[keyof typeof EnvelopeStatus];

// ─── Canonical Multi-Provider Architecture (S29) ───────────────────────────

export const CANONICAL_PROVIDER_IDS = ['openai', 'gemini', 'claude', 'deepseek'] as const;
export type CanonicalProviderId = (typeof CANONICAL_PROVIDER_IDS)[number];

export const PROVIDER_MODES = ['browser', 'api', 'manual'] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

export type ProviderConnectionStatus =
  | 'not-configured'
  | 'configured'
  | 'connected'
  | 'auth-failed'
  | 'rate-limited'
  | 'temporarily-unavailable'
  | 'unsupported-mode'
  | 'user-action-required'
  | 'disabled'
  | 'unverified';

export interface ProviderConnectionId {
  readonly provider: CanonicalProviderId;
  readonly mode: ProviderMode;
  readonly accountOrSessionId?: string | undefined;
}

export function serializeConnectionId(conn: ProviderConnectionId): string {
  if (conn.accountOrSessionId) {
    return `${conn.provider}:${conn.mode}:${conn.accountOrSessionId}`;
  }
  return `${conn.provider}:${conn.mode}`;
}

export function parseConnectionId(raw: string): Result<ProviderConnectionId, MediatorError> {
  if (!raw || typeof raw !== 'string') {
    return err(
      makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Connection ID must be a non-empty string'),
    );
  }
  const parts = raw.split(':');
  if (parts.length < 2 || parts.length > 3) {
    return err(
      makeMediatorError(
        ErrorCode.SCHEMA_INVALID,
        `Invalid connection ID format "${raw}". Expected "provider:mode" or "provider:mode:sessionId".`,
        { detail: { raw } },
      ),
    );
  }
  const [rawProvider, rawMode, accountOrSessionId] = parts;
  const normalizedProvider = normalizeProviderId(rawProvider!);
  if (!normalizedProvider) {
    return err(
      makeMediatorError(
        ErrorCode.PROVIDER_UNKNOWN,
        `Unknown or unsupported provider ID "${rawProvider}". Allowed: ${CANONICAL_PROVIDER_IDS.join(', ')}.`,
        { detail: { rawProvider, allowed: CANONICAL_PROVIDER_IDS } },
      ),
    );
  }
  if (!PROVIDER_MODES.includes(rawMode as ProviderMode)) {
    return err(
      makeMediatorError(
        ErrorCode.PROVIDER_MODE_UNSUPPORTED,
        `Unsupported provider mode "${rawMode}". Allowed: ${PROVIDER_MODES.join(', ')}.`,
        { detail: { rawMode, allowed: PROVIDER_MODES } },
      ),
    );
  }

  return ok({
    provider: normalizedProvider,
    mode: rawMode as ProviderMode,
    ...(accountOrSessionId ? { accountOrSessionId } : {}),
  });
}

export function isCanonicalProviderId(id: string): id is CanonicalProviderId {
  return (CANONICAL_PROVIDER_IDS as readonly string[]).includes(id);
}

export function normalizeProviderId(id: string): CanonicalProviderId | undefined {
  if (!id) return undefined;
  const lower = id.toLowerCase().trim();
  if (isCanonicalProviderId(lower)) return lower;
  if (lower === 'google-gemini') return 'gemini';
  if (lower === 'openai-chatgpt' || lower === 'chatgpt') return 'openai';
  if (lower === 'anthropic' || lower === 'anthropic-claude') return 'claude';
  return undefined;
}

export interface ProviderCapabilities {
  readonly supportsBrowserBridge: boolean;
  readonly supportsOfficialApi: boolean;
  readonly supportsManualHandoff: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsCancellation: boolean;
  readonly supportsModelSelection: boolean;
  readonly supportsUsageTracking: boolean;
  readonly supportsCostEstimation: boolean;
  readonly supportsSystemPrompt: boolean;
  readonly supportsImageInput: boolean;
}

export interface ProviderModelConfig {
  readonly id: string;
  readonly displayName: string;
  readonly contextWindowTokens?: number | undefined;
  readonly defaultMaxTokens?: number | undefined;
  readonly inputCostPerMillionUsd?: number | undefined;
  readonly outputCostPerMillionUsd?: number | undefined;
  readonly recommended?: boolean | undefined;
}

export interface ProviderUsageMetadata {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly estimatedCostUsd?: number | undefined;
  readonly latencyMs?: number | undefined;
}

export interface CredentialMetadata {
  readonly providerId: CanonicalProviderId;
  readonly keyHash: string; // sha256 prefix for identification, NEVER raw secret
  readonly lastFour: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly storageType: 'dpapi' | 'wincred' | 'encrypted-local';
}

export interface ProviderMetadata {
  readonly providerId: CanonicalProviderId;
  readonly displayName: string;
  readonly description: string;
  readonly officialWebsiteUrl: string;
  readonly officialApiDocsUrl: string;
  readonly supportedModes: readonly ProviderMode[];
  readonly capabilities: ProviderCapabilities;
  readonly availableModels: readonly ProviderModelConfig[];
  readonly defaultModelId?: string | undefined;
}

// ─── Provider & Conversation identity ──────────────────────────────────────

export interface ProviderIdentity {
  readonly provider: string;
  readonly conversationId: string;
  readonly tabId?: number | undefined;
  readonly messageId?: string | undefined;
  readonly branchId?: string | undefined;
  readonly chatTitle?: string | undefined;
}

export type ConversationIdentity = ProviderIdentity;

// ─── Shared Task, Session, Round, Evidence ─────────────────────────────────

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly workspaceRoot: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly state: TaskStateValue;
  readonly maxRounds: number;
}

export interface Session {
  readonly id: string;
  readonly taskId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly provider: ProviderIdentity;
  readonly state: TaskStateValue;
}

export interface Round {
  readonly roundNumber: number;
  readonly taskId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly nonce: string;
  readonly startedAt: number;
  readonly completedAt?: number | undefined;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'failed';
  readonly actionCount: number;
}

export interface Evidence {
  readonly id: string;
  readonly level: EvidenceLevelValue;
  readonly source: string;
  readonly timestamp: number;
  readonly summary: string;
  readonly artifactRef?: string | undefined;
  readonly rawDetails?: Record<string, unknown> | undefined;
}

// ─── Workspace Root State ──────────────────────────────────────────────────

export type WorkspaceSelectionSource = 'ide' | 'cli';
export type WorkspaceConfirmationStatus = 'pending' | 'confirmed' | 'denied';
export type WorkspaceResolutionStatus = 'resolved' | 'missing' | 'unavailable' | 'unresolved';
export type WorkspaceCloudStatus =
  | 'not_cloud'
  | 'onedrive_redirected'
  | 'cloud_placeholder'
  | 'unknown';

export interface WorkspaceRootState {
  readonly selectedPath: string;
  readonly canonicalPath: string | null;
  readonly selectionSource: WorkspaceSelectionSource;
  readonly confirmationStatus: WorkspaceConfirmationStatus;
  readonly confirmationTimestamp?: number | undefined;
  readonly resolutionStatus: WorkspaceResolutionStatus;
  readonly cloudStatus: WorkspaceCloudStatus;
}

// ─── Contained Path State (S05) ────────────────────────────────────────────

export type FileOperationType = 'read' | 'write' | 'delete' | 'patch' | 'rename' | 'list';

export interface ContainedPath {
  /** The original input path requested */
  readonly inputPath: string;
  /** The validated absolute canonical path on disk (or safe projected target) */
  readonly resolvedPath: string;
  /** The normalized relative path from canonical root using forward slashes */
  readonly relativePath: string;
  /** Whether the target currently exists on disk */
  readonly exists: boolean;
  /** Whether the target is a directory (if exists) */
  readonly isDirectory?: boolean | undefined;
}


// ─── Action definitions ────────────────────────────────────────────────────

export interface BaseAction {
  readonly id: string;
  readonly type: ActionTypeValue;
}

export interface ListFilesAction extends BaseAction {
  readonly type: 'list_files';
  readonly pathPrefix: string;
  readonly limit: number;
}

export interface ReadFileAction extends BaseAction {
  readonly type: 'read_file';
  readonly path: string;
  readonly rangeStart?: number;
  readonly rangeEnd?: number;
}

export interface SearchTextAction extends BaseAction {
  readonly type: 'search_text';
  readonly query: string;
  readonly pathGlob?: string;
  readonly limit: number;
}

export interface GetDiagnosticsAction extends BaseAction {
  readonly type: 'get_diagnostics';
  readonly path?: string;
}

export interface GetDiffAction extends BaseAction {
  readonly type: 'get_diff';
  readonly fileSelector?: string;
}

export interface RequestMoreContextAction extends BaseAction {
  readonly type: 'request_more_context';
  readonly reason: string;
  readonly topicHints?: string[];
  readonly pathHints?: string[];
  readonly byteBudget?: number;
}

export interface ProposePatchAction extends BaseAction {
  readonly type: 'propose_patch';
  readonly path: string;
  readonly expectedBaseHash: string;
  readonly contentBlockId: string;
}

export interface RequestRecipeRunAction extends BaseAction {
  readonly type: 'request_recipe_run';
  readonly recipeId: string;
  readonly parameters: Record<string, string>;
}

export interface RequestDependencyChangeAction extends BaseAction {
  readonly type: 'request_dependency_change';
  readonly ecosystem: string;
  readonly name: string;
  readonly version: string;
  readonly rationale: string;
}

export interface RequestNetworkAccessAction extends BaseAction {
  readonly type: 'request_network_access';
  readonly domains: string[];
  readonly reason: string;
  readonly durationSeconds: number;
}

export interface RequestDeleteAction extends BaseAction {
  readonly type: 'request_delete';
  readonly path: string;
  readonly expectedHash: string;
}

export interface RequestRenameAction extends BaseAction {
  readonly type: 'request_rename';
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceHash: string;
}

export interface AskUserAction extends BaseAction {
  readonly type: 'ask_user';
  readonly question: string;
  readonly options?: string[];
}

export interface ReportProgressAction extends BaseAction {
  readonly type: 'report_progress';
  readonly summary: string;
  readonly referencedActionIds?: string[];
}

export type AnyAction =
  | ListFilesAction
  | ReadFileAction
  | SearchTextAction
  | GetDiagnosticsAction
  | GetDiffAction
  | RequestMoreContextAction
  | ProposePatchAction
  | RequestRecipeRunAction
  | RequestDependencyChangeAction
  | RequestNetworkAccessAction
  | RequestDeleteAction
  | RequestRenameAction
  | AskUserAction
  | ReportProgressAction;

// ─── Content block ─────────────────────────────────────────────────────────

export interface ContentBlock {
  readonly id: string;
  readonly delimiter: string;
  readonly encoding: 'utf-8';
  readonly byteLength: number;
  readonly sha256: string;
}

// ─── Protocol envelope ─────────────────────────────────────────────────────

export interface ProtocolEnvelope {
  readonly protocolVersion: ProtocolVersion;
  readonly taskId: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly round: number;
  readonly sequence: number;
  readonly conversation: ConversationIdentity;
  readonly baseStateHash: string;
  readonly status: EnvelopeStatusValue;
  readonly actions: AnyAction[];
  readonly contentBlocks: ContentBlock[];
}

// ─── Approval ──────────────────────────────────────────────────────────────

export interface PendingApproval {
  readonly approvalId: string;
  readonly actionId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly payloadHash: string;
  readonly scope: string;
  readonly expiresAt: number; // unix ms
  readonly createdAt: number;
  readonly risk: 'low' | 'medium' | 'high';
  readonly description: string;
}

export interface ResolvedApproval extends PendingApproval {
  readonly resolvedAt: number;
  readonly resolution: 'approved' | 'denied';
  readonly resolvedBy: 'ide-ui';
}

// ─── IDE capability contracts (Sprint S15) ─────────────────────────────────

export type CapabilityStatus =
  | 'supported'
  | 'available'
  | 'unavailable'
  | 'permission_denied'
  | 'not_yet_verified'
  | 'disabled'
  | 'unknown';

export type IdeCapabilityId =
  | 'canonical_workspace'
  | 'file_enumeration'
  | 'git_status'
  | 'diagnostics'
  | 'language_symbols'
  | 'test_discovery'
  | 'editor_context'
  | 'file_change_events'
  | 'ide_product_info';

export interface IdeCapabilityReportItem {
  readonly capabilityId: IdeCapabilityId;
  readonly status: CapabilityStatus;
  readonly dataSource?: string | undefined;
  readonly productName?: string | undefined;
  readonly productVersion?: string | undefined;
  readonly timestamp: number;
  readonly reason?: string | undefined;
  readonly correlationId: string;
}

export interface IdeCapabilityMatrix {
  readonly productName: string;
  readonly productVersion?: string | undefined;
  readonly ideFamily: 'vscode' | 'antigravity' | 'unknown';
  readonly verifiedAt: number;
  readonly correlationId: string;
  readonly capabilities: Record<IdeCapabilityId, IdeCapabilityReportItem>;
}

export interface IdeProductInfo {
  readonly productName: string;
  readonly version?: string | undefined;
  readonly ideFamily: 'vscode' | 'antigravity' | 'unknown';
  readonly environment?: 'desktop' | 'web' | 'unknown' | undefined;
  readonly isVSCode: boolean;
  readonly isAntigravity: boolean;
}

export interface IdeGitStatus {
  readonly isAvailable: boolean;
  readonly branch?: string | undefined;
  readonly modifiedFiles: readonly string[];
  readonly stagedFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly aheadCount?: number | undefined;
  readonly behindCount?: number | undefined;
}

export interface IdeDiagnosticItem {
  readonly filePath: string;
  readonly severity: 'error' | 'warning' | 'info' | 'hint';
  readonly message: string;
  readonly range: {
    readonly startLine: number;
    readonly startCol: number;
    readonly endLine: number;
    readonly endCol: number;
  };
  readonly source?: string | undefined;
  readonly code?: string | number | undefined;
}

export interface IdeDiagnosticsResult {
  readonly status: CapabilityStatus;
  readonly items: readonly IdeDiagnosticItem[];
  readonly totalCount: number;
  readonly truncated: boolean;
}

export interface IdeSymbolItem {
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly range: {
    readonly startLine: number;
    readonly startCol: number;
    readonly endLine: number;
    readonly endCol: number;
  };
  readonly containerName?: string | undefined;
}

export interface IdeSymbolsResult {
  readonly status: CapabilityStatus;
  readonly symbols: readonly IdeSymbolItem[];
  readonly truncated: boolean;
}

export interface IdeTestDiscoveryResult {
  readonly status: CapabilityStatus;
  readonly framework?: string | undefined;
  readonly candidateTestFiles: readonly string[];
  readonly testCommands: readonly string[];
  readonly isPartial: boolean;
}

export interface EditorSelectionContext {
  readonly filePath: string;
  readonly cursorPosition: {
    readonly line: number;
    readonly character: number;
  };
  readonly selectionRange?: {
    readonly startLine: number;
    readonly startCol: number;
    readonly endLine: number;
    readonly endCol: number;
  } | undefined;
  readonly selectedText?: string | undefined;
  readonly hasOptedIn: boolean;
  readonly redacted?: boolean | undefined;
}

export interface EditorConsentSettings {
  readonly allowEditorContext: boolean;
  readonly allowSelectedText: boolean;
  readonly maxSelectedTextBytes?: number | undefined;
}

export interface IdeFileChangeEvent {
  readonly type: 'create' | 'modify' | 'delete' | 'rename';
  readonly path: string;
  readonly oldPath?: string | undefined;
  readonly timestamp?: number | undefined;
}

// ─── Handoff & Report Domain Models (S17) ───────────────────────────────────

export const HandoffStatus = {
  PREPARED: 'prepared',
  WAITING_FOR_AGENT: 'waiting-for-agent',
  REPORT_RECEIVED: 'report-received',
  REVIEW_REQUIRED: 'review-required',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  REJECTED: 'rejected',
} as const;

export type HandoffStatusValue = (typeof HandoffStatus)[keyof typeof HandoffStatus];

export interface HandoffRecord {
  readonly handoffId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly stageId?: string | undefined;
  readonly workspaceRoot: string;
  readonly correlationId: string;
  readonly status: HandoffStatusValue;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly promptHash: string;
  readonly promptPreviewSafe: string;
  readonly allowedScope: readonly string[];
  readonly expectedReportSchemaVersion: string;
  readonly callerSource: string;
  readonly cancellationReason?: string | undefined;
  readonly linkedApprovalId?: string | undefined;
  readonly auditRef?: string | undefined;
}

export interface ClaimedVerificationCommand {
  readonly command: string;
  readonly exitCode?: number | undefined;
  readonly outputSnippet?: string | undefined;
  readonly actuallyRun: boolean;
}

export interface ClaimedFileOperation {
  readonly path: string;
  readonly operation: string;
}

export interface AgentReport {
  readonly reportId: string;
  readonly handoffId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly summary: string;
  readonly claimedChangedPaths: readonly string[];
  readonly claimedOperations?: readonly ClaimedFileOperation[] | undefined;
  readonly claimedVerificationCommands?: readonly ClaimedVerificationCommand[] | undefined;
  readonly blockers?: readonly string[] | undefined;
  readonly stageId?: string | undefined;
  readonly actionId?: string | undefined;
  readonly submittedAt: number;
  readonly schemaVersion: string;
}

export const AgentReportSchema = z.object({
  reportId: z.string().min(1),
  handoffId: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  summary: z.string().max(8192),
  claimedChangedPaths: z.array(z.string()).max(100),
  claimedOperations: z.array(z.object({
    path: z.string().max(1024),
    operation: z.string().max(64),
  })).max(100).optional(),
  claimedVerificationCommands: z.array(z.object({
    command: z.string().max(1024),
    exitCode: z.number().int().optional(),
    outputSnippet: z.string().max(4096).optional(),
    actuallyRun: z.boolean(),
  })).max(50).optional(),
  blockers: z.array(z.string().max(512)).max(50).optional(),
  stageId: z.string().max(128).optional(),
  actionId: z.string().max(128).optional(),
  submittedAt: z.number().int().positive(),
  schemaVersion: z.string().default('1.0'),
});

export interface HandoffReportDiscrepancy {
  readonly type: 'claimed_files_not_staged' | 'staged_files_not_claimed' | 'outside_scope_path' | 'secret_path_claimed';
  readonly path: string;
  readonly detail: string;
}

export interface IngestReportResult {
  readonly reportId: string;
  readonly handoffId: string;
  readonly status: HandoffStatusValue;
  readonly evidenceId: string;
  readonly evidenceLevel: EvidenceLevelValue;
  readonly discrepancies: readonly HandoffReportDiscrepancy[];
  readonly requiresReview: boolean;
  readonly summarySafe: string;
}

export const ReviewRequestStatus = {
  PENDING_REVIEW: 'pending-review',
  APPROVED: 'approved',
  DENIED: 'denied',
  EXPIRED: 'expired',
  INVALIDATED: 'invalidated',
} as const;

export type ReviewRequestStatusValue = (typeof ReviewRequestStatus)[keyof typeof ReviewRequestStatus];

export interface PendingReviewRequest {
  readonly requestId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly actionId?: string | undefined;
  readonly stageId?: string | undefined;
  readonly payloadHash: string;
  readonly requestedScope: readonly string[];
  readonly origin: string;
  readonly reason: string;
  readonly status: ReviewRequestStatusValue;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly correlationId: string;
  readonly resolvedAt?: number | undefined;
  readonly resolvedBy?: string | undefined;
  readonly resolutionReason?: string | undefined;
}

export const RequestReviewInputSchema = z.object({
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  actionId: z.string().optional(),
  stageId: z.string().optional(),
  payloadHash: z.string().optional(),
  requestedScope: z.array(z.string()).min(1),
  reason: z.string().min(1).max(2048),
  timeoutMs: z.number().int().positive().optional(),
});

// ─── Executor capability field ─────────────────────────────────────────────

export type CapabilityEnforcer = 'mediator' | 'ide' | 'host' | 'unknown';

export interface CapabilityField {
  readonly value: boolean;
  readonly enforcedBy: CapabilityEnforcer;
  readonly evidenceRef: string | null;
}

/** unknown capability field — always treated as false */
export const CAPABILITY_UNKNOWN: CapabilityField = {
  value: false,
  enforcedBy: 'unknown',
  evidenceRef: null,
};

export interface ExecutorCapability {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly probeId: string;
  readonly verifiedAt: string;
  readonly supported: boolean;
  readonly stageRoot: {
    readonly read: CapabilityField;
    readonly write: CapabilityField;
  };
  readonly liveWorkspace: {
    readonly read: CapabilityField;
    readonly write: CapabilityField;
  };
  readonly process: {
    readonly fixedExecutableAndArgs: CapabilityField;
    readonly childProcessConfinement: CapabilityField;
    readonly hostShellFallback: CapabilityField;
  };
  readonly network: {
    readonly defaultDeny: CapabilityField;
    readonly allowedDomains: CapabilityField;
  };
  readonly limits: {
    readonly timeout: CapabilityField;
    readonly outputBytes: CapabilityField;
    readonly cpuMemory: CapabilityField;
    readonly cancelChildTree: CapabilityField;
  };
  readonly capturesRealExitCode: boolean;
}

/**
 * Check all required capability fields to determine if automatic execution is permitted.
 * ALL required fields must be non-unknown and pass for execution to be enabled.
 */
export function isExecutorSufficientForAutoExec(cap: ExecutorCapability): boolean {
  if (!cap.supported) return false;
  if (!cap.stageRoot.read.value) return false;
  if (!cap.stageRoot.write.value) return false;
  if (cap.liveWorkspace.write.value) return false; // live workspace must NOT be writable
  if (!cap.process.fixedExecutableAndArgs.value) return false;
  if (!cap.capturesRealExitCode) return false;
  // hostShellFallback must be explicitly false (enforced by mediator)
  if (cap.process.hostShellFallback.value !== false) return false;
  if (cap.process.hostShellFallback.enforcedBy === 'unknown') return false;
  return true;
}

// ─── S21 & S22 Capability, Canary & Execution Contracts ──────────────────

export const S00ExecutionDecisionValues = {
  GO_IDE: 'GO-IDE',
  GO_WSL2: 'GO-WSL2',
  GO_GUARDED_AUTOPILOT: 'GO-GUARDED-AUTOPILOT',
  NO_GO_AUTOEXEC: 'NO-GO-AUTOEXEC',
} as const;

export const S00_DECISION_NO_GO = S00ExecutionDecisionValues.NO_GO_AUTOEXEC;

export type S00ExecutionDecision =
  (typeof S00ExecutionDecisionValues)[keyof typeof S00ExecutionDecisionValues];

export const S00ExecutionDecisionSchema = z.enum([
  'GO-IDE',
  'GO-WSL2',
  'GO-GUARDED-AUTOPILOT',
  'NO-GO-AUTOEXEC',
]);

export const EvidenceProvenanceKinds = {
  RUNTIME_CANARY: 'runtime_canary',
  UNIT_CONTRACT_TEST: 'unit_contract_test',
  IDE_API_REPORTED: 'ide_api_reported',
  DOCUMENTATION_ASSERTION: 'documentation_assertion',
  AGENT_REPORTED_CLAIM: 'agent_reported_claim',
  UNKNOWN_UNVERIFIED: 'unknown_unverified',
} as const;

export type EvidenceProvenanceKind =
  (typeof EvidenceProvenanceKinds)[keyof typeof EvidenceProvenanceKinds];

export const EvidenceProvenanceKindSchema = z.enum([
  'runtime_canary',
  'unit_contract_test',
  'ide_api_reported',
  'documentation_assertion',
  'agent_reported_claim',
  'unknown_unverified',
]);

export interface SecurityCapabilityField {
  readonly value: boolean;
  readonly enforcedBy: CapabilityEnforcer;
  readonly evidenceRef: string | null;
  readonly provenance: EvidenceProvenanceKind;
  readonly observedAt?: number | undefined;
  readonly executorId?: string | undefined;
  readonly executorVersion?: string | undefined;
  readonly canaryId?: string | undefined;
  readonly statusOrLimitations?: string | undefined;
  readonly correlationId?: string | undefined;
}

export const SecurityCapabilityFieldSchema = z.object({
  value: z.boolean(),
  enforcedBy: z.enum(['mediator', 'ide', 'host', 'unknown']),
  evidenceRef: z.string().nullable(),
  provenance: EvidenceProvenanceKindSchema,
  observedAt: z.number().optional(),
  executorId: z.string().optional(),
  executorVersion: z.string().optional(),
  canaryId: z.string().optional(),
  statusOrLimitations: z.string().optional(),
  correlationId: z.string().optional(),
});

export const CAPABILITY_FIELD_UNKNOWN: SecurityCapabilityField = {
  value: false,
  enforcedBy: 'unknown',
  evidenceRef: null,
  provenance: 'unknown_unverified',
};

export interface ExecutorSecurityCapabilities {
  readonly version: string;
  readonly executorId: string;
  readonly executorVersion: string;
  readonly s00Decision: S00ExecutionDecision;
  readonly stageId: string;
  readonly workspaceRoot: string;
  readonly evaluatedAt: number;
  readonly correlationId: string;

  // Filesystem
  readonly filesystem: {
    readonly stageRootRead: SecurityCapabilityField;
    readonly stageRootWrite: SecurityCapabilityField;
    readonly liveWorkspaceWriteDenied: SecurityCapabilityField;
    readonly outsideRootDenied: SecurityCapabilityField;
    readonly secretFilesProtected: SecurityCapabilityField;
    readonly symlinkEscapeDenied: SecurityCapabilityField;
    readonly filesystemLimitsEnforced: SecurityCapabilityField;
  };

  // Process and executable
  readonly process: {
    readonly executableAllowlistEnforced: SecurityCapabilityField;
    readonly argumentsRestricted: SecurityCapabilityField;
    readonly untrustedScriptsRejected: SecurityCapabilityField;
    readonly childProcessesControlled: SecurityCapabilityField;
    readonly processTerminationEnforced: SecurityCapabilityField;
    readonly hostShellFallbackDenied: SecurityCapabilityField;
  };

  // Network
  readonly network: {
    readonly networkRestricted: SecurityCapabilityField;
    readonly networkPolicyTested: SecurityCapabilityField;
  };

  // Resource control
  readonly limits: {
    readonly timeoutEnforced: SecurityCapabilityField;
    readonly cancellationEnforced: SecurityCapabilityField;
    readonly outputByteLimitsEnforced: SecurityCapabilityField;
    readonly cpuMemoryLimitsEnforced: SecurityCapabilityField;
    readonly concurrentProcessLimitsEnforced: SecurityCapabilityField;
    readonly capturesRealExitCode: SecurityCapabilityField;
  };

  // Execution and evidence
  readonly execution: {
    readonly fixedRecipeOnly: SecurityCapabilityField;
    readonly actualCommandObserved: SecurityCapabilityField;
    readonly boundedOutputCaptured: SecurityCapabilityField;
    readonly exitCodeReliablyCollected: SecurityCapabilityField;
    readonly crashReconciliationSupported: SecurityCapabilityField;
    readonly stagedSourceProven: SecurityCapabilityField;
  };
}

export const ExecutorSecurityCapabilitiesSchema = z.object({
  version: z.string(),
  executorId: z.string(),
  executorVersion: z.string(),
  s00Decision: S00ExecutionDecisionSchema,
  stageId: z.string(),
  workspaceRoot: z.string(),
  evaluatedAt: z.number(),
  correlationId: z.string(),
  filesystem: z.object({
    stageRootRead: SecurityCapabilityFieldSchema,
    stageRootWrite: SecurityCapabilityFieldSchema,
    liveWorkspaceWriteDenied: SecurityCapabilityFieldSchema,
    outsideRootDenied: SecurityCapabilityFieldSchema,
    secretFilesProtected: SecurityCapabilityFieldSchema,
    symlinkEscapeDenied: SecurityCapabilityFieldSchema,
    filesystemLimitsEnforced: SecurityCapabilityFieldSchema,
  }),
  process: z.object({
    executableAllowlistEnforced: SecurityCapabilityFieldSchema,
    argumentsRestricted: SecurityCapabilityFieldSchema,
    untrustedScriptsRejected: SecurityCapabilityFieldSchema,
    childProcessesControlled: SecurityCapabilityFieldSchema,
    processTerminationEnforced: SecurityCapabilityFieldSchema,
    hostShellFallbackDenied: SecurityCapabilityFieldSchema,
  }),
  network: z.object({
    networkRestricted: SecurityCapabilityFieldSchema,
    networkPolicyTested: SecurityCapabilityFieldSchema,
  }),
  limits: z.object({
    timeoutEnforced: SecurityCapabilityFieldSchema,
    cancellationEnforced: SecurityCapabilityFieldSchema,
    outputByteLimitsEnforced: SecurityCapabilityFieldSchema,
    cpuMemoryLimitsEnforced: SecurityCapabilityFieldSchema,
    concurrentProcessLimitsEnforced: SecurityCapabilityFieldSchema,
    capturesRealExitCode: SecurityCapabilityFieldSchema,
  }),
  execution: z.object({
    fixedRecipeOnly: SecurityCapabilityFieldSchema,
    actualCommandObserved: SecurityCapabilityFieldSchema,
    boundedOutputCaptured: SecurityCapabilityFieldSchema,
    exitCodeReliablyCollected: SecurityCapabilityFieldSchema,
    crashReconciliationSupported: SecurityCapabilityFieldSchema,
    stagedSourceProven: SecurityCapabilityFieldSchema,
  }),
});

export type CapabilityEvaluationResult =
  | 'eligible'
  | 'blocked'
  | 'unverified'
  | 'unsupported';

export interface CapabilityEvaluationReport {
  readonly result: CapabilityEvaluationResult;
  readonly isEligibleForAutoExec: boolean;
  readonly s00Decision: S00ExecutionDecision;
  readonly executorId: string;
  readonly executorVersion: string;
  readonly evaluatedAt: number;
  readonly passedRequirements: readonly string[];
  readonly failedRequirements: readonly string[];
  readonly unverifiedRequirements: readonly string[];
  readonly blockedReasons: readonly string[];
}

export const CapabilityEvaluationReportSchema = z.object({
  result: z.enum(['eligible', 'blocked', 'unverified', 'unsupported']),
  isEligibleForAutoExec: z.boolean(),
  s00Decision: S00ExecutionDecisionSchema,
  executorId: z.string(),
  executorVersion: z.string(),
  evaluatedAt: z.number(),
  passedRequirements: z.array(z.string()),
  failedRequirements: z.array(z.string()),
  unverifiedRequirements: z.array(z.string()),
  blockedReasons: z.array(z.string()),
});

export type CanaryClassification =
  | 'pass'
  | 'fail'
  | 'inconclusive'
  | 'unverified';

export interface CanaryRunRecord {
  readonly runId: string;
  readonly executorId: string;
  readonly executorVersion: string;
  readonly s00DecisionRef: S00ExecutionDecision;
  readonly stageId: string;
  readonly workspaceRoot: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly capability: string;
  readonly expectedResult: string;
  readonly observedResult: string;
  readonly enforcingLayer: CapabilityEnforcer;
  readonly classification: CanaryClassification;
  readonly evidenceRef: string;
  readonly correlationId: string;
  readonly redactedDiagnostics?: string | undefined;
}

export const CanaryRunRecordSchema = z.object({
  runId: z.string(),
  executorId: z.string(),
  executorVersion: z.string(),
  s00DecisionRef: S00ExecutionDecisionSchema,
  stageId: z.string(),
  workspaceRoot: z.string(),
  startedAt: z.number(),
  completedAt: z.number(),
  capability: z.string(),
  expectedResult: z.string(),
  observedResult: z.string(),
  enforcingLayer: z.enum(['mediator', 'ide', 'host', 'unknown']),
  classification: z.enum(['pass', 'fail', 'inconclusive', 'unverified']),
  evidenceRef: z.string(),
  correlationId: z.string(),
  redactedDiagnostics: z.string().optional(),
});

export interface ExecuteRecipeRequest {
  readonly recipeId: string;
  readonly recipeHash: string;
  readonly stageId: string;
  readonly workspaceRoot: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly approvalId: string;
  readonly approvedPayloadHash: string;
  readonly correlationId: string;
  readonly args?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
}

export const ExecuteRecipeRequestSchema = z.object({
  recipeId: z.string().min(1),
  recipeHash: z.string().min(1),
  stageId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  approvalId: z.string().min(1),
  approvedPayloadHash: z.string().min(1),
  correlationId: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export type ExecutionStatus =
  | 'executed'
  | 'execution-unavailable'
  | 'execution-blocked'
  | 'failed'
  | 'unverified';

export interface SuggestedManualRecipe {
  readonly recipeId: string;
  readonly commandText: string;
  readonly instructions: string;
  readonly workingDirectory: string;
  readonly safeToRunManually: boolean;
}

export interface ExecuteRecipeResponse {
  readonly success: boolean;
  readonly status: ExecutionStatus;
  readonly s00Decision: S00ExecutionDecision;
  readonly message: string;
  readonly errorCode?: ErrorCodeValue | undefined;
  readonly suggestedManualRecipe?: SuggestedManualRecipe | undefined;
  readonly diagnostics?: Record<string, unknown> | undefined;
  readonly exitCode?: number | undefined;
  readonly stdoutSnippet?: string | undefined;
  readonly stderrSnippet?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly correlationId: string;
}

// ─── Recipe Contract (S23) ──────────────────────────────────────────────────

export const RecipeIdValues = {
  PROJECT_TEST: 'project.test',
  PROJECT_LINT: 'project.lint',
  PROJECT_TYPECHECK: 'project.typecheck',
  PROJECT_BUILD: 'project.build',
  PROJECT_SINGLE_TEST: 'project.single_test',
  GIT_STATUS: 'git.status',
  GIT_DIFF: 'git.diff',
  PYTHON_TEST: 'python.test',
  PYTHON_SINGLE_TEST: 'python.single_test',
} as const;

export type RecipeId = (typeof RecipeIdValues)[keyof typeof RecipeIdValues];
export const RecipeIdSchema = z.enum([
  'project.test',
  'project.lint',
  'project.typecheck',
  'project.build',
  'project.single_test',
  'git.status',
  'git.diff',
  'python.test',
  'python.single_test',
]);

export const RecipeCategoryValues = {
  TEST: 'test',
  LINT: 'lint',
  TYPECHECK: 'typecheck',
  BUILD: 'build',
  VCS: 'vcs',
} as const;
export type RecipeCategory = (typeof RecipeCategoryValues)[keyof typeof RecipeCategoryValues];
export const RecipeCategorySchema = z.enum(['test', 'lint', 'typecheck', 'build', 'vcs']);

export const RecipeStatusValues = {
  AVAILABLE: 'available',
  MANUAL_ONLY: 'manual-only',
  BLOCKED: 'blocked',
  UNSUPPORTED: 'unsupported',
  UNVERIFIED: 'unverified',
} as const;
export type RecipeStatus = (typeof RecipeStatusValues)[keyof typeof RecipeStatusValues];
export const RecipeStatusSchema = z.enum(['available', 'manual-only', 'blocked', 'unsupported', 'unverified']);

export const RecipeRiskValues = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;
export type RecipeRisk = (typeof RecipeRiskValues)[keyof typeof RecipeRiskValues];
export const RecipeRiskSchema = z.enum(['low', 'medium', 'high']);

export const DependencyReadinessStateValues = {
  NOT_INSPECTED: 'not-inspected',
  MANIFEST_OBSERVED: 'manifest-observed',
  DEPENDENCIES_UNAVAILABLE: 'dependencies-unavailable',
  DEPENDENCY_RISK_REVIEW_REQUIRED: 'dependency-risk-review-required',
  READY_FOR_MANUAL_CHECK: 'ready-for-manual-check',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
} as const;
export type DependencyReadinessState =
  (typeof DependencyReadinessStateValues)[keyof typeof DependencyReadinessStateValues];
export const DependencyReadinessStateSchema = z.enum([
  'not-inspected',
  'manifest-observed',
  'dependencies-unavailable',
  'dependency-risk-review-required',
  'ready-for-manual-check',
  'blocked',
  'unknown',
]);

export interface RecipeArgumentSchema {
  readonly maxArgs: number;
  readonly allowedFlags?: readonly string[] | undefined;
  readonly allowsPathTarget?: boolean | undefined;
  readonly pathTargetPattern?: string | undefined;
}

export interface RecipeDefinition {
  readonly recipeId: RecipeId;
  readonly version: string;
  readonly recipeVersion?: string | undefined;
  readonly definitionHash: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: RecipeCategory;
  readonly executable: string;
  readonly fixedArgs?: readonly string[] | undefined;
  readonly defaultArgs?: readonly string[] | undefined;
  readonly argumentSchema?: RecipeArgumentSchema | undefined;
  readonly allowCustomTarget?: boolean | undefined;
  readonly workingDirectoryPolicy: 'stage-root' | 'workspace-root';
  readonly permittedInputScope?: 'stage-only' | 'workspace-only' | undefined;
  readonly scopePolicy?: 'stage-isolated' | 'workspace-readonly' | 'stage-only' | 'workspace-only' | undefined;
  readonly envAllowlist: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly requiredCapabilities: readonly string[];
  readonly requiredPolicyLevel?: 'allow' | 'require_approval' | undefined;
  readonly requiredApprovalLevel?: 'manual-review' | 'automated-safe' | 'allow' | 'require_approval' | undefined;
  readonly supportedProjectTypes: readonly string[];
  readonly dependencyRequirements: readonly string[];
  readonly riskClassification: RecipeRisk;
  readonly executionStatus: RecipeStatus;
  readonly definitionProvenance?: string | undefined;
  readonly provenance?: string | undefined;
  readonly createdAt?: number | undefined;
  readonly updatedAt?: number | undefined;
}

export interface RecipeExecutionRequest {
  readonly recipeId: RecipeId;
  readonly expectedDefinitionHash?: string | undefined;
  readonly definitionHash?: string | undefined;
  readonly targetTestPath?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Record<string, string> | undefined;
  readonly envOverrides?: Record<string, string> | undefined;
  readonly stageId?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly workingDirectory?: string | undefined;
  readonly taskId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export interface RecipeValidationResult {
  readonly ok?: boolean | undefined;
  readonly valid?: boolean | undefined;
  readonly recipeId?: RecipeId | undefined;
  readonly definitionHash?: string | undefined;
  readonly recipe?: RecipeDefinition | undefined;
  readonly errors?: readonly string[] | undefined;
  readonly rejectionCode?: ErrorCodeValue | undefined;
  readonly errorCode?: ErrorCodeValue | undefined;
  readonly rejectionReason?: string | undefined;
  readonly rejectionErrors?: readonly string[] | undefined;
  readonly manualInstruction?: SuggestedManualRecipe | undefined;
  readonly suggestedManualRecipe?: SuggestedManualRecipe | undefined;
  readonly canExecuteAutomatically?: boolean | undefined;
  readonly executionBlockedReason?: string | undefined;
  readonly effectiveArgs?: readonly string[] | undefined;
  readonly effectiveWorkingDirectory?: string | undefined;
}

export interface DependencyInspectionReport {
  readonly workspaceRoot?: string | undefined;
  readonly state?: DependencyReadinessState | undefined;
  readonly readinessState?: DependencyReadinessState | undefined;
  readonly manifestFound?: boolean | undefined;
  readonly manifestObserved?: boolean | undefined;
  readonly manifestPath?: string | undefined;
  readonly lockfileFound?: boolean | undefined;
  readonly lockfileObserved?: boolean | undefined;
  readonly lockfilePath?: string | undefined;
  readonly nodeModulesFound?: boolean | undefined;
  readonly installedDependenciesCount?: number | undefined;
  readonly riskSignals: readonly string[];
  readonly missingDependencies?: readonly string[] | undefined;
  readonly recommendedAction?: string | undefined;
  readonly manualHandoffMessage?: string | undefined;
  readonly canRunManualRecipe?: boolean | undefined;
  readonly correlationId?: string | undefined;
  readonly inspectedAt: number;
}

// ─── Assisted End-to-End Loop & Orchestration (S24) ─────────────────────────

export const OrchestrationStateValues = {
  IDLE: 'idle',
  RESPONSE_RECEIVED: 'response-received',
  PROTOCOL_VALIDATING: 'protocol-validating',
  POLICY_REVIEW: 'policy-review',
  STAGING: 'staging',
  DIFF_READY: 'diff-ready',
  AWAITING_APPROVAL: 'awaiting-approval',
  APPROVAL_EXPIRED: 'approval-expired',
  CONFLICTED: 'conflicted',
  VERIFICATION_BLOCKED: 'verification-blocked',
  MANUAL_HANDOFF_READY: 'manual-handoff-ready',
  AWAITING_MANUAL_RESULT: 'awaiting-manual-result',
  RESULT_RECEIVED: 'result-received',
  FEEDBACK_READY: 'feedback-ready',
  AWAITING_SEND_CONFIRMATION: 'awaiting-send-confirmation',
  COMPLETED: 'completed',
  PAUSED: 'paused',
  FAILED: 'failed',
  RECOVERY_REQUIRED: 'recovery-required',
} as const;

export type OrchestrationState =
  (typeof OrchestrationStateValues)[keyof typeof OrchestrationStateValues];

export const OrchestrationStateSchema = z.enum([
  'idle',
  'response-received',
  'protocol-validating',
  'policy-review',
  'staging',
  'diff-ready',
  'awaiting-approval',
  'approval-expired',
  'conflicted',
  'verification-blocked',
  'manual-handoff-ready',
  'awaiting-manual-result',
  'result-received',
  'feedback-ready',
  'awaiting-send-confirmation',
  'completed',
  'paused',
  'failed',
  'recovery-required',
]);

export interface WorkflowBudgetConfig {
  readonly maxRoundsPerTask: number;
  readonly maxTransitionsPerTask: number;
  readonly maxFeedbackBytes: number;
  readonly maxDiffBytes: number;
  readonly maxValidationFailures: number;
  readonly actionDeadlineMs: number;
  readonly maxTaskDurationMs?: number | undefined;
  readonly maxActionsPerTask?: number | undefined;
  readonly maxTotalInputBytes?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly maxRepeatedErrors?: number | undefined;
  readonly maxNoProgressRounds?: number | undefined;
  readonly maxDebugBundleBytes?: number | undefined;
}

export const DEFAULT_WORKFLOW_BUDGET_CONFIG: WorkflowBudgetConfig = {
  maxRoundsPerTask: 10,
  maxTransitionsPerTask: 50,
  maxFeedbackBytes: 16384,
  maxDiffBytes: 65536,
  maxValidationFailures: 3,
  actionDeadlineMs: 120000,
  maxTaskDurationMs: 1800000, // 30 minutes
  maxActionsPerTask: 20,
  maxTotalInputBytes: 1048576, // 1 MB
  maxOutputBytes: 65536,
  maxRepeatedErrors: 3,
  maxNoProgressRounds: 3,
  maxDebugBundleBytes: 524288, // 512 KB
};

export interface WorkflowStepRecord {
  readonly stepId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly fromState: OrchestrationState;
  readonly toState: OrchestrationState;
  readonly timestamp: number;
  readonly payloadHash?: string | undefined;
  readonly correlationId: string;
  readonly detail?: Record<string, unknown> | undefined;
}

export interface VerificationEvidenceRecord {
  readonly evidenceId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly checkName: string;
  readonly recipeId?: RecipeId | undefined;
  readonly provenance: EvidenceProvenanceKind;
  readonly outcome: 'passed' | 'failed' | 'blocked' | 'inconclusive';
  readonly observedAt: number;
  readonly summary: string;
  readonly evidenceRef?: string | undefined;
  readonly verifiedBy?: string | undefined;
  readonly limitations?: string | undefined;
}

export interface VerificationSummary {
  readonly taskId: string;
  readonly totalChecks: number;
  readonly passedChecks: number;
  readonly failedChecks: number;
  readonly blockedChecks: number;
  readonly evidenceRecords: readonly VerificationEvidenceRecord[];
  readonly overallStatus: 'fully-verified' | 'partially-verified' | 'blocked' | 'unverified';
  readonly automatedExecutionBlocked: boolean;
  readonly s00Decision: S00ExecutionDecision;
}

export interface ControlledTaskOutcome {
  readonly testTaskId: string;
  readonly initialScenario: string;
  readonly expectedResult: string;
  readonly observedResult: string;
  readonly finalState: OrchestrationState;
  readonly policyStatus: 'allowed' | 'denied' | 'require_approval' | 'unsupported';
  readonly approvalRequired: boolean;
  readonly stageStatus: string;
  readonly evidenceProvenance: EvidenceProvenanceKind;
  readonly userActionRequired: boolean;
  readonly correlationId: string;
  readonly testType: 'fixture' | 'integration-mock' | 'live-check';
  readonly passed: boolean;
}

// ─── Sprint S25: Recovery, Loops, Observability & Compaction ────────────────

export type RecoveryStatus =
  | 'recovery-not-required'
  | 'reconciliation-pending'
  | 'recovered'
  | 'paused-for-user'
  | 'recovery-required'
  | 'unknown-completion'
  | 'recovery-failed';

export const RecoveryStatusValues = [
  'recovery-not-required',
  'reconciliation-pending',
  'recovered',
  'paused-for-user',
  'recovery-required',
  'unknown-completion',
  'recovery-failed',
] as const;

export type ActionCompletionStatus = 'completed' | 'failed' | 'unknown' | 'in-flight';

export interface ActionRecordSummary {
  readonly actionId: string;
  readonly type: string;
  readonly status: ActionCompletionStatus;
  readonly payloadHash?: string | undefined;
  readonly targetPath?: string | undefined;
  readonly lastObservedState?: string | undefined;
  readonly failureReason?: string | undefined;
}

export interface ReconciliationReport {
  readonly reconciliationId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly status: RecoveryStatus;
  readonly unknownActions: readonly ActionRecordSummary[];
  readonly expiredApprovalsCount: number;
  readonly stageConflictDetected: boolean;
  readonly conversationIdentityVerified: boolean;
  readonly capabilityStatusValid: boolean;
  readonly canSafeResume: boolean;
  readonly safeResumeBlockers: readonly string[];
  readonly timestamp: number;
  readonly correlationId: string;
}

export interface ContextIndicators {
  readonly packetBytes: number;
  readonly estimatedTokens: number;
  readonly configuredBudget: number;
  readonly selectedExcerptsCount: number;
  readonly omittedCount: number;
  readonly changedVsUnchangedRatio: number;
  readonly repetitionRatio: number;
  readonly freshnessTimestamp: number;
  readonly redactionCount: number;
}

export interface CompactedTaskSummary {
  readonly taskId: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly lastAcceptedRound: number;
  readonly currentStageId: string;
  readonly changedFilePaths: readonly string[];
  readonly policyApprovalState: string;
  readonly verificationSummary: VerificationSummary;
  readonly blockers: readonly string[];
  readonly knownIssues: readonly string[];
  readonly decisionsMade: readonly string[];
  readonly nextRequiredAction: string;
  readonly indicators: ContextIndicators;
  readonly updatedAt: number;
}

export interface CorrelationTimelineEvent {
  readonly eventId: string;
  readonly correlationId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly actionId?: string | undefined;
  readonly eventType: string;
  readonly timestamp: number;
  readonly resultOrStatus: string;
  readonly reasonCode?: string | undefined;
  readonly provenance?: EvidenceProvenanceKind | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface DebugBundleManifest {
  readonly bundleVersion: string;
  readonly generatedAt: number;
  readonly timeRangeCoveredMs: number;
  readonly omittedCategories: readonly string[];
  readonly secretScanVerified: boolean;
  readonly bundleSizeBytes: number;
}

export interface DebugBundleData {
  readonly manifest: DebugBundleManifest;
  readonly taskSessionSummary: Record<string, unknown>;
  readonly correlationTimeline: readonly CorrelationTimelineEvent[];
  readonly workflowHistory: readonly WorkflowStepRecord[];
  readonly typedErrors: readonly Record<string, unknown>[];
  readonly recoveryDecisions: readonly Record<string, unknown>[];
  readonly capabilityStatus: Record<string, unknown>;
  readonly budgetCounters: Record<string, unknown>;
  readonly contextIndicators?: ContextIndicators | undefined;
  readonly recipeMetadata: readonly Record<string, unknown>[];
  readonly actionSummaries: readonly ActionRecordSummary[];
  readonly stagingSummary: Record<string, unknown>;
}

// ─── Sprint S26: Limited Autopilot Gate & Profile ──────────────────────────

export type AutopilotGateStatus = 'eligible' | 'deferred' | 'disabled';

export interface AutopilotGateResult {
  readonly status: AutopilotGateStatus;
  readonly isEligible: boolean;
  readonly s00Decision: S00ExecutionDecision;
  readonly verifiedCapabilities: readonly string[];
  readonly unverifiedCapabilities: readonly string[];
  readonly missingPrerequisites: readonly string[];
  readonly blockingReasons: readonly string[];
  readonly evaluatedAt: number;
  readonly nextAssessmentRequirements: readonly string[];
}

export interface AutopilotLowRiskProfile {
  readonly profileId: string;
  readonly version: string;
  readonly maxFileDiffLines: number;
  readonly maxDiffSizeBytes: number;
  readonly allowedFileExtensions: readonly string[];
  readonly allowProtectedPaths: false;
  readonly allowDeletesOrRenames: false;
  readonly allowScriptModifications: false;
  readonly allowManifestOrLockfileModifications: false;
  readonly allowDependencyInstall: false;
  readonly allowNetworkAccess: false;
  readonly allowArbitraryExecutables: false;
  readonly approvedRecipeIds: readonly RecipeId[];
  readonly maxRoundsBudget: number;
  readonly maxDurationBudgetMs: number;
  readonly active: boolean; // false under NO-GO-AUTOEXEC; true when guarded profile active
}

export const CANONICAL_AUTOPILOT_LOW_RISK_PROFILE: AutopilotLowRiskProfile = {
  profileId: 'autopilot.low_risk.v1',
  version: '1.0.0',
  maxFileDiffLines: 100,
  maxDiffSizeBytes: 4096,
  allowedFileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.css', '.html'],
  allowProtectedPaths: false,
  allowDeletesOrRenames: false,
  allowScriptModifications: false,
  allowManifestOrLockfileModifications: false,
  allowDependencyInstall: false,
  allowNetworkAccess: false,
  allowArbitraryExecutables: false,
  approvedRecipeIds: ['project.test', 'project.lint', 'project.typecheck'],
  maxRoundsBudget: 3,
  maxDurationBudgetMs: 300000,
  active: false,
};

// ─── Guarded Isolated-Worktree Autopilot Contracts (ADR-031 / Phase D) ─────

export type AutopilotStopReason =
  | 'SUCCESS'
  | 'BUDGET_EXHAUSTED_ITERATIONS'
  | 'BUDGET_EXHAUSTED_TIMEOUT'
  | 'CONSECUTIVE_FAILURES_EXCEEDED'
  | 'SECURITY_VIOLATION'
  | 'SANDBOX_UNAVAILABLE'
  | 'MALFORMED_PROPOSAL'
  | 'CANCELLED'
  | 'CRASH_RECOVERY';

export interface AutopilotTaskConfig {
  readonly enabled: boolean;
  readonly maxIterations: number;
  readonly maxDurationMs: number;
  readonly maxChangedFiles: number;
  readonly maxDiffSizeBytes: number;
  readonly maxConsecutiveFailures: number;
  readonly validationRecipeId: RecipeId;
  readonly isolatedWorktreeRoot?: string | undefined;
}

export const DEFAULT_AUTOPILOT_TASK_CONFIG: AutopilotTaskConfig = {
  enabled: false,
  maxIterations: 5,
  maxDurationMs: 600000, // 10 minutes
  maxChangedFiles: 10,
  maxDiffSizeBytes: 65536, // 64 KiB
  maxConsecutiveFailures: 3,
  validationRecipeId: 'project.test',
};

export interface AutopilotIterationReport {
  readonly iterationNumber: number;
  readonly status: 'routing' | 'staging' | 'validating' | 'correcting' | 'completed' | 'failed' | 'stopped';
  readonly validation?: {
    readonly recipeId: string;
    readonly exitCode: number;
    readonly passed: boolean;
    readonly stdoutSnippet: string;
    readonly stderrSnippet: string;
    readonly durationMs: number;
  } | undefined;
  readonly changedFiles: readonly string[];
  readonly timestamp: number;
  readonly note?: string | undefined;
}

export interface AutopilotRunResult {
  readonly taskId: string;
  readonly status: 'completed' | 'stopped' | 'failed' | 'cancelled';
  readonly iterationsRun: number;
  readonly stopReason: AutopilotStopReason;
  readonly details: string;
  readonly changedFiles: readonly string[];
  readonly stagedDiff?: string | undefined;
  readonly approvalId?: string | undefined;
  readonly iterationReports: readonly AutopilotIterationReport[];
  readonly durationMs: number;
}


// ─── Session priming ───────────────────────────────────────────────────────

export interface SessionPrimingConfig {
  readonly taskId: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly conversationIdentity: ConversationIdentity;
  readonly protocolVersion: ProtocolVersion;
  readonly allowedActions: ActionTypeValue[];
  readonly projectRules?: string;
  readonly acceptanceCriteria?: string[];
  readonly maxRounds: number;
  readonly maxRuntimeMs: number;
}

// ─── Audit event ───────────────────────────────────────────────────────────

export interface AuditEvent {
  readonly eventId: string;
  readonly previousEventHash: string | null; // tamper-evident chain
  readonly timestamp: number; // unix ms
  readonly taskId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly actionId?: string;
  readonly eventType: string;
  readonly actor: 'user' | 'mediator' | 'ai-provider' | 'ide-agent' | 'mcp-caller';
  readonly outcome: 'allowed' | 'denied' | 'pending' | 'error';
  readonly detail: Record<string, unknown>; // must be pre-redacted — no secrets
}

// ─── Aliases ───────────────────────────────────────────────────────────────

export type Action = AnyAction;
export type Approval = PendingApproval | ResolvedApproval;

// ─── Zod Schemas & Validation ──────────────────────────────────────────────

export const ProviderIdentitySchema = z.object({
  provider: z.string().min(1),
  conversationId: z.string().min(1),
  tabId: z.number().int().positive().optional(),
  messageId: z.string().optional(),
  branchId: z.string().optional(),
  chatTitle: z.string().optional(),
});

export const ContentBlockSchema = z.object({
  id: z.string().min(1),
  delimiter: z.string().min(1),
  encoding: z.literal('utf-8'),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, 'Must be valid 64-char sha256 hex string'),
});

export const ListFilesActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('list_files'),
  pathPrefix: z.string(),
  limit: z.number().int().positive().max(1000),
});

export const ReadFileActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('read_file'),
  path: z.string().min(1),
  rangeStart: z.number().int().nonnegative().optional(),
  rangeEnd: z.number().int().positive().optional(),
});

export const SearchTextActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('search_text'),
  query: z.string().min(1),
  pathGlob: z.string().optional(),
  limit: z.number().int().positive().max(500),
});

export const GetDiagnosticsActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('get_diagnostics'),
  path: z.string().optional(),
});

export const GetDiffActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('get_diff'),
  fileSelector: z.string().optional(),
});

export const RequestMoreContextActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('request_more_context'),
  reason: z.string().min(1),
  topicHints: z.array(z.string()).optional(),
  pathHints: z.array(z.string()).optional(),
  byteBudget: z.number().int().positive().optional(),
});

export const ProposePatchActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('propose_patch'),
  path: z.string().min(1),
  expectedBaseHash: z.string().regex(/^[a-f0-9]{64}$/i, 'Must be valid 64-char sha256 hex string'),
  contentBlockId: z.string().min(1),
});

export const RequestRecipeRunActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('request_recipe_run'),
  recipeId: z.string().min(1),
  parameters: z.record(z.string()),
});

export const RequestDependencyChangeActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('request_dependency_change'),
  ecosystem: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  rationale: z.string().min(1),
});

export const RequestNetworkAccessActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('request_network_access'),
  domains: z.array(z.string()),
  reason: z.string().min(1),
  durationSeconds: z.number().int().positive().max(3600),
});

export const RequestDeleteActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('request_delete'),
  path: z.string().min(1),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/i, 'Must be valid 64-char sha256 hex string'),
});

export const RequestRenameActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('request_rename'),
  sourcePath: z.string().min(1),
  destinationPath: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/i, 'Must be valid 64-char sha256 hex string'),
});

export const AskUserActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('ask_user'),
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
});

export const ReportProgressActionSchema = z.object({
  id: z.string().min(1),
  type: z.literal('report_progress'),
  summary: z.string().min(1),
  referencedActionIds: z.array(z.string()).optional(),
});

export const ActionSchema = z.discriminatedUnion('type', [
  ListFilesActionSchema,
  ReadFileActionSchema,
  SearchTextActionSchema,
  GetDiagnosticsActionSchema,
  GetDiffActionSchema,
  RequestMoreContextActionSchema,
  ProposePatchActionSchema,
  RequestRecipeRunActionSchema,
  RequestDependencyChangeActionSchema,
  RequestNetworkAccessActionSchema,
  RequestDeleteActionSchema,
  RequestRenameActionSchema,
  AskUserActionSchema,
  ReportProgressActionSchema,
]);

export const ProtocolEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  nonce: z.string().min(8),
  round: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  conversation: ProviderIdentitySchema,
  baseStateHash: z.string().regex(/^[a-f0-9]{64}$/i, 'Must be valid 64-char sha256 hex string'),
  status: z.enum([
    EnvelopeStatus.CONTINUE,
    EnvelopeStatus.AWAIT_USER,
    EnvelopeStatus.COMPLETE,
    EnvelopeStatus.PROPOSED_COMPLETE,
  ]),
  actions: z.array(ActionSchema).max(50),
  contentBlocks: z.array(ContentBlockSchema).max(20),
});

export const BoundaryEventSchema = z.object({
  eventId: z.string().min(1),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().optional(),
  timestamp: z.number().int().positive(),
  source: z.enum(['ide', 'browser', 'cli', 'mcp', 'core']),
  type: z.string().min(1),
  payload: z.unknown(),
});

// ─── Schema Validation Helpers ─────────────────────────────────────────────

export const MAX_ENVELOPE_RAW_BYTES = 1024 * 1024; // 1 MB limit

export function validateProtocolEnvelope(input: unknown): Result<ProtocolEnvelope, MediatorError> {
  if (typeof input !== 'object' || input === null) {
    return err(
      makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Envelope input must be a non-null object', {
        detail: { receivedType: typeof input },
      }),
    );
  }

  // Size guard on raw JSON representation
  try {
    const rawString = JSON.stringify(input);
    if (rawString.length > MAX_ENVELOPE_RAW_BYTES) {
      return err(
        makeMediatorError(
          ErrorCode.OVERSIZED_INPUT,
          `Envelope exceeds maximum size of ${MAX_ENVELOPE_RAW_BYTES} bytes (actual: ${rawString.length} bytes)`,
          { detail: { byteLength: rawString.length, maxAllowed: MAX_ENVELOPE_RAW_BYTES } },
        ),
      );
    }
  } catch (serializationErr) {
    return err(
      makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Envelope input cannot be serialized to JSON', {
        detail: { error: String(serializationErr) },
      }),
    );
  }

  const parseResult = ProtocolEnvelopeSchema.safeParse(input);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const pathStr = firstIssue ? firstIssue.path.join('.') : 'root';
    const message = firstIssue ? `${pathStr}: ${firstIssue.message}` : 'Schema validation failed';
    return err(
      makeMediatorError(ErrorCode.SCHEMA_INVALID, `Protocol envelope schema invalid: ${message}`, {
        detail: { issues: parseResult.error.issues },
      }),
    );
  }

  return ok(parseResult.data as ProtocolEnvelope);
}

export function validateBoundaryEvent<T = unknown>(input: unknown): Result<BoundaryEvent<T>, MediatorError> {
  if (typeof input !== 'object' || input === null) {
    return err(
      makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Boundary event must be a non-null object'),
    );
  }

  const parseResult = BoundaryEventSchema.safeParse(input);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const pathStr = firstIssue ? firstIssue.path.join('.') : 'root';
    return err(
      makeMediatorError(
        ErrorCode.SCHEMA_INVALID,
        `Boundary event schema invalid at ${pathStr}: ${firstIssue?.message ?? 'unknown'}`,
      ),
    );
  }

  return ok(parseResult.data as BoundaryEvent<T>);
}

// ─── Diagnostics & System Health (S48) ─────────────────────────────────────

export type DiagnosticCheckStatus = 'READY' | 'ACTION_REQUIRED' | 'UNSUPPORTED' | 'FAILED' | 'NOT_YET_VERIFIED';

export type DiagnosticCategory =
  | 'core'
  | 'sandbox'
  | 'network'
  | 'toolchain'
  | 'providers'
  | 'native_host'
  | 'workspace'
  | 'autopilot';

export interface DiagnosticCheckItem {
  readonly id: string;
  readonly name: string;
  readonly category: DiagnosticCategory;
  readonly status: DiagnosticCheckStatus;
  readonly detail: string;
  readonly remediation?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface PlatformDiagnosticsReport {
  readonly reportId: string;
  readonly generatedAt: number;
  readonly mediatorVersion: string;
  readonly protocolVersion: string;
  readonly osPlatform: string;
  readonly osRelease: string;
  readonly nodeVersion: string;
  readonly overallStatus: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  readonly autopilotPolicy: 'BLOCKED' | 'GUARDED_ISOLATED';
  readonly checks: readonly DiagnosticCheckItem[];
  readonly sanitized: boolean;
}

export const DiagnosticCheckItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.enum([
    'core',
    'sandbox',
    'network',
    'toolchain',
    'providers',
    'native_host',
    'workspace',
    'autopilot',
  ]),
  status: z.enum(['READY', 'ACTION_REQUIRED', 'UNSUPPORTED', 'FAILED', 'NOT_YET_VERIFIED']),
  detail: z.string(),
  remediation: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const PlatformDiagnosticsReportSchema = z.object({
  reportId: z.string().min(1),
  generatedAt: z.number().int().positive(),
  mediatorVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  osPlatform: z.string().min(1),
  osRelease: z.string().min(1),
  nodeVersion: z.string().min(1),
  overallStatus: z.enum(['HEALTHY', 'DEGRADED', 'UNHEALTHY']),
  autopilotPolicy: z.enum(['BLOCKED', 'GUARDED_ISOLATED']),
  checks: z.array(DiagnosticCheckItemSchema),
  sanitized: z.boolean(),
});

