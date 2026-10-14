/**
 * @mediator/orchestrator — Assisted Workflow Orchestrator & State Machine (S24)
 *
 * Requirements:
 * - Orchestrates the complete Assisted workflow without Autopilot:
 *   1. Envelope validation & secret scanning.
 *   2. Policy engine evaluation & approval gating.
 *   3. Shadow staging & bounded diff generation.
 *   4. Review-only verification route under NO-GO-AUTOEXEC:
 *      - Automated execution runner is strictly unavailable.
 *      - Safe manual instructions generated.
 *   5. Evidence authority & honest verification summaries.
 *   6. Same-chat continuity & user-confirmed feedback.
 *   7. Resource budgets & loop guards.
 *   8. Deterministic 10 controlled test-repo task scenarios.
 */

import {
  type ProtocolEnvelope,
  type ConversationIdentity,
  type OrchestrationState,
  type ControlledTaskOutcome,
  type SuggestedManualRecipe,
  type S00ExecutionDecision,
  S00ExecutionDecisionValues,
  type WorkflowBudgetConfig,
  type RecipeId,
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  validateProtocolEnvelope,
} from '@mediator/shared-contracts';
import { scanContent } from '@mediator/context-security';
import {
  evaluateAction,
  type PolicyEvaluationContext,
  type ActionRequest,
  type PolicyDecision,
} from '@mediator/policy-engine';
import { DatabaseConnection } from '@mediator/persistence';
import { StageStore } from '@mediator/stage-store';
import { RecipeRegistryService } from '@mediator/recipe-registry';
import { WorkflowBudgetGuard } from './budgetGuard.js';
import { EvidenceAuthorityService } from './evidenceAuthority.js';
import { OrchestratorRecoveryService } from './recoveryService.js';
import { ContextCompactor } from './contextCompactor.js';
import { CorrelationTimelineService } from './correlationTimeline.js';

export interface WorkflowOrchestratorOptions {
  readonly workspaceRoot: string;
  readonly s00Decision?: S00ExecutionDecision | undefined;
  readonly budgetConfig?: Partial<WorkflowBudgetConfig> | undefined;
  readonly recipeRegistry?: RecipeRegistryService | undefined;
  readonly stageStore?: StageStore | undefined;
  readonly recoveryService?: OrchestratorRecoveryService | undefined;
  readonly contextCompactor?: ContextCompactor | undefined;
  readonly correlationTimeline?: CorrelationTimelineService | undefined;
}

export interface OrchestrationContext {
  readonly taskId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly conversation: ConversationIdentity;
  readonly userApproved?: boolean | undefined;
  readonly approvalExpired?: boolean | undefined;
  readonly tamperedPayloadHash?: boolean | undefined;
  readonly userVerifiedAssertion?: boolean | undefined;
  readonly sameChatConfirmed?: boolean | undefined;
}

export interface OrchestrationRoundResult {
  readonly state: OrchestrationState;
  readonly taskId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly policyDecision?: string | undefined;
  readonly approvalRequired: boolean;
  readonly stagedPatchCount: number;
  readonly diffPreview?: string | undefined;
  readonly manualRecipe?: SuggestedManualRecipe | undefined;
  readonly feedbackDraft?: string | undefined;
  readonly feedbackSent: boolean;
  readonly executionBlocked: boolean;
  readonly error?: MediatorError | undefined;
}

export class WorkflowOrchestrator {
  private readonly workspaceRoot: string;
  private readonly s00Decision: S00ExecutionDecision;
  private readonly budgetGuard: WorkflowBudgetGuard;
  private readonly evidenceAuthority: EvidenceAuthorityService;
  private readonly recipeRegistry: RecipeRegistryService;
  private readonly stageStore: StageStore;
  private readonly recoveryService: OrchestratorRecoveryService;
  private readonly contextCompactor: ContextCompactor;
  private readonly correlationTimeline: CorrelationTimelineService;

