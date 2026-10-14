/**
 * @mediator/context-engine — Compact Task Summaries (S11)
 *
 * Requirements:
 * - Persists rolling task state: goal, criteria, state, latest round, plan,
 *   next action, files examined/changed, test exit codes, blockers, decisions.
 * - Enforces strict evidence distinction:
 *   - agent-reported (never elevated to verified)
 *   - mediator-observed
 *   - executor-verified
 * - Never stores raw conversation bodies or page dumps.
 * - Deterministic, stable serialization.
 * - Malformed or incomplete stored summaries fail safely.
 */

import { TaskState, type TaskStateValue } from '@mediator/shared-contracts';
import { type ClassifiedEvidence } from '@mediator/policy-engine';
import { safeRedactString } from '@mediator/persistence';

export interface TestExecutionRecord {
  readonly command: string;
  readonly exitCode: number;
  readonly passed: boolean;
  readonly verifiedBy: 'mediator' | 'executor';
}

export interface StructuredEvidenceStore {
  readonly agentReported: readonly string[];
  readonly mediatorObserved: readonly string[];
  readonly executorVerified: readonly string[];
}

export interface TaskSummary {
  readonly taskId: string;
  readonly originalUserGoal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly taskState: TaskStateValue;
  readonly latestAcceptedRound: number;
  readonly approvedPlan?: string | undefined;
  readonly nextExpectedAction?: string | undefined;
  readonly filesExamined: readonly string[];
  readonly filesChanged: readonly string[];
  readonly testExecutions: readonly TestExecutionRecord[];
  readonly evidence: StructuredEvidenceStore;
  readonly blockers: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly relevantDecisions: readonly string[];
  readonly latestKnownSafeRecoveryState: string;
  readonly updatedAt: number;
}

export interface CreateTaskSummaryParams {
  readonly taskId: string;
  readonly originalUserGoal: string;
  readonly acceptanceCriteria?: readonly string[] | undefined;
  readonly taskState?: TaskStateValue | undefined;
  readonly latestAcceptedRound?: number | undefined;
  readonly approvedPlan?: string | undefined;
  readonly nextExpectedAction?: string | undefined;
  readonly filesExamined?: readonly string[] | undefined;
  readonly filesChanged?: readonly string[] | undefined;
  readonly testExecutions?: readonly TestExecutionRecord[] | undefined;
  readonly blockers?: readonly string[] | undefined;
  readonly unresolvedQuestions?: readonly string[] | undefined;
  readonly relevantDecisions?: readonly string[] | undefined;
  readonly latestKnownSafeRecoveryState?: string | undefined;
  readonly updatedAt?: number | undefined;
}

export function createInitialTaskSummary(params: CreateTaskSummaryParams): TaskSummary {
  return {
    taskId: params.taskId,
    originalUserGoal: safeRedactString(params.originalUserGoal.trim()),
    acceptanceCriteria: (params.acceptanceCriteria ?? []).map((c) => safeRedactString(c.trim())),
    taskState: params.taskState ?? TaskState.TASK_DEFINED,
    latestAcceptedRound: params.latestAcceptedRound ?? 0,
    approvedPlan: params.approvedPlan ? safeRedactString(params.approvedPlan.trim()) : undefined,
    nextExpectedAction: params.nextExpectedAction
      ? safeRedactString(params.nextExpectedAction.trim())
      : undefined,
    filesExamined: params.filesExamined ?? [],
    filesChanged: params.filesChanged ?? [],
    testExecutions: params.testExecutions ?? [],
    evidence: {
      agentReported: [],
      mediatorObserved: [],
      executorVerified: [],
    },
    blockers: (params.blockers ?? []).map((b) => safeRedactString(b.trim())),
    unresolvedQuestions: (params.unresolvedQuestions ?? []).map((q) =>
      safeRedactString(q.trim()),
    ),
    relevantDecisions: params.relevantDecisions ?? [],
    latestKnownSafeRecoveryState:
      params.latestKnownSafeRecoveryState ?? 'initial_safe_checkpoint',
    updatedAt: params.updatedAt ?? Date.now(),
  };
}

