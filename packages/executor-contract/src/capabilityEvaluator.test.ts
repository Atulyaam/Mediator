import { describe, it, expect, beforeEach } from 'vitest';
import {
  CapabilityEvaluationEngine,
  type CapabilityEvaluationInput,
} from './capabilityEvaluator.js';
import {
  type ExecutorSecurityCapabilities,
  type SecurityCapabilityField,
  S00ExecutionDecisionValues,
  PROTOCOL_VERSION,
} from '@mediator/shared-contracts';

describe('Sprint S21 — Executor Capability Schema & Evaluator Engine', () => {
  let engine: CapabilityEvaluationEngine;
  let validCapabilities: ExecutorSecurityCapabilities;
  const now = Date.now();

  const makeValidField = (overrides?: Partial<SecurityCapabilityField>): SecurityCapabilityField => ({
    value: true,
    enforcedBy: 'mediator',
    evidenceRef: 'evidence:canary-verified',
    provenance: 'runtime_canary',
    observedAt: now,
    executorId: 'antigravity-sandbox',
    executorVersion: '1.0.0',
    canaryId: 'canary-1',
    statusOrLimitations: 'Verified',
    correlationId: 'corr-1',
    ...overrides,
  });

  beforeEach(() => {
    engine = new CapabilityEvaluationEngine({ defaultMaxAgeMs: 3600_000 });

    validCapabilities = {
      version: PROTOCOL_VERSION,
      executorId: 'antigravity-sandbox',
      executorVersion: '1.0.0',
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      stageId: 'stage-123',
      workspaceRoot: 'C:/Users/User/Desktop/Project',
      evaluatedAt: now,
      correlationId: 'corr-123',
      filesystem: {
        stageRootRead: makeValidField(),
        stageRootWrite: makeValidField(),
        liveWorkspaceWriteDenied: makeValidField(),
        outsideRootDenied: makeValidField(),
        secretFilesProtected: makeValidField(),
        symlinkEscapeDenied: makeValidField(),
        filesystemLimitsEnforced: makeValidField(),
      },
      process: {
        executableAllowlistEnforced: makeValidField(),
        argumentsRestricted: makeValidField(),
        untrustedScriptsRejected: makeValidField(),
        childProcessesControlled: makeValidField(),
        processTerminationEnforced: makeValidField(),
        hostShellFallbackDenied: makeValidField(),
      },
      network: {
        networkRestricted: makeValidField({ value: false, enforcedBy: 'unknown', provenance: 'unknown_unverified' }),
        networkPolicyTested: makeValidField({ value: false, enforcedBy: 'unknown', provenance: 'unknown_unverified' }),
      },
      limits: {
        timeoutEnforced: makeValidField(),
        cancellationEnforced: makeValidField(),
        outputByteLimitsEnforced: makeValidField(),
        cpuMemoryLimitsEnforced: makeValidField({ value: false, enforcedBy: 'unknown', provenance: 'unknown_unverified' }),
        concurrentProcessLimitsEnforced: makeValidField(),
        capturesRealExitCode: makeValidField(),
      },
      execution: {
        fixedRecipeOnly: makeValidField(),
        actualCommandObserved: makeValidField(),
        boundedOutputCaptured: makeValidField(),
        exitCodeReliablyCollected: makeValidField(),
        crashReconciliationSupported: makeValidField(),
        stagedSourceProven: makeValidField(),
      },
    };
  });

  const createInput = (overrides?: Partial<CapabilityEvaluationInput>): CapabilityEvaluationInput => ({
    executorId: 'antigravity-sandbox',
    executorVersion: '1.0.0',
    s00Decision: S00ExecutionDecisionValues.GO_IDE,
    capabilities: validCapabilities,
    requiredStageId: 'stage-123',
    requiredWorkspaceRoot: 'C:/Users/User/Desktop/Project',
    evaluationTime: now,
    ...overrides,
  });

  it('1. validates a fully compliant capability schema as eligible under GO decision', () => {
    const report = engine.evaluate(createInput());
    expect(report.result).toBe('eligible');
    expect(report.isEligibleForAutoExec).toBe(true);
    expect(report.failedRequirements).toHaveLength(0);
    expect(report.unverifiedRequirements).toHaveLength(0);
  });

  it('2. missing mandatory capability rejects execution eligibility', () => {
    const caps: any = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        stageRootRead: undefined,
      },
    };
    const report = engine.evaluate(createInput({ capabilities: caps }));
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.unverifiedRequirements).toContain('filesystem.stageRootRead');
  });

  it('3. unknown enforcedBy always evaluates as false for security guarantees', () => {
    const caps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        liveWorkspaceWriteDenied: makeValidField({ enforcedBy: 'unknown' }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: caps }));
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.unverifiedRequirements).toContain('filesystem.liveWorkspaceWriteDenied');
    expect(report.blockedReasons.some((r) => r.includes("enforcing layer is 'unknown'"))).toBe(true);
  });

  it('4. documentation-only evidence cannot satisfy a runtime gate', () => {
    const caps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        liveWorkspaceWriteDenied: makeValidField({ provenance: 'documentation_assertion' }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: caps }));
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.unverifiedRequirements).toContain('filesystem.liveWorkspaceWriteDenied');
    expect(report.blockedReasons.some((r) => r.includes('documentation-only assertion'))).toBe(true);
  });

  it('5. mock-only or simulated evidence cannot satisfy mandatory runtime canary gates', () => {
    const caps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        outsideRootDenied: makeValidField({ provenance: 'unit_contract_test' }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: caps }));
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.unverifiedRequirements).toContain('filesystem.outsideRootDenied');
    expect(report.blockedReasons.some((r) => r.includes('requires runtime_canary evidence'))).toBe(true);
  });

  it('6. agent-reported claims cannot satisfy a runtime gate', () => {
    const caps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        secretFilesProtected: makeValidField({ provenance: 'agent_reported_claim' }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: caps }));
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.unverifiedRequirements).toContain('filesystem.secretFilesProtected');
    expect(report.blockedReasons.some((r) => r.includes('agent-reported claim'))).toBe(true);
  });

  it('7. stale evidence is rejected', () => {
    const twoHoursAgo = now - 2 * 3600_000;
    const caps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        liveWorkspaceWriteDenied: makeValidField({ observedAt: twoHoursAgo }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: caps, evaluationTime: now }));
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.failedRequirements).toContain('filesystem.liveWorkspaceWriteDenied');
    expect(report.blockedReasons.some((r) => r.includes('evidence is stale'))).toBe(true);
  });

  it('8. evidence for another executor or version is rejected', () => {
    const reportWrongId = engine.evaluate(createInput({ executorId: 'different-executor' }));
    expect(reportWrongId.isEligibleForAutoExec).toBe(false);
    expect(reportWrongId.failedRequirements).toContain('executor_id_match');

    const reportWrongVer = engine.evaluate(createInput({ executorVersion: '2.0.0' }));
    expect(reportWrongVer.isEligibleForAutoExec).toBe(false);
    expect(reportWrongVer.failedRequirements).toContain('executor_version_match');
  });

  it('9. evidence for another stage or workspace is rejected', () => {
    const reportWrongStage = engine.evaluate(createInput({ requiredStageId: 'stage-other' }));
    expect(reportWrongStage.isEligibleForAutoExec).toBe(false);
    expect(reportWrongStage.failedRequirements).toContain('stage_id_match');

    const reportWrongWorkspace = engine.evaluate(createInput({ requiredWorkspaceRoot: 'C:/Other/Path' }));
    expect(reportWrongWorkspace.isEligibleForAutoExec).toBe(false);
    expect(reportWrongWorkspace.failedRequirements).toContain('workspace_root_match');
  });

  it('10. missing S00 decision blocks eligibility', () => {
    const report = engine.evaluate(createInput({ s00Decision: undefined as any }));
    expect(report.result).toBe('blocked');
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.failedRequirements).toContain('s00_decision_valid');
  });

  it('11. NO-GO-AUTOEXEC always blocks execution', () => {
    const report = engine.evaluate(createInput({ s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC }));
    expect(report.result).toBe('blocked');
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.blockedReasons.some((r) => r.includes('NO-GO-AUTOEXEC'))).toBe(true);
  });

  it('12. required source-write denial failure blocks execution', () => {
    const caps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        liveWorkspaceWriteDenied: makeValidField({ value: false }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: caps }));
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.failedRequirements).toContain('filesystem.liveWorkspaceWriteDenied');
  });

  it('13. required stage-read failure blocks execution', () => {
    const caps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        stageRootRead: makeValidField({ value: false }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: caps }));
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.failedRequirements).toContain('filesystem.stageRootRead');
  });

  it('14. outside-root access not demonstrably denied blocks execution', () => {
    const caps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        outsideRootDenied: makeValidField({ value: false }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: caps }));
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.failedRequirements).toContain('filesystem.outsideRootDenied');
  });

  it('15. secret protection unverified blocks execution', () => {
    const caps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        secretFilesProtected: makeValidField({ value: false }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: caps }));
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.failedRequirements).toContain('filesystem.secretFilesProtected');
  });

  it('16. unverified exit code capture leaves capability unverified and blocks execution', () => {
    const caps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      limits: {
        ...validCapabilities.limits,
        capturesRealExitCode: makeValidField({ value: false, enforcedBy: 'unknown', provenance: 'unknown_unverified' }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: caps }));
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.unverifiedRequirements).toContain('limits.capturesRealExitCode');
  });

  it('17. timeout and cancellation enforcement are evaluated properly', () => {
    const report = engine.evaluate(createInput());
    expect(report.passedRequirements).toContain('limits.timeoutEnforced');

    const caps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      limits: {
        ...validCapabilities.limits,
        timeoutEnforced: makeValidField({ value: false }),
      },
    };
    const reportFailed = engine.evaluate(createInput({ capabilities: caps }));
    expect(reportFailed.failedRequirements).toContain('limits.timeoutEnforced');
  });

  it('18. capturesRealExitCode must be true and verified for eligibility', () => {
    const report = engine.evaluate(createInput());
    expect(report.passedRequirements).toContain('limits.capturesRealExitCode');
  });

  it('19. capability report contains clear explainable blocked and unverified reasons', () => {
    const caps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        liveWorkspaceWriteDenied: makeValidField({ value: false, statusOrLimitations: 'Write permitted to source' }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: caps }));
    expect(report.blockedReasons.length).toBeGreaterThan(0);
    expect(report.blockedReasons[0]).toContain('filesystem.liveWorkspaceWriteDenied');
  });

  it('20. evaluation output is immutable and does not modify input capabilities', () => {
    const originalValue = validCapabilities.filesystem.stageRootRead.value;
    const report = engine.evaluate(createInput());
    expect(report.isEligibleForAutoExec).toBe(true);
    expect(validCapabilities.filesystem.stageRootRead.value).toBe(originalValue);
  });

  it('21. evaluation cannot alter the S00 decision', () => {
    const report = engine.evaluate(createInput({ s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC }));
    expect(report.s00Decision).toBe(S00ExecutionDecisionValues.NO_GO_AUTOEXEC);
  });

  it('22. capability evaluation cannot grant approval or alter policy', () => {
    const report = engine.evaluate(createInput());
    expect(report).not.toHaveProperty('grantApproval');
    expect(report).not.toHaveProperty('mutatePolicy');
  });

  it('23. normalized Windows path comparison succeeds for equivalent workspace roots', () => {
    const report = engine.evaluate(
      createInput({
        requiredWorkspaceRoot: 'c:\\Users\\User\\Desktop\\Project',
      }),
    );
    expect(report.passedRequirements).toContain('workspace_root_match');
  });

  it('24. evidence timestamp in future is rejected', () => {
    const futureTime = now + 120_000;
    const caps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        stageRootRead: makeValidField({ observedAt: futureTime }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: caps }));
    expect(report.failedRequirements).toContain('filesystem.stageRootRead');
    expect(report.blockedReasons.some((r) => r.includes('future'))).toBe(true);
  });

  it('25. contradictory evidence claiming write denied while status reports integrity breach is rejected', () => {
    const contradictoryCaps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        liveWorkspaceWriteDenied: makeValidField({
          value: true,
          statusOrLimitations: 'Live source sentinel was tampered; liveWorkspaceIntegrityPreserved: false',
        }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: contradictoryCaps }));
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.failedRequirements).toContain('filesystem.liveWorkspaceWriteDenied');
    expect(report.blockedReasons.some((r) => r.includes('contradictory evidence rejected'))).toBe(true);
  });

  it('26. post-hoc detection or restoration after an unprevented write cannot satisfy prevention requirement', () => {
    const detectedCaps: ExecutorSecurityCapabilities = {
      ...validCapabilities,
      filesystem: {
        ...validCapabilities.filesystem,
        liveWorkspaceWriteDenied: makeValidField({
          value: true,
          statusOrLimitations: 'Write permitted to live workspace but detected after write and restored after write',
        }),
      },
    };
    const report = engine.evaluate(createInput({ capabilities: detectedCaps }));
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.failedRequirements).toContain('filesystem.liveWorkspaceWriteDenied');
    expect(report.blockedReasons.some((r) => r.includes('post-hoc detection or cleanup does NOT satisfy prevention guarantee'))).toBe(true);
  });

  it('27. underlying canary run record with failure overrides capability value claim of true', () => {
    const report = engine.evaluate(
      createInput({
        capabilities: validCapabilities,
        canaryRecords: [
          {
            runId: 'canary-source-tamper-run-1',
            executorId: 'antigravity-sandbox',
            executorVersion: '1.0.0',
            s00DecisionRef: S00ExecutionDecisionValues.GO_IDE,
            stageId: 'stage-123',
            workspaceRoot: 'C:/Users/User/Desktop/Project',
            startedAt: now - 5000,
            completedAt: now,
            capability: 'filesystem.liveWorkspaceWriteDenied',
            expectedResult: 'Source write denied',
            observedResult: 'Sentinel was modified by running process',
            enforcingLayer: 'mediator',
            classification: 'fail',
            evidenceRef: 'tamper-detected',
            correlationId: 'corr-123',
          },
        ],
      }),
    );
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.failedRequirements).toContain('filesystem.liveWorkspaceWriteDenied');
    expect(report.blockedReasons.some((r) => r.includes('underlying canary run'))).toBe(true);
  });
});
