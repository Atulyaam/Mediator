/**
 * @mediator/stage-store — Apply-Back & Approval Types (S14)
 *
 * Defines contracts for trusted approval binding, transactional apply-back,
 * rollback journals, and failure recovery.
 */

import { type StageChangeType, type StagedFileRecord } from './stageTypes.js';
import { type CallerIdentity } from '@mediator/policy-engine';

export const DEFAULT_APPROVAL_EXPIRY_MS = 120_000; // 120 seconds default expiry

export type ApplyTransactionStatus =
  | 'preflight'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'rolled_back'
  | 'recovery_required';

export type ApplyItemStatus =
  | 'pending'
  | 'applied'
  | 'failed'
  | 'rolled_back'
  | 'recovery_required';

export interface BoundApproval {
  readonly approvalId: string;
  readonly actionId: string;
  readonly taskId: string;
  readonly stageId: string;
  readonly workspaceIdentity: string;
  readonly targetPaths: readonly string[];
  readonly operations: readonly StageChangeType[];
  /** SHA-256 hash of all target paths, operations, base hashes, and staged hashes */
  readonly payloadHash: string;
  readonly expectedBaseHashes: Readonly<Record<string, string | null>>;
  readonly expectedStageHashes: Readonly<Record<string, string>>;
  readonly isProtected: boolean;
  readonly requiresManualReview: boolean;
  readonly isDestructive: boolean;
  readonly status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly resolvedAt?: number | undefined;
  readonly resolvedBy?: string | undefined;
  readonly consumedAt?: number | undefined;
  readonly caller: CallerIdentity;
}

export interface CreateApprovalParams {
  readonly taskId: string;
  readonly stageId: string;
  readonly workspaceIdentity: string;
  readonly files: readonly StagedFileRecord[];
  readonly caller: CallerIdentity;
  readonly timeoutMs?: number | undefined;
}

export interface ResolveApprovalParams {
  readonly approvalId: string;
  readonly resolution: 'approved' | 'denied';
  readonly caller: CallerIdentity;
  readonly resolvedBy?: string | undefined;
}

export interface ApplyTransactionRecord {
  readonly transactionId: string;
  readonly taskId: string;
  readonly stageId: string;
  readonly approvalId: string;
  readonly payloadHash: string;
  readonly status: ApplyTransactionStatus;
  readonly backupDir: string;
  readonly createdAt: number;
  readonly completedAt?: number | undefined;
  readonly errorMessage?: string | undefined;
}

export interface ApplyItemRecord {
  readonly itemId: string;
  readonly transactionId: string;
  readonly relativePath: string;
  readonly operation: StageChangeType;
  readonly baseHash: string | null;
  readonly postApplyHash?: string | undefined;
  readonly status: ApplyItemStatus;
  readonly backupPath?: string | undefined;
  readonly targetPath?: string | undefined;
  readonly appliedAt?: number | undefined;
  readonly errorMessage?: string | undefined;
}

export interface ApplyResult {
  readonly transactionId: string;
  readonly status: ApplyTransactionStatus;
  readonly appliedCount: number;
  readonly rolledBackCount: number;
  readonly recoveryRequiredCount: number;
  readonly items: readonly ApplyItemRecord[];
  readonly errorMessage?: string | undefined;
}