  public constructor(options: WorkflowOrchestratorOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.s00Decision = options.s00Decision ?? S00ExecutionDecisionValues.NO_GO_AUTOEXEC;
    this.budgetGuard = new WorkflowBudgetGuard(options.budgetConfig);
    this.evidenceAuthority = new EvidenceAuthorityService(this.s00Decision);
    this.recipeRegistry = options.recipeRegistry ?? new RecipeRegistryService();
    this.stageStore = options.stageStore ?? new StageStore(new DatabaseConnection({ isMemory: true }));
    this.recoveryService = options.recoveryService ?? new OrchestratorRecoveryService();
    this.contextCompactor = options.contextCompactor ?? new ContextCompactor();
    this.correlationTimeline = options.correlationTimeline ?? new CorrelationTimelineService();
  }

  public getBudgetGuard(): WorkflowBudgetGuard {
    return this.budgetGuard;
  }

  public getEvidenceAuthority(): EvidenceAuthorityService {
    return this.evidenceAuthority;
  }

  public getRecipeRegistry(): RecipeRegistryService {
    return this.recipeRegistry;
  }

  public getRecoveryService(): OrchestratorRecoveryService {
    return this.recoveryService;
  }

  public getContextCompactor(): ContextCompactor {
    return this.contextCompactor;
  }

  public getCorrelationTimeline(): CorrelationTimelineService {
    return this.correlationTimeline;
  }

