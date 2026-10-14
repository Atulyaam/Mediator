/**
 * @mediator/mcp-server — Read-only Tool Handlers (Sprint S16)
 *
 * Implements the 5 canonical read-only tools:
 * 1. mediator.get_capabilities
 * 2. mediator.get_task_brief
 * 3. mediator.get_relevant_context
 * 4. mediator.get_staged_changes
 * 5. mediator.get_diff
 *
 * Strictly read-only, bounds sizes, redacts secrets, validates task scope.
 */

import {
  type Result,
  err,
  makeMediatorError,
  ErrorCode,
  type MediatorError,
  type WorkspaceRootState,
} from '@mediator/shared-contracts';
import { type TaskRepository } from '@mediator/persistence';
import { type StageStore, type ReviewIntakeService } from '@mediator/stage-store';
import {
  assembleContextPacket,
  createInitialTaskSummary,
} from '@mediator/context-engine';
import { validateContainedPath } from '@mediator/workspace-boundary';
import { checkPathExclusion, MANDATORY_EXCLUSIONS } from '@mediator/context-security';
import { type IdeWorkspaceAdapter } from '@mediator/ide-adapter-vscode';
import {
  MCP_TOOL_NAMES,
  GetTaskBriefArgsSchema,
  GetRelevantContextArgsSchema,
  GetStagedChangesArgsSchema,
  GetDiffArgsSchema,
  GetCapabilitiesArgsSchema,
  RequestReviewArgsSchema,
} from './mcpProtocolTypes.js';
import { type McpSecurityFilter } from './mcpSecurityFilter.js';

export interface ToolHandlerDependencies {
  readonly taskRepo: TaskRepository;
  readonly stageStore: StageStore;
  readonly ideAdapter: IdeWorkspaceAdapter;
  readonly rootState: WorkspaceRootState;
  readonly securityFilter: McpSecurityFilter;
  readonly reviewIntakeService?: ReviewIntakeService | undefined;
}

export class McpToolHandlers {
  constructor(private readonly deps: ToolHandlerDependencies) {}

