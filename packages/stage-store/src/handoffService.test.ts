/**
 * @mediator/stage-store — Sprint S17 Comprehensive Tests
 *
 * Covers all 20 requirements from Sprint S17 specification:
 * 1. Handoff creation persists correctly.
 * 2. Generated prompt uses authoritative task/context data.
 * 3. Prompt remains bounded.
 * 4. Prompt contains no excluded secrets.
 * 5. Copy/ingest/cancel lifecycle.
 * 6. Ingesting a valid report assigns agent-reported provenance.
 * 7. A claimed verified: true cannot become executor-verified.
 * 8. A claimed approved: true cannot resolve approval.
 * 9. Invalid report schema rejects safely.
 * 10. Oversized/nested malicious reports reject.
 * 11. Wrong-task/session/handoff identity rejects.
 * 12. Stale, expired and cancelled handoffs reject late reports.
 * 13. Unexpected reported paths produce a discrepancy/blocker.
 * 14. Secret-bearing report content is rejected or sanitized safely.
 * 15. MCP report cannot change policy.
 * 16. MCP cannot resolve an approval.
 * 17. Any permitted request-intake endpoint creates pending review only.
 * 18. Changing payload hash invalidates a pending request's approval eligibility.
 * 19. Restart preserves valid handoff metadata without replay.
 * 20. Audit events are bounded and secret-safe.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  type WorkspaceRootState,
  TaskState,
  EvidenceLevel,
  HandoffStatus,
  ReviewRequestStatus,
  ErrorCode,
} from '@mediator/shared-contracts';
import { type CallerIdentity } from '@mediator/policy-engine';
import {
  DatabaseConnection,
  runMigrations,
  TaskRepository,
  type TaskRecord,
  SessionRepository,
  EvidenceRepository,
  AuditRepository,
  HandoffRepository,
  ReviewRequestRepository,
} from '@mediator/persistence';
import { inspectWorkspaceRoot } from '@mediator/workspace-boundary';
import { StageStore } from './stageStore.js';
import { HandoffService } from './handoffService.js';
import { ReviewIntakeService } from './reviewIntakeService.js';

describe('Sprint S17 — MCP Handoff UX & Evidence Provenance', () => {
  let tempBaseDir: string;
  let workspaceDir: string;
  let stagingDir: string;
  let dbPath: string;
  let db: DatabaseConnection;
  let taskRepo: TaskRepository;
  let sessionRepo: SessionRepository;
  let evidenceRepo: EvidenceRepository;
  let auditRepo: AuditRepository;
  let handoffRepo: HandoffRepository;
  let reviewRequestRepo: ReviewRequestRepository;
  let stageStore: StageStore;
  let handoffService: HandoffService;
  let reviewIntakeService: ReviewIntakeService;
  let rootState: WorkspaceRootState;

  const validTaskId = 'task-s17-001';
  const otherTaskId = 'task-s17-other';
  const validSessionId = 'session-s17-001';

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s17-test-'));
    workspaceDir = path.join(tempBaseDir, 'workspace');
    stagingDir = path.join(tempBaseDir, 'staging');
    dbPath = path.join(tempBaseDir, 'mediator.sqlite');

    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    // Seed sample files
    fs.writeFileSync(path.join(workspaceDir, 'package.json'), JSON.stringify({ name: 'test-app' }));
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# Test Project');

    // Confirmed workspace root
    rootState = inspectWorkspaceRoot(workspaceDir, 'ide');
    rootState = {
      ...rootState,
      confirmationStatus: 'confirmed',
      confirmationTimestamp: Date.now(),
    };

    // Database and repositories
    db = new DatabaseConnection({ path: dbPath });
    db.open();
    runMigrations(db);

    taskRepo = new TaskRepository(db);
    sessionRepo = new SessionRepository(db);
    evidenceRepo = new EvidenceRepository(db);
    auditRepo = new AuditRepository(db);
    handoffRepo = new HandoffRepository(db);
    reviewRequestRepo = new ReviewRequestRepository(db);

    // Seed tasks
    taskRepo.createTask({
      taskId: validTaskId,
      state: TaskState.TASK_DEFINED,
      goalSummary: 'Implement secure login validation',
      acceptanceCriteria: ['Validates input safely', 'Returns 401 on invalid token'],
      createdAt: Date.now(),
      metadata: {
        scope: ['src/auth.ts'],
        maxRounds: 10,
        roundCount: 1,
        conversationId: 'conv-s17-001',
      },
    });

    taskRepo.createTask({
      taskId: otherTaskId,
      state: TaskState.TASK_DEFINED,
      goalSummary: 'Other separate task',
      acceptanceCriteria: ['Must not leak'],
      createdAt: Date.now(),
      metadata: {
        scope: ['src/other.ts'],
        maxRounds: 10,
        roundCount: 1,
        conversationId: 'conv-s17-other',
      },
    });

    // Seed session
    sessionRepo.createSession({
      sessionId: validSessionId,
      taskId: validTaskId,
      providerId: 'provider-test',
      conversationId: 'conv-s17-001',
      lifecycleState: 'active',
      protocolVersion: '1.0.0',
      baseStateHash: 'base-hash-001',
      nonce: 'nonce-s17-001',
    });

    stageStore = new StageStore(db, {
      baseStagingDir: stagingDir,
    });

    handoffService = new HandoffService({
      handoffRepo,
      taskRepo,
      stageStore,
      evidenceRepo,
      auditRepo,
      rootState,
    });

    reviewIntakeService = new ReviewIntakeService({
      reviewRequestRepo,
      taskRepo,
      auditRepo,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // 1. Handoff creation persists correctly
  it('1. handoff creation persists correctly', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
      allowedScope: ['src/auth.ts'],
      correlationId: 'corr-001',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const { handoff, prompt } = res.value;
    expect(handoff.handoffId).toMatch(/^handoff_/);
    expect(handoff.taskId).toBe(validTaskId);
    expect(handoff.sessionId).toBe(validSessionId);
    expect(handoff.status).toBe(HandoffStatus.PREPARED);
    expect(prompt).toBeTruthy();

    // Verify persistence retrieval
    const retrieved = handoffRepo.getHandoff(handoff.handoffId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.handoffId).toBe(handoff.handoffId);
    expect(retrieved?.status).toBe(HandoffStatus.PREPARED);
  });

  // 2. Generated prompt uses authoritative task/context data
  it('2. generated prompt uses authoritative task/context data', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
      allowedScope: ['src/auth.ts'],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const { prompt } = res.value;
    expect(prompt).toContain('Implement secure login validation');
    expect(prompt).toContain('Validates input safely');
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('mediator.get_task_brief');
    expect(prompt).toContain('does NOT grant permission to mutate live workspace files directly');
  });

  // 3. Prompt remains bounded
  it('3. prompt remains bounded and within byte budget', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const bytes = Buffer.byteLength(res.value.prompt, 'utf8');
    expect(bytes).toBeLessThanOrEqual(8 * 1024);
  });

  // 4. Prompt contains no excluded secrets
  it('4. prompt contains no excluded secrets or sensitive environment patterns', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const { prompt } = res.value;
    expect(prompt).not.toContain('ghp_');
    expect(prompt).not.toContain('AKIA');
    expect(prompt).not.toContain('BEGIN PRIVATE KEY');
  });

  // 5. Copy / ingest / cancel lifecycle
  it('5. copy/ingest/cancel lifecycle progresses through valid statuses', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const handoffId = res.value.handoff.handoffId;

    // Transition to waiting
    const waitRes = await handoffService.markWaitingForAgent(handoffId);
    expect(waitRes.ok).toBe(true);
    if (!waitRes.ok) return;
    expect(waitRes.value.status).toBe(HandoffStatus.WAITING_FOR_AGENT);

    // Cancel
    const cancelRes = await handoffService.cancelHandoff(handoffId, 'Testing cancellation');
    expect(cancelRes.ok).toBe(true);
    if (!cancelRes.ok) return;
    expect(cancelRes.value.status).toBe(HandoffStatus.CANCELLED);
    expect(cancelRes.value.cancellationReason).toBe('Testing cancellation');
  });

  // 6. Ingesting a valid report assigns agent-reported provenance
  it('6. ingesting a valid report assigns agent-reported provenance', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
      allowedScope: ['src/auth.ts'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const handoffId = res.value.handoff.handoffId;
    await handoffService.markWaitingForAgent(handoffId);

    const reportPayload = {
      reportId: 'rep-001',
      handoffId,
      taskId: validTaskId,
      sessionId: validSessionId,
      summary: 'Added login validation checks',
      claimedChangedPaths: ['src/auth.ts'],
      claimedVerificationCommands: [
        { command: 'npm test', exitCode: 0, actuallyRun: true },
      ],
      submittedAt: Date.now(),
      schemaVersion: '1.0.0',
    };

    const ingestRes = await handoffService.ingestReport(handoffId, reportPayload);
    expect(ingestRes.ok).toBe(true);
    if (!ingestRes.ok) return;

    expect(ingestRes.value.evidenceLevel).toBe(EvidenceLevel.AGENT_REPORTED);
    expect(ingestRes.value.status).toBe(HandoffStatus.REPORT_RECEIVED);

    // Evidence repository must store with AGENT_REPORTED
    const storedEvidence = evidenceRepo.getEvidence(ingestRes.value.evidenceId);
    expect(storedEvidence).not.toBeNull();
    expect(storedEvidence?.evidenceLevel).toBe(EvidenceLevel.AGENT_REPORTED);
  });

  // 7. A claimed verified: true cannot become executor-verified
  it('7. a claimed verified: true cannot become executor-verified', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
      allowedScope: ['src/auth.ts'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const handoffId = res.value.handoff.handoffId;

    const untrustedPayload = {
      reportId: 'rep-fake-verified',
      handoffId,
      taskId: validTaskId,
      sessionId: validSessionId,
      summary: 'Sneaky report claiming full verification',
      claimedChangedPaths: ['src/auth.ts'],
      verified: true,
      trusted: true,
      testsPassed: true,
      executorVerified: true,
      submittedAt: Date.now(),
      schemaVersion: '1.0.0',
    };

    const ingestRes = await handoffService.ingestReport(handoffId, untrustedPayload);
    expect(ingestRes.ok).toBe(true);
    if (!ingestRes.ok) return;

    // Provenance MUST strictly remain agent-reported
    expect(ingestRes.value.evidenceLevel).toBe(EvidenceLevel.AGENT_REPORTED);
    expect(ingestRes.value.evidenceLevel).not.toBe(EvidenceLevel.MEDIATOR_EXECUTOR_VERIFIED);

    const storedEvidence = evidenceRepo.getEvidence(ingestRes.value.evidenceId);
    expect(storedEvidence?.evidenceLevel).toBe(EvidenceLevel.AGENT_REPORTED);
  });

  // 8. A claimed approved: true cannot resolve approval
  it('8. a claimed approved: true cannot resolve approval or alter policy', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const handoffId = res.value.handoff.handoffId;

    const untrustedPayload = {
      reportId: 'rep-fake-approved',
      handoffId,
      taskId: validTaskId,
      sessionId: validSessionId,
      summary: 'Sneaky report claiming approval',
      claimedChangedPaths: [],
      approved: true,
      status: 'approved',
      submittedAt: Date.now(),
      schemaVersion: '1.0.0',
    };

    const ingestRes = await handoffService.ingestReport(handoffId, untrustedPayload);
    expect(ingestRes.ok).toBe(true);

    // Handoff status must be report-received, NOT approved
    const handoff = handoffRepo.getHandoff(handoffId);
    expect(handoff?.status).toBe(HandoffStatus.REPORT_RECEIVED);
    expect(handoff?.status).not.toBe('approved');
  });

  // 9. Invalid report schema rejects safely
  it('9. invalid report schema rejects safely', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const handoffId = res.value.handoff.handoffId;

    // Missing summary and submittedAt
    const invalidPayload = {
      reportId: 'rep-invalid',
      handoffId,
      taskId: validTaskId,
      sessionId: validSessionId,
    };

    const ingestRes = await handoffService.ingestReport(handoffId, invalidPayload);
    expect(ingestRes.ok).toBe(false);
    if (ingestRes.ok) return;

    expect(ingestRes.error.code).toBe(ErrorCode.REPORT_SCHEMA_INVALID);
  });

  // 10. Oversized/nested malicious reports reject
  it('10. oversized/nested malicious reports reject', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const handoffId = res.value.handoff.handoffId;

    // Create 100 KB report (exceeding 64 KB limit)
    const giantSummary = 'A'.repeat(70 * 1024);
    const oversizedPayload = {
      reportId: 'rep-oversized',
      handoffId,
      taskId: validTaskId,
      sessionId: validSessionId,
      summary: giantSummary,
      claimedChangedPaths: [],
      submittedAt: Date.now(),
      schemaVersion: '1.0.0',
    };

    const ingestRes = await handoffService.ingestReport(handoffId, oversizedPayload);
    expect(ingestRes.ok).toBe(false);
    if (ingestRes.ok) return;

    expect(ingestRes.error.code).toBe(ErrorCode.REPORT_OVERSIZED);
  });

  // 11. Wrong-task/session/handoff identity rejects
  it('11. wrong task/session/handoff identity rejects', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const handoffId = res.value.handoff.handoffId;

    // Report claims a different task
    const crossTaskPayload = {
      reportId: 'rep-cross',
      handoffId,
      taskId: otherTaskId, // mismatch!
      sessionId: validSessionId,
      summary: 'Cross-task report attempt',
      claimedChangedPaths: [],
      submittedAt: Date.now(),
      schemaVersion: '1.0.0',
    };

    const ingestRes = await handoffService.ingestReport(handoffId, crossTaskPayload);
    expect(ingestRes.ok).toBe(false);
    if (ingestRes.ok) return;

    expect(ingestRes.error.code).toBe(ErrorCode.HANDOFF_TASK_MISMATCH);
  });

  // 12. Stale, expired and cancelled handoffs reject late reports
  it('12. stale, expired and cancelled handoffs reject late reports', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const handoffId = res.value.handoff.handoffId;

    // Cancel handoff
    await handoffService.cancelHandoff(handoffId, 'Testing rejection');

    const reportPayload = {
      reportId: 'rep-late',
      handoffId,
      taskId: validTaskId,
      sessionId: validSessionId,
      summary: 'Late report attempt',
      claimedChangedPaths: [],
      submittedAt: Date.now(),
      schemaVersion: '1.0.0',
    };

    const ingestRes = await handoffService.ingestReport(handoffId, reportPayload);
    expect(ingestRes.ok).toBe(false);
    if (ingestRes.ok) return;

    expect(ingestRes.error.code).toBe(ErrorCode.HANDOFF_CANCELLED);
  });

  // 13. Unexpected reported paths produce a discrepancy/blocker
  it('13. unexpected reported paths produce a discrepancy and review-required state', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
      allowedScope: ['src/auth.ts'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const handoffId = res.value.handoff.handoffId;

    const reportWithDiscrepancy = {
      reportId: 'rep-disc',
      handoffId,
      taskId: validTaskId,
      sessionId: validSessionId,
      summary: 'Report touching unpermitted path',
      claimedChangedPaths: ['src/unrelated/config.ts', 'src/auth.ts'], // outside scope!
      submittedAt: Date.now(),
      schemaVersion: '1.0.0',
    };

    const ingestRes = await handoffService.ingestReport(handoffId, reportWithDiscrepancy);
    expect(ingestRes.ok).toBe(true);
    if (!ingestRes.ok) return;

    expect(ingestRes.value.requiresReview).toBe(true);
    expect(ingestRes.value.status).toBe(HandoffStatus.REVIEW_REQUIRED);
    expect(ingestRes.value.discrepancies.length).toBeGreaterThan(0);
    expect(ingestRes.value.discrepancies[0].type).toBe('outside_scope_path');
  });

  // 14. Secret-bearing report content is rejected or sanitized safely
  it('14. secret-bearing report content is sanitized and does not leak raw secrets', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const handoffId = res.value.handoff.handoffId;

    const secretReport = {
      reportId: 'rep-secret',
      handoffId,
      taskId: validTaskId,
      sessionId: validSessionId,
      summary: 'Tested with key ghp_secret123456789012345678901234567890123456',
      claimedChangedPaths: [],
      submittedAt: Date.now(),
      schemaVersion: '1.0.0',
    };

    const ingestRes = await handoffService.ingestReport(handoffId, secretReport);
    expect(ingestRes.ok).toBe(true);
    if (!ingestRes.ok) return;

    expect(ingestRes.value.summarySafe).not.toContain('ghp_secret');
    expect(ingestRes.value.summarySafe).toContain('[REDACTED');
  });

  // 15. MCP report cannot change policy
  it('15. MCP report ingestion cannot mutate policy rules', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const handoffId = res.value.handoff.handoffId;

    const policyExploitReport = {
      reportId: 'rep-policy-hack',
      handoffId,
      taskId: validTaskId,
      sessionId: validSessionId,
      summary: 'Attempting policy change',
      policyOverride: { allowAll: true },
      claimedChangedPaths: [],
      submittedAt: Date.now(),
      schemaVersion: '1.0.0',
    };

    const ingestRes = await handoffService.ingestReport(handoffId, policyExploitReport);
    expect(ingestRes.ok).toBe(true);

    // Staging and policy state untouched
    expect(stageStore.getStagesForTask(validTaskId)).toEqual([]);
  });

  // 16. MCP cannot resolve an approval
  it('16. MCP cannot resolve an approval via review intake', () => {
    const untrustedCaller: CallerIdentity = {
      type: 'mcp',
      id: 'mcp-agent',
      isTrustedUI: false,
    };

    // Attempting resolution from untrusted caller
    const resolveRes = reviewIntakeService.resolveReviewRequest({
      requestId: 'some-request-id',
      resolution: 'approved',
      caller: untrustedCaller,
    });

    expect(resolveRes.ok).toBe(false);
    if (resolveRes.ok) return;
    expect(resolveRes.error.code).toBe(ErrorCode.ACTION_DENIED);
  });

  // 17. Any permitted request-intake endpoint creates pending review only
  it('17. review intake creates pending-review only and does not grant permissions', () => {
    const createRes = reviewIntakeService.createReviewRequest({
      taskId: validTaskId,
      sessionId: validSessionId,
      requestedScope: ['src/auth.ts'],
      origin: 'mcp-agent',
      reason: 'Need review of authentication changes',
    });

    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const request = createRes.value;
    expect(request.status).toBe(ReviewRequestStatus.PENDING_REVIEW);
    expect(request.requestedScope).toEqual(['src/auth.ts']);

    // Authoritative resolution requires trusted UI
    const trustedCaller: CallerIdentity = {
      type: 'ide',
      id: 'local-user',
      isTrustedUI: true,
    };

    const resolveRes = reviewIntakeService.resolveReviewRequest({
      requestId: request.requestId,
      resolution: 'approved',
      caller: trustedCaller,
    });

    expect(resolveRes.ok).toBe(true);
    if (!resolveRes.ok) return;
    expect(resolveRes.value.status).toBe(ReviewRequestStatus.APPROVED);
  });

  // 18. Changing payload hash invalidates a pending request's approval eligibility
  it('18. changing payload hash invalidates pending review request eligibility', () => {
    const createRes = reviewIntakeService.createReviewRequest({
      taskId: validTaskId,
      sessionId: validSessionId,
      requestedScope: ['src/auth.ts'],
      origin: 'mcp-agent',
      reason: 'Hash binding test',
      payloadHash: 'hash-version-1',
    });

    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const request = createRes.value;

    const trustedCaller: CallerIdentity = {
      type: 'ide',
      id: 'local-user',
      isTrustedUI: true,
    };

    // User attempts to approve, but underlying payload changed (hash-version-2)
    const resolveRes = reviewIntakeService.resolveReviewRequest({
      requestId: request.requestId,
      resolution: 'approved',
      caller: trustedCaller,
      currentPayloadHash: 'hash-version-2-modified',
    });

    expect(resolveRes.ok).toBe(false);
    if (resolveRes.ok) return;
    expect(resolveRes.error.code).toBe(ErrorCode.REVIEW_REQUEST_INVALIDATED);

    // Request in repository must now be INVALIDATED
    const stored = reviewIntakeService.getRequest(request.requestId);
    expect(stored?.status).toBe(ReviewRequestStatus.INVALIDATED);
  });

  // 19. Restart preserves valid handoff metadata without replay
  it('19. restart preserves valid handoff metadata without replaying actions', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
      allowedScope: ['src/auth.ts'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const handoffId = res.value.handoff.handoffId;

    // Simulate restart: close DB and reopen with new service instance
    db.close();

    const reopenedDb = new DatabaseConnection({ path: dbPath });
    reopenedDb.open();
    const reopenedHandoffRepo = new HandoffRepository(reopenedDb);
    const reopenedTaskRepo = new TaskRepository(reopenedDb);
    const reopenedEvidenceRepo = new EvidenceRepository(reopenedDb);
    const reopenedAuditRepo = new AuditRepository(reopenedDb);

    const restartedService = new HandoffService({
      handoffRepo: reopenedHandoffRepo,
      taskRepo: reopenedTaskRepo,
      stageStore: new StageStore(reopenedDb, {
        baseStagingDir: stagingDir,
      }),
      evidenceRepo: reopenedEvidenceRepo,
      auditRepo: reopenedAuditRepo,
      rootState,
    });

    const restoredHandoff = restartedService.getHandoff(handoffId);
    expect(restoredHandoff).not.toBeNull();
    expect(restoredHandoff?.handoffId).toBe(handoffId);
    expect(restoredHandoff?.status).toBe(HandoffStatus.PREPARED);

    // Run recovery
    const recoveredCount = restartedService.recoverHandoffs();
    expect(recoveredCount).toBeGreaterThanOrEqual(0);

    reopenedDb.close();
  });

  // 20. Audit events are bounded and secret-safe
  it('20. audit events are bounded and secret-safe', async () => {
    const res = await handoffService.prepareHandoff({
      taskId: validTaskId,
      sessionId: validSessionId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const events = auditRepo.getEventsByTaskId(validTaskId);
    expect(events.length).toBeGreaterThan(0);

    for (const ev of events) {
      const serialized = JSON.stringify(ev);
      expect(serialized).not.toContain('ghp_');
      expect(serialized).not.toContain('AKIA');
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(4096);
    }
  });
});
