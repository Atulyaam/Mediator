/**
 * @mediator/persistence — Project Memory Repository (S11)
 *
 * Requirements:
 * - Persists bounded project maps keyed by workspace ID.
 * - Stores project-level memory: rules, decisions, and known issues.
 * - Enforces separation of user-approved vs AI-proposed rules.
 * - Never stores secrets; uses safeRedactString on text payloads.
 */

import { safeRedactString } from '../auditEvent.js';
import { type DatabaseConnection } from '../database.js';

export interface ProjectMapRecord {
  readonly workspaceId: string;
  readonly projectName: string;
  readonly rootPath: string;
  readonly mapJson: string;
  readonly lastScannedAt: number;
  readonly version: number;
}

export interface UpsertProjectMapParams {
  readonly workspaceId: string;
  readonly projectName: string;
  readonly rootPath: string;
  readonly mapJson: string;
  readonly lastScannedAt?: number | undefined;
  readonly version?: number | undefined;
}

export type ProjectMemoryCategory = 'rule' | 'decision' | 'known_issue';
export type MemoryItemStatus =
  | 'approved'
  | 'proposed'
  | 'deprecated'
  | 'rejected'
  | 'superseded';
export type MemoryAuthorType = 'user' | 'ai';

export interface ProjectMemoryItemRecord {
  readonly itemId: string;
  readonly workspaceId: string;
  readonly category: ProjectMemoryCategory;
  readonly title: string;
  readonly content: string;
  readonly status: MemoryItemStatus;
  readonly authorType: MemoryAuthorType;
  readonly relatedTaskId?: string | undefined;
  readonly metadata?: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RecordMemoryItemParams {
  readonly itemId: string;
  readonly workspaceId: string;
  readonly category: ProjectMemoryCategory;
  readonly title: string;
  readonly content: string;
  readonly status: MemoryItemStatus;
  readonly authorType: MemoryAuthorType;
  readonly relatedTaskId?: string | undefined;
  readonly metadata?: string | undefined;
  readonly createdAt?: number | undefined;
  readonly updatedAt?: number | undefined;
}

export class ProjectMemoryRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public upsertProjectMap(params: UpsertProjectMapParams): ProjectMapRecord {
    const now = params.lastScannedAt ?? Date.now();
    const version = params.version ?? 1;
    const safeJson = safeRedactString(params.mapJson);

    const stmt = this.db.prepare(`
      INSERT INTO project_maps (
        workspace_id,
        project_name,
        root_path,
        map_json,
        last_scanned_at,
        version
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        project_name = excluded.project_name,
        root_path = excluded.root_path,
        map_json = excluded.map_json,
        last_scanned_at = excluded.last_scanned_at,
        version = excluded.version;
    `);

    stmt.run(
      params.workspaceId,
      params.projectName,
      params.rootPath,
      safeJson,
      now,
      version,
    );

    return {
      workspaceId: params.workspaceId,
      projectName: params.projectName,
      rootPath: params.rootPath,
      mapJson: safeJson,
      lastScannedAt: now,
      version,
    };
  }

  public getProjectMap(workspaceId: string): ProjectMapRecord | undefined {
    const stmt = this.db.prepare(`
      SELECT
        workspace_id,
        project_name,
        root_path,
        map_json,
        last_scanned_at,
        version
      FROM project_maps
      WHERE workspace_id = ?;
    `);

    const row = stmt.get(workspaceId) as {
      workspace_id: string;
      project_name: string;
      root_path: string;
      map_json: string;
      last_scanned_at: number;
      version: number;
    } | undefined;

    if (!row) return undefined;

    return {
      workspaceId: row.workspace_id,
      projectName: row.project_name,
      rootPath: row.root_path,
      mapJson: row.map_json,
      lastScannedAt: row.last_scanned_at,
      version: row.version,
    };
  }

  public recordMemoryItem(params: RecordMemoryItemParams): ProjectMemoryItemRecord {
    const now = Date.now();
    const createdAt = params.createdAt ?? now;
    const updatedAt = params.updatedAt ?? now;
    const safeTitle = safeRedactString(params.title);
    const safeContent = safeRedactString(params.content);

    const stmt = this.db.prepare(`
      INSERT INTO project_memory_items (
        item_id,
        workspace_id,
        category,
        title,
        content,
        status,
        author_type,
        related_task_id,
        metadata,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        status = excluded.status,
        author_type = excluded.author_type,
        related_task_id = excluded.related_task_id,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at;
    `);

    stmt.run(
      params.itemId,
      params.workspaceId,
      params.category,
      safeTitle,
      safeContent,
      params.status,
      params.authorType,
      params.relatedTaskId ?? null,
      params.metadata ?? null,
      createdAt,
      updatedAt,
    );

    return {
      itemId: params.itemId,
      workspaceId: params.workspaceId,
      category: params.category,
      title: safeTitle,
      content: safeContent,
      status: params.status,
      authorType: params.authorType,
      relatedTaskId: params.relatedTaskId,
      metadata: params.metadata,
      createdAt,
      updatedAt,
    };
  }

  public getMemoryItems(
    workspaceId: string,
    category?: ProjectMemoryCategory,
    status?: MemoryItemStatus,
  ): ProjectMemoryItemRecord[] {
    let sql = `
      SELECT
        item_id,
        workspace_id,
        category,
        title,
        content,
        status,
        author_type,
        related_task_id,
        metadata,
        created_at,
        updated_at
      FROM project_memory_items
      WHERE workspace_id = ?
    `;
    const params: string[] = [workspaceId];

    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY created_at ASC;';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      item_id: string;
      workspace_id: string;
      category: ProjectMemoryCategory;
      title: string;
      content: string;
      status: MemoryItemStatus;
      author_type: MemoryAuthorType;
      related_task_id: string | null;
      metadata: string | null;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((r) => ({
      itemId: r.item_id,
      workspaceId: r.workspace_id,
      category: r.category,
      title: r.title,
      content: r.content,
      status: r.status,
      authorType: r.author_type,
      relatedTaskId: r.related_task_id ?? undefined,
      metadata: r.metadata ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  public getMemoryItem(itemId: string): ProjectMemoryItemRecord | undefined {
    const stmt = this.db.prepare(`
      SELECT
        item_id,
        workspace_id,
        category,
        title,
        content,
        status,
        author_type,
        related_task_id,
        metadata,
        created_at,
        updated_at
      FROM project_memory_items
      WHERE item_id = ?;
    `);

    const row = stmt.get(itemId) as {
      item_id: string;
      workspace_id: string;
      category: ProjectMemoryCategory;
      title: string;
      content: string;
      status: MemoryItemStatus;
      author_type: MemoryAuthorType;
      related_task_id: string | null;
      metadata: string | null;
      created_at: number;
      updated_at: number;
    } | undefined;

    if (!row) return undefined;

    return {
      itemId: row.item_id,
      workspaceId: row.workspace_id,
      category: row.category,
      title: row.title,
      content: row.content,
      status: row.status,
      authorType: row.author_type,
      relatedTaskId: row.related_task_id ?? undefined,
      metadata: row.metadata ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  public deleteMemoryItem(itemId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM project_memory_items WHERE item_id = ?;');
    const result = stmt.run(itemId);
    return Number(result.changes) > 0;
  }

  public clearProjectMemory(workspaceId: string, category?: ProjectMemoryCategory): number {
    let sql = 'DELETE FROM project_memory_items WHERE workspace_id = ?';
    const params: string[] = [workspaceId];
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return Number(result.changes);
  }
}
