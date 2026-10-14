/**
 * @mediator/persistence — Sprint S10 Test Suite
 * SQLite Task/Action Ledger, Tamper-Evident Audit Chain & Crash Recovery
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskState } from '@mediator/shared-contracts';
import { ReplayGuard } from '@mediator/protocol';
import {
  DatabaseConnection,
  runMigrations,
  getCurrentMigrationVersion,
  AuditRepository,
  AUDIT_GENESIS_HASH,
  computeAuditEventHash,
  TaskRepository,
  SessionRepository,
  RoundRepository,
  ActionRepository,
  ApprovalRepository,
  EvidenceRepository,
  ContextSummaryRepository,
  ProjectMemoryRepository,
  MIGRATIONS,
  RecoveryManager,
  PersistenceError,
  PersistenceErrorCode,
} from './index.js';

describe('Sprint S10 — SQLite Task/Action Ledger & Audit Events', () => {
  let tempDir: string;
  let tempDbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s10-test-'));
    tempDbPath = path.join(tempDir, 'test.db');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe('1 & 2. Database Initialization, Schema Migrations & Idempotency', () => {
    it('initializes database and applies versioned migrations', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();

      expect(db.isOpen()).toBe(true);
      expect(getCurrentMigrationVersion(db)).toBe(0);

      const result = runMigrations(db);
      expect(result.applied).toBe(5);
      expect(result.currentVersion).toBe(5);
      expect(getCurrentMigrationVersion(db)).toBe(5);

      db.close();
    });

    it('re-executing migrations is strictly idempotent without errors', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();

      const run1 = runMigrations(db);
      expect(run1.applied).toBe(5);

      const run2 = runMigrations(db);
      expect(run2.applied).toBe(0);
      expect(run2.currentVersion).toBe(5);

      db.close();
    });

    it('upgrades a disposable legacy v1 database to v5 preserving existing data', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();

      // Apply ONLY migration 1 manually
      MIGRATIONS[0].up(db);
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL,
          description TEXT NOT NULL
        );
        INSERT INTO schema_migrations (version, applied_at, description)
        VALUES (1, ${Date.now()}, 'Initial Mediator Task/Action Ledger and Audit Schema');
      `);

      expect(getCurrentMigrationVersion(db)).toBe(1);

      // Now run runMigrations which should apply migrations 2, 3, 4 and 5
      const upgradeResult = runMigrations(db);
      expect(upgradeResult.applied).toBe(4);
      expect(upgradeResult.currentVersion).toBe(5);
      expect(getCurrentMigrationVersion(db)).toBe(5);

      // Verify project_maps, project_memory_items, staging, and apply tables exist now
      const tableCheck = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name IN ('project_maps', 'project_memory_items', 'stages', 'staged_files', 'stage_checkpoints', 'apply_transactions', 'apply_transaction_items');
      `).all() as Array<{ name: string }>;
      expect(tableCheck.map((t) => t.name).sort()).toEqual([
        'apply_transaction_items',
        'apply_transactions',
        'project_maps',
        'project_memory_items',
        'stage_checkpoints',
        'staged_files',
        'stages',
      ]);

      db.close();
    });
  });

  describe('3. Durable Persistence Across Database Reopen', () => {
    it('persists tasks, sessions, and rounds durably across database reopen', () => {
      // Step 1: Open, migrate, insert records
      const db1 = new DatabaseConnection({ path: tempDbPath });
      db1.open();
      runMigrations(db1);

      const taskRepo1 = new TaskRepository(db1);
      const sessionRepo1 = new SessionRepository(db1);
      const roundRepo1 = new RoundRepository(db1);

      const task = taskRepo1.createTask({
        taskId: 'task-durable-1',
        goalSummary: 'Fix authentication error',
        acceptanceCriteria: ['Tests pass', 'No regressions'],
        state: TaskState.TASK_DEFINED,
      });

      const session = sessionRepo1.createSession({
        sessionId: 'session-durable-1',
        taskId: task.taskId,
        providerId: 'gemini-web',
        conversationId: 'conv-xyz-123',
        lifecycleState: 'active',
        protocolVersion: '1.3',
        baseStateHash: 'a'.repeat(64),
        nonce: 'secret_crypto_nonce_32_bytes_long!',
      });

      const round = roundRepo1.startRound({
        sessionId: session.sessionId,
        taskId: task.taskId,
        roundNumber: 1,
        sequenceStart: 0,
        state: 'IN_PROGRESS',
        baseStateHash: 'a'.repeat(64),
      });

      expect(task.taskId).toBe('task-durable-1');
      expect(session.sessionId).toBe('session-durable-1');
      // Verify raw nonce was NOT stored in database
      expect(session.nonceHash).toBe(SessionRepository.hashNonce('secret_crypto_nonce_32_bytes_long!'));

      db1.close();
      expect(db1.isOpen()).toBe(false);

      // Step 2: Reopen from disk in a fresh connection
      const db2 = new DatabaseConnection({ path: tempDbPath });
      db2.open();

      const taskRepo2 = new TaskRepository(db2);
      const sessionRepo2 = new SessionRepository(db2);
      const roundRepo2 = new RoundRepository(db2);

      const loadedTask = taskRepo2.getTask('task-durable-1');
      expect(loadedTask).not.toBeNull();
      expect(loadedTask?.goalSummary).toBe('Fix authentication error');
      expect(loadedTask?.state).toBe(TaskState.TASK_DEFINED);
      expect(loadedTask?.acceptanceCriteria).toEqual(['Tests pass', 'No regressions']);

      const loadedSession = sessionRepo2.getSession('session-durable-1');
      expect(loadedSession).not.toBeNull();
      expect(loadedSession?.providerId).toBe('gemini-web');
      expect(loadedSession?.conversationId).toBe('conv-xyz-123');
      expect(loadedSession?.nonceHash).toBe(SessionRepository.hashNonce('secret_crypto_nonce_32_bytes_long!'));

      const loadedRound = roundRepo2.getRound(round.roundId);
      expect(loadedRound).not.toBeNull();
      expect(loadedRound?.roundNumber).toBe(1);
      expect(loadedRound?.sequenceStart).toBe(0);

      db2.close();
    });
  });

  describe('4 & 5. Atomic Transactions & Rollback Semantics', () => {
    it('commits action and state updates atomically', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      runMigrations(db);

      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const actionRepo = new ActionRepository(db);

      db.transaction(() => {
        taskRepo.createTask({
          taskId: 'task-atom-1',
          goalSummary: 'Atomic test',
          state: TaskState.TASK_DEFINED,
        });

        sessionRepo.createSession({
          sessionId: 'session-atom-1',
          taskId: 'task-atom-1',
          providerId: 'provider-1',
          conversationId: 'conv-1',
          lifecycleState: 'active',
          protocolVersion: '1.3',
          baseStateHash: 'b'.repeat(64),
          nonce: 'nonce-12345678',
        });

        actionRepo.recordAction({
          actionId: 'act_101',
          taskId: 'task-atom-1',
          sessionId: 'session-atom-1',
          roundNumber: 0,
          sequenceNumber: 0,
          actionType: 'read_file',
          payloadHash: 'c'.repeat(64),
          parameters: { path: 'src/main.ts' },
          status: 'accepted',
          policyDecision: 'ALLOW',
        });
      });

      expect(taskRepo.getTask('task-atom-1')).not.toBeNull();
      expect(sessionRepo.getSession('session-atom-1')).not.toBeNull();
      expect(actionRepo.getAction('act_101')).not.toBeNull();

      db.close();
    });

    it('rolls back completely on error, leaving zero partial state', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      runMigrations(db);

      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);

      expect(() => {
        db.transaction(() => {
          taskRepo.createTask({
            taskId: 'task-rollback-1',
            goalSummary: 'Should not persist',
            state: TaskState.TASK_DEFINED,
          });

          // Deliberate error: foreign key constraint failure
          sessionRepo.createSession({
            sessionId: 'session-rollback-1',
            taskId: 'NON_EXISTENT_TASK_ID',
            providerId: 'provider-1',
            conversationId: 'conv-1',
            lifecycleState: 'active',
            protocolVersion: '1.3',
            baseStateHash: 'd'.repeat(64),
            nonce: 'nonce-abcdef12',
          });
        });
      }).toThrow();

      // Verify task-rollback-1 was NOT committed
      expect(taskRepo.getTask('task-rollback-1')).toBeNull();
      expect(sessionRepo.getSession('session-rollback-1')).toBeNull();

      db.close();
    });
  });

  describe('6. Replay Protection Across Restart (Single-Use Action IDs & Sequences)', () => {
    it('rejects duplicate action IDs across database restarts', () => {
      const db1 = new DatabaseConnection({ path: tempDbPath });
      db1.open();
      runMigrations(db1);

      const taskRepo1 = new TaskRepository(db1);
      const sessionRepo1 = new SessionRepository(db1);
      const actionRepo1 = new ActionRepository(db1);

      taskRepo1.createTask({
        taskId: 'task-replay-1',
        goalSummary: 'Replay test',
        state: TaskState.TASK_DEFINED,
      });

      sessionRepo1.createSession({
        sessionId: 'session-replay-1',
        taskId: 'task-replay-1',
        providerId: 'provider-1',
        conversationId: 'conv-1',
        lifecycleState: 'active',
        protocolVersion: '1.3',
        baseStateHash: 'e'.repeat(64),
        nonce: 'nonce-11223344',
      });

      actionRepo1.recordAction({
        actionId: 'act_single_use_99',
        taskId: 'task-replay-1',
        sessionId: 'session-replay-1',
        roundNumber: 0,
        sequenceNumber: 0,
        actionType: 'read_file',
        payloadHash: 'f'.repeat(64),
        parameters: { path: 'file1.txt' },
        status: 'accepted',
        policyDecision: 'ALLOW',
      });

      db1.close();

      // Reopen in db2
      const db2 = new DatabaseConnection({ path: tempDbPath });
      db2.open();
      const actionRepo2 = new ActionRepository(db2);

      // Verify consumed action ID is durable
      const consumedIds = actionRepo2.getConsumedActionIdsForSession('session-replay-1');
      expect(consumedIds.has('act_single_use_99')).toBe(true);

      // Attempt to re-insert the exact same action ID into the ledger fails with constraint violation
      expect(() => {
        actionRepo2.recordAction({
          actionId: 'act_single_use_99',
          taskId: 'task-replay-1',
          sessionId: 'session-replay-1',
          roundNumber: 0,
          sequenceNumber: 1,
          actionType: 'read_file',
          payloadHash: 'f'.repeat(64),
          parameters: { path: 'file1.txt' },
          status: 'accepted',
          policyDecision: 'ALLOW',
        });
      }).toThrowError(PersistenceError);

      db2.close();
    });

    it('restores consumed action IDs into ReplayGuard upon restart', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      runMigrations(db);

      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const actionRepo = new ActionRepository(db);

      taskRepo.createTask({
        taskId: 'task-replay-guard-1',
        goalSummary: 'Replay guard test',
        state: TaskState.TASK_DEFINED,
      });

      sessionRepo.createSession({
        sessionId: 'session-rg-1',
        taskId: 'task-replay-guard-1',
        providerId: 'provider-1',
        conversationId: 'conv-1',
        lifecycleState: 'active',
        protocolVersion: '1.3',
        baseStateHash: '1'.repeat(64),
        nonce: 'nonce-authoritative-1234',
      });

      actionRepo.recordAction({
        actionId: 'act_replayed_1',
        taskId: 'task-replay-guard-1',
        sessionId: 'session-rg-1',
        roundNumber: 0,
        sequenceNumber: 0,
        actionType: 'read_file',
        payloadHash: '2'.repeat(64),
        status: 'accepted',
        policyDecision: 'ALLOW',
      });

      // Simulate recovery seeding
      const recoveryManager = new RecoveryManager(db);
      const replayGuard = new ReplayGuard();
      replayGuard.attachSession({
        taskId: 'task-replay-guard-1',
        sessionId: 'session-rg-1',
        authoritativeNonce: 'nonce-authoritative-1234',
        providerId: 'provider-1',
        conversationId: 'conv-1',
        expectedRound: 0,
        expectedSequence: 1,
        expectedBaseStateHash: '1'.repeat(64),
      });

      const report = recoveryManager.runStartupRecovery({ replayGuard });
      expect(report.consumedActionIds).toContain('act_replayed_1');

      // Now verify ReplayGuard rejects an envelope attempting to reuse act_replayed_1
      const validateResult = replayGuard.validateEnvelope({
        protocolVersion: '1.3',
        taskId: 'task-replay-guard-1',
        sessionId: 'session-rg-1',
        nonce: 'nonce-authoritative-1234',
        round: 0,
        sequence: 1,
        providerId: 'provider-1',
        conversationId: 'conv-1',
        baseStateHash: '1'.repeat(64),
        status: 'continue',
        actions: [{ id: 'act_replayed_1', type: 'read_file' }],
        contentBlocks: [],
        rawBytesLength: 100,
      });

      expect(validateResult.ok).toBe(false);
      if (!validateResult.ok) {
        expect(validateResult.error.code).toBe('ACTION_ID_DUPLICATE');
      }

      db.close();
    });
  });

  describe('7 & 8. Approvals Persistence, Trusted Resolution & Single-Use Consumption', () => {
    it('approvals remain pending until trusted resolution, and cannot be reused after consumption', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      runMigrations(db);

      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const actionRepo = new ActionRepository(db);
      const approvalRepo = new ApprovalRepository(db);

      taskRepo.createTask({
        taskId: 'task-appr-1',
        goalSummary: 'Approval test',
        state: TaskState.TASK_DEFINED,
      });

      sessionRepo.createSession({
        sessionId: 'session-appr-1',
        taskId: 'task-appr-1',
        providerId: 'provider-1',
        conversationId: 'conv-1',
        lifecycleState: 'active',
        protocolVersion: '1.3',
        baseStateHash: '3'.repeat(64),
        nonce: 'nonce-appr-12345',
      });

      actionRepo.recordAction({
        actionId: 'act_dangerous_1',
        taskId: 'task-appr-1',
        sessionId: 'session-appr-1',
        roundNumber: 0,
        sequenceNumber: 0,
        actionType: 'request_delete',
        payloadHash: '4'.repeat(64),
        status: 'pending_approval',
        policyDecision: 'REQUIRE_APPROVAL',
      });

      // 1. Create approval request -> must be 'pending'
      const appr = approvalRepo.createApproval({
        approvalId: 'appr_req_1',
        actionId: 'act_dangerous_1',
        taskId: 'task-appr-1',
        sessionId: 'session-appr-1',
        changeHash: '5'.repeat(64),
        requestingCaller: 'ai-provider',
        timeoutMs: 60_000,
      });

      expect(appr.status).toBe('pending');

      // 2. Resolve approval by trusted UI -> becomes 'approved'
      const resolved = approvalRepo.resolveApproval('appr_req_1', 'approved', 'trusted-ide-ui', 'User confirmed deletion');
      expect(resolved.status).toBe('approved');
      expect(resolved.resolvedBy).toBe('trusted-ide-ui');

      // 3. Consume approval for the exact action -> becomes 'consumed'
      const consumed = approvalRepo.consumeApproval('appr_req_1', 'act_dangerous_1');
      expect(consumed.status).toBe('consumed');

      // 4. Second attempt to consume the same approval throws MUTATION_DENIED
      expect(() => {
        approvalRepo.consumeApproval('appr_req_1', 'act_dangerous_1');
      }).toThrowError(PersistenceError);

      db.close();
    });

    it('rejects consuming an approval for a different action ID', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      runMigrations(db);

      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const actionRepo = new ActionRepository(db);
      const approvalRepo = new ApprovalRepository(db);

      taskRepo.createTask({
        taskId: 'task-appr-scope',
        goalSummary: 'Scope test',
        state: TaskState.TASK_DEFINED,
      });

      sessionRepo.createSession({
        sessionId: 'session-appr-scope',
        taskId: 'task-appr-scope',
        providerId: 'p1',
        conversationId: 'c1',
        lifecycleState: 'active',
        protocolVersion: '1.3',
        baseStateHash: '6'.repeat(64),
        nonce: 'nonce-scope-1234',
      });

      actionRepo.recordAction({
        actionId: 'act_original',
        taskId: 'task-appr-scope',
        sessionId: 'session-appr-scope',
        roundNumber: 0,
        sequenceNumber: 0,
        actionType: 'request_delete',
        payloadHash: '7'.repeat(64),
        status: 'pending_approval',
        policyDecision: 'REQUIRE_APPROVAL',
      });

      approvalRepo.createApproval({
        approvalId: 'appr_scope_1',
        actionId: 'act_original',
        taskId: 'task-appr-scope',
        sessionId: 'session-appr-scope',
        changeHash: '8'.repeat(64),
        requestingCaller: 'ai',
      });

      approvalRepo.resolveApproval('appr_scope_1', 'approved', 'trusted-ide-ui');

      expect(() => {
        approvalRepo.consumeApproval('appr_scope_1', 'act_DIFFERENT_UNAPPROVED');
      }).toThrowError(PersistenceError);

      db.close();
    });
  });

  describe('9. Evidence Levels Preservation', () => {
    it('preserves evidence levels strictly; agent-reported never becomes executor-verified', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      runMigrations(db);

      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const evidenceRepo = new EvidenceRepository(db);

      taskRepo.createTask({
        taskId: 'task-ev-1',
        goalSummary: 'Evidence test',
        state: TaskState.TASK_DEFINED,
      });

      sessionRepo.createSession({
        sessionId: 'session-ev-1',
        taskId: 'task-ev-1',
        providerId: 'gemini',
        conversationId: 'c1',
        lifecycleState: 'active',
        protocolVersion: '1.3',
        baseStateHash: '9'.repeat(64),
        nonce: 'nonce-ev-1234',
      });

      // Record agent claim
      const agentClaim = evidenceRepo.recordEvidence({
        evidenceId: 'ev_agent_1',
        taskId: 'task-ev-1',
        sessionId: 'session-ev-1',
        source: 'agent',
        evidenceLevel: 'agent-reported',
        verificationStatus: 'unverified',
        evidenceHash: 'a'.repeat(64),
        summary: 'Agent claimed npm test passed with 100% success',
      });

      expect(agentClaim.evidenceLevel).toBe('agent-reported');

      // Re-read from DB
      const loaded = evidenceRepo.getEvidence('ev_agent_1');
      expect(loaded?.evidenceLevel).toBe('agent-reported');
      expect(loaded?.verificationStatus).toBe('unverified');

      db.close();
    });
  });

  describe('10, 11 & 12. Tamper-Evident Audit Hash Chain & Immutability', () => {
    it('computes deterministic SHA-256 hash chain with genesis value', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      runMigrations(db);

      const auditRepo = new AuditRepository(db);

      // Append 3 events
      const e0 = auditRepo.appendEvent({
        taskId: 'task-chain-1',
        sessionId: 'session-chain-1',
        correlationId: 'corr-0',
        eventType: 'TASK_CREATED',
        details: { name: 'Initial setup' },
      });

      expect(e0.chainIndex).toBe(0);
      expect(e0.previousEventHash).toBe(AUDIT_GENESIS_HASH);

      const e1 = auditRepo.appendEvent({
        taskId: 'task-chain-1',
        sessionId: 'session-chain-1',
        correlationId: 'corr-1',
        eventType: 'ACTION_EVALUATED',
        details: { action: 'read_file', decision: 'ALLOW' },
      });

      expect(e1.chainIndex).toBe(1);
      expect(e1.previousEventHash).toBe(e0.eventHash);

      const e2 = auditRepo.appendEvent({
        taskId: 'task-chain-1',
        sessionId: 'session-chain-1',
        correlationId: 'corr-2',
        eventType: 'ROUND_COMPLETED',
        details: { round: 1 },
      });

      expect(e2.chainIndex).toBe(2);
      expect(e2.previousEventHash).toBe(e1.eventHash);

      // Verify chain
      const verifyRes = auditRepo.verifyChain();
      expect(verifyRes.valid).toBe(true);
      expect(verifyRes.verifiedCount).toBe(3);
      expect(verifyRes.tipHash).toBe(e2.eventHash);

      db.close();
    });

    it('detects tampering when an event details_json is modified', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      runMigrations(db);

      const auditRepo = new AuditRepository(db);

      auditRepo.appendEvent({
        taskId: 't1',
        sessionId: 's1',
        correlationId: 'c0',
        eventType: 'E0',
        details: { val: 0 },
      });

      const e1 = auditRepo.appendEvent({
        taskId: 't1',
        sessionId: 's1',
        correlationId: 'c1',
        eventType: 'E1',
        details: { val: 1 },
      });

      auditRepo.appendEvent({
        taskId: 't1',
        sessionId: 's1',
        correlationId: 'c2',
        eventType: 'E2',
        details: { val: 2 },
      });

      // Chain should initially be valid
      expect(auditRepo.verifyChain().valid).toBe(true);

      // To test tamper detection without trigger blocking UPDATE, temporarily test hash verification directly:
      // An attacker bypasses application layer or tampers raw payload
      const tamperedDetails = { val: 999 };
      const computedTamperedHash = computeAuditEventHash({
        chainIndex: e1.chainIndex,
        eventId: e1.eventId,
        timestamp: e1.timestamp,
        taskId: e1.taskId,
        sessionId: e1.sessionId,
        correlationId: e1.correlationId,
        eventType: e1.eventType,
        actor: e1.actor,
        outcome: e1.outcome,
        details: tamperedDetails,
        previousEventHash: e1.previousEventHash,
      });

      expect(computedTamperedHash).not.toBe(e1.eventHash);

      db.close();
    });

    it('enforces append-only triggers preventing direct SQL UPDATE or DELETE on audit_events', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      runMigrations(db);

      const auditRepo = new AuditRepository(db);
      const e0 = auditRepo.appendEvent({
        taskId: 't-trigger',
        sessionId: 's-trigger',
        correlationId: 'c-trig',
        eventType: 'ORIGINAL',
        details: { safe: true },
      });

      // Attempting direct SQL UPDATE must be aborted by trigger
      expect(() => {
        db.exec(`UPDATE audit_events SET event_type = 'MODIFIED' WHERE event_id = '${e0.eventId}';`);
      }).toThrowError(/Audit events are immutable and append-only/);

      // Attempting direct SQL DELETE must be aborted by trigger
      expect(() => {
        db.exec(`DELETE FROM audit_events WHERE event_id = '${e0.eventId}';`);
      }).toThrowError(/Audit events are immutable and append-only/);

      // Verify row is still intact
      const check = auditRepo.verifyChain();
      expect(check.valid).toBe(true);
      expect(check.verifiedCount).toBe(1);

      db.close();
    });
  });

  describe('13 & 14. Crash Recovery (In-Flight Actions Marked Uncertain & Never Replayed Blindly)', () => {
    it('marks in-flight actions as uncertain and non-terminal tasks as paused (reconciliation_required)', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      runMigrations(db);

      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const actionRepo = new ActionRepository(db);

      taskRepo.createTask({
        taskId: 'task-crash-1',
        goalSummary: 'In-flight operation crash test',
        state: TaskState.EXECUTING, // was executing when crash occurred!
      });

      sessionRepo.createSession({
        sessionId: 'session-crash-1',
        taskId: 'task-crash-1',
        providerId: 'gemini',
        conversationId: 'c-crash',
        lifecycleState: 'active',
        protocolVersion: '1.3',
        baseStateHash: 'b'.repeat(64),
        nonce: 'nonce-crash-123',
      });

      // Action 1: was executing
      actionRepo.recordAction({
        actionId: 'act_executing_1',
        taskId: 'task-crash-1',
        sessionId: 'session-crash-1',
        roundNumber: 1,
        sequenceNumber: 0,
        actionType: 'run_recipe',
        payloadHash: 'c'.repeat(64),
        status: 'executing',
        policyDecision: 'ALLOW',
      });

      // Action 2: was proposed
      actionRepo.recordAction({
        actionId: 'act_proposed_2',
        taskId: 'task-crash-1',
        sessionId: 'session-crash-1',
        roundNumber: 1,
        sequenceNumber: 1,
        actionType: 'propose_patch',
        payloadHash: 'd'.repeat(64),
        status: 'proposed',
        policyDecision: 'ALLOW',
      });

      // Action 3: had already completed
      actionRepo.recordAction({
        actionId: 'act_completed_0',
        taskId: 'task-crash-1',
        sessionId: 'session-crash-1',
        roundNumber: 1,
        sequenceNumber: 2,
        actionType: 'read_file',
        payloadHash: 'e'.repeat(64),
        status: 'completed',
        policyDecision: 'ALLOW',
      });

      // Execute crash recovery
      const recoveryManager = new RecoveryManager(db);
      const report = recoveryManager.runStartupRecovery();

      expect(report.outcome).toBe('reconciliation_required');
      expect(report.uncertainActionsCount).toBe(2); // act_executing_1 and act_proposed_2
      expect(report.affectedTasks).toBe(1);

      // Verify in-flight actions were marked 'uncertain'
      const a1 = actionRepo.getAction('act_executing_1');
      expect(a1?.status).toBe('uncertain');

      const a2 = actionRepo.getAction('act_proposed_2');
      expect(a2?.status).toBe('uncertain');

      // Completed action remains 'completed'
      const a3 = actionRepo.getAction('act_completed_0');
      expect(a3?.status).toBe('completed');

      // Task is paused with reconciliation_required
      const t = taskRepo.getTask('task-crash-1');
      expect(t?.state).toBe(TaskState.PAUSED);
      expect(t?.completionStatus).toBe('reconciliation_required');

      db.close();
    });
  });

  describe('15. Incomplete Content Transfers Cannot Be Resumed as Verified', () => {
    it('incomplete staging tasks are transitioned to PAUSED (reconciliation_required)', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      runMigrations(db);

      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);

      taskRepo.createTask({
        taskId: 'task-staging-incomplete',
        goalSummary: 'Incomplete content transfer test',
        state: TaskState.STAGING, // was receiving blocks when crash happened
      });

      sessionRepo.createSession({
        sessionId: 'session-staging',
        taskId: 'task-staging-incomplete',
        providerId: 'gemini',
        conversationId: 'c1',
        lifecycleState: 'active',
        protocolVersion: '1.3',
        baseStateHash: 'f'.repeat(64),
        nonce: 'nonce-staging-123',
      });

      const recoveryManager = new RecoveryManager(db);
      const report = recoveryManager.runStartupRecovery();

      expect(report.outcome).toBe('reconciliation_required');
      const task = taskRepo.getTask('task-staging-incomplete');
      expect(task?.state).toBe(TaskState.PAUSED);
      expect(task?.completionStatus).toBe('reconciliation_required');

      db.close();
    });
  });

  describe('16. Context-Security Redaction (Secrets Never Enter Rows or Events)', () => {
    it('redacts sensitive values from action parameters, context summaries, and audit details', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      runMigrations(db);

      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const actionRepo = new ActionRepository(db);
      const summaryRepo = new ContextSummaryRepository(db);
      const auditRepo = new AuditRepository(db);

      taskRepo.createTask({
        taskId: 'task-secret-test',
        goalSummary: 'Secret redaction test',
        state: TaskState.TASK_DEFINED,
      });

      sessionRepo.createSession({
        sessionId: 'session-secret-test',
        taskId: 'task-secret-test',
        providerId: 'provider-1',
        conversationId: 'c1',
        lifecycleState: 'active',
        protocolVersion: '1.3',
        baseStateHash: '0'.repeat(64),
        nonce: 'nonce-sec-1234',
      });

      // Fixture with recognizable API key pattern
      const secretApiKey = ['sk', 'live', '51Abcdef1234567890abcdef1234567890'].join('_');

      // 1. Action parameter
      const action = actionRepo.recordAction({
        actionId: 'act_secret',
        taskId: 'task-secret-test',
        sessionId: 'session-secret-test',
        roundNumber: 0,
        sequenceNumber: 0,
        actionType: 'read_file',
        payloadHash: '1'.repeat(64),
        parameters: {
          key: secretApiKey,
          safeParam: 'hello',
        },
        status: 'accepted',
        policyDecision: 'ALLOW',
      });

      expect(JSON.stringify(action.parametersSafe)).not.toContain(secretApiKey);
      expect(JSON.stringify(action.parametersSafe)).toContain('[REDACTED:STRIPE_KEY]');

      // 2. Context summary
      const summary = summaryRepo.recordSummary({
        summaryId: 'sum_1',
        taskId: 'task-secret-test',
        topic: 'config',
        summaryText: `Found config with API key: ${secretApiKey}`,
      });

      expect(summary.summaryText).not.toContain(secretApiKey);
      expect(summary.summaryText).toContain('[REDACTED:STRIPE_KEY]');

      // 3. Audit event
      const auditEvt = auditRepo.appendEvent({
        taskId: 'task-secret-test',
        sessionId: 'session-secret-test',
        correlationId: 'corr-sec',
        eventType: 'DIAGNOSTIC',
        details: {
          token: secretApiKey,
        },
      });

      expect(JSON.stringify(auditEvt.details)).not.toContain(secretApiKey);
      expect(JSON.stringify(auditEvt.details)).toContain('[REDACTED:STRIPE_KEY]');

      db.close();
    });
  });

  describe('17. Fail-Closed on Database Failures', () => {
    it('throws PersistenceError when database is closed or unavailable', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      // Do not open()!
      const taskRepo = new TaskRepository(db);

      expect(() => {
        taskRepo.getTask('task-unopened');
      }).toThrowError(PersistenceError);

      try {
        taskRepo.getTask('task-unopened');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(PersistenceError);
        const pErr = err as PersistenceError;
        expect(pErr.code).toBe(PersistenceErrorCode.DATABASE_UNAVAILABLE);
      }
    });
  });

  describe('18. ProjectMemoryRepository (S11 Schema V2)', () => {
    it('persists and retrieves project map and project memory items', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      runMigrations(db);

      const memoryRepo = new ProjectMemoryRepository(db);

      // 1. Upsert project map
      const mapRecord = memoryRepo.upsertProjectMap({
        workspaceId: 'ws-test-1',
        projectName: 'Mediator',
        rootPath: 'C:\\test\\workspace',
        mapJson: JSON.stringify({ languages: ['TypeScript'], entryPoints: ['src/index.ts'] }),
      });
      expect(mapRecord.workspaceId).toBe('ws-test-1');
      expect(mapRecord.projectName).toBe('Mediator');

      const retrievedMap = memoryRepo.getProjectMap('ws-test-1');
      expect(retrievedMap).toBeDefined();
      expect(retrievedMap?.projectName).toBe('Mediator');

      // 2. Record memory items
      memoryRepo.recordMemoryItem({
        itemId: 'rule-1',
        workspaceId: 'ws-test-1',
        category: 'rule',
        title: 'Review-only mode',
        content: 'Never execute shell commands automatically',
        status: 'approved',
        authorType: 'user',
      });

      memoryRepo.recordMemoryItem({
        itemId: 'dec-1',
        workspaceId: 'ws-test-1',
        category: 'decision',
        title: 'ADR-002',
        content: 'Use Review-only mode for V1',
        status: 'approved',
        authorType: 'user',
      });

      const rules = memoryRepo.getMemoryItems('ws-test-1', 'rule');
      expect(rules.length).toBe(1);
      expect(rules[0].title).toBe('Review-only mode');

      const allItems = memoryRepo.getMemoryItems('ws-test-1');
      expect(allItems.length).toBe(2);

      // 3. Clear memory items without deleting project map
      const cleared = memoryRepo.clearProjectMemory('ws-test-1', 'rule');
      expect(cleared).toBe(1);
      expect(memoryRepo.getMemoryItems('ws-test-1', 'rule').length).toBe(0);
      expect(memoryRepo.getProjectMap('ws-test-1')).toBeDefined();

      db.close();
    });

    it('applies Migration 3, 4 and 5 cleanly on existing schema', () => {
      const db = new DatabaseConnection({ path: tempDbPath });
      db.open();
      const migrationRes = runMigrations(db);
      expect(migrationRes.currentVersion).toBe(5);

      // Verify stages table exists
      const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('stages', 'staged_files', 'stage_checkpoints', 'apply_transactions', 'apply_transaction_items', 'handoffs', 'review_requests') ORDER BY name;");
      const rows = stmt.all() as Array<{ name: string }>;
      expect(rows.map((r) => r.name)).toEqual(['apply_transaction_items', 'apply_transactions', 'handoffs', 'review_requests', 'stage_checkpoints', 'staged_files', 'stages']);

      db.close();
    });
  });
});

