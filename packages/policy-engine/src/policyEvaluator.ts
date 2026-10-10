/**
 * @mediator/policy-engine — Authoritative Policy Evaluator (S07)
 *
 * Single pure entry point: evaluateAction(request, context, policyConfig)
 *
 * Security invariants:
 * - Pure function: identical input + context + config yields identical decision.
 * - No side effects: does NOT mutate filesystem, DOM, or run processes.
 * - Centralized: every browser, IDE, CLI, or MCP action must pass this boundary.
 * - Fail-closed: unconfirmed roots, outside paths, secret exclusions, protected paths,
 *   unverified executors, and malformed inputs fail closed.
 */

import {
  checkPathExclusion,
  MANDATORY_EXCLUSIONS,
  isRelativePathSafe,
} from '@mediator/context-security';
import { TaskState } from '@mediator/shared-contracts';
import {
  type ActionRequest,
  type PolicyDecision,
  type PolicyEvaluationContext,
  type PolicyConfig,
  PolicyReasonCode,
} from './policyTypes.js';
import { getActionDefinition, CanonicalActionId } from './actionRegistry.js';
import { isProtectedPath } from './protectedPaths.js';
import { classifyEvidence } from './evidenceClassifier.js';
import { resolvePolicyConfig } from './policyDefaults.js';

