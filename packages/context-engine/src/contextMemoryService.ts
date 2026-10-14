/**
 * @mediator/context-engine — Context Memory Service & Orchestration (S11)
 *
 * Requirements:
 * - High-level memory management API:
 *   - getTaskSummary, updateTaskSummary
 *   - getProjectMap, refreshProjectMap
 *   - listProjectRules, addProjectRule
 *   - listDecisions, recordDecision
 *   - listKnownIssues, recordKnownIssue
 *   - previewContextPacket
 *   - exportRedactedSummary
 *   - clearTaskMemory (with explicit confirmation; preserves audit chain)
 * - Integration with SQLite persistence (@mediator/persistence).
 */

import {
  type WorkspaceRootState,
} from '@mediator/shared-contracts';
import {
  type DatabaseConnection,
  type TaskRepository,
  type ContextSummaryRepository,
  type ProjectMemoryRepository,
  type AuditRepository,
  safeRedactString,
} from '@mediator/persistence';
import { ContextEngineError, ContextEngineErrorCode } from './errors.js';
import {
  type TaskSummary,
  createInitialTaskSummary,
  serializeTaskSummary,
  deserializeTaskSummary,
} from './taskSummary.js';
import {
  type ProjectMap,
  type ScanProjectOptions,
  scanProjectMap,
} from './projectMap.js';
import {
  type ProjectRule,
  validateRuleContentSafety,
} from './projectRules.js';
import { type ArchitecturalDecision } from './decisionMemory.js';
import { type KnownIssue } from './knownIssues.js';
import {
  type AssembleContextParams,
  type AssembledContextPacket,
  assembleContextPacket,
} from './contextAssembler.js';

export interface ContextMemoryServiceDependencies {
  readonly db: DatabaseConnection;
  readonly taskRepo: TaskRepository;
  readonly summaryRepo: ContextSummaryRepository;
  readonly projectMemoryRepo: ProjectMemoryRepository;
  readonly auditRepo?: AuditRepository | undefined;
}

export interface ClearMemoryConfirmation {
  readonly confirmClear: boolean;
  readonly userRequested: boolean;
}

export class ContextMemoryService {
  constructor(private readonly deps: ContextMemoryServiceDependencies) {}

  /**
   * Retrieves the current rolling task summary from SQLite, falling back safely if absent.
   */
  public getTaskSummary(taskId: string): TaskSummary {
    const record = this.deps.summaryRepo.getLatestSummaryForTask(taskId, 'rolling_summary');
    if (record) {
      return deserializeTaskSummary(record.summaryText, taskId);
    }

    // Fallback: check if task exists in task repository
    const taskRecord = this.deps.taskRepo.getTask(taskId);
    if (taskRecord) {
      return createInitialTaskSummary({
        taskId: taskRecord.taskId,
        originalUserGoal: taskRecord.goalSummary,
        acceptanceCriteria: taskRecord.acceptanceCriteria ?? [],
        taskState: taskRecord.state,
      });
    }

    return createInitialTaskSummary({
      taskId,
      originalUserGoal: 'Initialized task summary',
    });
  }

  /**
   * Saves or updates a rolling task summary in SQLite.
   */
  public saveTaskSummary(summary: TaskSummary): void {
    const serialized = serializeTaskSummary(summary);
    const summaryId = `summary-${summary.taskId}-${Date.now()}`;
    this.deps.summaryRepo.recordSummary({
      summaryId,
      taskId: summary.taskId,
      topic: 'rolling_summary',
      summaryText: serialized,
    });
  }

  /**
   * Updates task summary through an authorized updater function and persists it.
   */
  public updateTaskSummary(
    taskId: string,
    updater: (current: TaskSummary) => TaskSummary,
  ): TaskSummary {
    const current = this.getTaskSummary(taskId);
    const updated = updater(current);
    this.saveTaskSummary(updated);
    return updated;
  }

  /**
   * Retrieves persisted project map for workspace.
   */
  public getProjectMap(workspaceId: string): ProjectMap | undefined {
    const record = this.deps.projectMemoryRepo.getProjectMap(workspaceId);
    if (!record) return undefined;
    try {
      return JSON.parse(record.mapJson) as ProjectMap;
    } catch {
      return undefined;
    }
  }

  /**
   * Scans and refreshes the project map, persisting it in SQLite.
   */
  public refreshProjectMap(
    rootState: WorkspaceRootState,
    options?: ScanProjectOptions,
  ): ProjectMap {
    const workspaceId =
      rootState.selectedPath.toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'workspace';
    const previousMap = options?.previousMap ?? this.getProjectMap(workspaceId);

    const map = scanProjectMap(rootState, {
      ...options,
      previousMap,
    });

    this.deps.projectMemoryRepo.upsertProjectMap({
      workspaceId: map.workspaceId,
      projectName: map.projectName,
      rootPath: map.canonicalRoot,
      mapJson: JSON.stringify(map),
      lastScannedAt: map.lastScannedAt,
      version: map.version,
    });

    return map;
  }

