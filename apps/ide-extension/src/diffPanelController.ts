/**
 * @mediator/ide-extension — Diff Panel & Approval Controller (S14)
 *
 * Requirements:
 * - Trustworthy local IDE control surface.
 * - Distinct, honest status labels:
 *   Proposed, Staged, Validated, Conflicted, Awaiting user approval,
 *   Approved but not applied, Applying, Applied, Denied, Paused, Stopped,
 *   Rollback available, Recovery required.
 * - Bounded diff previews with protected-path and destructive operation badges.
 * - Single-action approval resolution restricted to trusted local UI callers.
 * - Pause and Stop semantics preserving state and recovery evidence.
 * - Controlled live apply-back and hash-verified rollback.
 */

import { type WorkspaceRootState } from '@mediator/workspace-boundary';
import { type CallerIdentity } from '@mediator/policy-engine';
import {
  type StageStore,
  type StageDiffPreview,
  type BoundApproval,
  type ApplyService,
  type ApplyResult,
  type ApprovalService,
} from '@mediator/stage-store';

export type ReviewStatus =
  | 'proposed'
  | 'staged'
  | 'validated'
  | 'conflicted'
  | 'awaiting_approval'
  | 'approved'
  | 'applying'
  | 'applied'
  | 'denied'
  | 'paused'
  | 'stopped'
  | 'rollback_available'
  | 'recovery_required';

export interface FileReviewItem {
  readonly relativePath: string;
  readonly changeType: string;
  readonly isProtected: boolean;
  readonly requiresManualReview: boolean;
  readonly isDestructive: boolean;
  readonly conflictStatus: string;
  readonly conflictReason?: string | undefined;
  readonly baseHash: string | null;
  readonly stagedHash: string;
  readonly diff: StageDiffPreview;
}

export interface ReviewPanelState {
  readonly taskId: string;
  readonly stageId: string;
  readonly status: ReviewStatus;
  readonly items: readonly FileReviewItem[];
  readonly activeApproval: BoundApproval | null;
  readonly conflictsCount: number;
  readonly protectedCount: number;
  readonly destructiveCount: number;
  readonly errorMessage: string | null;
  readonly applySupported: boolean;
  readonly lastValidatedAt: number;
  readonly lastTransactionId?: string | undefined;
}

export class DiffPanelController {
  private state: ReviewPanelState;

  constructor(
    private readonly stageStore: StageStore,
    private readonly approvalService: ApprovalService,
    private readonly applyService: ApplyService,
    taskId: string,
    stageId: string,
  ) {
    this.state = {
      taskId,
      stageId,
      status: 'proposed',
      items: [],
      activeApproval: null,
      conflictsCount: 0,
      protectedCount: 0,
      destructiveCount: 0,
      errorMessage: null,
      applySupported: true,
      lastValidatedAt: Date.now(),
    };
  }

  public getState(): ReviewPanelState {
    return this.state;
  }

  /**
   * Load and refresh staged changes, diffs, conflicts, and risk classifications.
   */
  public refreshReview(workspace: WorkspaceRootState): ReviewPanelState {
    const stagedFiles = this.stageStore.listStagedChanges(this.state.stageId, workspace);
    const diffs = this.stageStore.getStageDiff(this.state.stageId, workspace);

    let conflictsCount = 0;
    let protectedCount = 0;
    let destructiveCount = 0;

    const items: FileReviewItem[] = stagedFiles.map((file) => {
      const diff = diffs.find((d) => d.relativePath === file.relativePath) ?? {
        relativePath: file.relativePath,
        changeType: file.changeType,
        stats: { additions: 0, deletions: 0, modifications: 0 },
        diffText: '',
        baseHash: file.baseContentHash,
        stagedHash: file.stagedContentHash,
        isProtected: file.isProtected,
        policyDecision: file.policyDecision,
        conflictStatus: file.conflictStatus,
        conflictReason: file.conflictReason,
        requiresManualReview: file.requiresManualReview,
        isBinary: file.encoding === 'binary',
      };

      if (file.conflictStatus !== 'clean') conflictsCount++;
      if (file.isProtected) protectedCount++;
      const isDestructive = file.changeType === 'delete-proposed' || file.changeType === 'rename-proposed';
      if (isDestructive) destructiveCount++;

      return {
        relativePath: file.relativePath,
        changeType: file.changeType,
        isProtected: file.isProtected,
        requiresManualReview: file.requiresManualReview || isDestructive,
        isDestructive,
        conflictStatus: file.conflictStatus,
        conflictReason: file.conflictReason,
        baseHash: file.baseContentHash,
        stagedHash: file.stagedContentHash,
        diff,
      };
    });

    let newStatus: ReviewStatus = this.state.status;
    if (this.state.status === 'paused' || this.state.status === 'stopped') {
      // Preserve paused / stopped state
    } else if (conflictsCount > 0) {
      newStatus = 'conflicted';
    } else if (items.length > 0) {
      newStatus = this.state.activeApproval
        ? this.state.activeApproval.status === 'approved'
          ? 'approved'
          : 'awaiting_approval'
        : 'staged';
    } else {
      newStatus = 'proposed';
    }

    this.state = {
      ...this.state,
      items,
      status: newStatus,
      conflictsCount,
      protectedCount,
      destructiveCount,
      lastValidatedAt: Date.now(),
    };

    return this.state;
  }