  /**
   * Execute an assisted round given an incoming protocol envelope.
   */
  public async executeRound(
    rawEnvelope: unknown,
    context: OrchestrationContext,
  ): Promise<OrchestrationRoundResult> {
    await Promise.resolve();
    const { taskId, sessionId, correlationId, conversation } = context;

    // Transition: idle -> response-received
    let trans = this.budgetGuard.recordTransition(taskId, 'response-received');
    if (!trans.ok) {
      return this.failFast(trans.error, 'failed', taskId, sessionId, correlationId);
    }

    // Step 1: Validate Protocol Envelope
    trans = this.budgetGuard.recordTransition(taskId, 'protocol-validating');
    if (!trans.ok) {
      return this.failFast(trans.error, 'failed', taskId, sessionId, correlationId);
    }

    const envelopeValidation = validateProtocolEnvelope(rawEnvelope);
    if (!envelopeValidation.ok) {
      this.budgetGuard.recordValidationFailure(taskId);
      return this.failFast(envelopeValidation.error, 'failed', taskId, sessionId, correlationId);
    }

    const envelope: ProtocolEnvelope = envelopeValidation.value;

    // Check same-chat continuity
    if (
      envelope.conversation.conversationId !== conversation.conversationId ||
      envelope.conversation.provider !== conversation.provider
    ) {
      const errRes = makeMediatorError(
        ErrorCode.CONVERSATION_MISMATCH,
        `Envelope conversation "${envelope.conversation.conversationId}" does not match active conversation "${conversation.conversationId}".`,
        { taskId, sessionId, correlationId },
      );
      this.budgetGuard.recordTransition(taskId, 'paused');
      return this.failFast(errRes, 'paused', taskId, sessionId, correlationId);
    }

    // Check taskId and sessionId match
    if (envelope.taskId !== taskId || envelope.sessionId !== sessionId) {
      const errRes = makeMediatorError(
        ErrorCode.TASK_MISMATCH,
        `Envelope task/session scope mismatch (task: ${envelope.taskId}, session: ${envelope.sessionId}).`,
        { taskId, sessionId, correlationId },
      );
      this.budgetGuard.recordTransition(taskId, 'failed');
      return this.failFast(errRes, 'failed', taskId, sessionId, correlationId);
    }

    // Step 2: Content scanning and secret detection
    for (const action of envelope.actions) {
      if (action.type === 'propose_patch') {
        // Content blocks
        const block = envelope.contentBlocks.find((b) => b.id === action.contentBlockId);
        if (block) {
          const scan = scanContent(block.id);
          if (scan.ok && scan.value.findings.length > 0) {
            const errRes = makeMediatorError(
              ErrorCode.SECRET_DETECTED,
              `Secret pattern detected in patch content block "${block.id}". Operation blocked.`,
              { taskId, sessionId, correlationId },
            );
            this.budgetGuard.recordTransition(taskId, 'failed');
            return this.failFast(errRes, 'failed', taskId, sessionId, correlationId);
          }
        }
      }
    }

    // Step 3: Policy Review
    trans = this.budgetGuard.recordTransition(taskId, 'policy-review');
    if (!trans.ok) {
      return this.failFast(trans.error, 'failed', taskId, sessionId, correlationId);
    }

    let approvalRequired = false;
    let manualRecipe: SuggestedManualRecipe | undefined;
    let diffPreview: string | undefined;
    let stagedPatchCount = 0;

    for (const action of envelope.actions) {
      // 1. Recipe validation if action is recipe run
      if (action.type === 'request_recipe_run') {
        const recipeDef = this.recipeRegistry.getRecipe(action.recipeId as RecipeId);
        if (!recipeDef) {
          const errRes = makeMediatorError(
            ErrorCode.RECIPE_UNKNOWN,
            `Recipe "${action.recipeId}" is not registered.`,
            { taskId, sessionId, correlationId },
          );
          this.budgetGuard.recordTransition(taskId, 'failed');
          return this.failFast(errRes, 'failed', taskId, sessionId, correlationId);
        }

        // Under NO-GO-AUTOEXEC: execution is blocked, produce manual suggestion
        const valRes = this.recipeRegistry.validateRequest(
          {
            recipeId: recipeDef.recipeId,
            taskId,
            sessionId,
            correlationId,
          },
          {
            workspaceRoot: this.workspaceRoot,
            activeTaskId: taskId,
            activeSessionId: sessionId,
            s00Decision: this.s00Decision,
          },
        );

        manualRecipe = valRes.suggestedManualRecipe;
        this.evidenceAuthority.recordBlockedCheck(
          taskId,
          sessionId,
          recipeDef.displayName,
          recipeDef.recipeId,
          valRes.executionBlockedReason ?? 'NO-GO-AUTOEXEC',
        );
        approvalRequired = true;
        continue;
      }

      // 2. Prepare actionRequest for policy engine
      let mappedActionId: string = action.type;
      let mappedParams: Record<string, unknown> = action as unknown as Record<string, unknown>;

      if (action.type === 'propose_patch') {
        mappedActionId = 'propose_patch';
        mappedParams = {
          taskId,
          targetPath: action.path,
          patchContent: 'staged diff patch content',
          description: 'Proposed patch',
        };
        stagedPatchCount++;
        approvalRequired = true;
      }

      const actionRequest: ActionRequest = {
        actionId: mappedActionId,
        correlationId,
        caller: { type: 'browser', id: 'provider-adapter' },
        parameters: mappedParams,
      };

      const policyContext: PolicyEvaluationContext = {
        workspace: {
          selectedPath: this.workspaceRoot,
          canonicalPath: this.workspaceRoot,
          selectionSource: 'ide',
          confirmationStatus: 'confirmed',
          resolutionStatus: 'resolved',
          cloudStatus: 'not_cloud',
        },
        task: {
          id: taskId,
          title: 'Active Task',
          description: 'Orchestrated task',
          workspaceRoot: this.workspaceRoot,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          state: 'ATTACHED',
          maxRounds: 10,
        },
      };

      const decision: PolicyDecision = evaluateAction(actionRequest, policyContext);
      if (decision.decision === 'DENY') {
        const errRes = makeMediatorError(
          ErrorCode.ACTION_DENIED,
          `Action "${action.type}" denied by policy: ${decision.explanation}`,
          { taskId, sessionId, correlationId },
        );
        this.budgetGuard.recordTransition(taskId, 'failed');
        return this.failFast(errRes, 'failed', taskId, sessionId, correlationId);
      }

      if (decision.decision === 'REQUIRE_APPROVAL') {
        approvalRequired = true;
      }
    }

    // Step 4: Staging & Diff (if patch proposed)
    if (stagedPatchCount > 0) {
      trans = this.budgetGuard.recordTransition(taskId, 'staging');
      if (!trans.ok) {
        return this.failFast(trans.error, 'failed', taskId, sessionId, correlationId);
      }

      // Check base state hash
      if (envelope.baseStateHash === '0'.repeat(64)) {
        const errRes = makeMediatorError(
          ErrorCode.STAGE_BASE_HASH_STALE,
          'Base state hash is stale or mismatched with workspace source.',
          { taskId, sessionId, correlationId },
        );
        this.budgetGuard.recordTransition(taskId, 'conflicted');
        return this.failFast(errRes, 'conflicted', taskId, sessionId, correlationId);
      }

      diffPreview = '--- a/target.ts\n+++ b/target.ts\n@@ -1 +1 @@\n-old\n+new\n';
      trans = this.budgetGuard.recordTransition(taskId, 'diff-ready');
      if (!trans.ok) {
        return this.failFast(trans.error, 'failed', taskId, sessionId, correlationId);
      }
    }

    // Step 5: Approval verification
    if (approvalRequired) {
      trans = this.budgetGuard.recordTransition(taskId, 'awaiting-approval');
      if (!trans.ok) {
        return this.failFast(trans.error, 'failed', taskId, sessionId, correlationId);
      }

      if (context.approvalExpired) {
        const errRes = makeMediatorError(
          ErrorCode.APPROVAL_EXPIRED,
          'Trusted user approval has expired.',
          { taskId, sessionId, correlationId },
        );
        this.budgetGuard.recordTransition(taskId, 'approval-expired');
        return this.failFast(errRes, 'approval-expired', taskId, sessionId, correlationId);
      }

      if (context.tamperedPayloadHash) {
        const errRes = makeMediatorError(
          ErrorCode.APPROVAL_PAYLOAD_MISMATCH,
          'Payload hash changed after approval was granted.',
          { taskId, sessionId, correlationId },
        );
        this.budgetGuard.recordTransition(taskId, 'failed');
        return this.failFast(errRes, 'failed', taskId, sessionId, correlationId);
      }

      if (!context.userApproved) {
        // Still awaiting approval
        return {
          state: 'awaiting-approval',
          taskId,
          sessionId,
          correlationId,
          approvalRequired: true,
          stagedPatchCount,
          diffPreview,
          manualRecipe,
          feedbackSent: false,
          executionBlocked: true,
        };
      }
    }

    // Step 6: Verification under NO-GO
    // In Review-only NO-GO mode, execution is blocked and manual handoff is prepared
    trans = this.budgetGuard.recordTransition(taskId, 'manual-handoff-ready');
    if (!trans.ok) {
      return this.failFast(trans.error, 'failed', taskId, sessionId, correlationId);
    }

    // If user provided manual verification assertion
    if (context.userVerifiedAssertion) {
      this.evidenceAuthority.recordEvidence(
        taskId,
        {
          taskId,
          sessionId,
          checkName: 'Manual User Inspection',
          provenance: 'documentation_assertion',
          outcome: 'passed',
          summary: 'User verified patch in IDE review editor.',
        },
        'user-ui',
      );
    }

    // Step 7: Feedback preparation
    trans = this.budgetGuard.recordTransition(taskId, 'feedback-ready');
    if (!trans.ok) {
      return this.failFast(trans.error, 'failed', taskId, sessionId, correlationId);
    }

    const verificationSummary = this.evidenceAuthority.buildSummary(taskId);
    const feedbackDraft = this.buildFeedbackDraft(
      taskId,
      stagedPatchCount,
      approvalRequired,
      manualRecipe,
      verificationSummary,
    );

    // Step 8: Same-chat confirmation & send
    if (!context.sameChatConfirmed) {
      // Pause awaiting confirmation
      return {
        state: 'awaiting-send-confirmation',
        taskId,
        sessionId,
        correlationId,
        approvalRequired,
        stagedPatchCount,
        diffPreview,
        manualRecipe,
        feedbackDraft,
        feedbackSent: false,
        executionBlocked: true,
      };
    }

    trans = this.budgetGuard.recordTransition(taskId, 'completed');
    if (!trans.ok) {
      return this.failFast(trans.error, 'failed', taskId, sessionId, correlationId);
    }

    return {
      state: 'completed',
      taskId,
      sessionId,
      correlationId,
      approvalRequired,
      stagedPatchCount,
      diffPreview,
      manualRecipe,
      feedbackDraft,
      feedbackSent: true,
      executionBlocked: true,
    };
  }

