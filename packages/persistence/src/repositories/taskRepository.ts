/**
 * @mediator/persistence — Task Repository (S10)
 */

import { TaskState, type TaskStateValue } from '@mediator/shared-contracts';
import { type DatabaseConnection } from '../database.js';
import { PersistenceError, PersistenceErrorCode } from '../errors.js';

export interface TaskRecord {
  readonly taskId: string;
  readonly goalSummary: string;
  readonly acceptanceCriteria?: string[] | undefined;
  readonly state: TaskStateValue;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completionStatus: string;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface CreateTaskParams {
  readonly taskId: string;
  readonly goalSummary: string;
  readonly acceptanceCriteria?: string[] | undefined;
  readonly state?: TaskStateValue | undefined;
  readonly createdAt?: number | undefined;
  readonly completionStatus?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export class TaskRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public createTask(params: CreateTaskParams): TaskRecord {
    const now = params.createdAt ?? Date.now();
    const criteriaJson = params.acceptanceCriteria ? JSON.stringify(params.acceptanceCriteria) : null;
    const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;
    const completionStatus = params.completionStatus ?? 'none';
    const state = params.state ?? TaskState.TASK_DEFINED;

    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        task_id,
        goal_summary,
        acceptance_criteria,
        state,
        created_at,
        updated_at,
        completion_status,
        metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `);

    stmt.run(
      params.taskId,
      params.goalSummary,
      criteriaJson,
      state,
      now,
      now,
      completionStatus,
      metadataJson,
    );

    return {
      taskId: params.taskId,
      goalSummary: params.goalSummary,
      acceptanceCriteria: params.acceptanceCriteria,
      state,
      createdAt: now,
      updatedAt: now,
      completionStatus,
      metadata: params.metadata,
    };
  }

  public getTask(taskId: string): TaskRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        task_id,
        goal_summary,
        acceptance_criteria,
        state,
        created_at,
        updated_at,
        completion_status,
        metadata
      FROM tasks
      WHERE task_id = ?;
    `);

    const row = stmt.get(taskId) as
      | {
          task_id: string;
          goal_summary: string;
          acceptance_criteria: string | null;
          state: string;
          created_at: number;
          updated_at: number;
          completion_status: string;
          metadata: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      taskId: row.task_id,
      goalSummary: row.goal_summary,
      acceptanceCriteria: row.acceptance_criteria ? (JSON.parse(row.acceptance_criteria) as string[]) : undefined,
      state: row.state as TaskStateValue,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completionStatus: row.completion_status,
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    };
  }

  public updateTaskState(
    taskId: string,
    newState: TaskStateValue,
    completionStatus?: string,
    metadata?: Record<string, unknown>,
  ): TaskRecord {
    const now = Date.now();
    const existing = this.getTask(taskId);
    if (!existing) {
      throw new PersistenceError(PersistenceErrorCode.RECORD_NOT_FOUND, `Task '${taskId}' not found`);
    }

    const nextCompletion = completionStatus ?? existing.completionStatus;
    const mergedMetadata = metadata ? { ...(existing.metadata ?? {}), ...metadata } : existing.metadata;
    const metadataJson = mergedMetadata ? JSON.stringify(mergedMetadata) : null;

    const stmt = this.db.prepare(`
      UPDATE tasks
      SET state = ?, updated_at = ?, completion_status = ?, metadata = ?
      WHERE task_id = ?;
    `);

    stmt.run(newState, now, nextCompletion, metadataJson, taskId);

    return {
      ...existing,
      state: newState,
      updatedAt: now,
      completionStatus: nextCompletion,
      metadata: mergedMetadata,
    };
  }

  public listActiveTasks(): TaskRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        task_id,
        goal_summary,
        acceptance_criteria,
        state,
        created_at,
        updated_at,
        completion_status,
        metadata
      FROM tasks
      WHERE state NOT IN ('VERIFIED_COMPLETE', 'USER_ACCEPTED_UNVERIFIED', 'DENIED', 'STOPPED', 'FAILED_SAFE')
      ORDER BY updated_at DESC;
    `);

    const rows = stmt.all() as Array<{
      task_id: string;
      goal_summary: string;
      acceptance_criteria: string | null;
      state: string;
      created_at: number;
      updated_at: number;
      completion_status: string;
      metadata: string | null;
    }>;

    return rows.map((r) => ({
      taskId: r.task_id,
      goalSummary: r.goal_summary,
      acceptanceCriteria: r.acceptance_criteria ? (JSON.parse(r.acceptance_criteria) as string[]) : undefined,
      state: r.state as TaskStateValue,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      completionStatus: r.completion_status,
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : undefined,
    }));
  }
}
