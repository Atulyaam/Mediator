import { describe, it, expect } from 'vitest';
import { RuntimeCanaryHarness } from './canaryHarness.js';
import { S00ExecutionDecisionValues } from '@mediator/shared-contracts';

describe('Sprint S21 — Runtime Canary Harness', () => {
  it('runs full synthetic canary battery cleanly and verifies live workspace integrity', async () => {
    const harness = new RuntimeCanaryHarness({
      executorId: 'antigravity-sandbox',
      executorVersion: '1.0.0',
      s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
    });

    const result = await harness.runCanaryBattery();

    expect(result.workspaceIntegrityVerified).toBe(true);
    expect(result.runRecords.length).toBeGreaterThanOrEqual(7);

    // Verify individual canary checks
    const stageRead = result.runRecords.find((r) => r.capability === 'filesystem.stageRootRead');
    expect(stageRead).toBeDefined();
    expect(stageRead?.classification).toBe('pass');

    const stageWrite = result.runRecords.find((r) => r.capability === 'filesystem.stageRootWrite');
    expect(stageWrite).toBeDefined();
    expect(stageWrite?.classification).toBe('pass');

    const sourceDenial = result.runRecords.find((r) => r.capability === 'filesystem.liveWorkspaceWriteDenied');
    expect(sourceDenial).toBeDefined();
    expect(sourceDenial?.classification).toBe('pass');

    const outsideRoot = result.runRecords.find((r) => r.capability === 'filesystem.outsideRootDenied');
    expect(outsideRoot).toBeDefined();
    expect(outsideRoot?.classification).toBe('pass');

    const secretExclusion = result.runRecords.find((r) => r.capability === 'filesystem.secretFilesProtected');
    expect(secretExclusion).toBeDefined();
    expect(secretExclusion?.classification).toBe('pass');

    const traversal = result.runRecords.find((r) => r.capability === 'filesystem.symlinkEscapeDenied');
    expect(traversal).toBeDefined();
    expect(traversal?.classification).toBe('pass');

    const integrity = result.runRecords.find((r) => r.capability === 'filesystem.liveWorkspaceIntegrity');
    expect(integrity).toBeDefined();
    expect(integrity?.classification).toBe('pass');

    const shellRejection = result.runRecords.find((r) => r.capability === 'process.untrustedScriptsRejected');
    expect(shellRejection).toBeDefined();
    expect(shellRejection?.classification).toBe('pass');

    // Under NO-GO-AUTOEXEC, process runner is disabled and exit code is marked inconclusive
    const processDisabled = result.runRecords.find((r) => r.capability === 'execution.fixedRecipeOnly');
    expect(processDisabled).toBeDefined();
    expect(processDisabled?.classification).toBe('pass');

    const exitCode = result.runRecords.find((r) => r.capability === 'limits.capturesRealExitCode');
    expect(exitCode).toBeDefined();
    expect(exitCode?.classification).toBe('inconclusive');
  });

  it('synthesizes capabilities where unverified fields count as false', async () => {
    const harness = new RuntimeCanaryHarness({
      s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
    });

    const result = await harness.runCanaryBattery();
    const caps = result.capabilities;

    expect(caps.filesystem.stageRootRead.value).toBe(true);
    expect(caps.filesystem.liveWorkspaceWriteDenied.value).toBe(true);
    expect(caps.limits.capturesRealExitCode.value).toBe(false); // unverified exit code capture
    expect(caps.network.networkRestricted.value).toBe(false); // unverified network restriction
  });
});
