/**
 * @mediator/stage-store — Trusted Approval Service (S14)
 *
 * Security Invariants:
 * - Approvals bind to exact taskId, stageId, workspaceIdentity, targetPaths,
 *   operations, expectedBaseHashes, expectedStageHashes, and SHA-256 payloadHash.
 * - Enforces default 120-second expiration (DEFAULT_APPROVAL_EXPIRY_MS).
 * - Only trusted local user UI callers may resolve approvals. AI, MCP, and browser callers cannot.
 * - Single-use consumption: once consumed, cannot be reused.
 * - Payload tampering or stage changes invalidate the approval at consumption time.
 */

import * as crypto from 'node:crypto';
import { type StagedFileRecord } from './stageTypes.js';
import {
  type BoundApproval,
  type CreateApprovalParams,
  type ResolveApprovalParams,
  DEFAULT_APPROVAL_EXPIRY_MS,
} from './applyTypes.js';
import { ApplyError, ApplyErrorCode } from './applyErrors.js';

export function computePayloadHash(files: readonly StagedFileRecord[]): string {
  const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const payloadEntries = sorted.map((f) => ({
    path: f.relativePath,
    op: f.changeType,
    baseHash: f.baseContentHash,
    stagedHash: f.stagedContentHash,
    targetPath: f.targetPath ?? null,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(payloadEntries)).digest('hex');
}

export class ApprovalService {
  private readonly approvals = new Map<string, BoundApproval>();

  /**
   * Create a pending approval request bound to the exact staged files.
   */
  public createApprovalRequest(params: CreateApprovalParams): BoundApproval {
    const { taskId, stageId, workspaceIdentity, files, caller } = params;

    if (files.length === 0) {
      throw new ApplyError(
        ApplyErrorCode.APPROVAL_REQUIRED,
        'Cannot create approval request for an empty set of staged files',
        { taskId, stageId },
      );
    }

    const now = Date.now();
    const timeoutMs = params.timeoutMs ?? DEFAULT_APPROVAL_EXPIRY_MS;
    const expiresAt = now + timeoutMs;
    const approvalId = `appr_${crypto.randomUUID()}`;
    const actionId = `act_${crypto.randomUUID()}`;

    const targetPaths = files.map((f) => f.relativePath);
    const operations = files.map((f) => f.changeType);

    const expectedBaseHashes: Record<string, string | null> = {};
    const expectedStageHashes: Record<string, string> = {};

    let isProtected = false;
    let requiresManualReview = false;
    let isDestructive = false;

    for (const f of files) {
      expectedBaseHashes[f.relativePath] = f.baseContentHash;
      expectedStageHashes[f.relativePath] = f.stagedContentHash;
      if (f.isProtected) isProtected = true;
      if (f.requiresManualReview) requiresManualReview = true;
      if (f.changeType === 'delete-proposed' || f.changeType === 'rename-proposed') {
        isDestructive = true;
        requiresManualReview = true;
      }
    }

    const payloadHash = computePayloadHash(files);

    const approval: BoundApproval = {
      approvalId,
      actionId,
      taskId,
      stageId,
      workspaceIdentity,
      targetPaths,
      operations,
      payloadHash,
      expectedBaseHashes,
      expectedStageHashes,
      isProtected,
      requiresManualReview,
      isDestructive,
      status: 'pending',
      createdAt: now,
      expiresAt,
      caller,
    };

    this.approvals.set(approvalId, approval);
    return approval;
  }

  /**
   * Resolve an approval request.
   * Invariant: Only trusted local UI callers may resolve. AI and MCP cannot.
   */
  public resolveApproval(params: ResolveApprovalParams): BoundApproval {
    const approval = this.approvals.get(params.approvalId);
    if (!approval) {
      throw new ApplyError(
        ApplyErrorCode.APPROVAL_NOT_FOUND,
        `Approval request '${params.approvalId}' was not found`,
        { approvalId: params.approvalId },
      );
    }

    // 1. Caller authority check: MCP, browser, or unauthenticated agent cannot resolve
    if (
      !params.caller.isTrustedUI ||
      params.caller.type === 'mcp' ||
      params.caller.type === 'agent' ||
      params.caller.type === 'browser'
    ) {
      throw new ApplyError(
        ApplyErrorCode.CALLER_UNAUTHORIZED,
        `Caller of type '${params.caller.type}' is unauthorized to resolve approvals. Only trusted user UI interactions may resolve approvals.`,
        { approvalId: params.approvalId, details: params.caller },
      );
    }

    // 2. Check expiration
    if (Date.now() > approval.expiresAt || approval.status === 'expired') {
      const expiredApproval: BoundApproval = { ...approval, status: 'expired' };
      this.approvals.set(params.approvalId, expiredApproval);
      throw new ApplyError(
        ApplyErrorCode.APPROVAL_EXPIRED,
        `Approval request '${params.approvalId}' has expired (timeout exceeded)`,
        { approvalId: params.approvalId },
      );
    }

    // 3. Check already resolved
    if (approval.status !== 'pending') {
      throw new ApplyError(
        ApplyErrorCode.APPROVAL_ALREADY_RESOLVED,
        `Approval request '${params.approvalId}' has already been resolved with status '${approval.status}'`,
        { approvalId: params.approvalId },
      );
    }

    const resolved: BoundApproval = {
      ...approval,
      status: params.resolution,
      resolvedAt: Date.now(),
      resolvedBy: params.resolvedBy ?? params.caller.id ?? 'trusted_ui_user',
    };

    this.approvals.set(params.approvalId, resolved);
    return resolved;
  }

  /**
   * Consume an approved request for apply-back.
   * Enforces single-use, non-expired status, and exact payload hash match.
   */
  public consumeApproval(
    approvalId: string,
    currentFiles: readonly StagedFileRecord[],
  ): BoundApproval {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      throw new ApplyError(
        ApplyErrorCode.APPROVAL_NOT_FOUND,
        `Approval '${approvalId}' was not found`,
        { approvalId },
      );
    }

    if (Date.now() > approval.expiresAt || approval.status === 'expired') {
      const expiredApproval: BoundApproval = { ...approval, status: 'expired' };
      this.approvals.set(approvalId, expiredApproval);
      throw new ApplyError(
        ApplyErrorCode.APPROVAL_EXPIRED,
        `Approval '${approvalId}' has expired`,
        { approvalId },
      );
    }

    if (approval.status === 'consumed') {
      throw new ApplyError(
        ApplyErrorCode.APPROVAL_ALREADY_CONSUMED,
        `Approval '${approvalId}' has already been consumed (single-use invariant)`,
        { approvalId },
      );
    }

    if (approval.status !== 'approved') {
      throw new ApplyError(
        ApplyErrorCode.APPROVAL_REQUIRED,
        `Approval '${approvalId}' is not approved (status: ${approval.status})`,
        { approvalId },
      );
    }

    // Verify current staged payload hash matches the approved hash exactly
    const currentPayloadHash = computePayloadHash(currentFiles);
    if (currentPayloadHash !== approval.payloadHash) {
      throw new ApplyError(
        ApplyErrorCode.APPROVAL_PAYLOAD_MISMATCH,
        `Staged content has changed since approval '${approvalId}' was granted. Re-inspection and re-approval required.`,
        { approvalId, details: { expected: approval.payloadHash, current: currentPayloadHash } },
      );
    }

    const consumed: BoundApproval = {
      ...approval,
      status: 'consumed',
      consumedAt: Date.now(),
    };

    this.approvals.set(approvalId, consumed);
    return consumed;
  }

  public getApproval(approvalId: string): BoundApproval | undefined {
    const app = this.approvals.get(approvalId);
    if (app && app.status === 'pending' && Date.now() > app.expiresAt) {
      const expired: BoundApproval = { ...app, status: 'expired' };
      this.approvals.set(approvalId, expired);
      return expired;
    }
    return app;
  }

  public listApprovals(): readonly BoundApproval[] {
    return Array.from(this.approvals.values()).map((a) => {
      if (a.status === 'pending' && Date.now() > a.expiresAt) {
        return { ...a, status: 'expired' };
      }
      return a;
    });
  }
}
