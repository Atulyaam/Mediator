/**
 * @mediator/persistence — Review Request Repository (S17)
 *
 * Persists pending human-review requests originated from MCP/agents or UI.
 * Security Invariant:
 * Creating or reading a review request NEVER authorizes or executes an action.
 * Only explicit trusted UI resolution can resolve pending requests.
 */

import {
  type PendingReviewRequest,
  type ReviewRequestStatusValue,
  ReviewRequestStatus,
} from '@mediator/shared-contracts';
import { type DatabaseConnection } from '../database.js';

interface ReviewRequestRow {
  request_id: string;
  task_id: string;
  session_id: string;
  action_id: string | null;
  stage_id: string | null;
  payload_hash: string;
  requested_scope: string;
  origin: string;
  reason: string;
  status: string;
  created_at: number;
  expires_at: number;
  correlation_id: string;
  resolved_at: number | null;
  resolved_by: string | null;
  resolution_reason: string | null;
}

function rowToRequest(row: ReviewRequestRow): PendingReviewRequest {
  let requestedScope: string[] = [];
  try {
    const parsed = JSON.parse(row.requested_scope) as unknown;
    if (Array.isArray(parsed)) {
      requestedScope = parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    requestedScope = [];
  }

  return {
    requestId: row.request_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    actionId: row.action_id ?? undefined,
    stageId: row.stage_id ?? undefined,
    payloadHash: row.payload_hash,
    requestedScope,
    origin: row.origin,
    reason: row.reason,
    status: row.status as ReviewRequestStatusValue,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    correlationId: row.correlation_id,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    resolutionReason: row.resolution_reason ?? undefined,
  };
}

export class ReviewRequestRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public createRequest(request: PendingReviewRequest): PendingReviewRequest {
    const stmt = this.db.prepare(`
      INSERT INTO review_requests (
        request_id,
        task_id,
        session_id,
        action_id,
        stage_id,
        payload_hash,
        requested_scope,
        origin,
        reason,
        status,
        created_at,
        expires_at,
        correlation_id,
        resolved_at,
        resolved_by,
        resolution_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    stmt.run(
      request.requestId,
      request.taskId,
      request.sessionId,
      request.actionId ?? null,
      request.stageId ?? null,
      request.payloadHash,
      JSON.stringify(request.requestedScope),
      request.origin,
      request.reason,
      request.status,
      request.createdAt,
      request.expiresAt,
      request.correlationId,
      request.resolvedAt ?? null,
      request.resolvedBy ?? null,
      request.resolutionReason ?? null,
    );

    return request;
  }

  public getRequest(requestId: string): PendingReviewRequest | null {
    const stmt = this.db.prepare(`
      SELECT * FROM review_requests WHERE request_id = ?;
    `);
    const row = stmt.get(requestId) as ReviewRequestRow | undefined;
    return row ? rowToRequest(row) : null;
  }

  public listRequestsForTask(taskId: string): readonly PendingReviewRequest[] {
    const stmt = this.db.prepare(`
      SELECT * FROM review_requests WHERE task_id = ? ORDER BY created_at DESC;
    `);
    const rows = stmt.all(taskId) as unknown as ReviewRequestRow[];
    return rows.map(rowToRequest);
  }

  public resolveRequest(
    requestId: string,
    resolution: 'approved' | 'denied',
    resolvedBy: string,
    resolutionReason?: string,
  ): PendingReviewRequest | null {
    const now = Date.now();
    const status: ReviewRequestStatusValue =
      resolution === 'approved' ? ReviewRequestStatus.APPROVED : ReviewRequestStatus.DENIED;

    const stmt = this.db.prepare(`
      UPDATE review_requests
      SET status = ?, resolved_at = ?, resolved_by = ?, resolution_reason = ?
      WHERE request_id = ? AND status = ?;
    `);
    stmt.run(status, now, resolvedBy, resolutionReason ?? null, requestId, ReviewRequestStatus.PENDING_REVIEW);

    return this.getRequest(requestId);
  }

  public invalidateRequest(requestId: string, reason: string): PendingReviewRequest | null {
    const stmt = this.db.prepare(`
      UPDATE review_requests
      SET status = ?, resolution_reason = ?
      WHERE request_id = ? AND status = ?;
    `);
    stmt.run(
      ReviewRequestStatus.INVALIDATED,
      reason,
      requestId,
      ReviewRequestStatus.PENDING_REVIEW,
    );
    return this.getRequest(requestId);
  }

  public expireStaleRequests(now: number = Date.now()): number {
    const stmt = this.db.prepare(`
      UPDATE review_requests
      SET status = ?
      WHERE expires_at < ? AND status = ?;
    `);
    const result = stmt.run(ReviewRequestStatus.EXPIRED, now, ReviewRequestStatus.PENDING_REVIEW);
    return Number(result.changes);
  }
}
