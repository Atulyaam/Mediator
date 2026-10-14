/**
 * @mediator/orchestrator — Host Containment & Trusted Broker Types (Sprint S45)
 *
 * Implements typed contracts for the Host-Side Core Containment architecture:
 * - Separates untrusted orchestration from privileged host workspace operations.
 * - Enforces narrow typed operation identifiers (no generic shell or arbitrary file execution).
 * - Cryptographic HMAC-SHA256 request authentication with freshness nonces.
 * - Replay protection, path containment, and single-use approval verification.
 */

import { z } from 'zod';
import { PROTOCOL_VERSION } from '@mediator/shared-contracts';

export const HOST_BROKER_PROTOCOL_VERSION = PROTOCOL_VERSION;

/**
 * Permitted Broker Operations:
 * Strictly limited to declarative workspace and staging actions.
 * Shell commands and arbitrary filesystem modifications are strictly excluded.
 */
export const HostBrokerOperation = {
  WORKSPACE_STATUS: 'broker.workspace_status',
  READ_SNAPSHOT: 'broker.read_snapshot',
  STAGE_PROPOSAL: 'broker.stage_proposal',
  APPLY_APPROVED_STAGE: 'broker.apply_approved_stage',
  DISPATCH_SANDBOX_RECIPE: 'broker.dispatch_sandbox_recipe',
} as const;

export type HostBrokerOperationValue =
  (typeof HostBrokerOperation)[keyof typeof HostBrokerOperation];

export const PERMITTED_BROKER_OPERATIONS = new Set<string>(
  Object.values(HostBrokerOperation),
);

/** Prohibited operations list for defense-in-depth */
export const PROHIBITED_BROKER_OPERATIONS = [
  'shell.exec',
  'shell.run',
  'cmd.execute',
  'powershell.invoke',
  'arbitrary_file.write',
  'arbitrary_file.read',
  'arbitrary_file.delete',
  'workspace.delete',
  'policy.bypass',
  'autopilot.force_enable',
] as const;

/** Operational limits for broker protocol */
export const HOST_BROKER_LIMITS = {
  /** Maximum single broker frame: 256 KiB */
  maxPayloadBytes: 256 * 1024,
  /** Maximum file snapshot size: 1 MiB */
  maxSnapshotBytes: 1024 * 1024,
  /** Request timestamp freshness window: 30 seconds (prevents replay) */
  freshnessWindowMs: 30_000,
  /** Nonce cache TTL: 5 minutes */
  nonceCacheTtlMs: 5 * 60 * 1000,
} as const;

/** Caller Identity classification for authorization gates */
export type BrokerCallerOrigin =
  | 'trusted_ui'
  | 'trusted_cli'
  | 'contained_orchestrator'
  | 'browser_ai'
  | 'mcp_agent';

/** Header present on every authenticated broker request */
export interface BrokerRequestHeader {
  readonly protocolVersion: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly taskId: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly callerOrigin: BrokerCallerOrigin;
  readonly signature: string; // HMAC-SHA256(secret, `${requestId}:${timestamp}:${nonce}:${operation}:${payloadHash}`)
}

export const BrokerRequestHeaderSchema = z.object({
  protocolVersion: z.string().min(1),
  requestId: z.string().uuid(),
  correlationId: z.string().min(1),
  taskId: z.string().min(1),
  timestamp: z.number().int().positive(),
  nonce: z.string().min(16),
  callerOrigin: z.enum([
    'trusted_ui',
    'trusted_cli',
    'contained_orchestrator',
    'browser_ai',
    'mcp_agent',
  ]),
  signature: z.string().min(64),
});

// ─── Operation Payloads & Responses ────────────────────────────────────────

// 1. Workspace Status
export interface WorkspaceStatusPayload {
  readonly workspaceRoot: string;
}

export interface WorkspaceStatusResult {
  readonly confirmed: boolean;
  readonly canonicalRoot: string;
  readonly exists: boolean;
}

// 2. Read Snapshot (Bounded to confirmed workspace)
export interface ReadSnapshotPayload {
  readonly relativePath: string;
}

export interface ReadSnapshotResult {
  readonly relativePath: string;
  readonly existsAtBase: boolean;
  readonly content: string | null;
  readonly contentHash: string | null;
  readonly sizeBytes: number;
}

// 3. Stage Proposal (Writes to isolated shadow staging ONLY)
export interface StageProposalPayload {
  readonly stageId: string;
  readonly relativePath: string;
  readonly proposedContent: string;
  readonly baseContentHash: string;
  readonly changeType: 'add-proposed' | 'modify-proposed' | 'delete-proposed';
}

export interface StageProposalResult {
  readonly stageId: string;
  readonly stagedPath: string;
  readonly stagedHash: string;
  readonly baseMatch: boolean;
}

// 4. Apply Approved Stage (Requires explicit trusted approval record)
export interface ApplyApprovedStagePayload {
  readonly stageId: string;
  readonly approvalId: string;
  readonly approvalToken: string;
  readonly targetFiles: ReadonlyArray<string>;
}

export interface ApplyApprovedStageResult {
  readonly success: boolean;
  readonly appliedFiles: ReadonlyArray<string>;
  readonly transactionId: string;
  readonly backupDir: string;
}

// 5. Dispatch Sandbox Recipe (Strictly to MediatorSandbox with network isolation)
export interface DispatchSandboxRecipePayload {
  readonly recipeId: string;
  readonly recipeHash: string;
  readonly taskWorkspaceRoot: string;
  readonly isolateNetwork: boolean;
  readonly allowUnisolatedNetworkForCanary?: boolean | undefined;
}

export interface DispatchSandboxRecipeResult {
  readonly status: 'success' | 'failed' | 'timeout' | 'cancelled' | 'security_violation';
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly violationDetails?: string | undefined;
}

// Generic Request Envelope
export interface BrokerRequest<T = unknown> {
  readonly header: BrokerRequestHeader;
  readonly operation: HostBrokerOperationValue;
  readonly payload: T;
}

// Generic Response Envelope
export interface BrokerResponse<T = unknown> {
  readonly ok: boolean;
  readonly requestId: string;
  readonly correlationId: string;
  readonly operation: string;
  readonly result?: T | undefined;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly violationDetails?: string | undefined;
  } | undefined;
}

/**
 * Transport interface for communicating with TrustedHostBroker.
 * Supports both in-process invocation and cross-process IPC.
 */
export interface BrokerTransport {
  handleRequest<T, R>(request: BrokerRequest<T>): Promise<BrokerResponse<R>>;
}