  public async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Result<unknown, MediatorError>> {
    await Promise.resolve();
    // 1. Prohibit mutation tools unconditionally
    const allowedCheck = this.deps.securityFilter.checkOperationAllowed(name);
    if (!allowedCheck.ok) {
      return err(allowedCheck.error);
    }

    switch (name) {
      case MCP_TOOL_NAMES.GET_CAPABILITIES: {
        const parsed = GetCapabilitiesArgsSchema.safeParse(args);
        if (!parsed.success) {
          return err(
            makeMediatorError(
              ErrorCode.SCHEMA_INVALID,
              `Invalid arguments for ${name}: ${parsed.error.message}`,
            ),
          );
        }
        const caps = this.deps.ideAdapter.getCapabilities(parsed.data.correlationId);
        const sanitized = this.deps.securityFilter.sanitizeAndBoundOutput(caps, name);
        return sanitized;
      }

      case MCP_TOOL_NAMES.GET_TASK_BRIEF: {
        const parsed = GetTaskBriefArgsSchema.safeParse(args);
        if (!parsed.success) {
          return err(
            makeMediatorError(
              ErrorCode.SCHEMA_INVALID,
              `Invalid arguments for ${name}: ${parsed.error.message}`,
            ),
          );
        }

        const scopeRes = this.deps.securityFilter.validateTaskScope(
          parsed.data.taskId,
          parsed.data.sessionId,
        );
        if (!scopeRes.ok) return err(scopeRes.error);
        const task = scopeRes.value;

        const brief = {
          taskId: task.taskId,
          goal: task.goalSummary,
          acceptanceCriteria: task.acceptanceCriteria ?? [],
          state: task.state,
          completionStatus: task.completionStatus,
          createdAt: task.createdAt,
        };

        return this.deps.securityFilter.sanitizeAndBoundOutput(brief, name);
      }

      case MCP_TOOL_NAMES.GET_RELEVANT_CONTEXT: {
        const parsed = GetRelevantContextArgsSchema.safeParse(args);
        if (!parsed.success) {
          return err(
            makeMediatorError(
              ErrorCode.SCHEMA_INVALID,
              `Invalid arguments for ${name}: ${parsed.error.message}`,
            ),
          );
        }

        const scopeRes = this.deps.securityFilter.validateTaskScope(
          parsed.data.taskId,
          parsed.data.sessionId,
        );
        if (!scopeRes.ok) return err(scopeRes.error);
        const task = scopeRes.value;

        // Validate requested file paths against containment and exclusions
        let validPaths: string[] | undefined = undefined;
        if (parsed.data.requestedFilePaths) {
          validPaths = [];
          for (const relPath of parsed.data.requestedFilePaths) {
            const pathCheck = validateContainedPath(this.deps.rootState, relPath);
            if (!pathCheck.ok) {
              return err(pathCheck.error);
            }
            const exclusion = checkPathExclusion(relPath, MANDATORY_EXCLUSIONS);
            if (exclusion.excluded) {
              return err(
                makeMediatorError(
                  ErrorCode.PATH_EXCLUDED,
                  `Path "${relPath}" is excluded by security policy: ${exclusion.reason ?? 'sensitive file'}`,
                ),
              );
            }
            validPaths.push(relPath);
          }
        }

        const summary = createInitialTaskSummary({
          taskId: task.taskId,
          originalUserGoal: task.goalSummary,
          acceptanceCriteria: task.acceptanceCriteria ?? [],
          taskState: task.state,
        });

        const maxBytes = parsed.data.maxBytes ?? 64 * 1024;
        const packet = assembleContextPacket({
          taskId: task.taskId,
          rootState: this.deps.rootState,
          summary,
          requestedFilePaths: validPaths,
          budget: {
            maxTotalBytes: maxBytes,
            maxExcerptBytes: 16 * 1024,
          },
        });

        return this.deps.securityFilter.sanitizeAndBoundOutput(packet, name);
      }

      case MCP_TOOL_NAMES.GET_STAGED_CHANGES: {
        const parsed = GetStagedChangesArgsSchema.safeParse(args);
        if (!parsed.success) {
          return err(
            makeMediatorError(
              ErrorCode.SCHEMA_INVALID,
              `Invalid arguments for ${name}: ${parsed.error.message}`,
            ),
          );
        }

        const scopeRes = this.deps.securityFilter.validateTaskScope(
          parsed.data.taskId,
          parsed.data.sessionId,
        );
        if (!scopeRes.ok) return err(scopeRes.error);

        // Stage scope validation: verify stage belongs to authorized task
        let targetStageId = parsed.data.stageId;
        if (targetStageId) {
          const stage = this.deps.stageStore.getStage(targetStageId);
          if (!stage || stage.taskId !== parsed.data.taskId) {
            return err(
              makeMediatorError(
                ErrorCode.UNAUTHORIZED_TASK_SCOPE,
                `Stage '${targetStageId}' does not belong to authorized task '${parsed.data.taskId}'`,
              ),
            );
          }
        } else {
          const stages = this.deps.stageStore.getStagesForTask(parsed.data.taskId);
          const activeStage = stages.find((s) => s.status === 'active') ?? stages[0];
          targetStageId = activeStage?.stageId;
        }

        const files = targetStageId
          ? this.deps.stageStore.listStagedChanges(targetStageId, this.deps.rootState)
          : [];

        const summary = files.map((f) => ({
          relativePath: f.relativePath,
          operation: f.changeType,
          isProtected: Boolean(f.isProtected),
          requiresManualReview: Boolean(f.requiresManualReview),
          conflictStatus: f.conflictStatus,
          conflictReason: f.conflictReason,
          byteLength: f.byteLength,
        }));

        const result = {
          taskId: parsed.data.taskId,
          stageId: targetStageId ?? null,
          stagedFiles: summary,
          totalCount: summary.length,
        };

        return this.deps.securityFilter.sanitizeAndBoundOutput(result, name);
      }

      case MCP_TOOL_NAMES.GET_DIFF: {
        const parsed = GetDiffArgsSchema.safeParse(args);
        if (!parsed.success) {
          return err(
            makeMediatorError(
              ErrorCode.SCHEMA_INVALID,
              `Invalid arguments for ${name}: ${parsed.error.message}`,
            ),
          );
        }

        const scopeRes = this.deps.securityFilter.validateTaskScope(
          parsed.data.taskId,
          parsed.data.sessionId,
        );
        if (!scopeRes.ok) return err(scopeRes.error);

        // Path validation on relativePath if provided
        if (parsed.data.relativePath) {
          const pathCheck = validateContainedPath(this.deps.rootState, parsed.data.relativePath);
          if (!pathCheck.ok) {
            return err(pathCheck.error);
          }
          const exclusion = checkPathExclusion(parsed.data.relativePath, MANDATORY_EXCLUSIONS);
          if (exclusion.excluded) {
            return err(
              makeMediatorError(
                ErrorCode.PATH_EXCLUDED,
                `Path "${parsed.data.relativePath}" is excluded by security policy: ${exclusion.reason ?? 'sensitive file'}`,
              ),
            );
          }
        }

        // Verify stage ownership
        let targetStageId = parsed.data.stageId;
        if (targetStageId) {
          const stage = this.deps.stageStore.getStage(targetStageId);
          if (!stage || stage.taskId !== parsed.data.taskId) {
            return err(
              makeMediatorError(
                ErrorCode.UNAUTHORIZED_TASK_SCOPE,
                `Stage '${targetStageId}' does not belong to authorized task '${parsed.data.taskId}'`,
              ),
            );
          }
        } else {
          const stages = this.deps.stageStore.getStagesForTask(parsed.data.taskId);
          const activeStage = stages.find((s) => s.status === 'active') ?? stages[0];
          targetStageId = activeStage?.stageId;
        }

        if (!targetStageId) {
          return this.deps.securityFilter.sanitizeAndBoundOutput(
            {
              taskId: parsed.data.taskId,
              stageId: null,
              diffs: [],
              diffText: '',
              totalDiffs: 0,
            },
            name,
          );
        }

        try {
          const previews = this.deps.stageStore.getStageDiff(
            targetStageId,
            this.deps.rootState,
            parsed.data.relativePath,
          );

          const output = {
            taskId: parsed.data.taskId,
            stageId: targetStageId,
            relativePath: parsed.data.relativePath ?? 'all',
            diffs: previews.map((p) => ({
              relativePath: p.relativePath,
              changeType: p.changeType,
              diffText: p.diffText,
              stats: p.stats,
              isBinary: p.isBinary,
              isProtected: p.isProtected,
            })),
            totalDiffs: previews.length,
          };

          return this.deps.securityFilter.sanitizeAndBoundOutput(output, name);
        } catch (diffErr: unknown) {
          const msg = diffErr instanceof Error ? diffErr.message : String(diffErr);
          return err(
            makeMediatorError(
              ErrorCode.STAGE_NOT_FOUND,
              `Failed to generate diff preview: ${msg}`,
            ),
          );
        }
      }

      case MCP_TOOL_NAMES.REQUEST_REVIEW: {
        const parsed = RequestReviewArgsSchema.safeParse(args);
        if (!parsed.success) {
          return err(
            makeMediatorError(
              ErrorCode.SCHEMA_INVALID,
              `Invalid arguments for ${name}: ${parsed.error.message}`,
            ),
          );
        }

        const taskCheck = this.deps.securityFilter.validateTaskScope(
          parsed.data.taskId,
          parsed.data.sessionId,
        );
        if (!taskCheck.ok) return err(taskCheck.error);

        if (!this.deps.reviewIntakeService) {
          return err(
            makeMediatorError(
              ErrorCode.CAPABILITY_UNAVAILABLE,
              'Review intake service is not configured on this MCP server instance',
            ),
          );
        }

        const intakeRes = this.deps.reviewIntakeService.createReviewRequest({
          taskId: parsed.data.taskId,
          sessionId: parsed.data.sessionId,
          actionId: parsed.data.actionId,
          stageId: parsed.data.stageId,
          payloadHash: parsed.data.payloadHash,
          requestedScope: parsed.data.requestedScope,
          origin: 'mcp_server',
          reason: parsed.data.reason,
          correlationId: parsed.data.correlationId,
        });

        if (!intakeRes.ok) return err(intakeRes.error);

        const resultOutput = {
          requestId: intakeRes.value.requestId,
          status: intakeRes.value.status,
          message:
            'Review request recorded for human review in IDE UI. This creates a pending request only and does not authorize changes.',
          taskId: intakeRes.value.taskId,
          sessionId: intakeRes.value.sessionId,
          requestedScope: intakeRes.value.requestedScope,
          expiresAt: intakeRes.value.expiresAt,
        };

        return this.deps.securityFilter.sanitizeAndBoundOutput(resultOutput, name);
      }

      default:
        return err(
          makeMediatorError(
            ErrorCode.ACTION_NOT_FOUND,
            `Unknown MCP tool: "${name}". MCP context server registers only read tools.`,
          ),
        );
    }
  }
}
