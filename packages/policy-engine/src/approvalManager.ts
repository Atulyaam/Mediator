/**
 * @mediator/policy-engine — Approval Manager (S07)
 *
 * Implements strict separation of approval request creation and approval resolution.
 *
 * Security invariants:
 * - `request_approval` creates a uniquely identified pending approval request ONLY.
 * - Approvals are bound to exact (taskId, actionId, targetPaths, changeHash).
 * - Approvals expire after a configured timeout (default: 5 minutes) and auto-deny.
 * - Only trusted user UI callers (IDE UI / CLI user confirmation) may resolve approvals.
 * - MCP tools, browser extensions, AI agents CANNOT resolve their own approval requests.
 * - Single-use: once consumed, an approval cannot be reused for another action.
 */

import { randomUUID } from 'crypto';
import {
  type PendingApprovalRequest,
  type CallerIdentity,
  type PolicyDecisionType,
} from './policyTypes.js';

export interface CreateApprovalParams {
  readonly taskId: string;
  readonly actionId: string;
  readonly targetPaths: readonly string[];
  readonly changeHash: string;
  readonly decision: PolicyDecisionType;
  readonly reason: string;
  readonly timeoutMs?: number | undefined;
}

export interface ResolveApprovalParams {
  readonly approvalId: string;
  readonly resolution: 'approved' | 'denied';
  readonly caller: CallerIdentity;
  readonly resolvedBy?: string | undefined;
}

export type ResolveApprovalResult =
  | { readonly success: true; readonly approval: PendingApprovalRequest }
  | { readonly success: false; readonly error: string; readonly reasonCode: string };

export type ConsumeApprovalResult =
  | { readonly success: true; readonly approval: PendingApprovalRequest }
  | { readonly success: false; readonly error: string; readonly reasonCode: string };

/**
 * In-memory or state-bound Approval Store.
 */
export class ApprovalStore {
  private readonly approvals = new Map<string, PendingApprovalRequest>();

  /**
   * Create and register a pending approval request.
   */
  createRequest(params: CreateApprovalParams): PendingApprovalRequest {
    const now = Date.now();
    const timeout = params.timeoutMs ?? 300_000; // default 5 minutes
    const approvalId = `appr_${randomUUID()}`;

    const request: PendingApprovalRequest = {
      approvalId,
      taskId: params.taskId,
      actionId: params.actionId,
      targetPaths: [...params.targetPaths],
      changeHash: params.changeHash,
      decision: params.decision,
      reason: params.reason,
      createdAt: now,
      expiresAt: now + timeout,
      status: 'pending',
    };

    this.approvals.set(approvalId, request);
    return request;
  }

  /**
   * Get an approval request by ID, evaluating timeout expiration.
   */
  get(approvalId: string): PendingApprovalRequest | undefined {
    const request = this.approvals.get(approvalId);
    if (!request) return undefined;

    // Check expiration on read
    if (request.status === 'pending' && Date.now() > request.expiresAt) {
      request.status = 'expired';
    }

    return request;
  }

  /**
   * Resolve a pending approval request.
   *
   * Crucial security rule: Only authenticated user UI interactions can resolve.
   */
  resolve(params: ResolveApprovalParams): ResolveApprovalResult {
    const request = this.get(params.approvalId);
    if (!request) {
      return {
        success: false,
        error: `Approval request '${params.approvalId}' not found.`,
        reasonCode: 'APPROVAL_NOT_FOUND',
      };
    }

    // Check caller authority: MCP, browser, agent, or unauthenticated callers CANNOT approve
    if (!params.caller.isTrustedUI || params.caller.type === 'mcp' || params.caller.type === 'agent' || params.caller.type === 'browser') {
      return {
        success: false,
        error: `Caller of type '${params.caller.type}' is unauthorized to resolve approvals. Only trusted user UI interactions may resolve approvals.`,
        reasonCode: 'CALLER_UNAUTHORIZED_FOR_APPROVAL',
      };
    }

    // Check if expired
    if (request.status === 'expired' || Date.now() > request.expiresAt) {
      request.status = 'expired';
      return {
        success: false,
        error: `Approval request '${params.approvalId}' has expired (timeout exceeded).`,
        reasonCode: 'APPROVAL_EXPIRED',
      };
    }

    // Check if already resolved
    if (request.status !== 'pending') {
      return {
        success: false,
        error: `Approval request '${params.approvalId}' has already been resolved with status '${request.status}'.`,
        reasonCode: 'APPROVAL_ALREADY_RESOLVED',
      };
    }

    request.status = params.resolution;
    request.resolvedAt = Date.now();
    request.resolvedBy = params.resolvedBy ?? params.caller.id ?? 'trusted_ui_user';

    return { success: true, approval: request };
  }

  /**
   * Consume an approved request for execution.
   * Enforces single-use and exact payload binding.
   */
  consume(
    approvalId: string,
    expectedTaskId: string,
    expectedActionId: string,
    expectedChangeHash?: string,
  ): ConsumeApprovalResult {
    const request = this.get(approvalId);
    if (!request) {
      return {
        success: false,
        error: `Approval '${approvalId}' not found.`,
        reasonCode: 'APPROVAL_NOT_FOUND',
      };
    }

    if (request.status === 'expired') {
      return {
        success: false,
        error: `Approval '${approvalId}' has expired.`,
        reasonCode: 'APPROVAL_EXPIRED',
      };
    }

    if (request.status !== 'approved') {
      return {
        success: false,
        error: `Approval '${approvalId}' is not approved (status: ${request.status}).`,
        reasonCode: 'APPROVAL_REQUIRED',
      };
    }

    if (request.consumed) {
      return {
        success: false,
        error: `Approval '${approvalId}' has already been consumed (single-use invariant).`,
        reasonCode: 'APPROVAL_ALREADY_RESOLVED',
      };
    }

    if (request.taskId !== expectedTaskId) {
      return {
        success: false,
        error: `Approval taskId mismatch (bound to '${request.taskId}', expected '${expectedTaskId}').`,
        reasonCode: 'APPROVAL_PAYLOAD_MISMATCH',
      };
    }

    if (request.actionId !== expectedActionId) {
      return {
        success: false,
        error: `Approval actionId mismatch (bound to '${request.actionId}', expected '${expectedActionId}').`,
        reasonCode: 'APPROVAL_PAYLOAD_MISMATCH',
      };
    }

    if (expectedChangeHash && request.changeHash !== expectedChangeHash) {
      return {
        success: false,
        error: `Approval changeHash mismatch. The staged content has changed since approval was granted.`,
        reasonCode: 'APPROVAL_PAYLOAD_MISMATCH',
      };
    }

    // Mark as consumed
    request.consumed = true;
    return { success: true, approval: request };
  }

  /** List all active approvals for diagnostics / UI */
  list(): readonly PendingApprovalRequest[] {
    return Array.from(this.approvals.values());
  }

  /** Clear all approvals (for test resets) */
  clear(): void {
    this.approvals.clear();
  }
}