/**
 * Ingest evidence while preserving strict separation of evidence levels.
 * CRITICAL INVARIANT: Agent-reported claims are NEVER elevated to verified evidence.
 */
export function addEvidenceToTaskSummary(
  summary: TaskSummary,
  evidence: ClassifiedEvidence | { level: 'agent-reported' | 'mediator-observed' | 'executor-verified'; summary: string },
): TaskSummary {
  const level = 'evidenceLevel' in evidence ? evidence.evidenceLevel : evidence.level;
  const rawSummary = 'summary' in evidence ? evidence.summary : String(evidence);
  const cleanSummary = safeRedactString(rawSummary.trim());

  const current = summary.evidence;
  const agentReported = [...current.agentReported];
  const mediatorObserved = [...current.mediatorObserved];
  const executorVerified = [...current.executorVerified];

  if (level === 'executor-verified') {
    if (!executorVerified.includes(cleanSummary)) {
      executorVerified.push(cleanSummary);
    }
  } else if (level === 'mediator-observed') {
    if (!mediatorObserved.includes(cleanSummary)) {
      mediatorObserved.push(cleanSummary);
    }
  } else {
    // 'agent-reported' — strictly unverified
    if (!agentReported.includes(cleanSummary)) {
      agentReported.push(cleanSummary);
    }
  }

  return {
    ...summary,
    evidence: {
      agentReported,
      mediatorObserved,
      executorVerified,
    },
    updatedAt: Date.now(),
  };
}

/**
 * Deterministic JSON serialization of TaskSummary.
 */
export function serializeTaskSummary(summary: TaskSummary): string {
  // Sort and canonicalize fields to guarantee stable serialization
  const canonicalObject = {
    taskId: summary.taskId,
    originalUserGoal: summary.originalUserGoal,
    acceptanceCriteria: [...summary.acceptanceCriteria].sort(),
    taskState: summary.taskState,
    latestAcceptedRound: summary.latestAcceptedRound,
    approvedPlan: summary.approvedPlan ?? null,
    nextExpectedAction: summary.nextExpectedAction ?? null,
    filesExamined: [...summary.filesExamined].sort(),
    filesChanged: [...summary.filesChanged].sort(),
    testExecutions: [...summary.testExecutions].map((t) => ({
      command: t.command,
      exitCode: t.exitCode,
      passed: t.passed,
      verifiedBy: t.verifiedBy,
    })),
    evidence: {
      agentReported: [...summary.evidence.agentReported],
      mediatorObserved: [...summary.evidence.mediatorObserved],
      executorVerified: [...summary.evidence.executorVerified],
    },
    blockers: [...summary.blockers].sort(),
    unresolvedQuestions: [...summary.unresolvedQuestions].sort(),
    relevantDecisions: [...summary.relevantDecisions].sort(),
    latestKnownSafeRecoveryState: summary.latestKnownSafeRecoveryState,
    updatedAt: summary.updatedAt,
  };

  return JSON.stringify(canonicalObject, null, 2);
}

/**
 * Safe deserialization that never throws on malformed or incomplete data.
 */