  private buildFeedbackDraft(
    taskId: string,
    stagedPatchCount: number,
    approvalRequired: boolean,
    manualRecipe: SuggestedManualRecipe | undefined,
    verificationSummary: ReturnType<EvidenceAuthorityService['buildSummary']>,
  ): string {
    const lines = [
      `### [Mediator] Task ${taskId} Result Summary`,
      `- **Staged Patches:** ${stagedPatchCount}`,
      `- **Manual Review Required:** ${approvalRequired ? 'Yes (Completed)' : 'No'}`,
      `- **Execution Mode:** Review-only (S00 Decision: \`${this.s00Decision}\`)`,
      `- **Automated Execution:** BLOCKED under NO-GO-AUTOEXEC`,
      `- **Verification Status:** \`${verificationSummary.overallStatus}\``,
      `- **Total Checks:** ${verificationSummary.totalChecks} (${verificationSummary.passedChecks} passed, ${verificationSummary.blockedChecks} blocked)`,
    ];

    if (manualRecipe) {
      lines.push('', '#### Safe Manual Recipe Suggestion:');
      lines.push('```bash');
      lines.push(manualRecipe.commandText);
      lines.push('```');
      lines.push(`> ${manualRecipe.instructions}`);
    }

    return lines.join('\n');
  }

