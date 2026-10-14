/**
 * @mediator/orchestrator — Host Containment & Trusted Broker Adversarial Test Suite (Sprint S45)
 *
 * Exercises the Host-Side Core Containment architecture across 11 comprehensive canaries:
 *   1. Read synthetic files outside permitted data area (Prevention).
 *   2. Modify synthetic protected files without approval (Prevention).
 *   3. Read synthetic secret deliberately placed outside boundary (Prevention).
 *   4. Launch arbitrary host command via broker (Prevention).
 *   5. Access sensitive environment values that should not be inherited (OS-Enforced Prevention).
 *   6. Spawn child processes that attempt to outlive cancellation (OS-Enforced Cleanup).
 *   7. Send unauthorized operations from AI/MCP origins or invalid HMAC (Prevention).
 *   8. Replay requests, reuse consumed approvals, or alter staged artifact after approval (Prevention & Detection).
 *   9. Path traversal, ADS streams, and DOS device name escapes (Prevention).
 *   10. Fail-closed behavior on broker unavailability or misconfiguration (Fail-Closed Integrity).
 *   11. Strict S00 NO-GO-AUTOEXEC and network-isolation dispatch gating (Policy Enforcement).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  type WorkspaceRootState,
} from '@mediator/workspace-boundary';
import {
  HostBrokerOperation,
  type HostBrokerOperationValue,
  type DispatchSandboxRecipePayload,
  type BrokerApprovalRecord,
  TrustedHostBroker,
  ContainedOrchestrator,
  WindowsProcessSupervisor,
  cleanseEnvironment,
} from './index.js';

describe('Sprint S45 — Host-Side Core Containment & Trusted Broker Architecture', () => {
  let tmpBase: string;
  let liveWorkspaceDir: string;
  let shadowStageDir: string;
  let backupDir: string;
  let outsideProtectedDir: string;

  let workspaceState: WorkspaceRootState;
  const sharedSecret = 's45-broker-super-secure-high-entropy-secret-key-32chars!';
  let broker: TrustedHostBroker;
  let orchestrator: ContainedOrchestrator;
  let processSupervisor: WindowsProcessSupervisor;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s45-host-'));
    liveWorkspaceDir = path.join(tmpBase, 'live-workspace');
    shadowStageDir = path.join(tmpBase, 'shadow-staging');
    backupDir = path.join(tmpBase, 'backups');
    outsideProtectedDir = path.join(tmpBase, 'outside-protected-data');

    fs.mkdirSync(liveWorkspaceDir, { recursive: true });
    fs.mkdirSync(shadowStageDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(outsideProtectedDir, { recursive: true });

    // Seed synthetic live files
    fs.writeFileSync(
      path.join(liveWorkspaceDir, 'calculator.ts'),
      'export function add(a: number, b: number): number { return a + b; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(liveWorkspaceDir, 'protected_sentinel.txt'),
      'LIVE_WORKSPACE_PROTECTED_DATA_V1\n',
      'utf8',
    );

    // Seed synthetic outside secrets
    fs.writeFileSync(
      path.join(outsideProtectedDir, 'user_private.txt'),
      'CONFIDENTIAL_USER_PRIVATE_NOTE\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(outsideProtectedDir, 'fake_cloud_credentials.env'),
      'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n',
      'utf8',
    );

    workspaceState = {
      selectedPath: liveWorkspaceDir,
      canonicalPath: liveWorkspaceDir,
      selectionSource: 'cli',
      confirmationStatus: 'confirmed',
      resolutionStatus: 'resolved',
      cloudStatus: 'not_cloud',
    };

    broker = new TrustedHostBroker({
      sharedSecret,
      workspace: workspaceState,
      shadowStageDir,
      backupDir,
      s00Decision: 'NO-GO-AUTOEXEC',
    });

    orchestrator = new ContainedOrchestrator({
      sharedSecret,
      broker,
      callerOrigin: 'contained_orchestrator',
    });

    processSupervisor = new WindowsProcessSupervisor();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // transient Windows cleanup error in temp
    }
  });

  // ─── Canary 1: Outside File Read Denial ──────────────────────────────────
  it('Canary 1 (Prevention): strictly denies reading synthetic files placed outside permitted workspace data area', async () => {
    // Attempt to read outside file via traversal
    const res = await orchestrator.readSnapshot('../outside-protected-data/user_private.txt');

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('PATH_OUTSIDE_WORKSPACE');
    expect(res.error?.message).toContain('Path outside workspace');
    expect(res.result).toBeUndefined();
  });

  // ─── Canary 2: Unapproved Live Modification Denial ───────────────────────
  it('Canary 2 (Prevention): strictly denies modifying synthetic protected files without explicit approval record', async () => {
    const sentinelPath = path.join(liveWorkspaceDir, 'protected_sentinel.txt');
    const initialContent = fs.readFileSync(sentinelPath, 'utf8');

    // Attempt to apply changes without registering an approval
    const res = await orchestrator.applyApprovedStage({
      stageId: 'stage_unauthorized_1',
      approvalId: 'appr_non_existent',
      approvalToken: 'fake_tok_123',
      targetFiles: ['protected_sentinel.txt'],
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('APPROVAL_NOT_FOUND');

    // Verify live file is completely unmodified
    const afterContent = fs.readFileSync(sentinelPath, 'utf8');
    expect(afterContent).toBe(initialContent);
  });

  // ─── Canary 3: Secret Exfiltration Denial ────────────────────────────────
  it('Canary 3 (Prevention): strictly denies reading synthetic secrets deliberately placed outside allowed boundary', async () => {
    // Attempt to reach fake_cloud_credentials.env via relative traversal
    const res = await orchestrator.readSnapshot(
      '../../outside-protected-data/fake_cloud_credentials.env',
    );

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('PATH_OUTSIDE_WORKSPACE');
    expect(res.result).toBeUndefined();
  });

  // ─── Canary 4: Arbitrary Host Command Denial ─────────────────────────────
  it('Canary 4 (Prevention): strictly rejects arbitrary host shell command execution requests via broker', async () => {
    const shellOps = ['shell.exec', 'cmd.execute', 'powershell.invoke', 'arbitrary_file.write'];

    for (const op of shellOps) {
      const forgedReq = orchestrator.createSignedRequest(
        op as unknown as HostBrokerOperationValue,
        { command: 'powershell.exe -Command Write-Host PWNED' },
      );

      const res = await orchestrator.sendRawRequest(forgedReq);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('PROHIBITED_OPERATION');
      expect(res.error?.message).toContain('strictly prohibited');
    }
  });

  // ─── Canary 5: Sensitive Environment Sanitization ────────────────────────
  it('Canary 5 (OS-Enforced Prevention): ensures sensitive host environment variables are scrubbed and not inherited', async () => {
    // Inject synthetic host secrets into process.env
    const prevSecret = process.env.SYNTHETIC_HOST_SECRET;
    const prevAws = process.env.AWS_SECRET_ACCESS_KEY;
    const prevApi = process.env.OPENAI_API_KEY;

    try {
      process.env.SYNTHETIC_HOST_SECRET = 'ultra-confidential-token-999';
      process.env.AWS_SECRET_ACCESS_KEY = 'synthetic-aws-secret-key-abc';
      process.env.OPENAI_API_KEY = 'sk-proj-synthetic-api-token-xyz';

      // 1. Unit check: cleanseEnvironment strips them
      const cleansed = cleanseEnvironment();
      expect(cleansed.SYNTHETIC_HOST_SECRET).toBeUndefined();
      expect(cleansed.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(cleansed.OPENAI_API_KEY).toBeUndefined();
      expect(cleansed.PATH).toBeDefined();

      // 2. Real OS Process execution check: child process reports environment
      const script = `
        const s1 = process.env.SYNTHETIC_HOST_SECRET;
        const s2 = process.env.AWS_SECRET_ACCESS_KEY;
        const s3 = process.env.OPENAI_API_KEY;
        if (s1 || s2 || s3) {
          console.error("SECRET_LEAKAGE");
          process.exit(1);
        } else {
          console.log("SECRETS_ABSENT");
          process.exit(0);
        }
      `;

      const result = await processSupervisor.executeCommand(
        process.execPath,
        ['-e', script],
        { sanitizedEnv: true, timeoutMs: 15000 },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('SECRETS_ABSENT');
      expect(result.stderr).not.toContain('SECRET_LEAKAGE');
    } finally {
      if (prevSecret === undefined) delete process.env.SYNTHETIC_HOST_SECRET;
      else process.env.SYNTHETIC_HOST_SECRET = prevSecret;

      if (prevAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = prevAws;

      if (prevApi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevApi;
    }
  }, 20000);

  // ─── Canary 6: Process Tree Confinement & Cleanup ────────────────────────
  it('Canary 6 (OS-Enforced Cleanup): halts spawned processes and process tree upon cancellation or timeout', async () => {
    const controller = new AbortController();

    // Spawn a long-running process
    const script = 'setInterval(() => {}, 500);';
    const executePromise = processSupervisor.executeCommand(
      process.execPath,
      ['-e', script],
      { signal: controller.signal, timeoutMs: 10_000 },
    );

    // Cancel after 300ms
    setTimeout(() => {
      controller.abort();
    }, 300);

    const result = await executePromise;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  // ─── Canary 7: Unauthorized Origins & Forged Signatures ──────────────────
  it('Canary 7 (Prevention): strictly rejects unauthorized caller origins (AI/MCP) and forged HMAC signatures', async () => {
    // 7a: Caller origin 'browser_ai' attempting to read snapshot
    const aiReq = orchestrator.createSignedRequest(
      HostBrokerOperation.READ_SNAPSHOT,
      { relativePath: 'calculator.ts' },
      { customCallerOrigin: 'browser_ai' },
    );
    const aiRes = await orchestrator.sendRawRequest(aiReq);
    expect(aiRes.ok).toBe(false);
    expect(aiRes.error?.code).toBe('CALLER_UNAUTHORIZED');

    // 7b: Caller origin 'mcp_agent' attempting to apply stage
    const mcpReq = orchestrator.createSignedRequest(
      HostBrokerOperation.APPLY_APPROVED_STAGE,
      {
        stageId: 'stage_test',
        approvalId: 'appr_test',
        approvalToken: 'tok_test',
        targetFiles: ['calculator.ts'],
      },
      { customCallerOrigin: 'mcp_agent' },
    );
    const mcpRes = await orchestrator.sendRawRequest(mcpReq);
    expect(mcpRes.ok).toBe(false);
    expect(mcpRes.error?.code).toBe('CALLER_UNAUTHORIZED');

    // 7c: Forged / tampered HMAC signature
    const forgedReq = orchestrator.createSignedRequest(
      HostBrokerOperation.READ_SNAPSHOT,
      { relativePath: 'calculator.ts' },
      { customSignature: '0000000000000000000000000000000000000000000000000000000000000000' },
    );
    const forgedRes = await orchestrator.sendRawRequest(forgedReq);
    expect(forgedRes.ok).toBe(false);
    expect(forgedRes.error?.code).toBe('AUTHENTICATION_FAILED');
  });

  // ─── Canary 8: Replay, Reuse, and Post-Approval Tamper ────────────────────
  it('Canary 8 (Prevention & Detection): rejects replayed nonces, expired timestamps, consumed approvals, and tampered artifacts', async () => {
    // 8a: Nonce Replay Attack
    const fixedNonce = '0123456789abcdef0123456789abcdef';
    const req1 = orchestrator.createSignedRequest(
      HostBrokerOperation.READ_SNAPSHOT,
      { relativePath: 'calculator.ts' },
      { customNonce: fixedNonce },
    );
    const res1 = await orchestrator.sendRawRequest(req1);
    expect(res1.ok).toBe(true);

    // Replay same request with same nonce
    const resReplay = await orchestrator.sendRawRequest(req1);
    expect(resReplay.ok).toBe(false);
    expect(resReplay.error?.code).toBe('REPLAY_ATTACK_DETECTED');

    // 8b: Stale Timestamp Drift (> 30s)
    const staleReq = orchestrator.createSignedRequest(
      HostBrokerOperation.READ_SNAPSHOT,
      { relativePath: 'calculator.ts' },
      { customTimestamp: Date.now() - 60_000 }, // 60 seconds old
    );
    const staleRes = await orchestrator.sendRawRequest(staleReq);
    expect(staleRes.ok).toBe(false);
    expect(staleRes.error?.code).toBe('REQUEST_STALE');

    // 8c: Single-Use Approval Consumption
    const stageId = 'stage_valid_1';
    const approvalId = 'appr_valid_1';
    const approvalToken = 'appr_tok_secure_123';
    const targetFile = 'calculator.ts';

    // Propose staged change
    const baseContent = fs.readFileSync(path.join(liveWorkspaceDir, targetFile), 'utf8');
    const baseHash = crypto.createHash('sha256').update(baseContent).digest('hex');
    const proposedContent = 'export function add(a: number, b: number): number { return (a + b) * 1; }\n';
    const proposedHash = crypto.createHash('sha256').update(proposedContent).digest('hex');

    const stageRes = await orchestrator.stageProposal({
      stageId,
      relativePath: targetFile,
      proposedContent,
      baseContentHash: baseHash,
      changeType: 'modify-proposed',
    });
    expect(stageRes.ok).toBe(true);

    const approvalRecord: BrokerApprovalRecord = {
      approvalId,
      stageId,
      approvalToken,
      targetFiles: [targetFile],
      baseContentHashes: { [targetFile]: baseHash },
      stagedContentHashes: { [targetFile]: proposedHash },
      status: 'approved',
      expiresAt: Date.now() + 60_000,
      grantedBy: 'trusted_ui',
    };
    broker.registerApproval(approvalRecord);

    // Apply first time: SUCCESS
    const applyRes1 = await orchestrator.applyApprovedStage({
      stageId,
      approvalId,
      approvalToken,
      targetFiles: [targetFile],
    });
    expect(applyRes1.ok).toBe(true);
    expect(applyRes1.result?.success).toBe(true);

    // Verify approval record status transitioned to 'consumed'
    const storedAppr = broker.getApproval(approvalId);
    expect(storedAppr?.status).toBe('consumed');

    // Replay same approval: REJECTED fail-closed
    const applyResReplay = await orchestrator.applyApprovedStage({
      stageId,
      approvalId,
      approvalToken,
      targetFiles: [targetFile],
    });
    expect(applyResReplay.ok).toBe(false);
    expect(applyResReplay.error?.code).toBe('APPROVAL_ALREADY_CONSUMED');

    // 8d: Staged File Tamper After Approval (TOCTOU Detection)
    const stageIdTamper = 'stage_tamper_1';
    const approvalIdTamper = 'appr_tamper_1';

    await orchestrator.stageProposal({
      stageId: stageIdTamper,
      relativePath: targetFile,
      proposedContent,
      baseContentHash: crypto.createHash('sha256').update(fs.readFileSync(path.join(liveWorkspaceDir, targetFile), 'utf8')).digest('hex'),
      changeType: 'modify-proposed',
    });

    const liveContentCurrent = fs.readFileSync(path.join(liveWorkspaceDir, targetFile), 'utf8');
    const liveHashCurrent = crypto.createHash('sha256').update(liveContentCurrent).digest('hex');

    broker.registerApproval({
      approvalId: approvalIdTamper,
      stageId: stageIdTamper,
      approvalToken: 'tamper_token_123',
      targetFiles: [targetFile],
      baseContentHashes: { [targetFile]: liveHashCurrent },
      stagedContentHashes: { [targetFile]: proposedHash }, // expecting proposedHash
      status: 'approved',
      expiresAt: Date.now() + 60_000,
      grantedBy: 'trusted_ui',
    });

    // Adversary modifies staged file on disk *after* approval was recorded
    const stagedFilePath = path.join(shadowStageDir, stageIdTamper, targetFile.replace(/[\\/]/g, '_'));
    fs.writeFileSync(stagedFilePath, 'MALICIOUS_INJECTED_PAYLOAD\n', 'utf8');

    // Apply attempt: must detect hash mismatch and reject
    const applyTamperRes = await orchestrator.applyApprovedStage({
      stageId: stageIdTamper,
      approvalId: approvalIdTamper,
      approvalToken: 'tamper_token_123',
      targetFiles: [targetFile],
    });

    expect(applyTamperRes.ok).toBe(false);
    expect(applyTamperRes.error?.code).toBe('STAGE_TAMPER_DETECTED');
    expect(applyTamperRes.error?.message).toContain('modified after approval was granted');
  });

  // ─── Canary 9: Path Traversal, ADS Streams, and Device Names ─────────────
  it('Canary 9 (Prevention): strictly rejects path traversal, ADS streams, and DOS device names', async () => {
    const maliciousPaths = [
      '../../escape.txt',
      '..\\..\\escape.txt',
      'calculator.ts:stream',
      'CON',
      'NUL',
      'COM1',
      'PRN.ts',
      '/leading_slash.txt',
      'C:\\absolute\\path.txt',
    ];

    for (const badPath of maliciousPaths) {
      const res = await orchestrator.readSnapshot(badPath);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('PATH_OUTSIDE_WORKSPACE');
    }
  });

  // ─── Canary 10: Fail-Closed Behavior on Misconfiguration ─────────────────
  it('Canary 10 (Fail-Closed Integrity): fails closed when broker configuration is invalid or secret mismatches', async () => {
    // 10a: Broker initialized with short/weak secret throws immediately
    expect(() => {
      new TrustedHostBroker({
        sharedSecret: 'short',
        workspace: workspaceState,
        shadowStageDir,
        backupDir,
      });
    }).toThrow('high-entropy shared secret');

    // 10b: Orchestrator configured with mismatched shared secret fails all requests
    const mismatchedOrchestrator = new ContainedOrchestrator({
      sharedSecret: 'completely-different-mismatched-key-32characters!',
      broker,
    });

    const res = await mismatchedOrchestrator.readSnapshot('calculator.ts');
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('AUTHENTICATION_FAILED');
  });

  // ─── Canary 11: Sandbox Recipe Dispatch Policy Gating ────────────────────
  it('Canary 11 (Policy Enforcement): blocks autonomous execution dispatch under S00 NO-GO-AUTOEXEC and enforces network isolation', async () => {
    // 11a: Autonomous execution is blocked fail-closed under S00 NO-GO-AUTOEXEC
    const dispatchReq: DispatchSandboxRecipePayload = {
      recipeId: 'project.test',
      recipeHash: 'hash123',
      taskWorkspaceRoot: '/tmp/task',
      isolateNetwork: true,
    };

    const res = await orchestrator.dispatchSandboxRecipe(dispatchReq);
    expect(res.ok).toBe(true); // Broker processed request
    expect(res.result?.status).toBe('security_violation');
    expect(res.result?.violationDetails).toContain('S00 NO-GO-AUTOEXEC');

    // 11b: Attempting to bypass network isolation without canary flag is rejected
    const brokerWithPermit = new TrustedHostBroker({
      sharedSecret,
      workspace: workspaceState,
      shadowStageDir,
      backupDir,
      s00Decision: 'GO_WSL2', // Even if S00 were temporarily set to GO_WSL2
    });

    const orchestratorPermit = new ContainedOrchestrator({
      sharedSecret,
      broker: brokerWithPermit,
    });

    const unisolatedReq: DispatchSandboxRecipePayload = {
      recipeId: 'project.test',
      recipeHash: 'hash123',
      taskWorkspaceRoot: '/tmp/task',
      isolateNetwork: false, // Attempting to turn off isolation
      allowUnisolatedNetworkForCanary: false,
    };

    const unisolatedRes = await orchestratorPermit.dispatchSandboxRecipe(unisolatedReq);
    expect(unisolatedRes.ok).toBe(true);
    expect(unisolatedRes.result?.status).toBe('security_violation');
    expect(unisolatedRes.result?.violationDetails).toContain('Attempted execution without network isolation');
  });
});
