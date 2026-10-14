/**
 * @mediator/stage-store — Staging Types & Contracts (S12)
 *
 * Defines the task-scoped shadow staging store data models, proposal contracts,
 * diff previews, checkpoint records, and staging capabilities.
 */

import { type PolicyDecisionType } from '@mediator/policy-engine';
import { type WorkspaceRootState } from '@mediator/workspace-boundary';

export type StageStatus = 'active' | 'checkpointed' | 'discarded' | 'conflict';

export type StageChangeType = 'add' | 'modify' | 'delete-proposed' | 'rename-proposed';

export type StageConflictStatus = 'clean' | 'conflict' | 'stale';

export interface StageRecord {
  readonly stageId: string;
  readonly taskId: string;
  readonly workspaceIdentity: string;
  readonly canonicalWorkspacePath: string;
  readonly status: StageStatus;
  readonly checkpointId: string | null;
  readonly stageVersion: number;
  readonly parentCheckpointId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface StagedFileRecord {
  readonly stageId: string;
  readonly relativePath: string;
  readonly sourceExistsAtBase: boolean;
  readonly baseContentHash: string | null;
  readonly baseMtimeMs: number | null;
  readonly baseSizeBytes: number | null;
  readonly stagedContentHash: string;
  readonly byteLength: number;
  readonly encoding: 'utf8' | 'binary';
  readonly changeType: StageChangeType;
  readonly isProtected: boolean;
  readonly policyDecision: PolicyDecisionType;
  readonly requiresManualReview: boolean;
  readonly targetPath?: string | undefined; // For rename-proposed
  readonly conflictStatus: StageConflictStatus;
  readonly conflictReason?: string | undefined;
  readonly stagedStoragePath: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StageFileProposal {
  readonly relativePath: string;
  readonly changeType: StageChangeType;
  readonly content?: string | Buffer | undefined;
  readonly targetPath?: string | undefined; // Required for rename-proposed
  readonly expectedBaseHash?: string | undefined;
  readonly encoding?: 'utf8' | 'binary' | undefined;
}

export interface StageDiffStats {
  readonly additions: number;
  readonly deletions: number;
  readonly modifications: number;
}

export interface StageDiffPreview {
  readonly relativePath: string;
  readonly changeType: StageChangeType;
  readonly stats: StageDiffStats;
  readonly diffText: string;
  readonly baseHash: string | null;
  readonly stagedHash: string;
  readonly isProtected: boolean;
  readonly policyDecision: PolicyDecisionType;
  readonly conflictStatus: StageConflictStatus;
  readonly conflictReason?: string | undefined;
  readonly requiresManualReview: boolean;
  readonly isBinary: boolean;
}

export interface StageCheckpointRecord {
  readonly checkpointId: string;
  readonly stageId: string;
  readonly taskId: string;
  readonly description?: string | undefined;
  readonly files: readonly StagedFileRecord[];
  readonly createdAt: number;
}

export interface StagingCapabilities {
  readonly stagingRoot: string;
  readonly isolationMethod: 'app_data_shadow';
  readonly liveWorkspaceMutationEnabled: false;
  readonly sandboxAccessibility: 'unknown';
}

export interface StageStoreOptions {
  /**
   * Base directory under which shadow files are placed.
   * If omitted, defaults to Mediator app-data staging directory.
   */
  readonly baseStagingDir?: string | undefined;
}

export interface CreateStageParams {
  readonly taskId: string;
  readonly workspace: WorkspaceRootState;
  readonly stageId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface DiscardStageConfirmation {
  readonly confirmed: boolean;
  readonly reason?: string | undefined;
}
