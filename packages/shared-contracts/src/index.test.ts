import { describe, it, expect } from 'vitest';
import {
  ok,
  err,
  makeMediatorError,
  ErrorCode,
  EvidenceLevel,
  canSatisfyVerificationGate,
  isExecutorSufficientForAutoExec,
  CAPABILITY_UNKNOWN,
  MANUAL_REVIEW_REQUIRED_ACTIONS,
  ActionType,
  TaskState,
  PROTOCOL_VERSION,
  type ExecutorCapability,
} from './index.js';

describe('Result helpers', () => {
  it('ok() creates a successful result', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err() creates a failed result', () => {
    const e = makeMediatorError(ErrorCode.PATH_OUTSIDE_ROOT, 'outside root');
    const r = err(e);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('PATH_OUTSIDE_ROOT');
      expect(r.error.message).toBe('outside root');
    }
  });
});

describe('makeMediatorError', () => {
  it('includes optional context fields', () => {
    const e = makeMediatorError(ErrorCode.NONCE_MISMATCH, 'bad nonce', {
      taskId: 'task-1',
      correlationId: 'corr-1',
    });
    expect(e.taskId).toBe('task-1');
    expect(e.correlationId).toBe('corr-1');
    expect(e.code).toBe('NONCE_MISMATCH');
  });
});

describe('ErrorCode', () => {
  it('has unique values', () => {
    const values = Object.values(ErrorCode);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

describe('TaskState', () => {
  it('has expected terminal states', () => {
    expect(TaskState.VERIFIED_COMPLETE).toBe('VERIFIED_COMPLETE');
    expect(TaskState.USER_ACCEPTED_UNVERIFIED).toBe('USER_ACCEPTED_UNVERIFIED');
    expect(TaskState.FAILED_SAFE).toBe('FAILED_SAFE');
    expect(TaskState.STOPPED).toBe('STOPPED');
  });

  it('VERIFIED_COMPLETE and USER_ACCEPTED_UNVERIFIED are distinct', () => {
    expect(TaskState.VERIFIED_COMPLETE).not.toBe(TaskState.USER_ACCEPTED_UNVERIFIED);
  });
});

describe('EvidenceLevel and verification gate', () => {
  it('executor-verified can satisfy verification gate', () => {
    expect(canSatisfyVerificationGate(EvidenceLevel.MEDIATOR_EXECUTOR_VERIFIED)).toBe(true);
    expect(canSatisfyVerificationGate(EvidenceLevel.TRUSTED_IDE_API_VERIFIED)).toBe(true);
  });

  it('agent-reported cannot satisfy verification gate', () => {
    expect(canSatisfyVerificationGate(EvidenceLevel.AGENT_REPORTED)).toBe(false);
    expect(canSatisfyVerificationGate(EvidenceLevel.MANUAL_RESULT_REPORTED)).toBe(false);
    expect(canSatisfyVerificationGate(EvidenceLevel.USER_ACCEPTED_UNVERIFIED)).toBe(false);
    expect(canSatisfyVerificationGate(EvidenceLevel.IDE_DIAGNOSTIC_OBSERVED)).toBe(false);
  });
});

describe('MANUAL_REVIEW_REQUIRED_ACTIONS', () => {
  it('request_recipe_run always requires manual review', () => {
    expect(MANUAL_REVIEW_REQUIRED_ACTIONS.has(ActionType.REQUEST_RECIPE_RUN)).toBe(true);
  });

  it('request_delete always requires manual review', () => {
    expect(MANUAL_REVIEW_REQUIRED_ACTIONS.has(ActionType.REQUEST_DELETE)).toBe(true);
  });

  it('propose_patch does NOT require automatic manual review (goes through policy)', () => {
    expect(MANUAL_REVIEW_REQUIRED_ACTIONS.has(ActionType.PROPOSE_PATCH)).toBe(false);
  });
});

describe('isExecutorSufficientForAutoExec', () => {
  const goodCap: ExecutorCapability = {
    adapterId: 'test',
    adapterVersion: '1.0',
    probeId: 'probe-1',
    verifiedAt: '2026-10-10T00:00:00Z',
    supported: true,
    stageRoot: {
      read: { value: true, enforcedBy: 'ide', evidenceRef: 'p1' },
      write: { value: true, enforcedBy: 'ide', evidenceRef: 'p2' },
    },
    liveWorkspace: {
      read: { value: false, enforcedBy: 'ide', evidenceRef: 'p3' },
      write: { value: false, enforcedBy: 'ide', evidenceRef: 'p4' },
    },
    process: {
      fixedExecutableAndArgs: { value: true, enforcedBy: 'mediator', evidenceRef: 'r1' },
      childProcessConfinement: { value: true, enforcedBy: 'ide', evidenceRef: 'p5' },
      hostShellFallback: { value: false, enforcedBy: 'mediator', evidenceRef: 'policy-1' },
    },
    network: {
      defaultDeny: { value: false, enforcedBy: 'unknown', evidenceRef: null },
      allowedDomains: { value: false, enforcedBy: 'unknown', evidenceRef: null },
    },
    limits: {
      timeout: { value: true, enforcedBy: 'mediator', evidenceRef: 'timer-1' },
      outputBytes: { value: true, enforcedBy: 'mediator', evidenceRef: 'collector-1' },
      cpuMemory: CAPABILITY_UNKNOWN,
      cancelChildTree: CAPABILITY_UNKNOWN,
    },
    capturesRealExitCode: true,
  };

  it('returns true for a fully verified executor', () => {
    expect(isExecutorSufficientForAutoExec(goodCap)).toBe(true);
  });

  it('returns false if not supported', () => {
    expect(isExecutorSufficientForAutoExec({ ...goodCap, supported: false })).toBe(false);
  });

  it('returns false if stage root not readable', () => {
    const cap: ExecutorCapability = {
      ...goodCap,
      stageRoot: { ...goodCap.stageRoot, read: CAPABILITY_UNKNOWN },
    };
    expect(isExecutorSufficientForAutoExec(cap)).toBe(false);
  });

  it('returns false if live workspace is writable (CRITICAL security check)', () => {
    const cap: ExecutorCapability = {
      ...goodCap,
      liveWorkspace: {
        ...goodCap.liveWorkspace,
        write: { value: true, enforcedBy: 'ide', evidenceRef: 'p-bad' },
      },
    };
    expect(isExecutorSufficientForAutoExec(cap)).toBe(false);
  });

  it('returns false if hostShellFallback enforcement is unknown', () => {
    const cap: ExecutorCapability = {
      ...goodCap,
      process: {
        ...goodCap.process,
        hostShellFallback: { value: false, enforcedBy: 'unknown', evidenceRef: null },
      },
    };
    expect(isExecutorSufficientForAutoExec(cap)).toBe(false);
  });

  it('returns false if exit code capture not available', () => {
    expect(isExecutorSufficientForAutoExec({ ...goodCap, capturesRealExitCode: false })).toBe(
      false,
    );
  });
});

describe('PROTOCOL_VERSION', () => {
  it('is 1.3', () => {
    expect(PROTOCOL_VERSION).toBe('1.3');
  });
});
