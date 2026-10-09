/**
 * @mediator/task-domain
 *
 * Pure state machine for Mediator task/session lifecycle.
 * NO filesystem, NO network, NO process execution.
 * Only the orchestrator may call transitionState().
 */

import {
  TaskState,
  type TaskStateValue,
  type MediatorError,
  ErrorCode,
  makeMediatorError,
  type Result,
  ok,
  err,
} from '@mediator/shared-contracts';

export { TaskState, type TaskStateValue };

// ─── Allowed transitions ───────────────────────────────────────────────────
//
// This is the single source of truth for the state machine.
// Any transition not listed here is REJECTED.

type TransitionMap = Readonly<Record<TaskStateValue, ReadonlyArray<TaskStateValue>>>;

const ALLOWED_TRANSITIONS: TransitionMap = {
  [TaskState.IDLE]: [TaskState.ATTACHED, TaskState.STOPPED],

  [TaskState.ATTACHED]: [
    TaskState.TASK_DEFINED,
    TaskState.PAUSED,
    TaskState.STOPPED,
    TaskState.FAILED_SAFE,
    TaskState.IDLE, // detach
  ],

  [TaskState.TASK_DEFINED]: [
    TaskState.WAITING_FOR_AI,
    TaskState.PAUSED,
    TaskState.STOPPED,
    TaskState.DENIED,
    TaskState.FAILED_SAFE,
  ],

  [TaskState.WAITING_FOR_AI]: [
    TaskState.VALIDATING,
    TaskState.PAUSED,
    TaskState.STOPPED,
    TaskState.FAILED_SAFE,
  ],

  [TaskState.VALIDATING]: [
    TaskState.STAGING,
    TaskState.DENIED,
    TaskState.PAUSED,
    TaskState.STOPPED,
    TaskState.FAILED_SAFE,
  ],

  [TaskState.STAGING]: [
    TaskState.REVIEW_REQUIRED,
    TaskState.READY_TO_VERIFY,
    TaskState.DENIED,
    TaskState.PAUSED,
    TaskState.STOPPED,
    TaskState.FAILED_SAFE,
  ],

  [TaskState.REVIEW_REQUIRED]: [
    TaskState.READY_TO_VERIFY, // user approved
    TaskState.DENIED,           // user denied
    TaskState.PAUSED,
    TaskState.STOPPED,
    TaskState.FAILED_SAFE,
  ],

  [TaskState.READY_TO_VERIFY]: [
    TaskState.EXECUTING,              // verified executor available
    TaskState.HANDOFF_PROMPT_READY,   // manual IDE-agent path
    TaskState.PAUSED,
    TaskState.STOPPED,
    TaskState.DENIED,
    TaskState.FAILED_SAFE,
  ],

  [TaskState.EXECUTING]: [
    TaskState.SANITIZING,
    TaskState.PAUSED,
    TaskState.STOPPED,
    TaskState.FAILED_SAFE,
  ],

  [TaskState.SANITIZING]: [
    TaskState.RETURNING_TO_SAME_CHAT,
    TaskState.PAUSED,
    TaskState.STOPPED,
    TaskState.FAILED_SAFE,
  ],

  [TaskState.RETURNING_TO_SAME_CHAT]: [
    TaskState.WAITING_FOR_AI, // next round
    TaskState.VERIFIED_COMPLETE,
    TaskState.PAUSED,
    TaskState.STOPPED,
    TaskState.FAILED_SAFE,
  ],

  [TaskState.HANDOFF_PROMPT_READY]: [
    TaskState.WAITING_FOR_USER_SUBMISSION,
    TaskState.PAUSED,
    TaskState.STOPPED,
    TaskState.DENIED,
  ],

  [TaskState.WAITING_FOR_USER_SUBMISSION]: [
    TaskState.AGENT_REPORT_RECEIVED,
    TaskState.PAUSED,
    TaskState.STOPPED,
    TaskState.DENIED,
  ],

  [TaskState.AGENT_REPORT_RECEIVED]: [
    TaskState.WAITING_FOR_AI, // agent report goes back to AI as agent-reported
    TaskState.PAUSED,
    TaskState.STOPPED,
    TaskState.FAILED_SAFE,
  ],

  // From PAUSED — resume requires revalidation
  [TaskState.PAUSED]: [
    TaskState.WAITING_FOR_AI,   // resume at last safe point
    TaskState.TASK_DEFINED,     // resume from beginning
    TaskState.STOPPED,
    TaskState.FAILED_SAFE,
    TaskState.IDLE,
  ],

  // Terminal states — no further transitions
  [TaskState.DENIED]: [],
  [TaskState.FAILED_SAFE]: [],
  [TaskState.STOPPED]: [TaskState.IDLE], // allow restart
  [TaskState.VERIFIED_COMPLETE]: [],
  [TaskState.USER_ACCEPTED_UNVERIFIED]: [],
};

