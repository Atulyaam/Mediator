import { describe, it, expect, beforeEach } from 'vitest';
import {
  OrchestratorRecoveryService,
  WorkflowBudgetGuard,
  ContextCompactor,
  DebugBundleService,
  CorrelationTimelineService,
} from './index.js';
import {
  S00ExecutionDecisionValues,
  type ConversationIdentity,
  ErrorCode,
} from '@mediator/shared-contracts';

describe('Sprint S25 — Recovery, Loop Guard, Observability & Context Compaction', () => {
  const workspaceRoot = 'C:\\workspace\\test-project';
  const taskId = 'task-s25-01';
  const sessionId = 'session-s25-01';
  const correlationId = 'corr-s25-01';
  const defaultConversation: ConversationIdentity = {
    provider: 'google-gemini',
    conversationId: 'conv-s25-alpha',
    tabId: 101,
  };

  let recoveryService: OrchestratorRecoveryService;
  let budgetGuard: WorkflowBudgetGuard;
  let compactor: ContextCompactor;
  let debugBundleService: DebugBundleService;
  let timelineService: CorrelationTimelineService;

  beforeEach(() => {
    recoveryService = new OrchestratorRecoveryService();
    budgetGuard = new WorkflowBudgetGuard();
    compactor = new ContextCompactor();
    debugBundleService = new DebugBundleService();
    timelineService = new CorrelationTimelineService();
  });

  describe('1. Startup Reconciliation & Unknown Action Non-Replay', () => {
    it('1. clean startup with no recovery required', () => {
      const report = recoveryService.reconcileStartup({
        workspaceRoot,
        taskId,
        sessionId,
        correlationId,
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
        activeConversation: defaultConversation,
        expectedConversation: defaultConversation,
        rawActions: [],
      });

      expect(report.status).toBe('recovery-not-required');
      expect(report.canSafeResume).toBe(true);
      expect(report.unknownActions).toHaveLength(0);
      expect(report.safeResumeBlockers).toHaveLength(0);
    });

    it('2. in-flight action with unknown completion is marked unknown and NEVER replayed', () => {
      const report = recoveryService.reconcileStartup({
        workspaceRoot,
        taskId,
        sessionId,
        correlationId,
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
        activeConversation: defaultConversation,
        expectedConversation: defaultConversation,
        rawActions: [
          { actionId: 'act-001', type: 'propose_patch', status: 'completed' },
          { actionId: 'act-002', type: 'request_recipe_run', status: 'in-flight' },
        ],
      });

      expect(report.status).toBe('unknown-completion');
      expect(report.canSafeResume).toBe(false);
      expect(report.unknownActions).toHaveLength(1);
      expect(report.unknownActions[0]?.actionId).toBe('act-002');
      expect(report.unknownActions[0]?.status).toBe('unknown');
      expect(report.safeResumeBlockers.some((b) => b.includes('cannot be replayed automatically'))).toBe(true);
    });

    it('3. restart with an expired approval is flagged and blocks resume', () => {
      const report = recoveryService.reconcileStartup({
        workspaceRoot,
        taskId,
        sessionId,
        correlationId,
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
        activeConversation: defaultConversation,
        expectedConversation: defaultConversation,
        pendingApproval: {
          approvalId: 'app-old',
          expiresAt: Date.now() - 5000, // expired 5s ago
          payloadHash: 'hash-abc',
          consumed: false,
        },
      });

      expect(report.status).toBe('recovery-required');
      expect(report.canSafeResume).toBe(false);
      expect(report.expiredApprovalsCount).toBe(1);
      expect(report.safeResumeBlockers.some((b) => b.includes('expired at'))).toBe(true);
    });

    it('4. restart with an already consumed approval is rejected', () => {
      const report = recoveryService.reconcileStartup({
        workspaceRoot,
        taskId,
        sessionId,
        correlationId,
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
        activeConversation: defaultConversation,
        expectedConversation: defaultConversation,
        pendingApproval: {
          approvalId: 'app-consumed',
          expiresAt: Date.now() + 60000,
          payloadHash: 'hash-abc',
          consumed: true,
        },
      });

      expect(report.status).toBe('paused-for-user');
      expect(report.canSafeResume).toBe(false);
      expect(report.safeResumeBlockers.some((b) => b.includes('already consumed'))).toBe(true);
    });

    it('5. conversation identity mismatch pauses resume safely', () => {
      const report = recoveryService.reconcileStartup({
        workspaceRoot,
        taskId,
        sessionId,
        correlationId,
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
        activeConversation: { provider: 'google-gemini', conversationId: 'conv-other-tab', tabId: 999 },
        expectedConversation: defaultConversation,
      });

      expect(report.status).toBe('recovery-required');
      expect(report.conversationIdentityVerified).toBe(false);
      expect(report.canSafeResume).toBe(false);
    });

    it('6. stale capability evidence (> 24h) flags capability invalid', () => {
      const report = recoveryService.reconcileStartup({
        workspaceRoot,
        taskId,
        sessionId,
        correlationId,
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
        activeConversation: defaultConversation,
        expectedConversation: defaultConversation,
        capabilityFreshnessTimestamp: Date.now() - 90000000, // 25h old
      });

      expect(report.status).toBe('recovery-required');
      expect(report.capabilityStatusValid).toBe(false);
      expect(report.safeResumeBlockers.some((b) => b.includes('evidence is stale'))).toBe(true);
    });

    it('7. resume without reconciliation is rejected fail-closed', () => {
      const res = recoveryService.requestSafeResume({
        taskId: 'unreconciled-task',
        sessionId,
        correlationId,
        explicitUserConfirmation: true,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.RECOVERY_RECONCILIATION_REQUIRED);
      }
    });

    it('8. resume without explicit user confirmation is rejected', () => {
      recoveryService.reconcileStartup({
        workspaceRoot,
        taskId,
        sessionId,
        correlationId,
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
        activeConversation: defaultConversation,
        expectedConversation: defaultConversation,
      });

      const res = recoveryService.requestSafeResume({
        taskId,
        sessionId,
        correlationId,
        explicitUserConfirmation: false,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.APPROVAL_REQUIRED);
      }
    });

    it('9. resume with unresolved unknown actions is refused', () => {
      recoveryService.reconcileStartup({
        workspaceRoot,
        taskId,
        sessionId,
        correlationId,
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
        activeConversation: defaultConversation,
        expectedConversation: defaultConversation,
        rawActions: [{ actionId: 'act-unknown', type: 'request_recipe_run', status: 'unknown' }],
      });

      const res = recoveryService.requestSafeResume({
        taskId,
        sessionId,
        correlationId,
        resolvedActionIds: [], // Did not resolve act-unknown
        explicitUserConfirmation: true,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.RECOVERY_ACTION_UNKNOWN);
      }
    });

    it('10. resume succeeds once user acknowledges/resolves unknown action', () => {
      recoveryService.reconcileStartup({
        workspaceRoot,
        taskId,
        sessionId,
        correlationId,
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
        activeConversation: defaultConversation,
        expectedConversation: defaultConversation,
        rawActions: [{ actionId: 'act-unknown', type: 'request_recipe_run', status: 'unknown' }],
      });

      const res = recoveryService.requestSafeResume({
        taskId,
        sessionId,
        correlationId,
        resolvedActionIds: ['act-unknown'],
        explicitUserConfirmation: true,
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.status).toBe('recovered');
        expect(res.value.canSafeResume).toBe(true);
      }
    });
  });

  describe('2. Persistent Budgets, Loop Guards & Duration Caps', () => {
    it('11. budget counters persist across process restarts via export/import', () => {
      const guard1 = new WorkflowBudgetGuard({ maxTransitionsPerTask: 10 });
      guard1.recordTransition(taskId, 'response-received');
      guard1.recordTransition(taskId, 'protocol-validating');
      guard1.recordRound(taskId);
      guard1.recordActions(taskId, 4);

      const exported = guard1.exportState(taskId);
      expect(exported).not.toBeNull();
      expect(exported?.['transitionCount']).toBe(2);
      expect(exported?.['roundCount']).toBe(1);
      expect(exported?.['actionCount']).toBe(4);

      // Rehydrate in new guard instance (simulating restart)
      const guard2 = new WorkflowBudgetGuard({ maxTransitionsPerTask: 10 });
      guard2.importState(taskId, exported!);

      const tracker2 = guard2.getTracker(taskId);
      expect(tracker2.transitionCount).toBe(2);
      expect(tracker2.roundCount).toBe(1);
      expect(tracker2.actionCount).toBe(4);

      // Subsequent transitions count from restored baseline
      guard2.recordTransition(taskId, 'policy-review');
      expect(guard2.getTracker(taskId).transitionCount).toBe(3);
    });

    it('12. maximum rounds per task is strictly enforced', () => {
      const guard = new WorkflowBudgetGuard({ maxRoundsPerTask: 3 });
      expect(guard.recordRound(taskId).ok).toBe(true);
      expect(guard.recordRound(taskId).ok).toBe(true);
      expect(guard.recordRound(taskId).ok).toBe(true);

      const fourth = guard.recordRound(taskId);
      expect(fourth.ok).toBe(false);
      if (!fourth.ok) {
        expect(fourth.error.code).toBe(ErrorCode.WORKFLOW_BUDGET_EXCEEDED);
      }
    });

    it('13. maximum actions per task is strictly enforced', () => {
      const guard = new WorkflowBudgetGuard({ maxActionsPerTask: 5 });
      expect(guard.recordActions(taskId, 3).ok).toBe(true);
      expect(guard.recordActions(taskId, 2).ok).toBe(true);

      const excess = guard.recordActions(taskId, 1);
      expect(excess.ok).toBe(false);
      if (!excess.ok) {
        expect(excess.error.code).toBe(ErrorCode.WORKFLOW_BUDGET_EXCEEDED);
      }
    });

    it('14. maximum total input bytes is strictly enforced', () => {
      const guard = new WorkflowBudgetGuard({ maxTotalInputBytes: 1000 });
      expect(guard.recordInputBytes(taskId, 500).ok).toBe(true);
      expect(guard.recordInputBytes(taskId, 400).ok).toBe(true);

      const excess = guard.recordInputBytes(taskId, 200);
      expect(excess.ok).toBe(false);
      if (!excess.ok) {
        expect(excess.error.code).toBe(ErrorCode.OVERSIZED_INPUT);
      }
    });

    it('15. repeated identical errors trigger loop guard trip', () => {
      const guard = new WorkflowBudgetGuard({ maxRepeatedErrors: 3 });
      expect(guard.recordError(taskId, 'STAGE_CONFLICT').ok).toBe(true);
      expect(guard.recordError(taskId, 'STAGE_CONFLICT').ok).toBe(true);

      const trip = guard.recordError(taskId, 'STAGE_CONFLICT');
      expect(trip.ok).toBe(false);
      if (!trip.ok) {
        expect(trip.error.code).toBe(ErrorCode.WORKFLOW_LOOP_DETECTED);
      }
    });

    it('16. task duration budget trips when elapsed time exceeds cap', () => {
      const guard = new WorkflowBudgetGuard({ maxTaskDurationMs: 100 });
      const tracker = guard.getTracker(taskId);
      // Simulate that task started in the past
      tracker.startedAt = Date.now() - 500;

      const res = guard.recordTransition(taskId, 'response-received');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.WORKFLOW_BUDGET_EXCEEDED);
      }
    });
  });

  describe('3. Context Compaction & Indicators', () => {
    it('17. compaction preserves goal, acceptance criteria, and produces indicators', () => {
      const summary = compactor.compactTaskState({
        taskId,
        sessionId,
        goal: 'Refactor user profile component',
        acceptanceCriteria: ['Pass lint', 'Pass typecheck'],
        round: 1,
        stageId: 'stage-01',
        changedFilePaths: ['src/userProfile.ts', 'src/userProfile.test.ts'],
        policyApprovalState: 'approved',
        verificationSummary: {
          taskId,
          totalChecks: 2,
          passedChecks: 2,
          failedChecks: 0,
          blockedChecks: 0,
          evidenceRecords: [],
          overallStatus: 'fully-verified',
          automatedExecutionBlocked: true,
          s00Decision: 'NO-GO-AUTOEXEC',
        },
      });

      expect(summary.goal).toBe('Refactor user profile component');
      expect(summary.acceptanceCriteria).toHaveLength(2);
      expect(summary.indicators.packetBytes).toBeGreaterThan(0);
      expect(summary.indicators.estimatedTokens).toBeGreaterThan(0);
      expect(summary.indicators.selectedExcerptsCount).toBe(2);
      expect(summary.indicators.repetitionRatio).toBe(0);
    });

    it('18. compaction NEVER drops unknown-completion facts or security blockers', () => {
      const summary = compactor.compactTaskState({
        taskId,
        sessionId,
        goal: 'Test unknown action retention',
        round: 2,
        stageId: 'stage-02',
        changedFilePaths: [],
        policyApprovalState: 'pending',
        unknownActions: ['act-pending-shell'],
        verificationSummary: {
          taskId,
          totalChecks: 1,
          passedChecks: 0,
          failedChecks: 0,
          blockedChecks: 1,
          evidenceRecords: [],
          overallStatus: 'blocked',
          automatedExecutionBlocked: true,
          s00Decision: 'NO-GO-AUTOEXEC',
        },
      });

      expect(summary.blockers.some((b) => b.includes('act-pending-shell'))).toBe(true);
      expect(summary.blockers.some((b) => b.includes('NO-GO-AUTOEXEC'))).toBe(true);
    });

    it('19. secret values are redacted during compaction and tracked in indicators', () => {
      const summary = compactor.compactTaskState({
        taskId,
        sessionId,
        goal: 'Configure API key sk-proj-1234567890abcdef12345678 for tests',
        round: 1,
        stageId: 'stage-03',
        changedFilePaths: ['src/config.ts'],
        policyApprovalState: 'review',
        verificationSummary: {
          taskId,
          totalChecks: 0,
          passedChecks: 0,
          failedChecks: 0,
          blockedChecks: 0,
          evidenceRecords: [],
          overallStatus: 'unverified',
          automatedExecutionBlocked: true,
          s00Decision: 'NO-GO-AUTOEXEC',
        },
      });

      expect(summary.goal).not.toContain('sk-proj-1234567890abcdef12345678');
      expect(summary.goal).toContain('[REDACTED:OPENAI_KEY]');
      expect(summary.indicators.redactionCount).toBeGreaterThan(0);
    });

    it('20. repetition ratio increments when identical files are repeated in subsequent rounds', () => {
      // Round 1
      compactor.compactTaskState({
        taskId: 'rep-task',
        sessionId,
        goal: 'Round 1',
        round: 1,
        stageId: 'stage-1',
        changedFilePaths: ['src/foo.ts', 'src/bar.ts'],
        policyApprovalState: 'review',
        verificationSummary: { taskId: 'rep-task', totalChecks: 0, passedChecks: 0, failedChecks: 0, blockedChecks: 0, evidenceRecords: [], overallStatus: 'unverified', automatedExecutionBlocked: true, s00Decision: 'NO-GO-AUTOEXEC' },
      });

      // Round 2 with same files
      const summary2 = compactor.compactTaskState({
        taskId: 'rep-task',
        sessionId,
        goal: 'Round 2',
        round: 2,
        stageId: 'stage-2',
        changedFilePaths: ['src/foo.ts', 'src/bar.ts'],
        policyApprovalState: 'review',
        verificationSummary: { taskId: 'rep-task', totalChecks: 0, passedChecks: 0, failedChecks: 0, blockedChecks: 0, evidenceRecords: [], overallStatus: 'unverified', automatedExecutionBlocked: true, s00Decision: 'NO-GO-AUTOEXEC' },
      });

      expect(summary2.indicators.repetitionRatio).toBe(1);
    });
  });

  describe('4. Redacted Debug Bundle & Correlation Timeline', () => {
    it('21. debug bundle export requires explicit user authorization', () => {
      const res = debugBundleService.generateBundle({
        explicitUserExportRequested: false,
        rawBundleData: {
          taskSessionSummary: { taskId },
          correlationTimeline: [],
          workflowHistory: [],
          typedErrors: [],
          recoveryDecisions: [],
          capabilityStatus: {},
          budgetCounters: {},
          recipeMetadata: [],
          actionSummaries: [],
          stagingSummary: {},
        },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.DEBUG_BUNDLE_EXPORT_REFUSED);
      }
    });

    it('22. debug bundle redacts sensitive tokens before export', () => {
      const res = debugBundleService.generateBundle({
        explicitUserExportRequested: true,
        rawBundleData: {
          taskSessionSummary: {
            taskId,
            apiKeyNote: 'Tested with key sk-proj-secret1234567890abcdef123',
          },
          correlationTimeline: [],
          workflowHistory: [],
          typedErrors: [],
          recoveryDecisions: [],
          capabilityStatus: {},
          budgetCounters: {},
          recipeMetadata: [],
          actionSummaries: [],
          stagingSummary: {},
        },
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.manifest.secretScanVerified).toBe(true);
        expect(JSON.stringify(res.value)).not.toContain('sk-proj-secret1234567890abcdef123');
      }
    });

    it('23. debug bundle enforces maximum size limit', () => {
      const largePayload = 'a'.repeat(2000);
      const res = debugBundleService.generateBundle({
        maxSizeBytes: 500, // Small limit
        explicitUserExportRequested: true,
        rawBundleData: {
          taskSessionSummary: { data: largePayload },
          correlationTimeline: [],
          workflowHistory: [],
          typedErrors: [],
          recoveryDecisions: [],
          capabilityStatus: {},
          budgetCounters: {},
          recipeMetadata: [],
          actionSummaries: [],
          stagingSummary: {},
        },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.DEBUG_BUNDLE_OVERSIZED);
      }
    });

    it('24. correlation timeline groups events and sanitizes metadata', () => {
      timelineService.recordEvent({
        correlationId: 'corr-01',
        taskId: 'task-01',
        sessionId: 'sess-01',
        eventType: 'ENVELOPE_VALIDATED',
        resultOrStatus: 'ok',
        metadata: { tokenUsed: 'Bearer sk-proj-sensitive987654321012345' },
      });

      timelineService.recordEvent({
        correlationId: 'corr-02',
        taskId: 'task-02',
        sessionId: 'sess-02',
        eventType: 'POLICY_EVALUATED',
        resultOrStatus: 'allowed',
      });

      const eventsTask01 = timelineService.getEventsByTaskId('task-01');
      expect(eventsTask01).toHaveLength(1);
      expect(eventsTask01[0]?.eventType).toBe('ENVELOPE_VALIDATED');
      expect(eventsTask01[0]?.metadata?.['tokenUsed']).toContain('[REDACTED:OPENAI_KEY]');

      const eventsTask02 = timelineService.getEventsByTaskId('task-02');
      expect(eventsTask02).toHaveLength(1);
      expect(eventsTask02[0]?.correlationId).toBe('corr-02');
    });
  });
});
