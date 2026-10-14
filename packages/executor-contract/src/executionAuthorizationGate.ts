/**
 * @mediator/executor-contract — Execution Authorization Gate (S22)
 *
 * Requirements:
 * - Single authoritative execution authorization gate.
 * - Revalidates all preconditions immediately before any execution attempt:
 *   1. S00 Decision is an explicit GO decision (fails closed on NO-GO-AUTOEXEC).
 *   2. S21 capability evaluation is eligible.
 *   3. Fresh capability evidence for active executor/version.
 *   4. Current canonical workspace and stage identity.
 *   5. Valid task/session state.
 *   6. Registered fixed recipe.
 *   7. Policy approval and valid payload hash match.
 *   8. No unresolved stage conflict.
 *   9. Rejection of AI/browser/MCP self-authorization.
 *   10. Rejection of arbitrary executable paths and shell operators.
 */

import {
  type S00ExecutionDecision,
  S00ExecutionDecisionValues,
  type ExecuteRecipeRequest,
  type CapabilityEvaluationReport,
  ErrorCode,
  type Result,
  ok,
  err,
  makeMediatorError,
  type MediatorError,
} from '@mediator/shared-contracts';
import { normalizeWindowsPath } from '@mediator/workspace-boundary';

export interface AuthorizationGateContext {
  readonly s00Decision: S00ExecutionDecision;
  readonly evaluationReport: CapabilityEvaluationReport;
  readonly activeTaskId: string;
  readonly activeSessionId: string;
  readonly stageConflictExists?: boolean | undefined;
  readonly callerOrigin?: 'ide' | 'user' | 'browser_ai' | 'mcp_agent' | undefined;
  readonly registeredRecipes?: ReadonlySet<string> | undefined;
}

export class ExecutionAuthorizationGate {
  private readonly defaultAllowedRecipes: ReadonlySet<string> = new Set([
    'project.test',
    'project.lint',
    'project.typecheck',
    'project.build',
    'project.single_test',
    'git.status',
    'git.diff',
  ]);

  /**
   * Authorize or fail-closed reject an execution request.
   */
  public authorize(
    request: ExecuteRecipeRequest,
    context: AuthorizationGateContext,
  ): Result<true, MediatorError> {
    const correlationId = request.correlationId;

    // 1. S00 Feasibility Gate (Fail-Closed)
    if (context.s00Decision !== S00ExecutionDecisionValues.GO_IDE && context.s00Decision !== S00ExecutionDecisionValues.GO_WSL2) {
      return err(
        makeMediatorError(
          ErrorCode.EXECUTION_UNAVAILABLE,
          `Automatic execution is disabled by S00 feasibility decision '${context.s00Decision}'. Mediator is active in Review-only mode.`,
          { correlationId, taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    // 2. Caller Origin Verification (AI/Browser/MCP cannot self-authorize execution)
    if (context.callerOrigin === 'browser_ai' || context.callerOrigin === 'mcp_agent') {
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_PERMISSION_DENIED,
          `Caller origin '${context.callerOrigin}' cannot authorize command execution. User confirmation in IDE is strictly required.`,
          { correlationId, taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    // 3. S21 Capability Evaluation Gate
    if (!context.evaluationReport.isEligibleForAutoExec || context.evaluationReport.result !== 'eligible') {
      const reasons = context.evaluationReport.blockedReasons.join('; ');
      return err(
        makeMediatorError(
          ErrorCode.EXECUTION_BLOCKED,
          `Executor capability evaluation failed with result '${context.evaluationReport.result}': ${reasons || 'Capabilities unverified'}`,
          { correlationId, taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    // 4. Task and Session State Binding
    if (request.taskId !== context.activeTaskId) {
      return err(
        makeMediatorError(
          ErrorCode.TASK_MISMATCH,
          `Request taskId '${request.taskId}' does not match active taskId '${context.activeTaskId}'`,
          { correlationId, taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    if (request.sessionId !== context.activeSessionId) {
      return err(
        makeMediatorError(
          ErrorCode.SESSION_MISMATCH,
          `Request sessionId '${request.sessionId}' does not match active sessionId '${context.activeSessionId}'`,
          { correlationId, taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    // 5. Stage Conflict Gate
    if (context.stageConflictExists) {
      return err(
        makeMediatorError(
          ErrorCode.STAGE_CONFLICT,
          'Unresolved stage conflict detected. Staging modifications conflict with live workspace.',
          { correlationId, taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    // 6. Registered Recipe Check
    const allowed = context.registeredRecipes ?? this.defaultAllowedRecipes;
    if (!allowed.has(request.recipeId)) {
      return err(
        makeMediatorError(
          ErrorCode.RECIPE_NOT_FOUND,
          `Recipe '${request.recipeId}' is not a registered fixed recipe. Arbitrary executables are prohibited.`,
          { correlationId, taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    // 7. Approval & Payload Hash Binding
    if (!request.approvalId || request.approvalId.trim() === '') {
      return err(
        makeMediatorError(
          ErrorCode.APPROVAL_REQUIRED,
          'Execution requires explicit user approval reference',
          { correlationId, taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    if (request.approvedPayloadHash !== request.recipeHash) {
      return err(
        makeMediatorError(
          ErrorCode.APPROVAL_PAYLOAD_MISMATCH,
          `Approved payload hash '${request.approvedPayloadHash}' does not match recipe hash '${request.recipeHash}'`,
          { correlationId, taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    // 8. Path Containment & Traversal Defense
    const normStage = normalizeWindowsPath(request.stageId);
    if (normStage.includes('..')) {
      return err(
        makeMediatorError(
          ErrorCode.PATH_TRAVERSAL,
          'Stage path contains illegal traversal components',
          { correlationId, taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    // 9. Argument Shell Operator Defense
    if (request.args && request.args.length > 0) {
      const shellOperators = ['&&', ';', '|', '>', '<', '`', '$', '\n', '\r'];
      for (const arg of request.args) {
        if (shellOperators.some((op) => arg.includes(op))) {
          return err(
            makeMediatorError(
              ErrorCode.UNTRUSTED_COMMAND_REJECTED,
              `Argument '${arg}' contains prohibited shell control characters`,
              { correlationId, taskId: request.taskId, sessionId: request.sessionId },
            ),
          );
        }
      }
    }

    return ok(true);
  }
}
