/**
 * @mediator/orchestrator — Loop Guard & Resource Budget Service (S24/S25)
 *
 * Requirements:
 * - Enforces strict resource budgets and termination guards:
 *   1. Maximum transitions per task.
 *   2. Maximum rounds per task.
 *   3. Maximum validation failures.
 *   4. Maximum task duration (monotonic elapsed check).
 *   5. Maximum actions per task.
 *   6. Maximum total input/context bytes.
 *   7. Maximum feedback, diff, and output byte limits.
 *   8. Loop detection: repeated identical payload hashes without state progress.
 *   9. Repeated error stop: trips after repeated identical failures.
 *   10. Durable persistence: tracker state can be exported and rehydrated across restarts.
 *   11. Strict immutability: AI/provider outputs cannot increase budgets.
 */

import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
  type OrchestrationState,
  type WorkflowBudgetConfig,
  DEFAULT_WORKFLOW_BUDGET_CONFIG,
} from '@mediator/shared-contracts';

export interface TaskBudgetTracker {
  transitionCount: number;
  roundCount: number;
  actionCount: number;
  validationFailureCount: number;
  totalInputBytes: number;
  recentPayloadHashes: string[];
  recentErrors: string[];
  lastState: OrchestrationState;
  startedAt: number;
  elapsedMs: number;
}

export class WorkflowBudgetGuard {
  private readonly config: WorkflowBudgetConfig;
  private readonly trackers: Map<string, TaskBudgetTracker> = new Map();

  public constructor(config?: Partial<WorkflowBudgetConfig>) {
    this.config = {
      ...DEFAULT_WORKFLOW_BUDGET_CONFIG,
      ...config,
    };
  }

  public getConfig(): WorkflowBudgetConfig {
    return { ...this.config };
  }

  public getTracker(taskId: string): TaskBudgetTracker {
    let tracker = this.trackers.get(taskId);
    if (!tracker) {
      tracker = {
        transitionCount: 0,
        roundCount: 0,
        actionCount: 0,
        validationFailureCount: 0,
        totalInputBytes: 0,
        recentPayloadHashes: [],
        recentErrors: [],
        lastState: 'idle',
        startedAt: Date.now(),
        elapsedMs: 0,
      };
      this.trackers.set(taskId, tracker);
    }
    return tracker;
  }

  /**
   * Records a workflow state transition and enforces transition limits and no-progress loops.
   */
  public recordTransition(
    taskId: string,
    toState: OrchestrationState,
    payloadHash?: string,
  ): Result<void, MediatorError> {
    const tracker = this.getTracker(taskId);
    tracker.transitionCount++;

    // 1. Duration check
    const currentDuration = Date.now() - tracker.startedAt + tracker.elapsedMs;
    const maxDuration = this.config.maxTaskDurationMs ?? 1800000;
    if (currentDuration > maxDuration) {
      return err(
        makeMediatorError(
          ErrorCode.WORKFLOW_BUDGET_EXCEEDED,
          `Task "${taskId}" exceeded maximum duration budget (${currentDuration}ms > ${maxDuration}ms). Workflow halted.`,
          { taskId },
        ),
      );
    }

    // 2. Transition count check
    if (tracker.transitionCount > this.config.maxTransitionsPerTask) {
      return err(
        makeMediatorError(
          ErrorCode.WORKFLOW_BUDGET_EXCEEDED,
          `Task "${taskId}" exceeded maximum transition limit (${tracker.transitionCount} > ${this.config.maxTransitionsPerTask}). Workflow halted.`,
          { taskId },
        ),
      );
    }

    // 3. Payload hash loop check
    if (payloadHash) {
      tracker.recentPayloadHashes.push(payloadHash);
      if (tracker.recentPayloadHashes.length > 5) {
        tracker.recentPayloadHashes.shift();
      }

      // If last 3 hashes are identical and state didn't change progression
      const last3 = tracker.recentPayloadHashes.slice(-3);
      if (last3.length === 3 && last3.every((h) => h === payloadHash) && tracker.lastState === toState) {
        return err(
          makeMediatorError(
            ErrorCode.WORKFLOW_LOOP_DETECTED,
            `Task "${taskId}" detected repeated identical payload loop without progression. Workflow halted.`,
            { taskId },
          ),
        );
      }
    }

    tracker.lastState = toState;
    return ok(undefined);
  }

  /**
   * Records a new AI interaction round and enforces max rounds per task.
   */
  public recordRound(taskId: string): Result<void, MediatorError> {
    const tracker = this.getTracker(taskId);
    tracker.roundCount++;

    if (tracker.roundCount > this.config.maxRoundsPerTask) {
      return err(
        makeMediatorError(
          ErrorCode.WORKFLOW_BUDGET_EXCEEDED,
          `Task "${taskId}" exceeded maximum round limit (${tracker.roundCount} > ${this.config.maxRoundsPerTask}). Workflow halted.`,
          { taskId },
        ),
      );
    }

    return ok(undefined);
  }

  /**
   * Records proposed actions and enforces maximum action count per task.
   */
  public recordActions(taskId: string, count: number): Result<void, MediatorError> {
    const tracker = this.getTracker(taskId);
    tracker.actionCount += count;

    const maxActions = this.config.maxActionsPerTask ?? 20;
    if (tracker.actionCount > maxActions) {
      return err(
        makeMediatorError(
          ErrorCode.WORKFLOW_BUDGET_EXCEEDED,
          `Task "${taskId}" exceeded maximum actions limit (${tracker.actionCount} > ${maxActions}). Workflow halted.`,
          { taskId },
        ),
      );
    }

    return ok(undefined);
  }