// ─── Task session ──────────────────────────────────────────────────────────

export interface TaskSession {
  readonly taskId: string;
  readonly sessionId: string;
  readonly state: TaskStateValue;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly correlationId: string;
  readonly pauseReason?: string | undefined;
  readonly stopReason?: string | undefined;
  readonly failureReason?: string | undefined;
  readonly roundCount: number;
  readonly maxRounds: number;
}

// ─── Transition request ────────────────────────────────────────────────────

export interface TransitionRequest {
  readonly from: TaskStateValue;
  readonly to: TaskStateValue;
  readonly correlationId: string;
  readonly reason?: string | undefined;
  readonly actor: 'orchestrator'; // only the orchestrator may call this
}

// ─── State machine ─────────────────────────────────────────────────────────

/**
 * Pure transition validator. Returns the new state on success or a typed error.
 * Does NOT mutate anything — caller is responsible for persisting the result.
 */
export function validateTransition(req: TransitionRequest): Result<TaskStateValue, MediatorError> {
  const allowed = ALLOWED_TRANSITIONS[req.from];

  if (!allowed || !allowed.includes(req.to)) {
    return err(
      makeMediatorError(
        ErrorCode.INVALID_STATE_TRANSITION,
        `Transition ${req.from} → ${req.to} is not allowed`,
        { correlationId: req.correlationId, detail: { from: req.from, to: req.to } },
      ),
    );
  }

  return ok(req.to);
}

/**
 * Apply a validated transition to a TaskSession, producing a new session value.
 * Does NOT mutate the input.
 */
export function applyTransition(
  session: TaskSession,
  req: TransitionRequest,
  now: number = Date.now(),
): Result<TaskSession, MediatorError> {
  const validationResult = validateTransition(req);
  if (!validationResult.ok) return validationResult;

  const next: TaskSession = {
    ...session,
    state: validationResult.value,
    updatedAt: now,
    correlationId: req.correlationId,
    // Carry over or clear context fields based on transition
    pauseReason: req.to === TaskState.PAUSED ? req.reason : undefined,
    stopReason: req.to === TaskState.STOPPED ? req.reason : undefined,
    failureReason: req.to === TaskState.FAILED_SAFE ? req.reason : undefined,
    roundCount:
      req.to === TaskState.WAITING_FOR_AI && req.from === TaskState.RETURNING_TO_SAME_CHAT
        ? session.roundCount + 1
        : session.roundCount,
  };

  // Round limit guard
  if (next.roundCount > next.maxRounds) {
    return err(
      makeMediatorError(
        ErrorCode.INVALID_STATE_TRANSITION,
        `Maximum rounds (${next.maxRounds}) exceeded`,
        { correlationId: req.correlationId, detail: { roundCount: next.roundCount } },
      ),
    );
  }

  return ok(next);
}

/**
 * Returns true if the given state is a terminal state (no further transitions possible,
 * or only IDLE restart is allowed).
 */
export function isTerminalState(state: TaskStateValue): boolean {
  const terminal: TaskStateValue[] = [
    TaskState.DENIED,
    TaskState.FAILED_SAFE,
    TaskState.VERIFIED_COMPLETE,
    TaskState.USER_ACCEPTED_UNVERIFIED,
  ];
  return terminal.includes(state);
}