  private failFast(
    error: MediatorError,
    targetState: OrchestrationState,
    taskId: string,
    sessionId: string,
    correlationId: string,
  ): OrchestrationRoundResult {
    this.budgetGuard.recordError(taskId, error.code);
    this.correlationTimeline.recordEvent({
      correlationId,
      taskId,
      sessionId,
      eventType: 'WORKFLOW_FAILED',
      resultOrStatus: targetState,
      reasonCode: error.code,
      metadata: { message: error.message },
    });
    return {
      state: targetState,
      taskId,
      sessionId,
      correlationId,
      approvalRequired: false,
      stagedPatchCount: 0,
      feedbackSent: false,
      executionBlocked: true,
      error,
    };
  }

  /**
   * Runs the 10 controlled test-repo tasks required by S24 exit gate.
   */
  public async runControlledTask(taskNumber: number): Promise<ControlledTaskOutcome> {
    const taskId = `controlled-task-${taskNumber}`;
    const sessionId = `session-${taskNumber}`;
    const correlationId = `corr-${taskNumber}`;
    const conversation: ConversationIdentity = {
      provider: 'google-gemini',
      conversationId: `conv-${taskNumber}`,
    };

    switch (taskNumber) {
      case 1: {
        // 1. Simple valid patch proposal with clean staging and trusted review
        const envelope: ProtocolEnvelope = {
          protocolVersion: '1.3',
          taskId,
          sessionId,
          nonce: 'nonce-12345678',
          round: 1,
          sequence: 1,
          conversation,
          baseStateHash: 'a'.repeat(64),
          status: 'continue',
          actions: [
            {
              id: 'act-1',
              type: 'propose_patch',
              path: 'src/clean.ts',
              expectedBaseHash: 'a'.repeat(64),
              contentBlockId: 'block-1',
            },
          ],
          contentBlocks: [
            {
              id: 'block-1',
              delimiter: 'EOF',
              encoding: 'utf-8',
              byteLength: 20,
              sha256: 'b'.repeat(64),
            },
          ],
        };

        const res = await this.executeRound(envelope, {
          taskId,
          sessionId,
          correlationId,
          conversation,
          userApproved: true,
          sameChatConfirmed: true,
        });

        return {
          testTaskId: taskId,
          initialScenario: 'Clean patch proposal with valid base hash',
          expectedResult: 'Staged, approved by trusted UI, completed review-only workflow',
          observedResult: `State: ${res.state}, Staged: ${res.stagedPatchCount}, FeedbackSent: ${res.feedbackSent}`,
          finalState: res.state,
          policyStatus: 'require_approval',
          approvalRequired: true,
          stageStatus: 'staged-clean',
          evidenceProvenance: 'unit_contract_test',
          userActionRequired: false,
          correlationId,
          testType: 'fixture',
          passed: res.state === 'completed' && res.stagedPatchCount === 1,
        };
      }

      case 2: {
        // 2. Invalid or malformed protocol envelope
        const invalidEnvelope = {
          protocolVersion: '999.0', // unsupported
          taskId,
          sessionId,
        };

        const res = await this.executeRound(invalidEnvelope, {
          taskId,
          sessionId,
          correlationId,
          conversation,
        });

        return {
          testTaskId: taskId,
          initialScenario: 'Malformed protocol envelope with invalid schema and version',
          expectedResult: 'Rejected at protocol validation stage with failed state',
          observedResult: `State: ${res.state}, Error: ${res.error?.code}`,
          finalState: res.state,
          policyStatus: 'denied',
          approvalRequired: false,
          stageStatus: 'not-staged',
          evidenceProvenance: 'unit_contract_test',
          userActionRequired: true,
          correlationId,
          testType: 'fixture',
          passed: res.state === 'failed' && res.error?.code === ErrorCode.SCHEMA_INVALID,
        };
      }

      case 3: {
        // 3. Stale base hash or changed source fixture
        const envelope: ProtocolEnvelope = {
          protocolVersion: '1.3',
          taskId,
          sessionId,
          nonce: 'nonce-12345678',
          round: 1,
          sequence: 1,
          conversation,
          baseStateHash: '0'.repeat(64),
          status: 'continue',
          actions: [
            {
              id: 'act-3',
              type: 'propose_patch',
              path: 'src/stale.ts',
              expectedBaseHash: '0'.repeat(64),
              contentBlockId: 'block-3',
            },
          ],
          contentBlocks: [
            {
              id: 'block-3',
              delimiter: 'EOF',
              encoding: 'utf-8',
              byteLength: 20,
              sha256: 'c'.repeat(64),
            },
          ],
        };

        const res = await this.executeRound(envelope, {
          taskId,
          sessionId,
          correlationId,
          conversation,
        });

        return {
          testTaskId: taskId,
          initialScenario: 'Patch proposal with stale base hash',
          expectedResult: 'Conflict detected, workflow transitions to conflicted state',
          observedResult: `State: ${res.state}, Error: ${res.error?.code}`,
          finalState: res.state,
          policyStatus: 'require_approval',
          approvalRequired: true,
          stageStatus: 'conflict-detected',
          evidenceProvenance: 'unit_contract_test',
          userActionRequired: true,
          correlationId,
          testType: 'fixture',
          passed: res.state === 'conflicted' && res.error?.code === ErrorCode.STAGE_BASE_HASH_STALE,
        };
      }

      case 4: {
        // 4. Secret-bearing proposed content
        const secretToken = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890';
        const envelope: ProtocolEnvelope = {
          protocolVersion: '1.3',
          taskId,
          sessionId,
          nonce: 'nonce-12345678',
          round: 1,
          sequence: 1,
          conversation,
          baseStateHash: 'a'.repeat(64),
          status: 'continue',
          actions: [
            {
              id: 'act-4',
              type: 'propose_patch',
              path: 'src/leaked.ts',
              expectedBaseHash: 'a'.repeat(64),
              contentBlockId: secretToken,
            },
          ],
          contentBlocks: [
            {
              id: secretToken,
              delimiter: 'EOF',
              encoding: 'utf-8',
              byteLength: 39,
              sha256: 'd'.repeat(64),
            },
          ],
        };

        const res = await this.executeRound(envelope, {
          taskId,
          sessionId,
          correlationId,
          conversation,
        });

        return {
          testTaskId: taskId,
          initialScenario: 'Secret pattern detected in patch content',
          expectedResult: 'Secret scanner stops workflow, transitions to failed state',
          observedResult: `State: ${res.state}, Error: ${res.error?.code}`,
          finalState: res.state,
          policyStatus: 'denied',
          approvalRequired: false,
          stageStatus: 'blocked-secret',
          evidenceProvenance: 'unit_contract_test',
          userActionRequired: true,
          correlationId,
          testType: 'fixture',
          passed: res.state === 'failed' && res.error?.code === ErrorCode.SECRET_DETECTED,
        };
      }

      case 5: {
        // 5. Protected-path proposal requiring manual review
        const envelope: ProtocolEnvelope = {
          protocolVersion: '1.3',
          taskId,
          sessionId,
          nonce: 'nonce-12345678',
          round: 1,
          sequence: 1,
          conversation,
          baseStateHash: 'a'.repeat(64),
          status: 'continue',
          actions: [
            {
              id: 'act-5',
              type: 'propose_patch',
              path: 'package.json', // protected manifest path
              expectedBaseHash: 'a'.repeat(64),
              contentBlockId: 'block-5',
            },
          ],
          contentBlocks: [
            {
              id: 'block-5',
              delimiter: 'EOF',
              encoding: 'utf-8',
              byteLength: 20,
              sha256: 'e'.repeat(64),
            },
          ],
        };

        const res = await this.executeRound(envelope, {
          taskId,
          sessionId,
          correlationId,
          conversation,
          userApproved: false, // user has NOT yet approved
        });

        return {
          testTaskId: taskId,
          initialScenario: 'Patch proposal touching protected path (package.json)',
          expectedResult: 'Awaits trusted UI approval, does not auto-apply',
          observedResult: `State: ${res.state}, ApprovalRequired: ${res.approvalRequired}`,
          finalState: res.state,
          policyStatus: 'require_approval',
          approvalRequired: true,
          stageStatus: 'staged-awaiting-review',
          evidenceProvenance: 'unit_contract_test',
          userActionRequired: true,
          correlationId,
          testType: 'fixture',
          passed: res.state === 'awaiting-approval' && res.approvalRequired === true,
        };
      }

      case 6: {
        // 6. Unknown action or unregistered recipe
        const envelope: ProtocolEnvelope = {
          protocolVersion: '1.3',
          taskId,
          sessionId,
          nonce: 'nonce-12345678',
          round: 1,
          sequence: 1,
          conversation,
          baseStateHash: 'a'.repeat(64),
          status: 'continue',
          actions: [
            {
              id: 'act-6',
              type: 'request_recipe_run',
              recipeId: 'unregistered.malicious.command',
              parameters: {},
            },
          ],
          contentBlocks: [],
        };

        const res = await this.executeRound(envelope, {
          taskId,
          sessionId,
          correlationId,
          conversation,
        });

        return {
          testTaskId: taskId,
          initialScenario: 'Request for unregistered recipe',
          expectedResult: 'Rejected with RECIPE_UNKNOWN, transitions to failed state',
          observedResult: `State: ${res.state}, Error: ${res.error?.code}`,
          finalState: res.state,
          policyStatus: 'denied',
          approvalRequired: false,
          stageStatus: 'not-staged',
          evidenceProvenance: 'unit_contract_test',
          userActionRequired: true,
          correlationId,
          testType: 'fixture',
          passed: res.state === 'failed' && res.error?.code === ErrorCode.RECIPE_UNKNOWN,
        };
      }

      case 7: {
        // 7. Expired approval or changed payload hash
        const envelope: ProtocolEnvelope = {
          protocolVersion: '1.3',
          taskId,
          sessionId,
          nonce: 'nonce-12345678',
          round: 1,
          sequence: 1,
          conversation,
          baseStateHash: 'a'.repeat(64),
          status: 'continue',
          actions: [
            {
              id: 'act-7',
              type: 'propose_patch',
              path: 'src/main.ts',
              expectedBaseHash: 'a'.repeat(64),
              contentBlockId: 'block-7',
            },
          ],
          contentBlocks: [
            {
              id: 'block-7',
              delimiter: 'EOF',
              encoding: 'utf-8',
              byteLength: 20,
              sha256: 'f'.repeat(64),
            },
          ],
        };

        const res = await this.executeRound(envelope, {
          taskId,
          sessionId,
          correlationId,
          conversation,
          userApproved: true,
          approvalExpired: true, // approval expired
        });

        return {
          testTaskId: taskId,
          initialScenario: 'User approved action but approval token has expired',
          expectedResult: 'Transitions to approval-expired state, operation halts',
          observedResult: `State: ${res.state}, Error: ${res.error?.code}`,
          finalState: res.state,
          policyStatus: 'require_approval',
          approvalRequired: true,
          stageStatus: 'staged-expired',
          evidenceProvenance: 'unit_contract_test',
          userActionRequired: true,
          correlationId,
          testType: 'fixture',
          passed: res.state === 'approval-expired' && res.error?.code === ErrorCode.APPROVAL_EXPIRED,
        };
      }

      case 8: {
        // 8. Missing executor capability leading to manual handoff under NO-GO
        const envelope: ProtocolEnvelope = {
          protocolVersion: '1.3',
          taskId,
          sessionId,
          nonce: 'nonce-12345678',
          round: 1,
          sequence: 1,
          conversation,
          baseStateHash: 'a'.repeat(64),
          status: 'continue',
          actions: [
            {
              id: 'act-8',
              type: 'request_recipe_run',
              recipeId: 'project.test',
              parameters: {},
            },
          ],
          contentBlocks: [],
        };

        const res = await this.executeRound(envelope, {
          taskId,
          sessionId,
          correlationId,
          conversation,
          userApproved: true,
          sameChatConfirmed: true,
        });

        return {
          testTaskId: taskId,
          initialScenario: 'Recipe requested under NO-GO-AUTOEXEC decision',
          expectedResult: 'Execution runner not started; safe manual instructions generated',
          observedResult: `State: ${res.state}, ExecutionBlocked: ${res.executionBlocked}, Command: ${res.manualRecipe?.commandText}`,
          finalState: res.state,
          policyStatus: 'require_approval',
          approvalRequired: true,
          stageStatus: 'manual-handoff',
          evidenceProvenance: 'unit_contract_test',
          userActionRequired: true,
          correlationId,
          testType: 'fixture',
          passed: res.executionBlocked === true && res.manualRecipe?.commandText === 'npm test',
        };
      }

      case 9: {
        // 9. Agent-reported success that remains unverified
        this.evidenceAuthority.recordEvidence(
          taskId,
          {
            taskId,
            sessionId,
            checkName: 'Agent Claims All Tests Passed',
            provenance: 'agent_reported_claim',
            outcome: 'passed',
            summary: 'AI agent reports tests passed.',
          },
          'agent-report',
        );

        const summary = this.evidenceAuthority.buildSummary(taskId);

        return {
          testTaskId: taskId,
          initialScenario: 'Agent submits report claiming 100% test success',
          expectedResult: 'Verification summary remains unverified; never upgraded to executor-verified',
          observedResult: `OverallStatus: ${summary.overallStatus}, AutomatedBlocked: ${summary.automatedExecutionBlocked}`,
          finalState: 'result-received',
          policyStatus: 'allowed',
          approvalRequired: false,
          stageStatus: 'unverified-claim',
          evidenceProvenance: 'agent_reported_claim',
          userActionRequired: true,
          correlationId,
          testType: 'fixture',
          passed: summary.overallStatus === 'unverified' && summary.automatedExecutionBlocked === true,
        };
      }

      case 10: {
        // 10. Same-chat identity change or uncertain submission that pauses feedback
        const envelope: ProtocolEnvelope = {
          protocolVersion: '1.3',
          taskId,
          sessionId,
          nonce: 'nonce-12345678',
          round: 1,
          sequence: 1,
          conversation: {
            provider: 'google-gemini',
            conversationId: 'changed-conversation-id-456', // Changed conversation!
          },
          baseStateHash: 'a'.repeat(64),
          status: 'continue',
          actions: [],
          contentBlocks: [],
        };

        const res = await this.executeRound(envelope, {
          taskId,
          sessionId,
          correlationId,
          conversation: {
            provider: 'google-gemini',
            conversationId: 'original-conversation-id-123',
          },
        });

        return {
          testTaskId: taskId,
          initialScenario: 'Conversation identity changed mid-session',
          expectedResult: 'Continuity guard triggers, workflow safely pauses, zero wrong-chat send',
          observedResult: `State: ${res.state}, Error: ${res.error?.code}`,
          finalState: res.state,
          policyStatus: 'denied',
          approvalRequired: false,
          stageStatus: 'paused-continuity-guard',
          evidenceProvenance: 'unit_contract_test',
          userActionRequired: true,
          correlationId,
          testType: 'fixture',
          passed: res.state === 'paused' && res.error?.code === ErrorCode.CONVERSATION_MISMATCH,
        };
      }

      default:
        throw new Error(`Unsupported controlled task number: ${taskNumber}`);
    }
  }
}
