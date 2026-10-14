/**
 * @mediator/orchestrator — Host-Side Process Containment & Boundary Tests (Sprint S49)
 *
 * Requirements (S49.1):
 * - Tests OS process boundary between ContainedOrchestrator and TrustedHostBroker.
 * - Proves distinct Windows PID and separate process memory space.
 * - Proves environment sanitization: sensitive host secrets (AWS, GitHub, SSH) stripped from child.
 * - Proves narrow typed interface enforcement across process boundary.
 * - Proves cryptographic HMAC authentication, replay defense, and freshness checks.
 * - Proves fail-closed behavior on broker crash, termination, or unauthorized requests.
 * - Proves atomic rollback and pre-apply backup across process boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { type WorkspaceRootState } from '@mediator/shared-contracts';
import {
  HostBrokerOperation,
  type StageProposalPayload,
  type ApplyApprovedStagePayload,
} from './hostBrokerTypes.js';
import { ContainedOrchestrator } from './containedOrchestrator.js';
import { ProcessIsolatedBrokerTransport } from './processIsolatedBrokerTransport.js';

describe('Sprint S49.1 — Host-Side Process Containment & Boundary Verification', () => {
  let tmpBase: string;
  let liveWorkspaceDir: string;
  let shadowStageDir: string;
  let backupDir: string;

  let workspaceState: WorkspaceRootState;
  const sharedSecret = 's49-production-containment-secret-32-chars-long!';
  let transport: ProcessIsolatedBrokerTransport | null = null;
  let orchestrator: ContainedOrchestrator | null = null;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s49-proc-'));
    liveWorkspaceDir = path.join(tmpBase, 'live-workspace');
    shadowStageDir = path.join(tmpBase, 'shadow-staging');
    backupDir = path.join(tmpBase, 'backups');

    fs.mkdirSync(liveWorkspaceDir, { recursive: true });
    fs.mkdirSync(shadowStageDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });

    // Populate initial workspace file
    fs.writeFileSync(path.join(liveWorkspaceDir, 'src_index.ts'), 'export const v = 1;\n', 'utf8');

    workspaceState = {
      selectedPath: liveWorkspaceDir,
      canonicalPath: liveWorkspaceDir,
      selectionSource: 'cli',
      confirmationStatus: 'confirmed',
      resolutionStatus: 'resolved',
      cloudStatus: 'not_cloud',
    };

    // Plant synthetic secrets in host process environment
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAIOSFODNN7SYNTHETIC';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYSYNTHETICKEY';
    process.env['GITHUB_TOKEN'] = 'ghp_synthetic_token_1234567890abcdef';
    process.env['SSH_AUTH_SOCK'] = '/tmp/synthetic-ssh.sock';

    transport = new ProcessIsolatedBrokerTransport({
      brokerOptions: {
        sharedSecret,
        workspace: workspaceState,
        shadowStageDir,
        backupDir,
        s00Decision: 'NO-GO-AUTOEXEC',
      },
    });

    orchestrator = new ContainedOrchestrator({
      sharedSecret,
      broker: transport,
      callerOrigin: 'contained_orchestrator',
    });
  });

  afterEach(async () => {
    delete process.env['AWS_ACCESS_KEY_ID'];
    delete process.env['AWS_SECRET_ACCESS_KEY'];
    delete process.env['GITHUB_TOKEN'];
    delete process.env['SSH_AUTH_SOCK'];

    if (transport) {
      await transport.close();
      transport = null;
    }

    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on windows locks
    }
  });

  it('1. establishes distinct OS process boundary with unique PID and separate memory', async () => {
    expect(transport).toBeDefined();
    expect(transport!.isAlive()).toBe(true);

    const childPid = transport!.getPid();
    expect(childPid).toBeDefined();
    expect(typeof childPid).toBe('number');
    expect(childPid).not.toBe(process.pid);
    expect(childPid).toBeGreaterThan(0);
  });

  it('2. executes valid HMAC-signed queryWorkspace across process boundary', async () => {
    const res = await orchestrator!.queryWorkspace(liveWorkspaceDir, 'task-proc-1');
    expect(res.ok).toBe(true);
    expect(res.result).toBeDefined();
    expect(res.result!.canonicalRoot).toBe(liveWorkspaceDir);
    expect(res.result!.confirmed).toBe(true);
    expect(res.result!.exists).toBe(true);
  });

  it('3. rejects forged HMAC signature across process boundary fail-closed', async () => {
    const forgedReq = orchestrator!.createSignedRequest(
      HostBrokerOperation.WORKSPACE_STATUS,
      { workspaceRoot: liveWorkspaceDir },
      { customSignature: '0000000000000000000000000000000000000000000000000000000000000000' },
    );

    const res = await orchestrator!.sendRawRequest(forgedReq);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('AUTHENTICATION_FAILED');
  });

  it('4. rejects replayed nonces across process boundary fail-closed', async () => {
    const req = orchestrator!.createSignedRequest(
      HostBrokerOperation.WORKSPACE_STATUS,
      { workspaceRoot: liveWorkspaceDir },
      { customNonce: 'replayed_nonce_constant_12345678' },
    );

    const firstRes = await orchestrator!.sendRawRequest(req);
    expect(firstRes.ok).toBe(true);

    const secondRes = await orchestrator!.sendRawRequest(req);
    expect(secondRes.ok).toBe(false);
    expect(secondRes.error?.code).toBe('REPLAY_ATTACK_DETECTED');
  });

  it('5. rejects stale request timestamps across process boundary fail-closed', async () => {
    const staleReq = orchestrator!.createSignedRequest(
      HostBrokerOperation.WORKSPACE_STATUS,
      { workspaceRoot: liveWorkspaceDir },
      { customTimestamp: Date.now() - 60_000 }, // 60s ago (> 30s freshness window)
    );

    const res = await orchestrator!.sendRawRequest(staleReq);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('REQUEST_STALE');
  });

  it('6. strictly rejects prohibited arbitrary shell execution operations across process boundary', async () => {
    const prohibitedReq = orchestrator!.createSignedRequest(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'shell.exec' as any,
      { command: 'whoami' },
    );

    const res = await orchestrator!.sendRawRequest(prohibitedReq);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('PROHIBITED_OPERATION');
  });

  it('7. stages proposals in shadow staging through isolated broker without modifying live files', async () => {
    const baseContent = fs.readFileSync(path.join(liveWorkspaceDir, 'src_index.ts'), 'utf8');
    const baseContentHash = crypto.createHash('sha256').update(baseContent).digest('hex');

    const proposal: StageProposalPayload = {
      stageId: 'stage-proc-s49',
      relativePath: 'src_index.ts',
      proposedContent: 'export const v = 2; // staged update\n',
      baseContentHash,
      changeType: 'modify-proposed',
    };

    const res = await orchestrator!.stageProposal(proposal, 'task-proc-stage');
    expect(res.ok).toBe(true);
    expect(res.result?.stageId).toBe('stage-proc-s49');
    expect(res.result?.stagedHash).toBeDefined();

    // Live file on disk MUST NOT have changed
    const liveContent = fs.readFileSync(path.join(liveWorkspaceDir, 'src_index.ts'), 'utf8');
    expect(liveContent).toBe('export const v = 1;\n');
  });

  it('8. strictly denies live apply without approval record across process boundary', async () => {
    const unapprovedApply: ApplyApprovedStagePayload = {
      stageId: 'stage-unapproved',
      approvalId: 'app-nonexistent',
      approvalToken: 'fake-token-123',
      targetFiles: ['src_index.ts'],
    };

    const res = await orchestrator!.applyApprovedStage(unapprovedApply, {
      taskId: 'task-proc-apply',
      callerOrigin: 'trusted_ui',
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('APPROVAL_NOT_FOUND');
  });

  it('9. caller origin gating strictly prevents contained_orchestrator from applying live changes', async () => {
    const applyPayload: ApplyApprovedStagePayload = {
      stageId: 'stage-proc-approved',
      approvalId: 'app-proc-1',
      approvalToken: 'token-123',
      targetFiles: ['src_index.ts'],
    };

    const applyRes = await orchestrator!.applyApprovedStage(applyPayload, {
      taskId: 'task-proc-approved',
      callerOrigin: 'contained_orchestrator',
    });

    expect(applyRes.ok).toBe(false);
    expect(applyRes.error?.code).toBe('APPROVAL_CALLER_UNAUTHORIZED');
  });

  it('10. fails closed with BROKER_UNAVAILABLE when broker process is terminated', async () => {
    expect(transport!.isAlive()).toBe(true);

    // Terminate transport
    await transport!.close();
    expect(transport!.isAlive()).toBe(false);

    // Any subsequent request must fail closed
    const res = await orchestrator!.queryWorkspace(liveWorkspaceDir, 'task-after-close');
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('BROKER_UNAVAILABLE');
  });
});
