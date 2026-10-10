/**
 * @mediator/policy-engine — Action Registry (S07)
 *
 * Defines the canonical registry of exactly 16 supported Mediator actions.
 *
 * Invariant: Every action must be declared in this registry with its stable schema,
 * permission flags, workspace requirements, and parameter validation.
 * Any action not declared here is UNKNOWN and denied.
 */

import { z } from 'zod';
import { type EvidenceLevelValue, EvidenceLevel } from '@mediator/shared-contracts';
import { type PolicyDecisionType } from './policyTypes.js';

// ─── The 16 Canonical Action IDs ───────────────────────────────────────────

export const CanonicalActionId = {
  GET_TASK_BRIEF: 'get_task_brief',
  GET_RELEVANT_CONTEXT: 'get_relevant_context',
  LIST_STAGED_CHANGES: 'list_staged_changes',
  GET_DIFF: 'get_diff',
  READ_FILE: 'read_file',
  SEARCH_TEXT: 'search_text',
  PROPOSE_PATCH: 'propose_patch',
  REQUEST_MORE_CONTEXT: 'request_more_context',
  REQUEST_APPROVAL: 'request_approval',
  SUBMIT_AGENT_REPORT: 'submit_agent_report',
  PAUSE_TASK: 'pause_task',
  GET_CAPABILITIES: 'get_capabilities',
  APPLY_PATCH_TO_STAGE: 'apply_patch_to_stage',
  RUN_RECIPE: 'run_recipe',
  APPLY_STAGED_CHANGES: 'apply_staged_changes',
  ROLLBACK_CHECKPOINT: 'rollback_checkpoint',
} as const;

export type CanonicalActionIdValue = (typeof CanonicalActionId)[keyof typeof CanonicalActionId];

export const CANONICAL_ACTION_IDS: readonly CanonicalActionIdValue[] = Object.values(CanonicalActionId);

// ─── Action Effect Metadata ────────────────────────────────────────────────

export interface ActionEffectFlags {
  readonly readsData: boolean;
  readonly changesStaging: boolean;
  readonly affectsLiveWorkspace: boolean;
  readonly requestsApproval: boolean;
  readonly requestsExecution: boolean;
}

export interface ActionDefinition<T = unknown> {
  readonly actionId: CanonicalActionIdValue;
  readonly version: '1.0';
  readonly description: string;
  readonly effect: ActionEffectFlags;
  readonly requiresWorkspace: boolean;
  readonly requiresActiveTask: boolean;
  readonly requiresApproval: boolean;
  readonly defaultReviewOnlyDecision: PolicyDecisionType;
  readonly allowedEvidenceLevels: readonly EvidenceLevelValue[];
  readonly schema: z.ZodType<T>;
}

// ─── Zod Parameter Schemas for all 16 actions ──────────────────────────────

const DisallowedInjectionKeys = ['command', 'exec', 'shell', 'spawn', 'script', 'sudo', 'bypass', 'force'];

function refineNoCommandInjection(data: Record<string, unknown>, ctx: z.RefinementCtx): void {
  for (const key of Object.keys(data)) {
    if (DisallowedInjectionKeys.includes(key.toLowerCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Disallowed parameter key '${key}' detected. Arbitrary execution commands are forbidden.`,
      });
    }
  }
}

export const GetTaskBriefSchema = z.object({
  taskId: z.string().min(1),
}).superRefine(refineNoCommandInjection);

export const GetRelevantContextSchema = z.object({
  taskId: z.string().min(1),
  query: z.string().optional(),
  filePaths: z.array(z.string()).optional(),
  maxBytes: z.number().positive().max(1024 * 1024).optional(),
}).superRefine(refineNoCommandInjection);

export const ListStagedChangesSchema = z.object({
  taskId: z.string().min(1),
}).superRefine(refineNoCommandInjection);

export const GetDiffSchema = z.object({
  taskId: z.string().min(1),
  path: z.string().optional(),
}).superRefine(refineNoCommandInjection);

export const ReadFileSchema = z.object({
  path: z.string().min(1),
  taskId: z.string().optional(),
}).superRefine(refineNoCommandInjection);

export const SearchTextSchema = z.object({
  query: z.string().min(1),
  pathPrefix: z.string().optional(),
  maxResults: z.number().int().positive().max(500).optional(),
}).superRefine(refineNoCommandInjection);

export const ProposePatchSchema = z.object({
  taskId: z.string().min(1),
  targetPath: z.string().min(1),
  patchContent: z.string().min(1),
  description: z.string().optional(),
}).superRefine(refineNoCommandInjection);

export const RequestMoreContextSchema = z.object({
  taskId: z.string().min(1),
  reason: z.string().min(1),
  filePaths: z.array(z.string()).optional(),
}).superRefine(refineNoCommandInjection);

export const RequestApprovalSchema = z.object({
  taskId: z.string().min(1),
  actionToApprove: z.string().min(1),
  targetPaths: z.array(z.string()),
  changeHash: z.string().min(1),
  reason: z.string().min(1),
}).superRefine(refineNoCommandInjection);

export const SubmitAgentReportSchema = z.object({
  taskId: z.string().min(1),
  summary: z.string().min(1),
  claimType: z.string().min(1),
  claimedResult: z.enum(['passed', 'failed', 'inconclusive']),
  details: z.record(z.unknown()).optional(),
}).superRefine(refineNoCommandInjection);

export const PauseTaskSchema = z.object({
  taskId: z.string().min(1),
  reason: z.string().min(1),
}).superRefine(refineNoCommandInjection);

export const GetCapabilitiesSchema = z.object({
  // No required params
}).superRefine(refineNoCommandInjection);

export const ApplyPatchToStageSchema = z.object({
  taskId: z.string().min(1),
  targetPath: z.string().min(1),
  patchContent: z.string().min(1),
}).superRefine(refineNoCommandInjection);

export const RunRecipeSchema = z.object({
  recipeId: z.string().min(1),
  taskId: z.string().min(1),
  parameters: z.record(z.unknown()).optional(),
}).superRefine((data, ctx) => {
  refineNoCommandInjection(data, ctx);
  // Specifically verify recipeId is NOT a raw shell command or path
  if (data.recipeId.includes('/') || data.recipeId.includes('\\') || data.recipeId.includes(' ') || data.recipeId.includes(';')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid recipe ID '${data.recipeId}'. Recipes must be pinned identifiers (e.g. 'project.test'), not shell commands.`,
    });
  }
});

