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
  validateProtocolEnvelope,
  validateBoundaryEvent,
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

describe('S02 — Protocol Schema Validation', () => {
  const validSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const validEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    taskId: 'task-100',
    sessionId: 'session-200',
    nonce: 'nonce-12345678',
    round: 1,
    sequence: 1,
    conversation: {
      provider: 'gemini',
      conversationId: 'chat-abc',
      chatTitle: 'My Project Chat',
    },
    baseStateHash: validSha256,
    status: 'continue',
    actions: [
      {
        id: 'act-1',
        type: 'list_files',
        pathPrefix: 'src',
        limit: 100,
      },
      {
        id: 'act-2',
        type: 'read_file',
        path: 'src/index.ts',
        rangeStart: 0,
        rangeEnd: 50,
      },
    ],
    contentBlocks: [
      {
        id: 'cb-1',
        delimiter: '---BLOCK-cb-1---',
        encoding: 'utf-8',
        byteLength: 42,
        sha256: validSha256,
      },
    ],
  };

  it('validates a well-formed protocol envelope', () => {
    const res = validateProtocolEnvelope(validEnvelope);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.taskId).toBe('task-100');
      expect(res.value.actions).toHaveLength(2);
      expect(res.value.actions[0]?.type).toBe('list_files');
    }
  });

  it('rejects null or non-object input with SCHEMA_INVALID', () => {
    const resNull = validateProtocolEnvelope(null);
    expect(resNull.ok).toBe(false);
    if (!resNull.ok) {
      expect(resNull.error.code).toBe(ErrorCode.SCHEMA_INVALID);
    }

    const resString = validateProtocolEnvelope('not an object');
    expect(resString.ok).toBe(false);
    if (!resString.ok) {
      expect(resString.error.code).toBe(ErrorCode.SCHEMA_INVALID);
    }
  });

  it('rejects missing required fields (e.g. nonce, taskId, actions)', () => {
    const missingTaskId = { ...validEnvelope };
    delete (missingTaskId as Record<string, unknown>).taskId;

    const res = validateProtocolEnvelope(missingTaskId);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.SCHEMA_INVALID);
      expect(res.error.message).toContain('taskId');
    }
  });

  it('rejects invalid sha256 hash length or format', () => {
    const badHash = { ...validEnvelope, baseStateHash: 'not-a-valid-sha256' };
    const res = validateProtocolEnvelope(badHash);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.SCHEMA_INVALID);
      expect(res.error.message).toContain('baseStateHash');
    }
  });

  it('rejects short nonces (< 8 characters)', () => {
    const shortNonce = { ...validEnvelope, nonce: 'short' };
    const res = validateProtocolEnvelope(shortNonce);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.SCHEMA_INVALID);
      expect(res.error.message).toContain('nonce');
    }
  });

  it('rejects invalid action types', () => {
    const badAction = {
      ...validEnvelope,
      actions: [{ id: 'bad-1', type: 'arbitrary_bash_command' }],
    };
    const res = validateProtocolEnvelope(badAction);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.SCHEMA_INVALID);
    }
  });

  it('rejects action missing required parameters (propose_patch without hash)', () => {
    const incompletePatch = {
      ...validEnvelope,
      actions: [
        {
          id: 'patch-1',
          type: 'propose_patch',
          path: 'src/main.ts',
          // missing expectedBaseHash and contentBlockId
        },
      ],
    };
    const res = validateProtocolEnvelope(incompletePatch);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.SCHEMA_INVALID);
    }
  });

  it('rejects oversized raw payload with OVERSIZED_INPUT', () => {
    // Construct an envelope payload that exceeds 1 MB
    const hugeString = 'x'.repeat(1024 * 1024 + 10);
    const hugeEnvelope = {
      ...validEnvelope,
      conversation: {
        ...validEnvelope.conversation,
        chatTitle: hugeString,
      },
    };

    const res = validateProtocolEnvelope(hugeEnvelope);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.OVERSIZED_INPUT);
      expect(res.error.message).toContain('exceeds maximum size');
    }
  });

  it('rejects envelope exceeding 50 actions limit', () => {
    const tooManyActions = {
      ...validEnvelope,
      actions: Array.from({ length: 51 }, (_, i) => ({
        id: `act-${i}`,
        type: 'list_files',
        pathPrefix: '',
        limit: 10,
      })),
    };
    const res = validateProtocolEnvelope(tooManyActions);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.SCHEMA_INVALID);
    }
  });
});

describe('S02 — Boundary Event Validation', () => {
  it('validates a well-formed boundary event with requestId, correlationId, taskId', () => {
    const validEvent = {
      eventId: 'evt-1',
      requestId: 'req-1',
      correlationId: 'corr-1',
      taskId: 'task-1',
      sessionId: 'sess-1',
      timestamp: Date.now(),
      source: 'ide',
      type: 'user_approval_granted',
      payload: { actionId: 'act-1' },
    };

    const res = validateBoundaryEvent(validEvent);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.requestId).toBe('req-1');
      expect(res.value.correlationId).toBe('corr-1');
      expect(res.value.taskId).toBe('task-1');
    }
  });

  it('rejects boundary event missing requestId', () => {
    const missingReq = {
      eventId: 'evt-1',
      // missing requestId
      correlationId: 'corr-1',
      taskId: 'task-1',
      timestamp: Date.now(),
      source: 'ide',
      type: 'test_event',
      payload: {},
    };

    const res = validateBoundaryEvent(missingReq);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.SCHEMA_INVALID);
      expect(res.error.message).toContain('requestId');
    }
  });

  it('rejects boundary event missing correlationId', () => {
    const missingCorr = {
      eventId: 'evt-1',
      requestId: 'req-1',
      // missing correlationId
      taskId: 'task-1',
      timestamp: Date.now(),
      source: 'browser',
      type: 'test_event',
      payload: {},
    };

    const res = validateBoundaryEvent(missingCorr);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.SCHEMA_INVALID);
      expect(res.error.message).toContain('correlationId');
    }
  });

  it('rejects boundary event with invalid source', () => {
    const badSource = {
      eventId: 'evt-1',
      requestId: 'req-1',
      correlationId: 'corr-1',
      taskId: 'task-1',
      timestamp: Date.now(),
      source: 'unauthorized_network_daemon',
      type: 'test_event',
      payload: {},
    };

    const res = validateBoundaryEvent(badSource);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.SCHEMA_INVALID);
      expect(res.error.message).toContain('source');
    }
  });
});

describe('S02 — ErrorCode additions', () => {
  it('contains PATH_DENIED, CONVERSATION_MISMATCH, OVERSIZED_INPUT', () => {
    expect(ErrorCode.PATH_DENIED).toBe('PATH_DENIED');
    expect(ErrorCode.CONVERSATION_MISMATCH).toBe('CONVERSATION_MISMATCH');
    expect(ErrorCode.OVERSIZED_INPUT).toBe('OVERSIZED_INPUT');
    expect(ErrorCode.CAPABILITY_UNAVAILABLE).toBe('CAPABILITY_UNAVAILABLE');
    expect(ErrorCode.APPROVAL_REQUIRED).toBe('APPROVAL_REQUIRED');
    expect(ErrorCode.TRANSFER_INCOMPLETE).toBe('TRANSFER_INCOMPLETE');
    expect(ErrorCode.CORE_NOT_RUNNING).toBe('CORE_NOT_RUNNING');
  });
});
