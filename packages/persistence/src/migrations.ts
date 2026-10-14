/**
 * @mediator/persistence — Versioned SQLite Schema Migrations (S10)
 *
 * Requirements:
 * - Versioned schema migration runner.
 * - Idempotent execution (skips already applied migrations).
 * - Runs each migration in an atomic transaction; rolls back on error.
 * - Enforces foreign keys and append-only triggers for audit immutability.
 */

import { type DatabaseConnection } from './database.js';
import { PersistenceError, PersistenceErrorCode } from './errors.js';

export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly up: (db: DatabaseConnection) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'Initial Mediator Task/Action Ledger and Audit Schema',
    up: (db: DatabaseConnection): void => {
      // 1. Tasks
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          task_id TEXT PRIMARY KEY,
          goal_summary TEXT NOT NULL,
          acceptance_criteria TEXT,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completion_status TEXT NOT NULL DEFAULT 'none',
          metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
      `);

      // 2. Sessions
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
          provider_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          branch_or_message_id TEXT,
          lifecycle_state TEXT NOT NULL,
          protocol_version TEXT NOT NULL,
          current_round INTEGER NOT NULL DEFAULT 0,
          current_sequence INTEGER NOT NULL DEFAULT 0,
          base_state_hash TEXT NOT NULL,
          nonce_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          recovery_status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);
      `);

      // 3. Rounds
      db.exec(`
        CREATE TABLE IF NOT EXISTS rounds (
          round_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
          round_number INTEGER NOT NULL,
          sequence_start INTEGER NOT NULL,
          sequence_end INTEGER,
          state TEXT NOT NULL,
          result_status TEXT,
          base_state_hash TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_rounds_session_round ON rounds(session_id, round_number);
      `);

      // 4. Actions
      db.exec(`
        CREATE TABLE IF NOT EXISTS actions (
          action_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
          session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
          round_number INTEGER NOT NULL,
          sequence_number INTEGER NOT NULL,
          action_type TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          parameters_safe TEXT NOT NULL,
          status TEXT NOT NULL,
          policy_decision TEXT NOT NULL,
          policy_reason TEXT,
          idempotent INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          outcome_details TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_actions_task_session ON actions(task_id, session_id);
        CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
        CREATE INDEX IF NOT EXISTS idx_actions_sequence ON actions(session_id, sequence_number);
      `);

      // 5. Approvals
      db.exec(`
        CREATE TABLE IF NOT EXISTS approvals (
          approval_id TEXT PRIMARY KEY,
          action_id TEXT NOT NULL REFERENCES actions(action_id) ON DELETE RESTRICT,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
          session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
          change_hash TEXT NOT NULL,
          requesting_caller TEXT NOT NULL,
          status TEXT NOT NULL,
          requested_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          resolved_at INTEGER,
          resolved_by TEXT,
          resolution_reason TEXT,
          consumed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_approvals_action_id ON approvals(action_id);
        CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      `);

      // 6. Evidence
      db.exec(`
        CREATE TABLE IF NOT EXISTS evidence (
          evidence_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
          session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE RESTRICT,
          action_id TEXT REFERENCES actions(action_id) ON DELETE RESTRICT,
          round_number INTEGER,
          source TEXT NOT NULL,
          evidence_level TEXT NOT NULL,
          verification_status TEXT NOT NULL,
          exit_code INTEGER,
          evidence_hash TEXT NOT NULL,
          summary_safe TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);
        CREATE INDEX IF NOT EXISTS idx_evidence_level ON evidence(evidence_level);
      `);

      // 7. Context summaries
      db.exec(`
        CREATE TABLE IF NOT EXISTS context_summaries (
          summary_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
          topic TEXT NOT NULL,
          summary_text TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_context_summaries_task ON context_summaries(task_id);
      `);

      // 8. Audit events (tamper-evident hash chain)
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_events (
          event_id TEXT PRIMARY KEY,
          chain_index INTEGER NOT NULL UNIQUE,
          timestamp INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          actor TEXT NOT NULL,
          outcome TEXT NOT NULL,
          details_json TEXT NOT NULL,
          previous_event_hash TEXT NOT NULL,
          event_hash TEXT NOT NULL UNIQUE
        );
        CREATE INDEX IF NOT EXISTS idx_audit_chain_index ON audit_events(chain_index);
        CREATE INDEX IF NOT EXISTS idx_audit_task_id ON audit_events(task_id);

        -- Enforce append-only / immutable events in SQLite
        CREATE TRIGGER IF NOT EXISTS prevent_audit_update
        BEFORE UPDATE ON audit_events
        BEGIN
          SELECT RAISE(ABORT, 'Audit events are immutable and append-only');
        END;

        CREATE TRIGGER IF NOT EXISTS prevent_audit_delete
        BEFORE DELETE ON audit_events
        BEGIN
          SELECT RAISE(ABORT, 'Audit events are immutable and append-only');
        END;
      `);
    },
  },
  {
    version: 2,
    description: 'Project Maps and Project Memory Schema (S11)',
    up: (db: DatabaseConnection): void => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_maps (
          workspace_id TEXT PRIMARY KEY,
          project_name TEXT NOT NULL,
          root_path TEXT NOT NULL,
          map_json TEXT NOT NULL,
          last_scanned_at INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS project_memory_items (
          item_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL,
          author_type TEXT NOT NULL,
          related_task_id TEXT,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_project_memory_workspace ON project_memory_items(workspace_id, category);
      `);
    },
  },
  {
    version: 3,
    description: 'Shadow Staging Store Schema (S12)',
    up: (db: DatabaseConnection): void => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS stages (
          stage_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
          workspace_identity TEXT NOT NULL,
          canonical_workspace_path TEXT NOT NULL,
          status TEXT NOT NULL,
          checkpoint_id TEXT,
          stage_version INTEGER NOT NULL DEFAULT 1,
          parent_checkpoint_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_stages_task ON stages(task_id);
        CREATE INDEX IF NOT EXISTS idx_stages_status ON stages(status);

        CREATE TABLE IF NOT EXISTS staged_files (
          stage_id TEXT NOT NULL REFERENCES stages(stage_id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          source_exists_at_base INTEGER NOT NULL,
          base_content_hash TEXT,
          base_mtime_ms INTEGER,
          base_size_bytes INTEGER,
          staged_content_hash TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          encoding TEXT NOT NULL,
          change_type TEXT NOT NULL,
          is_protected INTEGER NOT NULL DEFAULT 0,
          policy_decision TEXT NOT NULL,
          requires_manual_review INTEGER NOT NULL DEFAULT 0,
          target_path TEXT,
          conflict_status TEXT NOT NULL DEFAULT 'clean',
          conflict_reason TEXT,
          staged_storage_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (stage_id, relative_path)
        );
        CREATE INDEX IF NOT EXISTS idx_staged_files_stage ON staged_files(stage_id);

        CREATE TABLE IF NOT EXISTS stage_checkpoints (
          checkpoint_id TEXT PRIMARY KEY,
          stage_id TEXT NOT NULL REFERENCES stages(stage_id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          description TEXT,
          snapshot_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_stage_checkpoints_stage ON stage_checkpoints(stage_id);
        CREATE INDEX IF NOT EXISTS idx_stage_checkpoints_task ON stage_checkpoints(task_id);
      `);
    },
  },
  {
    version: 4,
    description: 'Apply Transactions, Transaction Items, and Rollback Journals (S14)',
    up: (db: DatabaseConnection): void => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS apply_transactions (
          transaction_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          stage_id TEXT NOT NULL,
          approval_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          backup_dir TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_apply_transactions_task ON apply_transactions(task_id);
        CREATE INDEX IF NOT EXISTS idx_apply_transactions_stage ON apply_transactions(stage_id);
        CREATE INDEX IF NOT EXISTS idx_apply_transactions_status ON apply_transactions(status);

        CREATE TABLE IF NOT EXISTS apply_transaction_items (
          item_id TEXT PRIMARY KEY,
          transaction_id TEXT NOT NULL REFERENCES apply_transactions(transaction_id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          operation TEXT NOT NULL,
          base_hash TEXT,
          post_apply_hash TEXT,
          status TEXT NOT NULL,
          backup_path TEXT,
          target_path TEXT,
          applied_at INTEGER,
          error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_apply_items_transaction ON apply_transaction_items(transaction_id);
        CREATE INDEX IF NOT EXISTS idx_apply_items_status ON apply_transaction_items(status);
      `);
    },
  },
  {
    version: 5,
    description: 'Handoff records and pending review requests (S17)',
    up: (db: DatabaseConnection): void => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS handoffs (
          handoff_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
          session_id TEXT NOT NULL,
          stage_id TEXT,
          workspace_root TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          prompt_hash TEXT NOT NULL,
          prompt_preview_safe TEXT NOT NULL,
          allowed_scope TEXT NOT NULL,
          expected_schema_version TEXT NOT NULL,
          caller_source TEXT NOT NULL,
          cancellation_reason TEXT,
          linked_approval_id TEXT,
          audit_ref TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_handoffs_task ON handoffs(task_id);
        CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status);

        CREATE TABLE IF NOT EXISTS review_requests (
          request_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
          session_id TEXT NOT NULL,
          action_id TEXT,
          stage_id TEXT,
          payload_hash TEXT NOT NULL,
          requested_scope TEXT NOT NULL,
          origin TEXT NOT NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          correlation_id TEXT NOT NULL,
          resolved_at INTEGER,
          resolved_by TEXT,
          resolution_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_review_requests_task ON review_requests(task_id);
        CREATE INDEX IF NOT EXISTS idx_review_requests_status ON review_requests(status);
      `);
    },
  },
];

export function getCurrentMigrationVersion(db: DatabaseConnection): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      description TEXT NOT NULL
    );
  `);

  const stmt = db.prepare('SELECT MAX(version) as max_version FROM schema_migrations;');
  const row = stmt.get() as { max_version?: number | null } | undefined;
  return row?.max_version ?? 0;
}

export function runMigrations(db: DatabaseConnection): { applied: number; currentVersion: number } {
  const current = getCurrentMigrationVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    return { applied: 0, currentVersion: current };
  }

  let appliedCount = 0;
  let latestVersion = current;

  for (const migration of pending) {
    try {
      db.transaction(() => {
        migration.up(db);
        const recordStmt = db.prepare(`
          INSERT INTO schema_migrations (version, applied_at, description)
          VALUES (?, ?, ?);
        `);
        recordStmt.run(migration.version, Date.now(), migration.description);
      });
      appliedCount++;
      latestVersion = migration.version;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PersistenceError(
        PersistenceErrorCode.MIGRATION_FAILED,
        `Migration version ${migration.version} ('${migration.description}') failed: ${msg}`,
        { version: migration.version, error: msg },
      );
    }
  }

  return { applied: appliedCount, currentVersion: latestVersion };
}