export const ApplyStagedChangesSchema = z.object({
  taskId: z.string().min(1),
  approvalId: z.string().optional(),
}).superRefine(refineNoCommandInjection);

export const RollbackCheckpointSchema = z.object({
  taskId: z.string().min(1),
  checkpointId: z.string().min(1),
}).superRefine(refineNoCommandInjection);

// ─── The Canonical Registry Map ────────────────────────────────────────────

export const ACTION_REGISTRY: ReadonlyMap<string, ActionDefinition> = new Map<string, ActionDefinition>([
  [
    CanonicalActionId.GET_TASK_BRIEF,
    {
      actionId: CanonicalActionId.GET_TASK_BRIEF,
      version: '1.0',
      description: 'Fetch task definition and brief description',
      effect: {
        readsData: true,
        changesStaging: false,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: false,
      requiresActiveTask: true,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [],
      schema: GetTaskBriefSchema,
    },
  ],
  [
    CanonicalActionId.GET_RELEVANT_CONTEXT,
    {
      actionId: CanonicalActionId.GET_RELEVANT_CONTEXT,
      version: '1.0',
      description: 'Retrieve filtered, secret-scanned context files for task',
      effect: {
        readsData: true,
        changesStaging: false,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: true,
      requiresActiveTask: true,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [],
      schema: GetRelevantContextSchema,
    },
  ],
  [
    CanonicalActionId.LIST_STAGED_CHANGES,
    {
      actionId: CanonicalActionId.LIST_STAGED_CHANGES,
      version: '1.0',
      description: 'List current staged file changes in shadow workspace',
      effect: {
        readsData: true,
        changesStaging: false,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: true,
      requiresActiveTask: true,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [],
      schema: ListStagedChangesSchema,
    },
  ],
  [
    CanonicalActionId.GET_DIFF,
    {
      actionId: CanonicalActionId.GET_DIFF,
      version: '1.0',
      description: 'Get unified diff between staging store and workspace',
      effect: {
        readsData: true,
        changesStaging: false,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: true,
      requiresActiveTask: true,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [],
      schema: GetDiffSchema,
    },
  ],
  [
    CanonicalActionId.READ_FILE,
    {
      actionId: CanonicalActionId.READ_FILE,
      version: '1.0',
      description: 'Read file contents from canonical workspace through boundary',
      effect: {
        readsData: true,
        changesStaging: false,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: true,
      requiresActiveTask: false,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [],
      schema: ReadFileSchema,
    },
  ],
  [
    CanonicalActionId.SEARCH_TEXT,
    {
      actionId: CanonicalActionId.SEARCH_TEXT,
      version: '1.0',
      description: 'Search text in workspace files within canonical root',
      effect: {
        readsData: true,
        changesStaging: false,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: true,
      requiresActiveTask: false,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [],
      schema: SearchTextSchema,
    },
  ],
  [
    CanonicalActionId.PROPOSE_PATCH,
    {
      actionId: CanonicalActionId.PROPOSE_PATCH,
      version: '1.0',
      description: 'Propose a patch for user review and eventual staging',
      effect: {
        readsData: false,
        changesStaging: false,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: true,
      requiresActiveTask: true,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [],
      schema: ProposePatchSchema,
    },
  ],
  [
    CanonicalActionId.REQUEST_MORE_CONTEXT,
    {
      actionId: CanonicalActionId.REQUEST_MORE_CONTEXT,
      version: '1.0',
      description: 'Request additional files or context from the local workspace',
      effect: {
        readsData: true,
        changesStaging: false,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: true,
      requiresActiveTask: true,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [],
      schema: RequestMoreContextSchema,
    },
  ],
  [
    CanonicalActionId.REQUEST_APPROVAL,
    {
      actionId: CanonicalActionId.REQUEST_APPROVAL,
      version: '1.0',
      description: 'Create a pending user approval request for a sensitive action',
      effect: {
        readsData: false,
        changesStaging: false,
        affectsLiveWorkspace: false,
        requestsApproval: true,
        requestsExecution: false,
      },
      requiresWorkspace: true,
      requiresActiveTask: true,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [],
      schema: RequestApprovalSchema,
    },
  ],
  [
    CanonicalActionId.SUBMIT_AGENT_REPORT,
    {
      actionId: CanonicalActionId.SUBMIT_AGENT_REPORT,
      version: '1.0',
      description: 'Submit an informational agent claim or test summary',
      effect: {
        readsData: false,
        changesStaging: false,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: false,
      requiresActiveTask: true,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [EvidenceLevel.AGENT_REPORTED],
      schema: SubmitAgentReportSchema,
    },
  ],
  [
    CanonicalActionId.PAUSE_TASK,
    {
      actionId: CanonicalActionId.PAUSE_TASK,
      version: '1.0',
      description: 'Pause the current task and halt further automation',
      effect: {
        readsData: false,
        changesStaging: false,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: false,
      requiresActiveTask: true,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [],
      schema: PauseTaskSchema,
    },
  ],
  [
    CanonicalActionId.GET_CAPABILITIES,
    {
      actionId: CanonicalActionId.GET_CAPABILITIES,
      version: '1.0',
      description: 'Query verified local runtime and executor capabilities',
      effect: {
        readsData: true,
        changesStaging: false,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: false,
      requiresActiveTask: false,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [],
      schema: GetCapabilitiesSchema,
    },
  ],
  [
    CanonicalActionId.APPLY_PATCH_TO_STAGE,
    {
      actionId: CanonicalActionId.APPLY_PATCH_TO_STAGE,
      version: '1.0',
      description: 'Apply a proposed patch to the isolated staging store (NOT live workspace)',
      effect: {
        readsData: false,
        changesStaging: true,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: true,
      requiresActiveTask: true,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [],
      schema: ApplyPatchToStageSchema,
    },
  ],
  [
    CanonicalActionId.RUN_RECIPE,
    {
      actionId: CanonicalActionId.RUN_RECIPE,
      version: '1.0',
      description: 'Request execution of a hash-pinned, approved verification recipe',
      effect: {
        readsData: false,
        changesStaging: false,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: true,
      },
      requiresWorkspace: true,
      requiresActiveTask: true,
      requiresApproval: true,
      defaultReviewOnlyDecision: 'DENY',
      allowedEvidenceLevels: [EvidenceLevel.MEDIATOR_EXECUTOR_VERIFIED],
      schema: RunRecipeSchema,
    },
  ],
  [
    CanonicalActionId.APPLY_STAGED_CHANGES,
    {
      actionId: CanonicalActionId.APPLY_STAGED_CHANGES,
      version: '1.0',
      description: 'Apply approved staged changes into live workspace files',
      effect: {
        readsData: false,
        changesStaging: false,
        affectsLiveWorkspace: true,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: true,
      requiresActiveTask: true,
      requiresApproval: true,
      defaultReviewOnlyDecision: 'REQUIRE_APPROVAL',
      allowedEvidenceLevels: [],
      schema: ApplyStagedChangesSchema,
    },
  ],
  [
    CanonicalActionId.ROLLBACK_CHECKPOINT,
    {
      actionId: CanonicalActionId.ROLLBACK_CHECKPOINT,
      version: '1.0',
      description: 'Roll back staging store to a previous safe checkpoint',
      effect: {
        readsData: false,
        changesStaging: true,
        affectsLiveWorkspace: false,
        requestsApproval: false,
        requestsExecution: false,
      },
      requiresWorkspace: true,
      requiresActiveTask: true,
      requiresApproval: false,
      defaultReviewOnlyDecision: 'ALLOW',
      allowedEvidenceLevels: [],
      schema: RollbackCheckpointSchema,
    },
  ],
]);

export function getActionDefinition(actionId: string): ActionDefinition | undefined {
  return ACTION_REGISTRY.get(actionId);
}

export function isCanonicalActionId(id: string): id is CanonicalActionIdValue {
  return ACTION_REGISTRY.has(id);
}
