/**
 * @mediator/executor-contract — Approved Execution Path (S22)
 *
 * Requirements:
 * - Implements exactly the execution path permitted by the S00 feasibility decision.
 * - Under NO-GO-AUTOEXEC:
 *   1. Does NOT implement an automatic execution runner.
 *   2. Returns clear Review-only capability status (EXECUTION_UNAVAILABLE).
 *   3. Generates copyable, safe manual recipe suggestions (descriptive text only).
 *   4. Generates manual IDE-agent handoff formatting.
 *   5. Explains why automatic execution is unavailable.
 *   6. Exposes capability diagnostics identifying missing canaries or blocked requirements.
 *   7. Rejects any attempt to execute automatically.
 */

import {
  type S00ExecutionDecision,
  S00ExecutionDecisionValues,
  type ExecuteRecipeRequest,
  type ExecuteRecipeResponse,
  type SuggestedManualRecipe,
  type CapabilityEvaluationReport,
  ErrorCode,
} from '@mediator/shared-contracts';
import {
  ExecutionAuthorizationGate,
  type AuthorizationGateContext,
} from './executionAuthorizationGate.js';

export interface ApprovedExecutionPathOptions {
  readonly s00Decision?: S00ExecutionDecision | undefined;
  readonly authorizationGate?: ExecutionAuthorizationGate | undefined;
}

export class ApprovedExecutionPathService {
  private readonly s00Decision: S00ExecutionDecision;
  private readonly authorizationGate: ExecutionAuthorizationGate;

  public constructor(options?: ApprovedExecutionPathOptions) {
    this.s00Decision = options?.s00Decision ?? S00ExecutionDecisionValues.NO_GO_AUTOEXEC;
    this.authorizationGate = options?.authorizationGate ?? new ExecutionAuthorizationGate();
  }

  /**
   * Request execution of an approved fixed recipe.
   * Under NO-GO-AUTOEXEC, this strictly returns Review-only status with safe manual command suggestions.
   */
  public executeRecipe(
    request: ExecuteRecipeRequest,
    context: Omit<AuthorizationGateContext, 's00Decision'>,
  ): Promise<ExecuteRecipeResponse> {
    const fullContext: AuthorizationGateContext = {
      ...context,
      s00Decision: this.s00Decision,
    };

    // Run the Authoritative Execution Gate
    const authResult = this.authorizationGate.authorize(request, fullContext);

    if (!authResult.ok) {
      const err = authResult.error;
      const suggestedRecipe = this.buildManualRecipeSuggestion(request);

      return Promise.resolve({
        success: false,
        status:
          err.code === ErrorCode.EXECUTION_UNAVAILABLE
            ? 'execution-unavailable'
            : 'execution-blocked',
        s00Decision: this.s00Decision,
        message: err.message,
        errorCode: err.code,
        suggestedManualRecipe: suggestedRecipe,
        diagnostics: {
          blockedReasons: context.evaluationReport.blockedReasons,
          unverifiedRequirements: context.evaluationReport.unverifiedRequirements,
          failedRequirements: context.evaluationReport.failedRequirements,
          activeTaskId: context.activeTaskId,
          stageId: request.stageId,
        },
        correlationId: request.correlationId,
      });
    }

    // If S00 decision is NO-GO-AUTOEXEC, the gate will have returned an error above.
    // If future GO-IDE / GO-WSL2 path were active and approved:
    return Promise.resolve({
      success: false,
      status: 'execution-unavailable',
      s00Decision: this.s00Decision,
      message: 'Automatic execution runner is not enabled. Review-only mode is active.',
      errorCode: ErrorCode.EXECUTION_UNAVAILABLE,
      suggestedManualRecipe: this.buildManualRecipeSuggestion(request),
      correlationId: request.correlationId,
    });
  }

  /**
   * Format safe copyable command suggestions for manual execution by user in IDE / terminal.
   */
  public buildManualRecipeSuggestion(request: ExecuteRecipeRequest): SuggestedManualRecipe {
    let commandText = 'npm test';
    let instructions = 'Run the test suite manually against the isolated stage or workspace.';

    switch (request.recipeId) {
      case 'project.test':
        commandText = 'npm test';
        instructions = 'Run the full project test suite in your local terminal.';
        break;
      case 'project.lint':
        commandText = 'npm run lint';
        instructions = 'Run ESLint across the codebase.';
        break;
      case 'project.typecheck':
        commandText = 'npm run typecheck';
        instructions = 'Run the TypeScript compiler type-check.';
        break;
      case 'project.build':
        commandText = 'npm run build';
        instructions = 'Compile the TypeScript packages.';
        break;
      case 'project.single_test':
        commandText = `npx vitest run ${request.args?.[0] ?? ''}`.trim();
        instructions = 'Run the specified test file in Vitest.';
        break;
      case 'git.status':
        commandText = 'git status --short';
        instructions = 'Inspect modified and untracked files.';
        break;
      case 'git.diff':
        commandText = 'git diff';
        instructions = 'Inspect unstaged modifications in the workspace.';
        break;
      default:
        commandText = `# Recipe: ${request.recipeId}`;
        instructions = 'Execute the verified recipe manually in the terminal.';
    }

    return {
      recipeId: request.recipeId,
      commandText,
      instructions,
      workingDirectory: request.workspaceRoot,
      safeToRunManually: true,
    };
  }

  /**
   * Format manual handoff message suitable for copying to an IDE agent or terminal.
   */
  public formatManualHandoffSnippet(
    request: ExecuteRecipeRequest,
    evaluationReport: CapabilityEvaluationReport,
  ): string {
    const suggestion = this.buildManualRecipeSuggestion(request);
    return [
      '### [Mediator] Manual Verification Handoff',
      `- **Task ID:** \`${request.taskId}\``,
      `- **Recipe:** \`${request.recipeId}\``,
      `- **Execution Mode:** Review-only (Automatic execution disabled by S00 decision: \`${this.s00Decision}\`)`,
      `- **Working Directory:** \`${suggestion.workingDirectory}\``,
      `- **Command:** \`${suggestion.commandText}\``,
      '',
      '> **Instructions:**',
      `> ${suggestion.instructions}`,
      '',
      '```bash',
      suggestion.commandText,
      '```',
      '',
      '#### Capability Diagnostics:',
      ...evaluationReport.blockedReasons.map((r) => `- ${r}`),
    ].join('\n');
  }

  /**
   * Retrieve current execution mode status and diagnostics.
   */
  public getStatus(evaluationReport?: CapabilityEvaluationReport | undefined): {
    readonly mode: 'review-only' | 'auto-exec';
    readonly s00Decision: S00ExecutionDecision;
    readonly autoExecAvailable: boolean;
    readonly summary: string;
    readonly diagnostics?: Record<string, unknown> | undefined;
  } {
    return {
      mode: 'review-only',
      s00Decision: this.s00Decision,
      autoExecAvailable: false,
      summary:
        'Mediator v1 is operating in Review-only mode. Automatic command execution is disabled by the S00 feasibility decision until a verified sandbox executor is established.',
      diagnostics: evaluationReport
        ? {
            isEligible: evaluationReport.isEligibleForAutoExec,
            result: evaluationReport.result,
            blockedReasons: evaluationReport.blockedReasons,
          }
        : undefined,
    };
  }
}
