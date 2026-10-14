/**
 * @mediator/mcp-server — Read-only Resource Handlers (Sprint S16)
 */

import {
  type Result,
  ok,
  err,
  makeMediatorError,
  ErrorCode,
  type MediatorError,
  type WorkspaceRootState,
} from '@mediator/shared-contracts';
import {
  type TaskRepository,
  type EvidenceRepository,
  type ProjectMemoryRepository,
} from '@mediator/persistence';
import {
  type StageStore,
} from '@mediator/stage-store';
import {
  loadWorkspaceRulesFile,
  assembleContextPacket,
  createInitialTaskSummary,
} from '@mediator/context-engine';
import {
  MCP_RESOURCE_URIS,
  type McpResourceUri,
} from './mcpProtocolTypes.js';
import { type McpSecurityFilter } from './mcpSecurityFilter.js';

export interface ResourceHandlerDependencies {
  readonly taskRepo: TaskRepository;
  readonly evidenceRepo?: EvidenceRepository | undefined;
  readonly memoryRepo?: ProjectMemoryRepository | undefined;
  readonly stageStore: StageStore;
  readonly rootState: WorkspaceRootState;
  readonly securityFilter: McpSecurityFilter;
}

export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

export class McpResourceHandlers {
  constructor(private readonly deps: ResourceHandlerDependencies) {}

  public async readResource(
    uri: string,
    taskId: string,
    sessionId: string,
  ): Promise<Result<McpResourceContent, MediatorError>> {
    await Promise.resolve();
    // 1. Scope validation
    const scopeCheck = this.deps.securityFilter.validateTaskScope(taskId, sessionId);
    if (!scopeCheck.ok) {
      return err(scopeCheck.error);
    }
    const task = scopeCheck.value;

    switch (uri as McpResourceUri) {
      case MCP_RESOURCE_URIS.TASK_CURRENT:
      case MCP_RESOURCE_URIS.TASK_BRIEF: {
        const payload = {
          taskId: task.taskId,
          goalSummary: task.goalSummary,
          state: task.state,
          acceptanceCriteria: task.acceptanceCriteria ?? [],
          completionStatus: task.completionStatus,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        };
        const sanitized = this.deps.securityFilter.sanitizeAndBoundOutput(payload, uri);
        if (!sanitized.ok) return err(sanitized.error);

        return ok({
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(sanitized.value, null, 2),
        });
      }

      case MCP_RESOURCE_URIS.TASK_ACCEPTANCE_CRITERIA: {
        const criteria = task.acceptanceCriteria ?? [];
        const payload = {
          taskId: task.taskId,
          acceptanceCriteria: criteria,
          totalCriteria: criteria.length,
        };
        const sanitized = this.deps.securityFilter.sanitizeAndBoundOutput(payload, uri);
        if (!sanitized.ok) return err(sanitized.error);

        return ok({
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(sanitized.value, null, 2),
        });
      }

      case MCP_RESOURCE_URIS.TASK_CHANGED_FILES: {
        const stages = this.deps.stageStore.getStagesForTask(task.taskId);
        const activeStage = stages.find((s) => s.status === 'active') ?? stages[0];
        const files = activeStage
          ? this.deps.stageStore.listStagedChanges(activeStage.stageId, this.deps.rootState)
          : [];

        const changes = files.map((f) => ({
          relativePath: f.relativePath,
          operation: f.changeType,
          isProtected: Boolean(f.isProtected),
          requiresManualReview: Boolean(f.requiresManualReview),
          conflictStatus: f.conflictStatus,
          conflictReason: f.conflictReason,
          byteLength: f.byteLength,
        }));

        const payload = {
          taskId: task.taskId,
          stageId: activeStage?.stageId ?? null,
          changedFiles: changes,
          totalChanged: changes.length,
        };
        const sanitized = this.deps.securityFilter.sanitizeAndBoundOutput(payload, uri);
        if (!sanitized.ok) return err(sanitized.error);

        return ok({
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(sanitized.value, null, 2),
        });
      }

      case MCP_RESOURCE_URIS.TASK_VERIFICATION_STATUS: {
        let evidenceItems: unknown[] = [];
        if (this.deps.evidenceRepo) {
          const raw = this.deps.evidenceRepo.getEvidenceForTask(task.taskId);
          evidenceItems = raw.map((e) => ({
            evidenceId: e.evidenceId,
            level: e.evidenceLevel, // agent-reported vs executor-verified
            summary: e.summarySafe,
            timestamp: e.createdAt,
          }));
        }

        const payload = {
          taskId: task.taskId,
          taskState: task.state,
          completionStatus: task.completionStatus,
          evidence: evidenceItems,
          totalEvidence: evidenceItems.length,
        };
        const sanitized = this.deps.securityFilter.sanitizeAndBoundOutput(payload, uri);
        if (!sanitized.ok) return err(sanitized.error);

        return ok({
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(sanitized.value, null, 2),
        });
      }

      case MCP_RESOURCE_URIS.PROJECT_RULES: {
        let rulesText = '';
        try {
          const rules = loadWorkspaceRulesFile(this.deps.rootState);
          rulesText = rules
            .map((r) => `- [${r.ruleId}] (${r.status}): ${r.title} - ${r.content}`)
            .join('\n');
        } catch {
          rulesText = '';
        }
        const rawOutput =
          rulesText.length > 0 ? `# Project Rules\n${rulesText}` : '# Project Rules\nNo custom project rules found.';

        const sanitized = this.deps.securityFilter.sanitizeAndBoundOutput(rawOutput, uri);
        if (!sanitized.ok) return err(sanitized.error);

        return ok({
          uri,
          mimeType: 'text/markdown',
          text: sanitized.value,
        });
      }

      case MCP_RESOURCE_URIS.TASK_CONTEXT: {
        // Reuse S11 context assembler
        const summary = createInitialTaskSummary({
          taskId: task.taskId,
          originalUserGoal: task.goalSummary,
          acceptanceCriteria: task.acceptanceCriteria ?? [],
          taskState: task.state,
        });

        const packet = assembleContextPacket({
          taskId: task.taskId,
          rootState: this.deps.rootState,
          summary,
        });

        const sanitized = this.deps.securityFilter.sanitizeAndBoundOutput(packet, uri);
        if (!sanitized.ok) return err(sanitized.error);

        return ok({
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(sanitized.value, null, 2),
        });
      }

      default:
        return err(
          makeMediatorError(
            ErrorCode.ACTION_NOT_FOUND,
            `Unknown or unsupported MCP resource URI: "${uri}"`,
          ),
        );
    }
  }
}
