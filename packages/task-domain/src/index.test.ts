import { describe, it, expect } from 'vitest';
import {
  TaskState,
  validateTransition,
  applyTransition,
  createTaskSession,
  isTerminalState,
  canScheduleNewRound,
  ALLOWED_TRANSITIONS,
} from './index.js';

// ─── Transition table exhaustiveness test ──────────────────────────────────

describe('ALLOWED_TRANSITIONS', () => {
  it('covers every TaskState value', () => {
    const allStates = Object.values(TaskState);
    const coveredStates = Object.keys(ALLOWED_TRANSITIONS);
    expect(coveredStates.sort()).toEqual(allStates.sort());
  });
});

// ─── Happy path transitions ────────────────────────────────────────────────

describe('validateTransition — allowed paths', () => {
  it('IDLE → ATTACHED', () => {
    const r = validateTransition({ from: TaskState.IDLE, to: TaskState.ATTACHED, correlationId: 'c1', actor: 'orchestrator' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(TaskState.ATTACHED);
  });

  it('ATTACHED → TASK_DEFINED', () => {
    const r = validateTransition({ from: TaskState.ATTACHED, to: TaskState.TASK_DEFINED, correlationId: 'c2', actor: 'orchestrator' });
    expect(r.ok).toBe(true);
  });

  it('full happy path: IDLE → VERIFIED_COMPLETE', () => {
    const path = [
      [TaskState.IDLE, TaskState.ATTACHED],
      [TaskState.ATTACHED, TaskState.TASK_DEFINED],
      [TaskState.TASK_DEFINED, TaskState.WAITING_FOR_AI],
      [TaskState.WAITING_FOR_AI, TaskState.VALIDATING],
      [TaskState.VALIDATING, TaskState.STAGING],
      [TaskState.STAGING, TaskState.READY_TO_VERIFY],
      [TaskState.READY_TO_VERIFY, TaskState.EXECUTING],
      [TaskState.EXECUTING, TaskState.SANITIZING],
      [TaskState.SANITIZING, TaskState.RETURNING_TO_SAME_CHAT],
      [TaskState.RETURNING_TO_SAME_CHAT, TaskState.VERIFIED_COMPLETE],
    ] as const;

    for (const [from, to] of path) {
      const r = validateTransition({ from, to, correlationId: 'c3', actor: 'orchestrator' });
      expect(r.ok, `${from} → ${to} should be allowed`).toBe(true);
    }
  });

  it('manual handoff path', () => {
    const path = [
      [TaskState.READY_TO_VERIFY, TaskState.HANDOFF_PROMPT_READY],
      [TaskState.HANDOFF_PROMPT_READY, TaskState.WAITING_FOR_USER_SUBMISSION],
      [TaskState.WAITING_FOR_USER_SUBMISSION, TaskState.AGENT_REPORT_RECEIVED],
      [TaskState.AGENT_REPORT_RECEIVED, TaskState.WAITING_FOR_AI],
    ] as const;

    for (const [from, to] of path) {
      const r = validateTransition({ from, to, correlationId: 'c4', actor: 'orchestrator' });
      expect(r.ok, `${from} → ${to} should be allowed`).toBe(true);
    }
  });
});

// ─── Impossible transitions ────────────────────────────────────────────────

describe('validateTransition — denied impossible transitions', () => {
  const illegalTransitions: [TaskStateValue, TaskStateValue][] = [
    [TaskState.IDLE, TaskState.EXECUTING],
    [TaskState.IDLE, TaskState.VERIFIED_COMPLETE],
    [TaskState.WAITING_FOR_AI, TaskState.EXECUTING],
    [TaskState.VALIDATING, TaskState.EXECUTING], // must go through STAGING
    [TaskState.VERIFIED_COMPLETE, TaskState.WAITING_FOR_AI],
    [TaskState.VERIFIED_COMPLETE, TaskState.STAGING],
    [TaskState.DENIED, TaskState.WAITING_FOR_AI],
    [TaskState.FAILED_SAFE, TaskState.EXECUTING],
    [TaskState.AGENT_REPORT_RECEIVED, TaskState.VERIFIED_COMPLETE], // agent cannot self-verify
    [TaskState.RETURNING_TO_SAME_CHAT, TaskState.EXECUTING], // cannot re-execute without new round
  ];

  for (const [from, to] of illegalTransitions) {
    it(`blocks ${from} → ${to}`, () => {
      const r = validateTransition({ from, to, correlationId: 'c5', actor: 'orchestrator' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_STATE_TRANSITION');
    });
  }
});

// ─── STOPPED blocks new rounds ─────────────────────────────────────────────

describe('Stop prevents new round scheduling', () => {
  it('canScheduleNewRound is false in STOPPED', () => {
    expect(canScheduleNewRound(TaskState.STOPPED)).toBe(false);
  });

  it('canScheduleNewRound is false in PAUSED', () => {
    expect(canScheduleNewRound(TaskState.PAUSED)).toBe(false);
  });

  it('canScheduleNewRound is true only in WAITING_FOR_AI', () => {
    expect(canScheduleNewRound(TaskState.WAITING_FOR_AI)).toBe(true);
    for (const state of Object.values(TaskState)) {
      if (state !== TaskState.WAITING_FOR_AI) {
        expect(canScheduleNewRound(state), `${state} should not allow new round`).toBe(false);
      }
    }
  });
});

// ─── Terminal states ───────────────────────────────────────────────────────

describe('isTerminalState', () => {
  it('VERIFIED_COMPLETE is terminal', () => {
    expect(isTerminalState(TaskState.VERIFIED_COMPLETE)).toBe(true);
  });

  it('USER_ACCEPTED_UNVERIFIED is terminal (and distinct from VERIFIED_COMPLETE)', () => {
    expect(isTerminalState(TaskState.USER_ACCEPTED_UNVERIFIED)).toBe(true);
  });

  it('DENIED is terminal', () => {
    expect(isTerminalState(TaskState.DENIED)).toBe(true);
  });

  it('FAILED_SAFE is terminal', () => {
    expect(isTerminalState(TaskState.FAILED_SAFE)).toBe(true);
  });

  it('STOPPED is NOT terminal (allows restart to IDLE)', () => {
    expect(isTerminalState(TaskState.STOPPED)).toBe(false);
  });

  it('PAUSED is NOT terminal', () => {
    expect(isTerminalState(TaskState.PAUSED)).toBe(false);
  });
});

// ─── applyTransition ───────────────────────────────────────────────────────

describe('applyTransition', () => {
  const base = createTaskSession('task-1', 'session-1', 'corr-1', 10);

  it('produces a new session with updated state', () => {
    const r = applyTransition(base, { from: TaskState.IDLE, to: TaskState.ATTACHED, correlationId: 'corr-2', actor: 'orchestrator' }, 1000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe(TaskState.ATTACHED);
      expect(r.value.updatedAt).toBe(1000);
      expect(r.value.taskId).toBe('task-1');
    }
  });

  it('does NOT mutate the original session', () => {
    applyTransition(base, { from: TaskState.IDLE, to: TaskState.ATTACHED, correlationId: 'corr-3', actor: 'orchestrator' });
    expect(base.state).toBe(TaskState.IDLE);
  });

  it('records pause reason', () => {
    const attached = { ...base, state: TaskState.ATTACHED } as const;
    const r = applyTransition(attached, {
      from: TaskState.ATTACHED, to: TaskState.PAUSED,
      correlationId: 'corr-4', actor: 'orchestrator', reason: 'DOM changed',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.pauseReason).toBe('DOM changed');
  });

  it('increments roundCount when entering WAITING_FOR_AI from RETURNING_TO_SAME_CHAT', () => {
    const returning = { ...base, state: TaskState.RETURNING_TO_SAME_CHAT, roundCount: 2 } as const;
    const r = applyTransition(returning, {
      from: TaskState.RETURNING_TO_SAME_CHAT, to: TaskState.WAITING_FOR_AI,
      correlationId: 'corr-5', actor: 'orchestrator',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.roundCount).toBe(3);
  });

  it('enforces maxRounds limit', () => {
    const returning = { ...base, state: TaskState.RETURNING_TO_SAME_CHAT, roundCount: 10, maxRounds: 10 } as const;
    const r = applyTransition(returning, {
      from: TaskState.RETURNING_TO_SAME_CHAT, to: TaskState.WAITING_FOR_AI,
      correlationId: 'corr-6', actor: 'orchestrator',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects invalid transition', () => {
    const r = applyTransition(base, { from: TaskState.IDLE, to: TaskState.EXECUTING, correlationId: 'corr-7', actor: 'orchestrator' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

// ─── createTaskSession ─────────────────────────────────────────────────────

describe('createTaskSession', () => {
  it('starts in IDLE with zero rounds', () => {
    const s = createTaskSession('t1', 's1', 'c1');
    expect(s.state).toBe(TaskState.IDLE);
    expect(s.roundCount).toBe(0);
  });
});


