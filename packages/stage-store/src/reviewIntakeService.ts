/**
 * @mediator/stage-store — Review Intake Service (Sprint S17)
 *
 * Requirements:
 * - Narrow, explicitly scoped intake path for recording human-review requests originated from MCP or agents.
 * - Request-only workflow: creating a review request NEVER authorizes, approves, or executes an action.
 * - Rejects caller-supplied trust/role/approval overrides; sets status strictly to 'pending-review'.
 * - ONLY trusted local user UI interactions can resolve pending review requests.
 * - Payload hash binding: any changed action/stage payload invalidates the request's approval eligibility.
 * - Comprehensive audit trails with correlation IDs.
 */

import * as crypto from 'node:crypto';
import {
  type Result,
  ok,
  err,
  makeMediatorError,
  ErrorCode,
  type MediatorError,
  type PendingReviewRequest,
  ReviewRequestStatus,
} from '@mediator/shared-contracts';
import {
  type ReviewRequestRepository,
  type TaskRepository,
  type AuditRepository,
  safeRedactString,
} from '@mediator/persistence';
import { type CallerIdentity } from '@mediator/policy-engine';

export const DEFAULT_REVIEW_REQUEST_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export interface CreateReviewRequestParams {
  readonly taskId: string;
  readonly sessionId: string;
  readonly actionId?: string | undefined;
  readonly stageId?: string | undefined;
  readonly payloadHash?: string | undefined;
  readonly requestedScope: readonly string[];
  readonly origin: string;
  readonly reason: string;
  readonly correlationId?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ResolveReviewRequestParams {
  readonly requestId: string;
  readonly resolution: 'approved' | 'denied';
  readonly caller: CallerIdentity;
  readonly currentPayloadHash?: string | undefined;
  readonly resolutionReason?: string | undefined;
}

export interface ReviewIntakeServiceDependencies {
  readonly reviewRequestRepo: ReviewRequestRepository;
  readonly taskRepo: TaskRepository;
  readonly auditRepo: AuditRepository;
}

export class ReviewIntakeService {
  constructor(private readonly deps: ReviewIntakeServiceDependencies) {}

  /**
   * Create a Pending Human-Review Request
   * Request-only: Never authorizes, approves, or mutates policy.
   */
  public createReviewRequest(
    params: CreateReviewRequestParams,
  ): Result<PendingReviewRequest, MediatorError> {
    const { taskId, sessionId } = params;

    // Validate task exists
    const task = this.deps.taskRepo.getTask(taskId);
    if (!task) {
      return err(
        makeMediatorError(
          ErrorCode.UNAUTHORIZED_TASK_SCOPE,
          `Cannot create review request: task "${taskId}" does not exist in local task ledger`,
          { taskId, sessionId },
        ),
      );
    }

    if (!params.requestedScope || params.requestedScope.length === 0) {
      return err(
        makeMediatorError(
          ErrorCode.SCHEMA_INVALID,
          'requestedScope must contain at least one target path or pattern',
          { taskId, sessionId },
        ),
      );
    }

    const now = Date.now();
    const timeoutMs = params.timeoutMs ?? DEFAULT_REVIEW_REQUEST_TIMEOUT_MS;
    const expiresAt = now + timeoutMs;
    const requestId = `rev_req_${crypto.randomUUID().slice(0, 12)}`;
    const correlationId = params.correlationId ?? `corr_${crypto.randomUUID().slice(0, 8)}`;
    const safeReason = safeRedactString(params.reason);
    const payloadHash =
      params.payloadHash ??
      crypto.createHash('sha256').update(JSON.stringify(params.requestedScope)).digest('hex');

    // STRICT: Status is ALWAYS pending-review regardless of caller request
    const request: PendingReviewRequest = {
      requestId,
      taskId,
      sessionId,
      actionId: params.actionId,
      stageId: params.stageId,
      payloadHash,
      requestedScope: params.requestedScope,
      origin: params.origin,
      reason: safeReason,
      status: ReviewRequestStatus.PENDING_REVIEW,
      createdAt: now,
      expiresAt,
      correlationId,
    };

    const saved = this.deps.reviewRequestRepo.createRequest(request);

    // Record audit event
    this.deps.auditRepo.appendEvent({
      taskId,
      sessionId,
      correlationId,
      eventType: 'review_requested',
      actor: 'agent',
      outcome: 'pending',
      details: {
        requestId,
        origin: params.origin,
        requestedScope: params.requestedScope,
        reason: safeReason,
        status: ReviewRequestStatus.PENDING_REVIEW,
        expiresAt,
        payloadHash,
      },
    });

    return ok(saved);
  }

  /**
   * Resolve a Pending Human-Review Request
   * STRICT: Only trusted local UI callers ('ide'/'cli' with isTrustedUI) can resolve.
   * Payload hash change invalidates approval eligibility.
   */
  public resolveReviewRequest(
    params: ResolveReviewRequestParams,
  ): Result<PendingReviewRequest, MediatorError> {
    // 1. Caller check: ONLY trusted UI caller allowed
    if (!params.caller.isTrustedUI || (params.caller.type !== 'ide' && params.caller.type !== 'cli')) {
      return err(
        makeMediatorError(
          ErrorCode.ACTION_DENIED,
          `Caller of type '${params.caller.type}' is unauthorized to resolve review requests. Only trusted local user UI interactions may resolve reviews.`,
          { detail: { caller: params.caller } },
        ),
      );
    }

    const request = this.deps.reviewRequestRepo.getRequest(params.requestId);
    if (!request) {
      return err(
        makeMediatorError(
          ErrorCode.REVIEW_REQUEST_NOT_FOUND,
          `Review request "${params.requestId}" not found`,
        ),
      );
    }

    // 2. Check expiration
    const now = Date.now();
    if (now > request.expiresAt || request.status === ReviewRequestStatus.EXPIRED) {
      this.deps.reviewRequestRepo.expireStaleRequests(now);
      return err(
        makeMediatorError(
          ErrorCode.REVIEW_REQUEST_EXPIRED,
          `Cannot resolve: review request "${params.requestId}" has expired`,
          { detail: { requestId: params.requestId, expiresAt: request.expiresAt } },
        ),
      );
    }

    // 3. Check already resolved or invalidated
    if (request.status !== ReviewRequestStatus.PENDING_REVIEW) {
      return err(
        makeMediatorError(
          ErrorCode.REVIEW_REQUEST_ALREADY_RESOLVED,
          `Review request "${params.requestId}" is already in status '${request.status}' and cannot be resolved again`,
          { detail: { requestId: params.requestId, status: request.status } },
        ),
      );
    }

    // 4. Payload hash binding: if current payload hash is supplied and differs, invalidate
    if (params.currentPayloadHash && params.currentPayloadHash !== request.payloadHash) {
      this.deps.reviewRequestRepo.invalidateRequest(
        params.requestId,
        `Payload hash mismatch: request hash ${request.payloadHash} != current hash ${params.currentPayloadHash}`,
      );

      this.deps.auditRepo.appendEvent({
        taskId: request.taskId,
        sessionId: request.sessionId,
        correlationId: request.correlationId,
        eventType: 'review_invalidated',
        actor: 'system',
        outcome: 'invalidated',
        details: {
          requestId: params.requestId,
          reason: 'Payload hash modified since review request creation',
          expectedHash: request.payloadHash,
          actualHash: params.currentPayloadHash,
        },
      });

      return err(
        makeMediatorError(
          ErrorCode.REVIEW_REQUEST_INVALIDATED,
          `Review request "${params.requestId}" was invalidated because the underlying payload changed since the request was created`,
          { detail: { expectedHash: request.payloadHash, actualHash: params.currentPayloadHash } },
        ),
      );
    }

    // 5. Execute resolution
    const resolvedBy = params.caller.id ?? 'trusted_ui_user';
    const resolutionReason = params.resolutionReason ? safeRedactString(params.resolutionReason) : undefined;
    const resolved = this.deps.reviewRequestRepo.resolveRequest(
      params.requestId,
      params.resolution,
      resolvedBy,
      resolutionReason,
    );

    if (!resolved) {
      return err(
        makeMediatorError(
          ErrorCode.INTERNAL_ERROR,
          `Failed to resolve review request "${params.requestId}"`,
        ),
      );
    }

    // Record audit event
    this.deps.auditRepo.appendEvent({
      taskId: request.taskId,
      sessionId: request.sessionId,
      correlationId: request.correlationId,
      eventType: 'review_resolved',
      actor: 'human_operator',
      outcome: params.resolution,
      details: {
        requestId: params.requestId,
        resolution: params.resolution,
        resolvedBy,
        resolutionReason,
      },
    });

    return ok(resolved);
  }

  public getRequest(requestId: string): PendingReviewRequest | null {
    return this.deps.reviewRequestRepo.getRequest(requestId);
  }

  public listRequestsForTask(taskId: string): readonly PendingReviewRequest[] {
    return this.deps.reviewRequestRepo.listRequestsForTask(taskId);
  }

  public expireStaleRequests(): number {
    return this.deps.reviewRequestRepo.expireStaleRequests();
  }
}
