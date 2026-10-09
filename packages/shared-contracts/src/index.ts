/**
 * @mediator/shared-contracts
 *
 * Foundational protocol types, Zod schemas, typed error codes, and version constants.
 * This package has NO filesystem writes, NO network access, NO process execution.
 * It is a pure type/validation library importable by all other packages.
 */

// ─── Protocol version ──────────────────────────────────────────────────────

export const PROTOCOL_VERSION = '1.3';
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// ─── Stable error codes ────────────────────────────────────────────────────

export const ErrorCode = {
  // Path / workspace boundary
  PATH_OUTSIDE_ROOT: 'PATH_OUTSIDE_ROOT',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  PATH_ALTERNATE_DATA_STREAM: 'PATH_ALTERNATE_DATA_STREAM',
  PATH_RESERVED_DEVICE: 'PATH_RESERVED_DEVICE',
  PATH_MALFORMED: 'PATH_MALFORMED',
  PATH_SYMLINK_ESCAPE: 'PATH_SYMLINK_ESCAPE',
  PATH_CLOUD_PLACEHOLDER: 'PATH_CLOUD_PLACEHOLDER',
  WORKSPACE_ROOT_UNCONFIRMED: 'WORKSPACE_ROOT_UNCONFIRMED',

  // Protocol / session
  NONCE_MISMATCH: 'NONCE_MISMATCH',
  ROUND_STALE: 'ROUND_STALE',
  SEQUENCE_DUPLICATE: 'SEQUENCE_DUPLICATE',
  ACTION_ID_DUPLICATE: 'ACTION_ID_DUPLICATE',
  CONVERSATION_CHANGED: 'CONVERSATION_CHANGED',
  BASE_STATE_HASH_MISMATCH: 'BASE_STATE_HASH_MISMATCH',
  TRANSFER_INCOMPLETE: 'TRANSFER_INCOMPLETE',
  TRANSFER_HASH_MISMATCH: 'TRANSFER_HASH_MISMATCH',
  ENVELOPE_EXPIRED: 'ENVELOPE_EXPIRED',
  PROTOCOL_VERSION_UNSUPPORTED: 'PROTOCOL_VERSION_UNSUPPORTED',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  CONTENT_BLOCK_MISSING: 'CONTENT_BLOCK_MISSING',
  CONTENT_BLOCK_DUPLICATE: 'CONTENT_BLOCK_DUPLICATE',

  // Policy / permissions
  ACTION_DENIED: 'ACTION_DENIED',
  PATH_PROTECTED: 'PATH_PROTECTED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_PAYLOAD_MISMATCH: 'APPROVAL_PAYLOAD_MISMATCH',

  // Execution / executor
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  SANDBOX_UNVERIFIED: 'SANDBOX_UNVERIFIED',
  EXECUTOR_NOT_CONFIGURED: 'EXECUTOR_NOT_CONFIGURED',
  RECIPE_NOT_FOUND: 'RECIPE_NOT_FOUND',
  RECIPE_HASH_MISMATCH: 'RECIPE_HASH_MISMATCH',

  // Staging
  STAGE_BASE_HASH_STALE: 'STAGE_BASE_HASH_STALE',
  STAGE_CONFLICT: 'STAGE_CONFLICT',
  STAGE_PATCH_AMBIGUOUS: 'STAGE_PATCH_AMBIGUOUS',

  // Core / IPC
  CORE_NOT_RUNNING: 'CORE_NOT_RUNNING',
  IPC_ORIGIN_REJECTED: 'IPC_ORIGIN_REJECTED',
  IPC_TOKEN_INVALID: 'IPC_TOKEN_INVALID',
  IPC_RATE_LIMIT: 'IPC_RATE_LIMIT',

  // Evidence / verification
  AGENT_REPORT_UNVERIFIED: 'AGENT_REPORT_UNVERIFIED',
  EVIDENCE_INSUFFICIENT: 'EVIDENCE_INSUFFICIENT',

  // State machine
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  TASK_ALREADY_ACTIVE: 'TASK_ALREADY_ACTIVE',

  // General
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SECRET_DETECTED: 'SECRET_DETECTED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ─── Typed error ───────────────────────────────────────────────────────────

export interface MediatorError {
  readonly code: ErrorCodeValue;
  readonly message: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly correlationId?: string;
  readonly actionId?: string;
  readonly detail?: Record<string, unknown>;
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
  readonly taskId: string;
  readonly sessionId: string;
  readonly roundId?: string;
  readonly correlationId: string;
  readonly actionId?: string;
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
  PROPOSED_COMPLETE: 'proposed_complete',
} as const;

export type EnvelopeStatusValue = (typeof EnvelopeStatus)[keyof typeof EnvelopeStatus];

// ─── Conversation identity ─────────────────────────────────────────────────

export interface ConversationIdentity {
  readonly provider: string;
  readonly conversationId: string;
  readonly tabId?: number;
  readonly messageId?: string;
  readonly branchId?: string;
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

// ─── Executor capability field ─────────────────────────────────────────────

export type CapabilityEnforcer = 'mediator' | 'ide' | 'unknown';

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