export function evaluateAction(
  request: ActionRequest<Record<string, unknown>>,
  context: PolicyEvaluationContext,
  configOverride?: Partial<PolicyConfig>,
): PolicyDecision {
  const config = resolvePolicyConfig(configOverride);
  const actionId = request.actionId;
  const correlationId = request.correlationId;

  // ── 1. Action Registry Validation ──────────────────────────────────────────
  const actionDef = getActionDefinition(actionId);
  if (!actionDef) {
    return {
      decision: 'DENY',
      reasonCode: PolicyReasonCode.UNKNOWN_ACTION,
      actionId,
      correlationId,
      applicableRuleIds: ['RULE_KNOWN_ACTIONS_ONLY'],
      explanation: `Action '${actionId}' is not registered in the canonical 16-action registry.`,
    };
  }

  // ── 2. Parameter Schema Validation ─────────────────────────────────────────
  const parseResult = actionDef.schema.safeParse(request.parameters ?? {});
  if (!parseResult.success) {
    const errorMsg = parseResult.error.issues.map(i => i.message).join('; ');
    return {
      decision: 'DENY',
      reasonCode: PolicyReasonCode.SCHEMA_INVALID,
      actionId,
      correlationId,
      applicableRuleIds: ['RULE_SCHEMA_VALIDATION'],
      explanation: `Invalid parameters for action '${actionId}': ${errorMsg}`,
    };
  }

  const params = parseResult.data as Record<string, unknown>;

  // ── 3. Anti-Tampering Check ────────────────────────────────────────────────
  // Callers cannot pass flags attempting to override security policy
  const tamperingKeywords = ['policyoverride', 'bypass', 'forceskip', 'disablepolicy', 'grantall'];
  const rawParams = request.parameters ?? {};
  for (const [key, val] of Object.entries(rawParams)) {
    if (tamperingKeywords.includes(key.toLowerCase()) || (typeof val === 'string' && tamperingKeywords.includes(val.toLowerCase()))) {
      return {
        decision: 'DENY',
        reasonCode: PolicyReasonCode.POLICY_TAMPERING_ATTEMPT,
        actionId,
        correlationId,
        applicableRuleIds: ['RULE_IMMUTABLE_POLICY_ENFORCEMENT'],
        explanation: 'Untrusted input attempted to bypass or alter security policy enforcement.',
      };
    }
  }

  // ── 4. Task State Validation ───────────────────────────────────────────────
  if (actionDef.requiresActiveTask) {
    if (!context.task) {
      return {
        decision: 'DENY',
        reasonCode: PolicyReasonCode.TASK_STATE_INVALID,
        actionId,
        correlationId,
        applicableRuleIds: ['RULE_ACTIVE_TASK_REQUIRED'],
        explanation: `Action '${actionId}' requires an active task, but no task is attached.`,
      };
    }

    if (params.taskId && params.taskId !== context.task.id) {
      return {
        decision: 'DENY',
        reasonCode: PolicyReasonCode.TASK_ID_MISMATCH,
        actionId,
        correlationId,
        applicableRuleIds: ['RULE_TASK_IDENTITY_BOUND'],
        explanation: `Task ID in parameters ('${String(params.taskId)}') does not match active task ID ('${context.task.id}').`,
      };
    }

    // Disallow actions on stopped/failed/denied tasks
    const terminalStates: readonly string[] = [TaskState.DENIED, TaskState.FAILED_SAFE, TaskState.STOPPED];
    if (terminalStates.includes(context.task.state)) {
      return {
        decision: 'DENY',
        reasonCode: PolicyReasonCode.TASK_STATE_INVALID,
        actionId,
        correlationId,
        applicableRuleIds: ['RULE_TASK_STATE_PERMITTED'],
        explanation: `Task is in terminal state '${context.task.state}'. Further actions are prohibited.`,
      };
    }
  }

  // ── 5. Workspace Root Confirmation Gating ──────────────────────────────────
  if (actionDef.requiresWorkspace) {
    if (context.workspace.confirmationStatus !== 'confirmed') {
      return {
        decision: 'DENY',
        reasonCode: PolicyReasonCode.WORKSPACE_UNCONFIRMED,
        actionId,
        correlationId,
        applicableRuleIds: ['RULE_WORKSPACE_CONFIRMATION_GATING'],
        explanation: 'Workspace root has not been confirmed by the user. All project file operations are blocked.',
      };
    }

    if (context.workspace.resolutionStatus !== 'resolved' || !context.workspace.canonicalPath) {
      return {
        decision: 'DENY',
        reasonCode: PolicyReasonCode.WORKSPACE_UNRESOLVED,
        actionId,
        correlationId,
        applicableRuleIds: ['RULE_WORKSPACE_RESOLUTION_GATING'],
        explanation: 'Workspace root is not resolved. All project file operations are blocked.',
      };
    }
  }

  // ── 6. Lexical & Containment Traversal Defense ──────────────────────────────
  const pathsToCheck: string[] = [];
  if (params.path && typeof params.path === 'string') pathsToCheck.push(params.path);
  if (params.targetPath && typeof params.targetPath === 'string') pathsToCheck.push(params.targetPath);
  if (params.pathPrefix && typeof params.pathPrefix === 'string') pathsToCheck.push(params.pathPrefix);
  if (Array.isArray(params.filePaths)) pathsToCheck.push(...params.filePaths.filter((p: unknown) => typeof p === 'string'));
  if (Array.isArray(params.targetPaths)) pathsToCheck.push(...params.targetPaths.filter((p: unknown) => typeof p === 'string'));

  for (const targetPath of pathsToCheck) {
    if (!isRelativePathSafe(targetPath)) {
      return {
        decision: 'DENY',
        reasonCode: PolicyReasonCode.PATH_OUTSIDE_WORKSPACE,
        actionId,
        correlationId,
        applicableRuleIds: ['RULE_PATH_CONTAINMENT_LEXICAL'],
        explanation: `Path traversal or outside-workspace path denied: '${targetPath}'.`,
      };
    }
  }

  // ── 7. Secret Exclusions (Context/File Reads) ──────────────────────────────
  const readsContext =
    actionId === CanonicalActionId.READ_FILE ||
    actionId === CanonicalActionId.GET_RELEVANT_CONTEXT ||
    actionId === CanonicalActionId.REQUEST_MORE_CONTEXT;

  if (readsContext) {
    for (const targetPath of pathsToCheck) {
      const exclusion = checkPathExclusion(targetPath, MANDATORY_EXCLUSIONS);
      if (exclusion.excluded) {
        return {
          decision: 'DENY',
          reasonCode: PolicyReasonCode.PATH_EXCLUDED_SECRET,
          actionId,
          correlationId,
          applicableRuleIds: ['RULE_MANDATORY_SECRET_EXCLUSIONS', exclusion.ruleId ?? 'EXCLUSION_UNKNOWN'],
          explanation: `Access denied to sensitive file matching secret exclusion rule: ${exclusion.reason}`,
        };
      }
    }
  }

  // ── 8. Action-Specific Hard Denials & Policies ─────────────────────────────

  // 8a. Propose Patch / Staging Patches — Protected Path Tagging
  if (actionId === CanonicalActionId.PROPOSE_PATCH || actionId === CanonicalActionId.APPLY_PATCH_TO_STAGE) {
    const targetPath = typeof params.targetPath === 'string' ? params.targetPath : '';
    const protectedMatch = isProtectedPath(targetPath, config.customProtectedPatterns);

    if (protectedMatch.isProtected) {
      return {
        decision: 'ALLOW',
        reasonCode: PolicyReasonCode.OK,
        actionId,
        correlationId,
        applicableRuleIds: ['RULE_PROTECTED_PATH_STAGED_REVIEW', protectedMatch.matchedRuleId ?? 'PROTECTED'],
        explanation: `Patch staged successfully. Note: Target '${targetPath}' is a protected path (${protectedMatch.reason}) and will require manual user approval before live application.`,
        details: {
          isProtected: true,
          matchedRuleId: protectedMatch.matchedRuleId,
          category: protectedMatch.category,
        },
      };
    }
  }

  // 8b. Apply Staged Changes — Live Workspace Mutation
  if (actionId === CanonicalActionId.APPLY_STAGED_CHANGES) {
    // In Review-only V1 mode: live mutation cannot proceed automatically
    if (config.executionMode === 'review_only') {
      const approvalId = typeof params.approvalId === 'string' ? params.approvalId : undefined;
      if (!approvalId) {
        return {
          decision: 'REQUIRE_APPROVAL',
          reasonCode: PolicyReasonCode.REVIEW_ONLY_MODE_BLOCKS_MUTATION,
          actionId,
          correlationId,
          applicableRuleIds: ['RULE_REVIEW_ONLY_MODE_ADR_002'],
          explanation: 'Live workspace changes require explicit manual user approval in Review-only mode (ADR-002).',
        };
      }

      // Check if approval was provided and matches
      const existing = context.pendingApprovals?.find(a => a.approvalId === approvalId);
      if (!existing) {
        return {
          decision: 'DENY',
          reasonCode: PolicyReasonCode.APPROVAL_NOT_FOUND,
          actionId,
          correlationId,
          applicableRuleIds: ['RULE_APPROVAL_BINDING'],
          explanation: `Approval ID '${approvalId}' was not found.`,
        };
      }

      if (existing.status !== 'approved') {
        return {
          decision: 'DENY',
          reasonCode: PolicyReasonCode.APPROVAL_REQUIRED,
          actionId,
          correlationId,
          applicableRuleIds: ['RULE_APPROVAL_BINDING'],
          explanation: `Approval request '${approvalId}' has not been approved (status: ${existing.status}).`,
        };
      }
    }
  }

  // 8c. Run Recipe — Command Execution
  if (actionId === CanonicalActionId.RUN_RECIPE) {
    // Review-only mode blocks all automatic command execution
    if (config.executionMode === 'review_only' || !config.allowRecipeExecution) {
      return {
        decision: 'DENY',
        reasonCode: PolicyReasonCode.REVIEW_ONLY_MODE_BLOCKS_EXECUTION,
        actionId,
        correlationId,
        applicableRuleIds: ['RULE_REVIEW_ONLY_NO_AUTOEXEC_ADR_002'],
        explanation: 'Automatic command execution is disabled in Review-only mode (ADR-002). Commands must be reviewed and run manually.',
      };
    }

    // Check executor capability
    const hasVerifiedExecutor = context.capabilities?.get('canary.verified') === true;
    if (!hasVerifiedExecutor) {
      return {
        decision: 'UNSUPPORTED',
        reasonCode: PolicyReasonCode.CAPABILITY_MISSING,
        actionId,
        correlationId,
        applicableRuleIds: ['RULE_EXECUTOR_CANARY_CAPABILITY'],
        explanation: 'Execution adapter has not passed runtime canary verification.',
      };
    }
  }

  // 8d. Request Approval — Request creation only
  if (actionId === CanonicalActionId.REQUEST_APPROVAL) {
    const approvalId = `appr_req_${correlationId}`;
    return {
      decision: 'ALLOW',
      reasonCode: PolicyReasonCode.OK,
      actionId,
      correlationId,
      applicableRuleIds: ['RULE_APPROVAL_REQUEST_CREATION'],
      explanation: 'Approval request created and awaiting user review.',
      approvalId,
      details: {
        actionToApprove: params.actionToApprove,
        targetPaths: params.targetPaths,
        changeHash: params.changeHash,
      },
    };
  }

  // 8e. Submit Agent Report — Informational only
  if (actionId === CanonicalActionId.SUBMIT_AGENT_REPORT) {
    const detailsObj = (params.details && typeof params.details === 'object') ? (params.details as Record<string, unknown>) : undefined;
    const claimedLevel = detailsObj && typeof detailsObj.level === 'string' ? detailsObj.level : undefined;
    const summary = typeof params.summary === 'string' ? params.summary : '';
    const classification = classifyEvidence(
      request.caller.type,
      claimedLevel,
      summary,
    );

    return {
      decision: 'ALLOW',
      reasonCode: PolicyReasonCode.OK,
      actionId,
      correlationId,
      applicableRuleIds: ['RULE_AGENT_REPORT_INFORMATIONAL_ONLY'],
      explanation: 'Agent report accepted as informational evidence (agent-reported).',
      details: {
        evidenceLevel: classification.level,
        canSatisfyVerificationGate: classification.canSatisfyGate,
        untrustedClaimStripped: classification.untrustedClaimStripped,
      },
    };
  }

  // ── Default: Action Allowed ───────────────────────────────────────────────
  return {
    decision: 'ALLOW',
    reasonCode: PolicyReasonCode.OK,
    actionId,
    correlationId,
    applicableRuleIds: ['RULE_DEFAULT_ALLOW'],
    explanation: `Action '${actionId}' permitted by policy.`,
  };
}