  /**
   * Lists approved or proposed project rules for workspace.
   */
  public listProjectRules(
    workspaceId: string,
    status?: 'approved' | 'proposed',
  ): ProjectRule[] {
    const records = this.deps.projectMemoryRepo.getMemoryItems(
      workspaceId,
      'rule',
      status,
    );
    return records.map((r) => ({
      ruleId: r.itemId,
      title: r.title,
      content: r.content,
      authorType: r.authorType,
      status: r.status as 'approved' | 'proposed',
      scope: r.metadata,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /**
   * Adds or updates a project rule in SQLite memory.
   */
  public addProjectRule(workspaceId: string, rule: ProjectRule): void {
    validateRuleContentSafety(rule.content);
    this.deps.projectMemoryRepo.recordMemoryItem({
      itemId: rule.ruleId,
      workspaceId,
      category: 'rule',
      title: rule.title,
      content: rule.content,
      status: rule.status,
      authorType: rule.authorType,
      metadata: rule.scope,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    });
  }

  /**
   * Lists architectural decisions for workspace.
   */
  public listDecisions(workspaceId: string): ArchitecturalDecision[] {
    const records = this.deps.projectMemoryRepo.getMemoryItems(workspaceId, 'decision');
    return records.map((r) => ({
      decisionId: r.itemId,
      title: r.title,
      rationale: r.content,
      status: r.status as 'approved' | 'proposed',
      authorType: r.authorType,
      relatedTaskId: r.relatedTaskId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /**
   * Records an architectural decision in SQLite memory.
   */
  public recordDecision(workspaceId: string, decision: ArchitecturalDecision): void {
    this.deps.projectMemoryRepo.recordMemoryItem({
      itemId: decision.decisionId,
      workspaceId,
      category: 'decision',
      title: decision.title,
      content: decision.rationale,
      status: decision.status,
      authorType: decision.authorType,
      relatedTaskId: decision.relatedTaskId,
      createdAt: decision.createdAt,
      updatedAt: decision.updatedAt,
    });
  }

  /**
   * Lists known issues for workspace.
   */
  public listKnownIssues(workspaceId: string): KnownIssue[] {
    const records = this.deps.projectMemoryRepo.getMemoryItems(
      workspaceId,
      'known_issue',
    );
    return records.map((r) => {
      let fixes: string[] = [];
      try {
        if (r.metadata) {
          const parsedFixes: unknown = JSON.parse(r.metadata);
          if (Array.isArray(parsedFixes)) {
            fixes = parsedFixes.filter((f): f is string => typeof f === 'string');
          }
        }
      } catch {
        // Ignore
      }
      return {
        issueId: r.itemId,
        title: r.title,
        description: r.content,
        attemptedFixes: fixes,
        status: r.status === 'approved' ? 'resolved' : 'unresolved',
        relatedTaskId: r.relatedTaskId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  /**
   * Records a known issue in SQLite memory.
   */
  public recordKnownIssue(workspaceId: string, issue: KnownIssue): void {
    this.deps.projectMemoryRepo.recordMemoryItem({
      itemId: issue.issueId,
      workspaceId,
      category: 'known_issue',
      title: issue.title,
      content: issue.description,
      status: issue.status === 'resolved' ? 'approved' : 'proposed',
      authorType: 'user',
      relatedTaskId: issue.relatedTaskId,
      metadata: JSON.stringify(issue.attemptedFixes),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    });
  }

  /**
   * Previews a context packet before assembly or transmission.
   */
  public previewContextPacket(
    params: AssembleContextParams,
  ): { packet: AssembledContextPacket; previewSummary: string } {
    const packet = assembleContextPacket(params);
    const summaryLines = [
      `=== Context Packet Preview (Task: ${packet.taskId}) ===`,
      `State: ${packet.taskState} | Round: ${packet.round}`,
      `Total UTF-8 Bytes: ${packet.totalBytes} | Approx Tokens: ${packet.approximateTokens} (${packet.tokenEstimateLabel})`,
      `Items Included: ${packet.items.length} | Omissions: ${packet.omissionMarkers.length}`,
      `Items Breakdown:`,
      ...packet.items.map(
        (i) => ` - [Rank ${i.priorityRank}] ${i.title} (${i.byteSize} bytes) -> Reason: ${i.inclusionReason}`,
      ),
      packet.omissionMarkers.length > 0 ? `Omission Markers:` : '',
      ...packet.omissionMarkers.map((o) => ` - [OMITTED] ${o.title}: ${o.reason}`),
    ]
      .filter(Boolean)
      .join('\n');

    return { packet, previewSummary: summaryLines };
  }

  /**
   * Exports a redacted task summary safely.
   */
  public exportRedactedSummary(taskId: string): string {
    const summary = this.getTaskSummary(taskId);
    const serialized = serializeTaskSummary(summary);
    return safeRedactString(serialized);
  }

  /**
   * Clears optional task memory with explicit user confirmation.
   * INVARIANT: Never deletes tasks, actions, approvals, evidence, or audit events!
   */
  public clearTaskMemory(
    taskId: string,
    confirmation: ClearMemoryConfirmation,
  ): { cleared: boolean; taskSummaryDeleted: boolean } {
    if (!confirmation.confirmClear || !confirmation.userRequested) {
      throw new ContextEngineError(
        ContextEngineErrorCode.MEMORY_CLEAR_CONFIRMATION_REQUIRED,
        'Clearing task memory requires explicit user confirmation ({ confirmClear: true, userRequested: true })',
        { detail: { taskId } },
      );
    }

    const count = this.deps.summaryRepo.deleteSummariesForTask(taskId, 'rolling_summary');

    if (this.deps.auditRepo) {
      this.deps.auditRepo.appendEvent({
        taskId,
        sessionId: 'session-local',
        correlationId: `clear-${Date.now()}`,
        eventType: 'CONTEXT_MEMORY_CLEARED',
        details: {
          taskId,
          summariesDeleted: count,
          userConfirmed: true,
        },
      });
    }

    return {
      cleared: true,
      taskSummaryDeleted: count > 0,
    };
  }
}
