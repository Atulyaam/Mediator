import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovedExecutionPathService } from './approvedExecutionPath.js';
import { ExecutionAuthorizationGate } from './executionAuthorizationGate.js';
import {
  type ExecuteRecipeRequest,
  type CapabilityEvaluationReport,
  S00ExecutionDecisionValues,
  ErrorCode,
  type Result,
  type MediatorError,
} from '@mediator/shared-contracts';

function assertErr(result: Result<unknown, MediatorError>): MediatorError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected result.ok to be false');
  return result.error;
}

describe('Sprint S22 — Approved Execution Path & Authorization Gate', () => {
  let service: ApprovedExecutionPathService;
  let gate: ExecutionAuthorizationGate;
  let validReport: CapabilityEvaluationReport;
  let validRequest: ExecuteRecipeRequest;

  beforeEach(() => {
    gate = new ExecutionAuthorizationGate();
    service = new ApprovedExecutionPathService({
      s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
      authorizationGate: gate,
    });

    validReport = {
      result: 'eligible',
      isEligibleForAutoExec: true,
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      executorId: 'antigravity-sandbox',
      executorVersion: '1.0.0',
      evaluatedAt: Date.now(),
      passedRequirements: ['stageRootRead', 'liveWorkspaceWriteDenied'],
      failedRequirements: [],
      unverifiedRequirements: [],
      blockedReasons: [],
    };

    validRequest = {
      recipeId: 'project.test',
      recipeHash: 'hash-recipe-123',
      stageId: 'stage-1',
      workspaceRoot: 'C:/Project',
      taskId: 'task-1',
      sessionId: 'session-1',
      approvalId: 'appr-1',
      approvedPayloadHash: 'hash-recipe-123',
      correlationId: 'corr-1',
    };
  });

  it('1. NO-GO-AUTOEXEC exposes no executable backend and returns execution-unavailable', async () => {
    const resp = await service.executeRecipe(validRequest, {
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });

    expect(resp.success).toBe(false);
    expect(resp.status).toBe('execution-unavailable');
    expect(resp.errorCode).toBe(ErrorCode.EXECUTION_UNAVAILABLE);
    expect(resp.suggestedManualRecipe).toBeDefined();
    expect(resp.suggestedManualRecipe?.safeToRunManually).toBe(true);
  });

  it('2. missing S00 decision blocks execution', () => {
    const authResult = gate.authorize(validRequest, {
      s00Decision: undefined as any,
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(assertErr(authResult).code).toBe(ErrorCode.EXECUTION_UNAVAILABLE);
  });

  it('3. GO decision with unverified S21 evidence blocks execution', () => {
    const unverifiedReport: CapabilityEvaluationReport = {
      ...validReport,
      result: 'unverified',
      isEligibleForAutoExec: false,
      blockedReasons: ['limits.capturesRealExitCode is unverified'],
    };

    const authResult = gate.authorize(validRequest, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: unverifiedReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });

    expect(assertErr(authResult).code).toBe(ErrorCode.EXECUTION_BLOCKED);
  });

  it('4. GO decision with mismatched task ID blocks execution', () => {
    const authResult = gate.authorize(validRequest, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: validReport,
      activeTaskId: 'different-task',
      activeSessionId: 'session-1',
    });
    expect(assertErr(authResult).code).toBe(ErrorCode.TASK_MISMATCH);
  });

  it('5. GO decision with mismatched session ID blocks execution', () => {
    const authResult = gate.authorize(validRequest, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'different-session',
    });
    expect(assertErr(authResult).code).toBe(ErrorCode.SESSION_MISMATCH);
  });

  it('6. failed capability evaluation report blocks execution', () => {
    const blockedReport: CapabilityEvaluationReport = {
      ...validReport,
      result: 'blocked',
      isEligibleForAutoExec: false,
      blockedReasons: ['filesystem.liveWorkspaceWriteDenied is false'],
    };

    const authResult = gate.authorize(validRequest, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: blockedReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });

    expect(assertErr(authResult).code).toBe(ErrorCode.EXECUTION_BLOCKED);
  });

  it('7. an unverified outside-root restriction disables execution', () => {
    const unverifiedReport: CapabilityEvaluationReport = {
      ...validReport,
      result: 'unverified',
      isEligibleForAutoExec: false,
      blockedReasons: ['filesystem.outsideRootDenied: unverified'],
    };

    const authResult = gate.authorize(validRequest, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: unverifiedReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });

    expect(assertErr(authResult).code).toBe(ErrorCode.EXECUTION_BLOCKED);
  });

  it('8. browser AI origin cannot grant execution authority', () => {
    const authResult = gate.authorize(validRequest, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
      callerOrigin: 'browser_ai',
    });
    expect(assertErr(authResult).code).toBe(ErrorCode.CAPABILITY_PERMISSION_DENIED);
  });

  it('9. MCP agent origin cannot grant execution authority', () => {
    const authResult = gate.authorize(validRequest, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
      callerOrigin: 'mcp_agent',
    });
    expect(assertErr(authResult).code).toBe(ErrorCode.CAPABILITY_PERMISSION_DENIED);
  });

  it('10. missing approval ID blocks execution', () => {
    const noApprovalReq = { ...validRequest, approvalId: '' };
    const authResult = gate.authorize(noApprovalReq, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(assertErr(authResult).code).toBe(ErrorCode.APPROVAL_REQUIRED);
  });

  it('11. modified payload hash (approvedPayloadHash !== recipeHash) blocks execution', () => {
    const tamperedReq = { ...validRequest, approvedPayloadHash: 'tampered-hash' };
    const authResult = gate.authorize(tamperedReq, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(assertErr(authResult).code).toBe(ErrorCode.APPROVAL_PAYLOAD_MISMATCH);
  });

  it('12. AI-controlled arbitrary recipe identifier is rejected', () => {
    const evilReq = { ...validRequest, recipeId: 'rm -rf /' };
    const authResult = gate.authorize(evilReq, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(assertErr(authResult).code).toBe(ErrorCode.RECIPE_NOT_FOUND);
  });

  it('13. shell operators in arguments are rejected', () => {
    const injectionReq = { ...validRequest, args: ['--grep', 'test; rm -rf /'] };
    const authResult = gate.authorize(injectionReq, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(assertErr(authResult).code).toBe(ErrorCode.UNTRUSTED_COMMAND_REJECTED);
  });

  it('14. pipe shell operator in arguments is rejected', () => {
    const pipeReq = { ...validRequest, args: ['arg1 | cat /etc/passwd'] };
    const authResult = gate.authorize(pipeReq, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(assertErr(authResult).code).toBe(ErrorCode.UNTRUSTED_COMMAND_REJECTED);
  });

  it('15. only the explicitly approved S00 path is instantiated', () => {
    const status = service.getStatus();
    expect(status.mode).toBe('review-only');
    expect(status.s00Decision).toBe(S00ExecutionDecisionValues.NO_GO_AUTOEXEC);
    expect(status.autoExecAvailable).toBe(false);
  });

  it('16. path traversal in stageId is rejected', () => {
    const traversalReq = { ...validRequest, stageId: '../../evil-stage' };
    const authResult = gate.authorize(traversalReq, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(assertErr(authResult).code).toBe(ErrorCode.PATH_TRAVERSAL);
  });

  it('17. stage conflict blocks execution launch', () => {
    const authResult = gate.authorize(validRequest, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
      stageConflictExists: true,
    });
    expect(assertErr(authResult).code).toBe(ErrorCode.STAGE_CONFLICT);
  });

  it('18. manual recipe suggestion generates safe command text for project.test', () => {
    const suggestion = service.buildManualRecipeSuggestion(validRequest);
    expect(suggestion.commandText).toBe('npm test');
    expect(suggestion.safeToRunManually).toBe(true);
  });

  it('19. manual recipe suggestion generates safe command text for project.lint', () => {
    const suggestion = service.buildManualRecipeSuggestion({ ...validRequest, recipeId: 'project.lint' });
    expect(suggestion.commandText).toBe('npm run lint');
  });

  it('20. manual recipe suggestion generates safe command text for project.typecheck', () => {
    const suggestion = service.buildManualRecipeSuggestion({ ...validRequest, recipeId: 'project.typecheck' });
    expect(suggestion.commandText).toBe('npm run typecheck');
  });

  it('21. manual handoff formatting contains task details and instructions without running code', () => {
    const snippet = service.formatManualHandoffSnippet(validRequest, validReport);
    expect(snippet).toContain('task-1');
    expect(snippet).toContain('project.test');
    expect(snippet).toContain('Review-only');
    expect(snippet).toContain('```bash\nnpm test\n```');
  });

  it('22. status reports correct review-only mode and diagnostics', () => {
    const status = service.getStatus(validReport);
    expect(status.mode).toBe('review-only');
    expect(status.diagnostics?.isEligible).toBe(true);
  });

  it('23. capability loss revokes execution eligibility and fails closed', async () => {
    const degradedReport: CapabilityEvaluationReport = {
      ...validReport,
      result: 'blocked',
      isEligibleForAutoExec: false,
      blockedReasons: ['Runtime canary failed'],
    };

    const resp = await service.executeRecipe(validRequest, {
      evaluationReport: degradedReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });

    expect(resp.success).toBe(false);
    expect(resp.status).toBe('execution-unavailable');
  });

  it('24. authorized gate passes under strict GO decision with all preconditions satisfied', () => {
    const authResult = gate.authorize(validRequest, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(authResult.ok).toBe(true);
  });

  it('25. newline and carriage return in arguments are rejected as injection attempts', () => {
    const nlReq = { ...validRequest, args: ['arg\nmalicious_cmd'] };
    const authResult = gate.authorize(nlReq, {
      s00Decision: S00ExecutionDecisionValues.GO_IDE,
      evaluationReport: validReport,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(assertErr(authResult).code).toBe(ErrorCode.UNTRUSTED_COMMAND_REJECTED);
  });
});
