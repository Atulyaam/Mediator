/**
 * @mediator/ide-extension — Handoff Panel Controller Tests (Sprint S17)
 *
 * Covers controller behaviors:
 * 1. Initial controller state (never claims external connection).
 * 2. Prepare handoff updates state with bounded prompt.
 * 3. Copy prompt writes to clipboard and reports success/failure.
 * 4. Waiting state enters waiting without claiming agent connection.
 * 5. Report ingestion updates state with discrepancies and provenance.
 * 6. Report rejection handles typed errors safely.
 * 7. Cancellation transitions state and stops waiting.
 * 8. Review request resolution restricted to trusted caller.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  type WorkspaceRootState,
  TaskState,
  HandoffStatus,
  ReviewRequestStatus,
  ErrorCode,
} from '@mediator/shared-contracts';
import { type CallerIdentity } from '@mediator/policy-engine';
import {
  HandoffPanelController,
  type HandoffPanelState,
} from './handoffPanelController.js';
import {
  HandoffService,
  ReviewIntakeService,
  StageStore,
} from '@mediator/stage-store';
import {
  DatabaseConnection,
  runMigrations,
  TaskRepository,
  SessionRepository,
  EvidenceRepository,
  AuditRepository,
  HandoffRepository,
  ReviewRequestRepository,
} from '@mediator/persistence';
import { inspectWorkspaceRoot } from '@mediator/workspace-boundary';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Sprint S17 — HandoffPanelController', () => {
  let tempDir: string;
  let workspaceDir: string;
  let stagingDir: string;
  let db: DatabaseConnection;
  let taskRepo: TaskRepository;
  let evidenceRepo: EvidenceRepository;
  let auditRepo: AuditRepository;
  let handoffRepo: HandoffRepository;
  let reviewRequestRepo: ReviewRequestRepository;
  let stageStore: StageStore;
  let handoffService: HandoffService;
  let reviewIntakeService: ReviewIntakeService;
  let rootState: WorkspaceRootState;
  let controller: HandoffPanelController;

  let clipboardBuffer = '';
  const mockClipboardWriter = async (text: string) => {
    clipboardBuffer = text;
  };

  const taskId = 'task-ctrl-001';
  const sessionId = 'session-ctrl-001';

  beforeEach(() => {
    clipboardBuffer = '';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-ctrl-test-'));
    workspaceDir = path.join(tempDir, 'workspace');
    stagingDir = path.join(tempDir, 'staging');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    rootState = {
      ...inspectWorkspaceRoot(workspaceDir, 'ide'),
      confirmationStatus: 'confirmed',
      confirmationTimestamp: Date.now(),
    };

    const dbPath = path.join(tempDir, 'test.sqlite');
    db = new DatabaseConnection({ path: dbPath });
    db.open();
    runMigrations(db);

    taskRepo = new TaskRepository(db);
    const sessionRepo = new SessionRepository(db);
    evidenceRepo = new EvidenceRepository(db);
    auditRepo = new AuditRepository(db);
    handoffRepo = new HandoffRepository(db);
    reviewRequestRepo = new ReviewRequestRepository(db);

    taskRepo.createTask({
      taskId,
      state: TaskState.TASK_DEFINED,
      goalSummary: 'Fix validation regex in auth module',
      acceptanceCriteria: ['Valid regex', 'Tests green'],
      createdAt: Date.now(),
      metadata: {
        scope: ['src/auth.ts'],
        maxRounds: 5,
        roundCount: 1,
        conversationId: 'conv-ctrl-001',
      },
    });

    sessionRepo.createSession({
      sessionId,
      taskId,
      providerId: 'provider-test',
      conversationId: 'conv-ctrl-001',
      lifecycleState: 'active',
      protocolVersion: '1.0.0',
      baseStateHash: 'base-hash-ctrl',
      nonce: 'nonce-ctrl',
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

    controller = new HandoffPanelController(
      handoffService,
      reviewIntakeService,
      mockClipboardWriter,
    );
  });

  it('1. starts with honest disconnected state and no active handoff', () => {
    const s = controller.getState();
    expect(s.currentHandoff).toBeNull();
    expect(s.promptText).toBeNull();
    expect(s.waitingForAgent).toBe(false);
    expect(s.isConnectedToExternalAgent).toBe(false);
  });

  it('2. prepareHandoff sets promptText and currentHandoff without claiming auto-dispatch', async () => {
    const state = await controller.prepareHandoff({
      taskId,
      sessionId,
      allowedScope: ['src/auth.ts'],
    });

    expect(state.errorMessage).toBeNull();
    expect(state.currentHandoff).not.toBeNull();
    expect(state.promptText).toContain('Fix validation regex in auth module');
    expect(state.waitingForAgent).toBe(false);
    expect(state.isConnectedToExternalAgent).toBe(false);
  });

  it('3. copyPrompt writes to clipboard writer and reports success', async () => {
    await controller.prepareHandoff({ taskId, sessionId });
    const res = await controller.copyPrompt();

    expect(res.success).toBe(true);
    expect(clipboardBuffer).toBeTruthy();
    expect(clipboardBuffer).toContain('Fix validation regex');
    expect(controller.getState().lastCopySuccess).toBe(true);
  });

  it('4. copyPrompt fails gracefully when no prompt exists', async () => {
    const res = await controller.copyPrompt();
    expect(res.success).toBe(false);
    expect(res.error).toContain('No prompt available');
    expect(controller.getState().lastCopySuccess).toBe(false);
  });

  it('5. markWaitingForAgent marks waiting state without claiming automated connection', async () => {
    await controller.prepareHandoff({ taskId, sessionId });
    const s = await controller.markWaitingForAgent();

    expect(s.waitingForAgent).toBe(true);
    expect(s.currentHandoff?.status).toBe(HandoffStatus.WAITING_FOR_AGENT);
    expect(s.isConnectedToExternalAgent).toBe(false);
    expect(s.statusMessage).toContain('Waiting for manual return of agent report');
  });

  it('6. ingestReport ingests valid report and assigns agent-reported provenance', async () => {
    await controller.prepareHandoff({ taskId, sessionId });
    await controller.markWaitingForAgent();

    const handoffId = controller.getState().currentHandoff!.handoffId;
    const report = {
      reportId: 'rep-ctrl-001',
      handoffId,
      taskId,
      sessionId,
      summary: 'Updated regex and ran local checks',
      claimedChangedPaths: ['src/auth.ts'],
      submittedAt: Date.now(),
      schemaVersion: '1.0.0',
    };

    const res = await controller.ingestReport(report);
    expect(res.success).toBe(true);
    expect(res.result).toBeDefined();

    const state = controller.getState();
    expect(state.waitingForAgent).toBe(false);
    expect(state.lastIngestResult?.evidenceLevel).toBe('agent-reported');
    expect(state.lastIngestError).toBeNull();
  });

  it('7. ingestReport sets lastIngestError and leaves state intact when report is rejected', async () => {
    await controller.prepareHandoff({ taskId, sessionId });

    const handoffId = controller.getState().currentHandoff!.handoffId;
    // Malformed report: missing summary
    const badReport = {
      reportId: 'rep-bad',
      handoffId,
      taskId,
      sessionId,
      claimedChangedPaths: [],
    };

    const res = await controller.ingestReport(badReport);
    expect(res.success).toBe(false);

    const state = controller.getState();
    expect(state.lastIngestResult).toBeNull();
    expect(state.lastIngestError).toContain('REPORT_SCHEMA_INVALID');
  });

  it('8. cancelHandoff updates handoff status and clears waiting state', async () => {
    await controller.prepareHandoff({ taskId, sessionId });
    await controller.markWaitingForAgent();

    const state = await controller.cancelHandoff('Operator decided to cancel');
    expect(state.waitingForAgent).toBe(false);
    expect(state.currentHandoff?.status).toBe(HandoffStatus.CANCELLED);
    expect(state.statusMessage).toContain('cancelled');
  });

  it('9. resolveReviewRequest allows trusted UI caller and rejects untrusted callers', async () => {
    await controller.prepareHandoff({ taskId, sessionId });

    // Create a pending review request
    const createRes = reviewIntakeService.createReviewRequest({
      taskId,
      sessionId,
      requestedScope: ['src/auth.ts'],
      origin: 'mcp-agent',
      reason: 'Need review',
    });
    expect(createRes.ok).toBe(true);
    const req = createRes.ok ? createRes.value : null;
    expect(req).not.toBeNull();

    // Untrusted caller
    const untrustedCaller: CallerIdentity = {
      type: 'mcp',
      id: 'agent-1',
      isTrustedUI: false,
    };
    const deniedRes = await controller.resolveReviewRequest(req!.requestId, 'approved', untrustedCaller);
    expect(deniedRes.success).toBe(false);
    expect(deniedRes.error).toContain('ACTION_DENIED');

    // Trusted UI caller
    const trustedCaller: CallerIdentity = {
      type: 'ide',
      id: 'human-user',
      isTrustedUI: true,
    };
    const allowedRes = await controller.resolveReviewRequest(req!.requestId, 'approved', trustedCaller);
    expect(allowedRes.success).toBe(true);
  });
});
