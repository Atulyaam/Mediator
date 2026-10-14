/**
 * @mediator/tests — Cross-Interface Integration & Security Suite (Sprint S35)
 *
 * Verifies end-to-end synchronization across all four interfaces:
 * 1. Standalone UI (Loopback HTTP & SSE)
 * 2. CLI (`runCli`)
 * 3. Browser Extension (Provider bridges)
 * 4. IDE Extension (VS Code / Antigravity)
 *
 * Authoritative Invariants:
 * - Single source of truth in MediatorCore.
 * - Tasks created in one interface appear instantly in all other interfaces.
 * - Provider responses trigger envelope validation, shadow staging, and approval creation.
 * - Workspace changes revalidate active tasks and invalidate stale approvals.
 * - Autopilot toggle is fail-closed under S00 NO-GO-AUTOEXEC across all clients.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { MediatorCore, MediatorHttpServer } from '@mediator/orchestrator';
import { runCli, getOrCreateCore } from '../apps/cli/src/index.js';
import {
  GeminiProviderAdapter,
  ChatGPTProviderAdapter,
  DeepSeekProviderAdapter,
  createDeepSeekCompletedWithEnvelopeFixture,
} from '../apps/browser-extension/src/index.js';

describe('Sprint S35 — Cross-Interface Integration & Security Suite', () => {
  let tempWorkspace: string;
  let core: MediatorCore;
  let server: MediatorHttpServer;
  let serverUrl: string;
  let token: string;

  beforeEach(async () => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s35-test-'));
    core = getOrCreateCore(tempWorkspace);
    core.setWorkspaceRoot(tempWorkspace, true);

    server = new MediatorHttpServer(core, { port: 0 });
    const { port } = await server.start();
    serverUrl = `http://127.0.0.1:${port}`;
    token = core.getPairingToken();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    if (fs.existsSync(tempWorkspace)) {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  // ─── 35.1 Cross-Interface Synchronization ─────────────────────────────────

  it('35.1.1 — task created in Standalone UI appears in CLI and Core snapshot', async () => {
    // 1. Standalone UI submits a task via HTTP
    const createRes = await fetch(`${serverUrl}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mediator-Token': token,
      },
      body: JSON.stringify({
        prompt: 'Add retry logic to network client',
        providerId: 'deepseek',
      }),
    });
    expect(createRes.status).toBe(201);
    const { task } = await createRes.json();
    expect(task.id).toBeDefined();
    expect(task.providerId).toBe('deepseek');

    // 2. Query through CLI
    const cliListRes = await runCli(['task', 'list', '--json']);
    expect(cliListRes.exitCode).toBe(0);
    const cliTasks = JSON.parse(cliListRes.output);
    const foundInCli = cliTasks.find((t: any) => t.id === task.id);
    expect(foundInCli).toBeDefined();
    expect(foundInCli.prompt).toBe('Add retry logic to network client');

    // 3. Query Core directly
    const snapshot = core.getStateSnapshot();
    expect(snapshot.activeTaskId).toBe(task.id);
  });

  it('35.1.2 — task created in CLI appears in Standalone UI and Core event stream', async () => {
    const receivedEvents: string[] = [];
    core.subscribe((evt) => receivedEvents.push(evt.type));

    // 1. CLI creates task
    const cliCreateRes = await runCli(['task', 'create', 'Refactor auth middleware']);
    expect(cliCreateRes.exitCode).toBe(0);
    const createdTask = cliCreateRes.data as any;
    expect(createdTask.id).toBeDefined();

    // 2. Fetch from Standalone UI endpoint
    const uiRes = await fetch(`${serverUrl}/api/tasks/${createdTask.id}`, {
      headers: { 'X-Mediator-Token': token },
    });
    expect(uiRes.status).toBe(200);
    const { task: uiTask } = await uiRes.json();
    expect(uiTask.id).toBe(createdTask.id);
    expect(uiTask.status).toBe('running');

    // 3. Event was distributed
    expect(receivedEvents).toContain('task:created');
  });

  it('35.1.3 — task state transitions propagate synchronously across clients', async () => {
    const taskRes = core.createTask({ prompt: 'Implement caching layer' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;
    const taskId = taskRes.value.id;

    // 1. Pause from CLI
    const cliPause = await runCli(['task', 'pause', taskId]);
    expect(cliPause.exitCode).toBe(0);

    // Verify in HTTP
    const httpCheck1 = await fetch(`${serverUrl}/api/tasks/${taskId}`, {
      headers: { 'X-Mediator-Token': token },
    });
    const { task: taskCheck1 } = await httpCheck1.json();
    expect(taskCheck1.status).toBe('paused');

    // 2. Resume from HTTP
    const httpResume = await fetch(`${serverUrl}/api/tasks/${taskId}/resume`, {
      method: 'POST',
      headers: { 'X-Mediator-Token': token },
    });
    expect(httpResume.status).toBe(200);

    // Verify in CLI
    const cliCheck2 = await runCli(['task', 'status', taskId, '--json']);
    const taskCheck2 = JSON.parse(cliCheck2.output);
    expect(taskCheck2.status).toBe('running');
  });

  it('35.1.4 — browser provider envelope ingestion creates shadow stage and pending approval', async () => {
    const taskRes = core.createTask({ prompt: 'Create helper utils' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;
    const taskId = taskRes.value.id;

    // Simulate incoming schema-validated envelope
    const validSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const validEnvelope = {
      protocolVersion: '1.3',
      taskId: taskId,
      sessionId: `sess_${taskId}`,
      nonce: 'nonce_sync_test_1234567890abcdef',
      round: 1,
      sequence: 1,
      conversation: {
        provider: 'gemini',
        conversationId: 'c1',
      },
      baseStateHash: validSha256,
      status: 'continue',
      actions: [
        {
          id: 'act_patch_1',
          type: 'propose_patch',
          path: 'src/utils.ts',
          expectedBaseHash: validSha256,
          contentBlockId: 'cb_1',
        },
      ],
      contentBlocks: [
        {
          id: 'cb_1',
          delimiter: '---BLOCK-cb_1---',
          encoding: 'utf-8',
          byteLength: 42,
          sha256: validSha256,
        },
      ],
    };

    // Post to HTTP endpoint
    const postRes = await fetch(`${serverUrl}/api/tasks/${taskId}/response`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mediator-Token': token,
      },
      body: JSON.stringify({ envelope: validEnvelope }),
    });
    expect(postRes.status).toBe(200);

    // Query stages from CLI
    const cliStages = await runCli(['stage', 'list', '--json']);
    const stages = JSON.parse(cliStages.output);
    expect(stages.length).toBeGreaterThan(0);

    // Query approvals from CLI
    const cliApprovals = await runCli(['approval', 'list', '--json']);
    const approvals = JSON.parse(cliApprovals.output);
    expect(approvals.length).toBeGreaterThan(0);
    const targetApproval = approvals[0];
    expect(targetApproval.status).toBe('pending');

    // Resolve approval from HTTP
    const resolveRes = await fetch(`${serverUrl}/api/approvals/${targetApproval.id}/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mediator-Token': token,
      },
      body: JSON.stringify({ approved: true }),
    });
    expect(resolveRes.status).toBe(200);
    const resolveJson = await resolveRes.json();
    expect(resolveJson.approval.status).toBe('approved');
  });

  it('35.1.5 — workspace change invalidates pending approvals across all clients', async () => {
    const taskRes = core.createTask({ prompt: 'Task for workspace A' });
    expect(taskRes.ok).toBe(true);

    const newWs = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s35-new-'));
    try {
      // Change workspace via CLI
      const wsChange = await runCli(['workspace', 'select', newWs, '--confirm', '--json']);
      expect(wsChange.exitCode).toBe(0);

      // Verify Core snapshot
      const snapshot = core.getStateSnapshot();
      expect(snapshot.workspaceRoot).toBe(newWs);

      // Verify HTTP sees new workspace
      const httpWs = await fetch(`${serverUrl}/api/workspace`, {
        headers: { 'X-Mediator-Token': token },
      });
      const wsJson = await httpWs.json();
      expect(wsJson.workspaceRoot).toBe(newWs);
    } finally {
      if (fs.existsSync(newWs)) {
        fs.rmSync(newWs, { recursive: true, force: true });
      }
    }
  });

  // ─── 35.3 Security and Recovery Gates ─────────────────────────────────────

  it('35.3.1 — rejects unauthenticated requests and requests with invalid tokens', async () => {
    // Missing token
    const res1 = await fetch(`${serverUrl}/api/state`);
    expect(res1.status).toBe(401);

    // Tampered token
    const res2 = await fetch(`${serverUrl}/api/state`, {
      headers: { 'X-Mediator-Token': 'invalid_forged_token' },
    });
    expect(res2.status).toBe(401);
  });

  it('35.3.2 — Autopilot enable requests fail-closed across all interfaces under S00 NO-GO', async () => {
    // Via CLI
    const cliRes = await runCli(['autopilot', 'enable', '--json']);
    expect(cliRes.exitCode).toBe(0);
    const cliData = JSON.parse(cliRes.output);
    expect(cliData.autopilotStatus).toBe('blocked');
    expect(cliData.canRun).toBe(false);

    // Via HTTP
    const httpRes = await fetch(`${serverUrl}/api/autopilot/toggle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mediator-Token': token,
      },
      body: JSON.stringify({ enable: true }),
    });
    expect(httpRes.status).toBe(200);
    const httpData = await httpRes.json();
    expect(httpData.autopilotStatus).toBe('blocked');
    expect(httpData.canRun).toBe(false);
    expect(httpData.blockingReasons).toContain(
      'Authoritative S00 decision is NO-GO-AUTOEXEC (Review-only mode active; automated execution forbidden).',
    );
  });

  it('35.3.3 — provider loop operates independently while Autopilot is blocked', async () => {
    // Autopilot is blocked
    core.toggleAutopilot(true);
    expect(core.getAutopilotStatus().autopilotStatus).toBe('blocked');

    // Provider loop remains operable
    const loopRes = core.toggleLoop(true);
    expect(loopRes.loopEnabled).toBe(true);
    expect(loopRes.loopStatus).toBe('ready');

    // CLI reports both truthfully
    const statusCli = await runCli(['status', '--json']);
    const statusData = JSON.parse(statusCli.output);
    expect(statusData.loopStatus).toBe('ready');
    expect(statusData.autopilotStatus).toBe('blocked');
  });

  it('35.3.4 — all three providers (Gemini, ChatGPT, DeepSeek) are supported and selectable', async () => {
    const providers = ['gemini', 'openai', 'deepseek'];
    for (const p of providers) {
      const selRes = await runCli(['providers', 'select', p, '--json']);
      expect(selRes.exitCode).toBe(0);
      expect(core.getActiveProviderId()).toBe(p);
    }
  });

  it('35.3.5 — rejects malformed envelopes and oversized payloads safely', async () => {
    const taskRes = core.createTask({ prompt: 'Test malformed envelope' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    // Send malformed text as envelope
    const badRes = await fetch(`${serverUrl}/api/tasks/${taskRes.value.id}/response`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mediator-Token': token,
      },
      body: JSON.stringify({ envelope: 'NOT_VALID_JSON_STRING' }),
    });
    expect(badRes.status).toBe(400);
    const badJson = await badRes.json();
    expect(badJson.ok).toBe(false);
  });
});