  /**
   * Request approval for the current set of staged changes.
   */
  public requestApproval(
    workspace: WorkspaceRootState,
    caller: CallerIdentity,
  ): BoundApproval {
    this.refreshReview(workspace);

    if (this.state.conflictsCount > 0) {
      throw new Error(`Cannot request approval: ${this.state.conflictsCount} unresolved conflict(s) detected`);
    }
    if (this.state.items.length === 0) {
      throw new Error('Cannot request approval for an empty stage');
    }

    const stagedFiles = this.stageStore.listStagedChanges(this.state.stageId, workspace);
    const canonicalRoot = workspace.canonicalPath ?? workspace.selectedPath;

    const approval = this.approvalService.createApprovalRequest({
      taskId: this.state.taskId,
      stageId: this.state.stageId,
      workspaceIdentity: canonicalRoot,
      files: stagedFiles,
      caller,
    });

    this.state = {
      ...this.state,
      activeApproval: approval,
      status: 'awaiting_approval',
    };

    return approval;
  }

  /**
   * Trusted user resolves approval (Approve Once).
   * Caller must be trusted local UI. AI and MCP cannot approve.
   */
  public approveOnce(caller: CallerIdentity): BoundApproval {
    if (!this.state.activeApproval) {
      throw new Error('No active approval request to approve');
    }

    const resolved = this.approvalService.resolveApproval({
      approvalId: this.state.activeApproval.approvalId,
      resolution: 'approved',
      caller,
    });

    this.state = {
      ...this.state,
      activeApproval: resolved,
      status: 'approved',
    };

    return resolved;
  }

  /**
   * Trusted user resolves approval (Deny).
   */
  public deny(caller: CallerIdentity): BoundApproval {
    if (!this.state.activeApproval) {
      throw new Error('No active approval request to deny');
    }

    const resolved = this.approvalService.resolveApproval({
      approvalId: this.state.activeApproval.approvalId,
      resolution: 'denied',
      caller,
    });

    this.state = {
      ...this.state,
      activeApproval: resolved,
      status: 'denied',
    };

    return resolved;
  }

  /**
   * Pause processing while preserving stage, checkpoints, and pending review state.
   */
  public pause(): ReviewPanelState {
    this.state = {
      ...this.state,
      status: 'paused',
    };
    return this.state;
  }

  /**
   * Stop processing, cancelling pending work while retaining recovery evidence.
   */
  public stop(): ReviewPanelState {
    this.state = {
      ...this.state,
      status: 'stopped',
    };
    return this.state;
  }

  /**
   * Resume from paused state after re-validation.
   */
  public resume(workspace: WorkspaceRootState): ReviewPanelState {
    this.state = {
      ...this.state,
      status: 'staged',
    };
    return this.refreshReview(workspace);
  }

  /**
   * Apply approved changes to the live workspace.
   */
  public applyToWorkspace(
    workspace: WorkspaceRootState,
    caller: CallerIdentity,
  ): ApplyResult {
    if (!this.state.activeApproval) {
      throw new Error('Cannot apply: no approval request has been created or approved');
    }

    const approvalId = this.state.activeApproval.approvalId;

    this.state = {
      ...this.state,
      status: 'applying',
    };

    try {
      const result = this.applyService.applyToWorkspace(
        this.state.stageId,
        approvalId,
        workspace,
        caller,
      );

      this.state = {
        ...this.state,
        status: 'applied',
        lastTransactionId: result.transactionId,
      };

      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state = {
        ...this.state,
        status: msg.includes('RECOVERY_REQUIRED') ? 'recovery_required' : 'conflicted',
        errorMessage: msg,
      };
      throw err;
    }
  }

  /**
   * Rollback a transaction that was applied to the live workspace.
   */
  public rollbackApplied(
    transactionId: string,
    workspace: WorkspaceRootState,
  ): ApplyResult {
    const res = this.applyService.rollbackTransaction(transactionId, workspace);
    this.state = {
      ...this.state,
      status: res.status === 'recovery_required' ? 'recovery_required' : 'rollback_available',
    };
    return res;
  }

  /**
   * Rollback staged shadow content using an S12 checkpoint.
   * Live workspace is never touched.
   */
  public rollbackStaged(checkpointId: string): void {
    this.stageStore.restoreCheckpoint(this.state.stageId, checkpointId);
    this.state = {
      ...this.state,
      status: 'rollback_available',
      activeApproval: null,
    };
  }
}