export function deserializeTaskSummary(
  serialized: string,
  fallbackTaskId = 'unknown-task',
): TaskSummary {
  try {
    if (!serialized || typeof serialized !== 'string' || serialized.trim().length === 0) {
      return createInitialTaskSummary({
        taskId: fallbackTaskId,
        originalUserGoal: 'Recovery: empty or missing stored summary',
        latestKnownSafeRecoveryState: 'recovery_empty_summary',
      });
    }

    const rawParsed: unknown = JSON.parse(serialized);
    if (typeof rawParsed !== 'object' || rawParsed === null) {
      return createInitialTaskSummary({
        taskId: fallbackTaskId,
        originalUserGoal: 'Recovery: non-object stored summary',
        latestKnownSafeRecoveryState: 'recovery_non_object_summary',
      });
    }

    const parsed = rawParsed as Record<string, unknown>;

    const taskId = typeof parsed.taskId === 'string' ? parsed.taskId : fallbackTaskId;
    const goal =
      typeof parsed.originalUserGoal === 'string'
        ? parsed.originalUserGoal
        : 'Recovered task (unspecified goal)';
    const criteria = Array.isArray(parsed.acceptanceCriteria)
      ? parsed.acceptanceCriteria.filter((c: unknown): c is string => typeof c === 'string')
      : [];
    const state: TaskStateValue =
      typeof parsed.taskState === 'string' &&
      Object.values(TaskState).includes(parsed.taskState as TaskStateValue)
        ? (parsed.taskState as TaskStateValue)
        : TaskState.PAUSED;

    const round = typeof parsed.latestAcceptedRound === 'number' ? parsed.latestAcceptedRound : 0;
    const plan = typeof parsed.approvedPlan === 'string' ? parsed.approvedPlan : undefined;
    const nextAction =
      typeof parsed.nextExpectedAction === 'string' ? parsed.nextExpectedAction : undefined;

    const filesExamined = Array.isArray(parsed.filesExamined)
      ? parsed.filesExamined.filter((f: unknown): f is string => typeof f === 'string')
      : [];
    const filesChanged = Array.isArray(parsed.filesChanged)
      ? parsed.filesChanged.filter((f: unknown): f is string => typeof f === 'string')
      : [];

    const testExecutions: TestExecutionRecord[] = [];
    if (Array.isArray(parsed.testExecutions)) {
      for (const item of parsed.testExecutions) {
        if (item && typeof item === 'object') {
          const t = item as Record<string, unknown>;
          if (typeof t.command === 'string') {
            testExecutions.push({
              command: t.command,
              exitCode: typeof t.exitCode === 'number' ? t.exitCode : 0,
              passed: Boolean(t.passed),
              verifiedBy: t.verifiedBy === 'executor' ? 'executor' : 'mediator',
            });
          }
        }
      }
    }

    const rawEvidence =
      parsed.evidence && typeof parsed.evidence === 'object'
        ? (parsed.evidence as Record<string, unknown>)
        : {};
    const agentReported = Array.isArray(rawEvidence.agentReported)
      ? rawEvidence.agentReported.filter((e: unknown): e is string => typeof e === 'string')
      : [];
    const mediatorObserved = Array.isArray(rawEvidence.mediatorObserved)
      ? rawEvidence.mediatorObserved.filter((e: unknown): e is string => typeof e === 'string')
      : [];
    const executorVerified = Array.isArray(rawEvidence.executorVerified)
      ? rawEvidence.executorVerified.filter((e: unknown): e is string => typeof e === 'string')
      : [];

    const blockers = Array.isArray(parsed.blockers)
      ? parsed.blockers.filter((b: unknown): b is string => typeof b === 'string')
      : [];
    const unresolvedQuestions = Array.isArray(parsed.unresolvedQuestions)
      ? parsed.unresolvedQuestions.filter((q: unknown): q is string => typeof q === 'string')
      : [];
    const relevantDecisions = Array.isArray(parsed.relevantDecisions)
      ? parsed.relevantDecisions.filter((d: unknown): d is string => typeof d === 'string')
      : [];
    const recoveryState =
      typeof parsed.latestKnownSafeRecoveryState === 'string'
        ? parsed.latestKnownSafeRecoveryState
        : 'recovered_fallback_checkpoint';
    const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now();

    return {
      taskId,
      originalUserGoal: goal,
      acceptanceCriteria: criteria,
      taskState: state,
      latestAcceptedRound: round,
      approvedPlan: plan,
      nextExpectedAction: nextAction,
      filesExamined,
      filesChanged,
      testExecutions,
      evidence: {
        agentReported,
        mediatorObserved,
        executorVerified,
      },
      blockers,
      unresolvedQuestions,
      relevantDecisions,
      latestKnownSafeRecoveryState: recoveryState,
      updatedAt,
    };
  } catch {
    // Malformed JSON fails safely into initialized recovery summary
    return createInitialTaskSummary({
      taskId: fallbackTaskId,
      originalUserGoal: 'Recovery: malformed summary parse error',
      taskState: TaskState.PAUSED,
      latestKnownSafeRecoveryState: 'recovery_malformed_json_fallback',
    });
  }
}