  /**
   * Records input bytes (context/packet) and enforces total input byte limit.
   */
  public recordInputBytes(taskId: string, byteLength: number): Result<void, MediatorError> {
    const tracker = this.getTracker(taskId);
    tracker.totalInputBytes += byteLength;

    const maxInput = this.config.maxTotalInputBytes ?? 1048576;
    if (tracker.totalInputBytes > maxInput) {
      return err(
        makeMediatorError(
          ErrorCode.OVERSIZED_INPUT,
          `Task "${taskId}" exceeded total input byte budget (${tracker.totalInputBytes} > ${maxInput} bytes).`,
          { taskId },
        ),
      );
    }

    return ok(undefined);
  }

  /**
   * Records a validation failure and trips when failure threshold is reached.
   */
  public recordValidationFailure(taskId: string): Result<void, MediatorError> {
    const tracker = this.getTracker(taskId);
    tracker.validationFailureCount++;

    if (tracker.validationFailureCount > this.config.maxValidationFailures) {
      return err(
        makeMediatorError(
          ErrorCode.WORKFLOW_BUDGET_EXCEEDED,
          `Task "${taskId}" exceeded maximum validation failures (${tracker.validationFailureCount} > ${this.config.maxValidationFailures}).`,
          { taskId },
        ),
      );
    }

    return ok(undefined);
  }

  /**
   * Records an error event and trips if repeated identical errors occur.
   */
  public recordError(taskId: string, errorCode: string): Result<void, MediatorError> {
    const tracker = this.getTracker(taskId);
    tracker.recentErrors.push(errorCode);
    if (tracker.recentErrors.length > 5) {
      tracker.recentErrors.shift();
    }

    const maxRepeated = this.config.maxRepeatedErrors ?? 3;
    const lastN = tracker.recentErrors.slice(-maxRepeated);
    if (lastN.length === maxRepeated && lastN.every((e) => e === errorCode)) {
      return err(
        makeMediatorError(
          ErrorCode.WORKFLOW_LOOP_DETECTED,
          `Task "${taskId}" detected repeated error "${errorCode}" (${maxRepeated} times). Workflow halted.`,
          { taskId },
        ),
      );
    }

    return ok(undefined);
  }

  /**
   * Enforces feedback and diff size constraints.
   */
  public checkByteBudgets(feedbackBytes: number, diffBytes: number): Result<void, MediatorError> {
    if (feedbackBytes > this.config.maxFeedbackBytes) {
      return err(
        makeMediatorError(
          ErrorCode.OVERSIZED_INPUT,
          `Feedback size (${feedbackBytes} bytes) exceeds maximum budget of ${this.config.maxFeedbackBytes} bytes.`,
        ),
      );
    }

    if (diffBytes > this.config.maxDiffBytes) {
      return err(
        makeMediatorError(
          ErrorCode.OVERSIZED_INPUT,
          `Diff size (${diffBytes} bytes) exceeds maximum budget of ${this.config.maxDiffBytes} bytes.`,
        ),
      );
    }

    return ok(undefined);
  }

  /**
   * Enforces debug bundle size limits.
   */
  public checkDebugBundleSize(bundleBytes: number): Result<void, MediatorError> {
    const maxBundle = this.config.maxDebugBundleBytes ?? 524288;
    if (bundleBytes > maxBundle) {
      return err(
        makeMediatorError(
          ErrorCode.DEBUG_BUNDLE_OVERSIZED,
          `Debug bundle size (${bundleBytes} bytes) exceeds maximum allowed size of ${maxBundle} bytes.`,
        ),
      );
    }
    return ok(undefined);
  }

  /**
   * Export tracker state for durable persistence across restarts.
   */
  public exportState(taskId: string): Record<string, unknown> | null {
    const tracker = this.trackers.get(taskId);
    if (!tracker) return null;
    return {
      transitionCount: tracker.transitionCount,
      roundCount: tracker.roundCount,
      actionCount: tracker.actionCount,
      validationFailureCount: tracker.validationFailureCount,
      totalInputBytes: tracker.totalInputBytes,
      recentPayloadHashes: [...tracker.recentPayloadHashes],
      recentErrors: [...tracker.recentErrors],
      lastState: tracker.lastState,
      elapsedMs: Date.now() - tracker.startedAt + tracker.elapsedMs,
    };
  }

  /**
   * Hydrate tracker state after a process restart so counters persist.
   */
  public importState(taskId: string, state: Record<string, unknown>): void {
    this.trackers.set(taskId, {
      transitionCount: typeof state['transitionCount'] === 'number' ? state['transitionCount'] : 0,
      roundCount: typeof state['roundCount'] === 'number' ? state['roundCount'] : 0,
      actionCount: typeof state['actionCount'] === 'number' ? state['actionCount'] : 0,
      validationFailureCount: typeof state['validationFailureCount'] === 'number' ? state['validationFailureCount'] : 0,
      totalInputBytes: typeof state['totalInputBytes'] === 'number' ? state['totalInputBytes'] : 0,
      recentPayloadHashes: Array.isArray(state['recentPayloadHashes']) ? (state['recentPayloadHashes'] as string[]) : [],
      recentErrors: Array.isArray(state['recentErrors']) ? (state['recentErrors'] as string[]) : [],
      lastState: typeof state['lastState'] === 'string' ? (state['lastState'] as OrchestrationState) : 'idle',
      startedAt: Date.now(),
      elapsedMs: typeof state['elapsedMs'] === 'number' ? state['elapsedMs'] : 0,
    });
  }

  public resetTask(taskId: string): void {
    this.trackers.delete(taskId);
  }
}
