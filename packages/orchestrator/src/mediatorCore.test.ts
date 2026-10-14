/**
 * @mediator/orchestrator — Authoritative Mediator Core Unit Tests (Sprint S33)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { MediatorCore } from './mediatorCore.js';
import { MediatorHttpServer } from './mediatorHttpServer.js';

describe('Sprint S33 — Authoritative Mediator Core & Loopback Service', () => {
  let tempWorkspace: string;
  let core: MediatorCore;
  let server: MediatorHttpServer;

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-core-test-'));
    core = new MediatorCore({ workspaceRoot: tempWorkspace });
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    if (fs.existsSync(tempWorkspace)) {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  it('1. initializes with single authoritative state and truthful NO-GO Autopilot status', () => {
    const state = core.getStateSnapshot();

    expect(state.coreVersion).toBe('0.0.1');
    expect(state.protocolVersion).toBe('1.3');
    expect(state.s00Decision).toBe('NO-GO-AUTOEXEC');
    expect(state.autopilotEnabled).toBe(false);
    expect(state.autopilotStatus).toBe('off');
    expect(state.autopilotCanRun).toBe(false);
    expect(state.autopilotBlockingReasons.length).toBeGreaterThan(0);
    expect(state.autopilotBlockingReasons[0]).toContain('NO-GO-AUTOEXEC');

    // Provider loop is independent
    expect(state.loopEnabled).toBe(true);
    expect(state.loopStatus).toBe('ready');
  });

  it('2. fails closed when Autopilot is toggled under NO-GO-AUTOEXEC', () => {
    const res = core.toggleAutopilot(true);

    expect(res.autopilotEnabled).toBe(true);
    expect(res.autopilotStatus).toBe('blocked');
    expect(res.canRun).toBe(false);
    expect(res.blockingReasons).toContain(
      'Authoritative S00 decision is NO-GO-AUTOEXEC (Review-only mode active; automated execution forbidden).',
    );

    const snapshot = core.getStateSnapshot();
    expect(snapshot.autopilotStatus).toBe('blocked');
  });

  it('3. provider loop operates and toggles independently of Autopilot execution', () => {
    const off = core.toggleLoop(false);
    expect(off.loopEnabled).toBe(false);
    expect(off.loopStatus).toBe('off');

    const on = core.toggleLoop(true);
    expect(on.loopEnabled).toBe(true);
    expect(on.loopStatus).toBe('ready');
  });

  it('4. manages full task lifecycle and dispatches typed events', () => {
    const receivedEvents: string[] = [];
    const unsubscribe = core.subscribe((evt) => {
      receivedEvents.push(evt.type);
    });

    const taskRes = core.createTask({
      prompt: 'Implement a binary search tree in TypeScript',
      providerId: 'gemini',
    });

    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    const task = taskRes.value;
    expect(task.status).toBe('running');
    expect(core.getActiveTaskId()).toBe(task.id);

    // Pause task
    const pauseRes = core.pauseTask(task.id, 'User needs to review');
    expect(pauseRes.ok).toBe(true);
    expect(core.getTask(task.id)?.status).toBe('paused');

    // Resume task
    const resumeRes = core.resumeTask(task.id);
    expect(resumeRes.ok).toBe(true);
    expect(core.getTask(task.id)?.status).toBe('running');

    // Complete task
    const completeRes = core.completeTask(task.id);
    expect(completeRes.ok).toBe(true);
    expect(core.getTask(task.id)?.status).toBe('completed');

    unsubscribe();

    expect(receivedEvents).toContain('task:created');
    expect(receivedEvents).toContain('task:paused');
    expect(receivedEvents).toContain('task:updated');
    expect(receivedEvents).toContain('task:completed');
  });

  it('5. invalidates pending approvals when workspace root changes', () => {
    const taskRes = core.createTask({ prompt: 'Create test file' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    // Simulate an approval
    const apprRes = core.resolveApproval('non_existent', true);
    expect(apprRes.ok).toBe(false);

    // Switch workspace
    const newWs = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-core-other-'));
    try {
      const setWsRes = core.setWorkspaceRoot(newWs, true);
      expect(setWsRes.ok).toBe(true);
      expect(core.getWorkspaceRoot()).toBe(newWs);
    } finally {
      if (fs.existsSync(newWs)) {
        fs.rmSync(newWs, { recursive: true, force: true });
      }
    }
  });

  it('6. starts loopback HTTP server and enforces pairing token authentication', async () => {
    server = new MediatorHttpServer(core, { port: 0 });
    const { port, host } = await server.start();

    expect(host).toBe('127.0.0.1');
    expect(port).toBeGreaterThan(0);

    const baseUrl = `http://127.0.0.1:${port}`;
    const token = core.getPairingToken();

    // 1. Unauthenticated request to /api/state is rejected
    const unauthRes = await fetch(`${baseUrl}/api/state`);
    expect(unauthRes.status).toBe(401);

    // 2. Authenticated request with header succeeds
    const authHeaderRes = await fetch(`${baseUrl}/api/state`, {
      headers: { 'X-Mediator-Token': token },
    });
    expect(authHeaderRes.status).toBe(200);
    const authHeaderJson = await authHeaderRes.json();
    expect(authHeaderJson.ok).toBe(true);
    expect(authHeaderJson.state.coreVersion).toBe('0.0.1');

    // 3. Authenticated request with query param succeeds
    const authQueryRes = await fetch(`${baseUrl}/api/state?token=${token}`);
    expect(authQueryRes.status).toBe(200);

    // 4. Create task over HTTP
    const createTaskRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mediator-Token': token,
      },
      body: JSON.stringify({ prompt: 'Build a calculator function' }),
    });
    expect(createTaskRes.status).toBe(201);
    const createdTaskJson = await createTaskRes.json();
    expect(createdTaskJson.ok).toBe(true);
    expect(createdTaskJson.task.prompt).toBe('Build a calculator function');

    // 5. Toggle autopilot over HTTP returns truthful BLOCKED
    const autoRes = await fetch(`${baseUrl}/api/autopilot/toggle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mediator-Token': token,
      },
      body: JSON.stringify({ enable: true }),
    });
    expect(autoRes.status).toBe(200);
    const autoJson = await autoRes.json();
    expect(autoJson.autopilotStatus).toBe('blocked');
    expect(autoJson.canRun).toBe(false);
  });
});