/**
 * Returns true if a new round can be scheduled from this state.
 * Stop prevents new rounds immediately.
 */
export function canScheduleNewRound(state: TaskStateValue): boolean {
  return state === TaskState.WAITING_FOR_AI;
}

/** Create a new TaskSession in IDLE state */
export function createTaskSession(
  taskId: string,
  sessionId: string,
  correlationId: string,
  maxRounds = 20,
  now: number = Date.now(),
): TaskSession {
  return {
    taskId,
    sessionId,
    state: TaskState.IDLE,
    createdAt: now,
    updatedAt: now,
    correlationId,
    roundCount: 0,
    maxRounds,
  };
}

/**
 * TaskCoordinator enforces that only one active task session exists at a time in V1.
 * Only the orchestrator (or coordinator methods) can transition states.
 * Mutation is encapsulated — external callers receive immutable TaskSession copies.
 */
export class TaskCoordinator {
  private _session: TaskSession | null = null;

  getActiveSession(): TaskSession | null {
    return this._session;
  }

  hasActiveTask(): boolean {
    if (!this._session) return false;
    return (
      !isTerminalState(this._session.state) &&
      this._session.state !== TaskState.STOPPED &&
      this._session.state !== TaskState.IDLE
    );
  }

  startSession(
    taskId: string,
    sessionId: string,
    correlationId: string,
    maxRounds = 20,
    now: number = Date.now(),
  ): Result<TaskSession, MediatorError> {
    if (this.hasActiveTask()) {
      return err(
        makeMediatorError(
          ErrorCode.TASK_ALREADY_ACTIVE,
          `Cannot start task ${taskId}: task ${this._session?.taskId ?? ''} is already active in state ${this._session?.state ?? ''}`,
          { correlationId, taskId, sessionId },
        ),
      );
    }

    const session = createTaskSession(taskId, sessionId, correlationId, maxRounds, now);
    this._session = session;
    return ok(session);
  }

  transition(
    req: Omit<TransitionRequest, 'actor' | 'from'> & { actor: 'orchestrator' },
    now: number = Date.now(),
  ): Result<TaskSession, MediatorError> {
    if (!this._session) {
      return err(
        makeMediatorError(
          ErrorCode.INVALID_STATE_TRANSITION,
          'No active session to transition',
          { correlationId: req.correlationId },
        ),
      );
    }

    const fullReq: TransitionRequest = {
      from: this._session.state,
      to: req.to,
      correlationId: req.correlationId,
      reason: req.reason,
      actor: 'orchestrator',
    };

    const res = applyTransition(this._session, fullReq, now);
    if (!res.ok) return res;

    this._session = res.value;
    return ok(this._session);
  }

  stop(
    reason: string,
    correlationId: string,
    now: number = Date.now(),
  ): Result<TaskSession, MediatorError> {
    if (!this._session) {
      return err(
        makeMediatorError(ErrorCode.INVALID_STATE_TRANSITION, 'No active session to stop', {
          correlationId,
        }),
      );
    }
    return this.transition({ to: TaskState.STOPPED, correlationId, reason, actor: 'orchestrator' }, now);
  }

  pause(
    reason: string,
    correlationId: string,
    now: number = Date.now(),
  ): Result<TaskSession, MediatorError> {
    if (!this._session) {
      return err(
        makeMediatorError(ErrorCode.INVALID_STATE_TRANSITION, 'No active session to pause', {
          correlationId,
        }),
      );
    }
    return this.transition({ to: TaskState.PAUSED, correlationId, reason, actor: 'orchestrator' }, now);
  }

  failSafe(
    reason: string,
    correlationId: string,
    now: number = Date.now(),
  ): Result<TaskSession, MediatorError> {
    if (!this._session) {
      return err(
        makeMediatorError(ErrorCode.INVALID_STATE_TRANSITION, 'No active session to fail-safe', {
          correlationId,
        }),
      );
    }
    return this.transition({ to: TaskState.FAILED_SAFE, correlationId, reason, actor: 'orchestrator' }, now);
  }
}

export { ALLOWED_TRANSITIONS };
