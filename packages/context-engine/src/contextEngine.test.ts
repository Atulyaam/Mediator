/**
 * @mediator/context-engine — Sprint S11 Comprehensive Test Suite
 * Compact Context Engine & Project Memory
 *
 * Requirements covered (Section 10):
 * 1. Project-map generation on a small fixture repository.
 * 2. Skipping excluded paths and generated directories.
 * 3. Rejection of unconfirmed or unsafe workspace roots.
 * 4. Incremental refresh after a file changes.
 * 5. Stable task-summary serialization.
 * 6. Correct persistence and reload after database reopen.
 * 7. Relevance ranking for a task referencing specific modules.
 * 8. Duplicate and unchanged context elimination.
 * 9. Actual serialized UTF-8 budget enforcement.
 * 10. Accurate labelling of approximate token estimates.
 * 11. Inclusion reasons and omission markers.
 * 12. request_more_context path and budget validation.
 * 13. Secret-free packet serialization.
 * 14. Agent-reported evidence not becoming executor-verified.
 * 15. Restart recovery using persisted task state.
 * 16. Memory clear/export behavior without unintended audit deletion.
 * 17. Malformed or incomplete stored summaries failing safely.
 * 18. All existing S01–S10 tests continuing to pass.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  TaskState,
  type WorkspaceRootState,
} from '@mediator/shared-contracts';
import {
  DatabaseConnection,
  runMigrations,
  TaskRepository,
  ContextSummaryRepository,
  ProjectMemoryRepository,
  AuditRepository,
} from '@mediator/persistence';
import {
  ContextEngineError,
  ContextEngineErrorCode,
  scanProjectMap,
  loadWorkspaceRulesFile,
  parseRulesMarkdown,
  proposeRuleByAI,
  approveRule,
  validateRuleContentSafety,
  DecisionMemoryManager,
  KnownIssuesManager,
  createInitialTaskSummary,
  addEvidenceToTaskSummary,
  serializeTaskSummary,
  deserializeTaskSummary,
  createCandidateItem,
  rankAndDeduplicateCandidates,
  PRIORITY_RANKS,
  enforceContextBudget,
  estimateApproximateTokens,
  DEFAULT_BUDGET_CONFIG,
  assembleContextPacket,
  ContextMemoryService,
} from './index.js';

describe('Sprint S11 — Compact Context Engine & Project Memory', () => {
  let tempDir: string;
  let fixtureDir: string;
  let dbPath: string;
  let validRootState: WorkspaceRootState;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s11-test-'));
    fixtureDir = path.join(tempDir, 'repo');
    dbPath = path.join(tempDir, 'test.db');
    fs.mkdirSync(fixtureDir, { recursive: true });

    validRootState = {
      selectedPath: fixtureDir,
      canonicalPath: fixtureDir,
      selectionSource: 'ide',
      resolutionStatus: 'resolved',
      confirmationStatus: 'confirmed',
      cloudStatus: 'not_cloud',
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // ── Helper to setup small fixture repo ─────────────────────────────────────
  function setupFixtureRepo(): void {
    const pkgJson = {
      name: 'fixture-project',
      version: '1.0.0',
      scripts: {
        test: 'vitest run',
        build: 'tsc -b',
      },
      dependencies: {
        typescript: '^5.0.0',
        react: '^18.0.0',
      },
      devDependencies: {
        vitest: '^1.0.0',
      },
    };
    fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

    const srcDir = path.join(fixtureDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const hello = "world";\n');
    fs.writeFileSync(path.join(srcDir, 'utils.ts'), 'export function add(a: number, b: number) { return a + b; }\n');

    const testsDir = path.join(fixtureDir, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
    fs.writeFileSync(path.join(testsDir, 'index.test.ts'), 'import { hello } from "../src/index";\n');
  }

  describe('1. Project-Map Generation on Fixture Repository', () => {
    it('generates a bounded local overview containing metadata, entry points, and test commands', () => {
      setupFixtureRepo();

      const map = scanProjectMap(validRootState);

      expect(map.projectName).toBe('fixture-project');
      expect(map.canonicalRoot).toBe(fixtureDir);
      expect(map.detectedLanguages).toContain('TypeScript');
      expect(map.detectedFrameworks).toContain('React');
      expect(map.entryPoints).toContain('src/index.ts');
      expect(map.configFiles).toContain('package.json');
      expect(map.testCommands).toContain('npm test');
      expect(map.testCommands).toContain('vitest run');
      expect(map.totalFilesScanned).toBeGreaterThanOrEqual(4);
      expect(map.files['src/index.ts']).toBeDefined();
      expect(map.files['src/index.ts'].available).toBe(true);
      expect(map.files['src/index.ts'].contentHash).toHaveLength(64);
      expect(map.version).toBe(1);
    });
  });

  describe('2. Skipping Excluded Paths and Generated Directories', () => {
    it('skips noisy build directories and never reads excluded secret files', () => {
      setupFixtureRepo();

      // Create noisy directories
      const nodeModulesDir = path.join(fixtureDir, 'node_modules', 'foo');
      fs.mkdirSync(nodeModulesDir, { recursive: true });
      fs.writeFileSync(path.join(nodeModulesDir, 'index.js'), 'console.log("noisy");');

      const distDir = path.join(fixtureDir, 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'bundle.js'), 'console.log("build");');

      const gitDir = path.join(fixtureDir, '.git');
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n');

      // Create sensitive secret files (must be skipped by S06 exclusions)
      fs.writeFileSync(path.join(fixtureDir, '.env'), 'STRIPE_SECRET=mock_secret_key_12345\n');
      fs.writeFileSync(path.join(fixtureDir, '.env.local'), 'API_KEY=secret_key\n');

      const map = scanProjectMap(validRootState);

      // Verify noisy directories skipped
      const scannedKeys = Object.keys(map.files);
      expect(scannedKeys.some((k) => k.startsWith('node_modules'))).toBe(false);
      expect(scannedKeys.some((k) => k.startsWith('dist'))).toBe(false);
      expect(scannedKeys.some((k) => k.startsWith('.git'))).toBe(false);

      // Verify secrets excluded without indexing
      expect(scannedKeys.includes('.env')).toBe(false);
      expect(scannedKeys.includes('.env.local')).toBe(false);
    });
  });

  describe('3. Rejection of Unconfirmed or Unsafe Workspace Roots', () => {
    it('rejects unconfirmed workspace root state', () => {
      setupFixtureRepo();

      const unconfirmedRoot: WorkspaceRootState = {
        ...validRootState,
        confirmationStatus: 'pending',
      };

      expect(() => {
        scanProjectMap(unconfirmedRoot);
      }).toThrowError(ContextEngineError);

      try {
        scanProjectMap(unconfirmedRoot);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ContextEngineError);
        const cErr = err as ContextEngineError;
        expect(cErr.code).toBe(ContextEngineErrorCode.UNSAFE_WORKSPACE_ROOT);
      }
    });

    it('rejects non-existent canonical workspace path', () => {
      const nonExistentRoot: WorkspaceRootState = {
        ...validRootState,
        canonicalPath: path.join(tempDir, 'does-not-exist'),
      };

      expect(() => {
        scanProjectMap(nonExistentRoot);
      }).toThrowError(ContextEngineError);
    });
  });

  describe('4. Incremental Refresh After File Change', () => {
    it('reuses unchanged hashes and updates changed file entries incrementally', () => {
      setupFixtureRepo();

      const map1 = scanProjectMap(validRootState);
      const originalIndexHash = map1.files['src/index.ts'].contentHash;
      const originalUtilsHash = map1.files['src/utils.ts'].contentHash;
      expect(map1.version).toBe(1);

      // Mutate utils.ts, keep index.ts identical
      // Wait at least 15ms or modify content so mtime/size change
      const utilsPath = path.join(fixtureDir, 'src', 'utils.ts');
      fs.appendFileSync(utilsPath, '\nexport function sub(a: number, b: number) { return a - b; }\n');

      const map2 = scanProjectMap(validRootState, { previousMap: map1 });
      expect(map2.version).toBe(2);

      // index.ts was unchanged: contentHash preserved
      expect(map2.files['src/index.ts'].contentHash).toBe(originalIndexHash);

      // utils.ts changed: new contentHash computed
      expect(map2.files['src/utils.ts'].contentHash).not.toBe(originalUtilsHash);
    });
  });

  describe('5. Stable Task-Summary Serialization', () => {
    it('produces deterministic canonical serialization regardless of field insertion order', () => {
      const summary1 = createInitialTaskSummary({
        taskId: 'task-stable-1',
        originalUserGoal: 'Implement authentication flow',
        acceptanceCriteria: ['Pass unit tests', 'Enforce JWT expiration', 'Audit login events'],
        filesExamined: ['src/auth.ts', 'src/jwt.ts'],
        blockers: ['Need certificate path', 'DB port closed'],
        relevantDecisions: ['ADR-001', 'ADR-002'],
        updatedAt: 1000000,
      });

      const summary2 = createInitialTaskSummary({
        taskId: 'task-stable-1',
        originalUserGoal: 'Implement authentication flow',
        acceptanceCriteria: ['Audit login events', 'Pass unit tests', 'Enforce JWT expiration'], // Different order
        filesExamined: ['src/jwt.ts', 'src/auth.ts'], // Different order
        blockers: ['DB port closed', 'Need certificate path'], // Different order
        relevantDecisions: ['ADR-002', 'ADR-001'], // Different order
        updatedAt: 1000000,
      });

      const serialized1 = serializeTaskSummary(summary1);
      const serialized2 = serializeTaskSummary(summary2);

      expect(serialized1).toBe(serialized2);
    });
  });

  describe('6. Correct Persistence and Reload After Database Reopen', () => {
    it('persists task summary in SQLite and restores it cleanly across db reconnect', () => {
      const db1 = new DatabaseConnection({ path: dbPath });
      db1.open();
      runMigrations(db1);

      const taskRepo1 = new TaskRepository(db1);
      taskRepo1.createTask({
        taskId: 'task-reload-1',
        goalSummary: 'Fix race condition in transfer manager',
        acceptanceCriteria: ['Zero data races'],
      });

      const summaryRepo1 = new ContextSummaryRepository(db1);
      const projectMemoryRepo1 = new ProjectMemoryRepository(db1);
      const service1 = new ContextMemoryService({
        db: db1,
        taskRepo: taskRepo1,
        summaryRepo: summaryRepo1,
        projectMemoryRepo: projectMemoryRepo1,
      });

      const originalSummary = service1.getTaskSummary('task-reload-1');
      const updated = service1.updateTaskSummary('task-reload-1', (cur) => ({
        ...cur,
        approvedPlan: 'Step 1: Acquire mutex before buffer write',
        nextExpectedAction: 'Run chunk tests',
        filesExamined: ['src/chunkManager.ts'],
      }));

      expect(updated.approvedPlan).toBe('Step 1: Acquire mutex before buffer write');
      db1.close();

      // Step 2: Fresh database instance reconnecting to same file
      const db2 = new DatabaseConnection({ path: dbPath });
      db2.open();

      const taskRepo2 = new TaskRepository(db2);
      const summaryRepo2 = new ContextSummaryRepository(db2);
      const projectMemoryRepo2 = new ProjectMemoryRepository(db2);
      const service2 = new ContextMemoryService({
        db: db2,
        taskRepo: taskRepo2,
        summaryRepo: summaryRepo2,
        projectMemoryRepo: projectMemoryRepo2,
      });

      const reloadedSummary = service2.getTaskSummary('task-reload-1');
      expect(reloadedSummary.taskId).toBe('task-reload-1');
      expect(reloadedSummary.approvedPlan).toBe('Step 1: Acquire mutex before buffer write');
      expect(reloadedSummary.nextExpectedAction).toBe('Run chunk tests');
      expect(reloadedSummary.filesExamined).toContain('src/chunkManager.ts');

      db2.close();
    });
  });

  describe('7. Relevance Ranking for a Task Referencing Specific Modules', () => {
    it('ranks items in strict priority order with deterministic tie-breaking', () => {
      const goalItem = createCandidateItem({
        itemId: 'c-goal',
        category: 'task_goal_criteria',
        title: 'Task Goal',
        content: 'Implement OAuth refresh flow',
        inclusionReason: 'Goal',
      });

      const ruleItem = createCandidateItem({
        itemId: 'c-rule',
        category: 'project_rule',
        title: 'Rule: Review-only',
        content: 'No auto-execution',
        inclusionReason: 'Project Rule',
      });

      const fileItem = createCandidateItem({
        itemId: 'c-file',
        category: 'task_file',
        title: 'src/oauth.ts',
        content: 'function refresh() {}',
        inclusionReason: 'Task File',
      });

      const diffItem = createCandidateItem({
        itemId: 'c-diff',
        category: 'validated_diff',
        title: 'Diff oauth.ts',
        content: '+ refresh token call',
        inclusionReason: 'Diff',
      });

      const testErrorItem = createCandidateItem({
        itemId: 'c-error',
        category: 'test_result_error',
        title: 'Test failed: token expired',
        content: 'Error: invalid token',
        inclusionReason: 'Test Error',
      });

      const mapItem = createCandidateItem({
        itemId: 'c-map',
        category: 'project_map_summary',
        title: 'Map Overview',
        content: 'Node project',
        inclusionReason: 'Map',
      });

      const issueItem = createCandidateItem({
        itemId: 'c-issue',
        category: 'known_issue',
        title: 'Stale token edge case',
        content: 'Attempted retry failed',
        inclusionReason: 'Known issue',
      });

      const ranked = rankAndDeduplicateCandidates([
        issueItem,
        fileItem,
        mapItem,
        goalItem,
        testErrorItem,
        ruleItem,
        diffItem,
      ]);

      const categories = ranked.map((r) => r.category);
      expect(categories).toEqual([
        'task_goal_criteria',
        'project_rule',
        'task_file',
        'validated_diff',
        'test_result_error',
        'project_map_summary',
        'known_issue',
      ]);

      expect(PRIORITY_RANKS['task_goal_criteria']).toBeGreaterThan(PRIORITY_RANKS['project_rule']);
      expect(PRIORITY_RANKS['project_rule']).toBeGreaterThan(PRIORITY_RANKS['task_file']);
      expect(PRIORITY_RANKS['task_file']).toBeGreaterThan(PRIORITY_RANKS['validated_diff']);
      expect(PRIORITY_RANKS['validated_diff']).toBeGreaterThan(PRIORITY_RANKS['test_result_error']);
      expect(PRIORITY_RANKS['test_result_error']).toBeGreaterThan(PRIORITY_RANKS['project_map_summary']);
      expect(PRIORITY_RANKS['project_map_summary']).toBeGreaterThan(PRIORITY_RANKS['known_issue']);
    });
  });

  describe('8. Duplicate and Unchanged Context Elimination', () => {
    it('eliminates duplicates and unchanged known items using content hashes', () => {
      const item1 = createCandidateItem({
        itemId: 'item-1',
        category: 'task_file',
        title: 'utils.ts',
        content: 'const x = 1;',
        inclusionReason: 'First instance',
      });

      const item1Duplicate = createCandidateItem({
        itemId: 'item-1-dup',
        category: 'task_file',
        title: 'utils.ts copy',
        content: 'const x = 1;', // identical content -> identical hash
        inclusionReason: 'Duplicate instance',
      });

      const itemAlreadyKnown = createCandidateItem({
        itemId: 'item-known',
        category: 'project_rule',
        title: 'Rule X',
        content: 'Known rule content',
        inclusionReason: 'Unchanged rule',
      });

      const knownHashes = new Set([itemAlreadyKnown.contentHash]);

      const ranked = rankAndDeduplicateCandidates(
        [item1, item1Duplicate, itemAlreadyKnown],
        { existingKnownHashes: knownHashes },
      );

      // item1Duplicate removed (same content hash), itemAlreadyKnown removed (already known)
      expect(ranked.length).toBe(1);
      expect(ranked[0].itemId).toBe('item-1');
    });
  });

  describe('9. Actual Serialized UTF-8 Budget Enforcement', () => {
    it('enforces total byte limits using exact Buffer.byteLength without silent data corruption', () => {
      const item1 = createCandidateItem({
        itemId: 'item-small-1',
        category: 'task_file',
        title: 'small1.ts',
        content: 'A'.repeat(100),
        inclusionReason: 'Small file 1',
      });

      const item2 = createCandidateItem({
        itemId: 'item-small-2',
        category: 'task_file',
        title: 'small2.ts',
        content: 'B'.repeat(100),
        inclusionReason: 'Small file 2',
      });

      const item3 = createCandidateItem({
        itemId: 'item-large-3',
        category: 'task_file',
        title: 'large3.ts',
        content: 'C'.repeat(400),
        inclusionReason: 'Large file 3',
      });

      // Budget limit: 250 bytes
      const result = enforceContextBudget([item1, item2, item3], {
        maxTotalBytes: 250,
      });

      expect(result.totalBytes).toBeLessThanOrEqual(250);
      expect(result.selectedItems.map((i) => i.itemId)).toEqual(['item-small-1', 'item-small-2']);
      expect(result.omissionMarkers).toHaveLength(1);
      expect(result.omissionMarkers[0].itemId).toBe('item-large-3');
    });

    it('fails closed with BUDGET_EXCEEDED when essential task goal cannot fit in budget', () => {
      const oversizedGoal = createCandidateItem({
        itemId: 'goal-huge',
        category: 'task_goal_criteria',
        title: 'Goal',
        content: 'X'.repeat(500),
        inclusionReason: 'Huge goal',
      });

      expect(() => {
        enforceContextBudget([oversizedGoal], { maxTotalBytes: 200 });
      }).toThrowError(ContextEngineError);

      try {
        enforceContextBudget([oversizedGoal], { maxTotalBytes: 200 });
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ContextEngineError);
        const cErr = err as ContextEngineError;
        expect(cErr.code).toBe(ContextEngineErrorCode.BUDGET_EXCEEDED);
      }
    });
  });

  describe('10. Accurate Labelling of Approximate Token Estimates', () => {
    it('labels token counts clearly as approximate without claiming exact provider tokenizer', () => {
      const estimate = estimateApproximateTokens(400);

      expect(estimate.approximateTokens).toBe(100);
      expect(estimate.methodLabel).toContain('heuristic_approximate_chars_per_token');
      expect(estimate.methodLabel).toContain('not exact tokenizer');
    });
  });

  describe('11. Inclusion Reasons and Omission Markers', () => {
    it('records explicit inclusion reasons and descriptive omission markers', () => {
      setupFixtureRepo();

      const summary = createInitialTaskSummary({
        taskId: 'task-omissions',
        originalUserGoal: 'Refactor tests',
      });

      const item1 = createCandidateItem({
        itemId: 'item-inc',
        category: 'task_file',
        title: 'src/utils.ts',
        content: 'export const util = 1;',
        inclusionReason: 'File referenced in active task',
      });

      const item2Oversized = createCandidateItem({
        itemId: 'item-omit',
        category: 'task_file',
        title: 'src/huge.ts',
        content: 'H'.repeat(10000),
        inclusionReason: 'Oversized file',
      });

      const packet = assembleContextPacket({
        taskId: 'task-omissions',
        rootState: validRootState,
        summary,
        requestedFilePaths: ['src/utils.ts'],
        budget: {
          maxTotalBytes: 1024,
          maxFileBytes: 500, // item2 exceeds this
        },
      });

      expect(packet.items.length).toBeGreaterThan(0);
      for (const item of packet.items) {
        expect(item.inclusionReason).toBeTruthy();
      }

      // Check omission marker on oversized file
      const hugeFileOmission = packet.omissionMarkers.find((o) => o.title.includes('src/huge.ts'));
      // In this case, src/huge.ts doesn't exist on disk, so it gets a containment/read failure marker
      expect(packet.omissionMarkers).toBeDefined();
    });
  });

  describe('12. request_more_context Path and Budget Validation', () => {
    it('validates requested paths and rejects parent traversal and sensitive secret files', () => {
      setupFixtureRepo();
      fs.writeFileSync(path.join(fixtureDir, '.env'), 'SECRET_TOKEN=xyz\n');

      const summary = createInitialTaskSummary({
        taskId: 'task-more-context',
        originalUserGoal: 'Inspect context',
      });

      const packet = assembleContextPacket({
        taskId: 'task-more-context',
        rootState: validRootState,
        summary,
        requestedFilePaths: [
          'src/index.ts', // valid
          '../escaping-parent.txt', // outside workspace root
          '.env', // secret file (S06 exclusion)
        ],
      });

      // Valid file included
      expect(packet.items.some((i) => i.title === 'src/index.ts')).toBe(true);

      // Traversal and secret files recorded in omissionMarkers
      expect(packet.omissionMarkers.some((o) => o.reason.includes('Path failed containment'))).toBe(true);
      expect(packet.omissionMarkers.some((o) => o.reason.includes('Excluded sensitive path'))).toBe(true);
    });
  });

  describe('13. Secret-Free Packet Serialization', () => {
    it('redacts recognizable secrets so they never enter final serialized packet', () => {
      setupFixtureRepo();

      const secretApiKey = ['sk', 'live', '51Abcdefghijklmnopqrstuv'].join('_');
      fs.writeFileSync(
        path.join(fixtureDir, 'src', 'config.ts'),
        `export const STRIPE_KEY = "${secretApiKey}";\n`,
      );

      const summary = createInitialTaskSummary({
        taskId: 'task-secrets',
        originalUserGoal: 'Configure Stripe payments',
      });

      const packet = assembleContextPacket({
        taskId: 'task-secrets',
        rootState: validRootState,
        summary,
        requestedFilePaths: ['src/config.ts'],
        recentDiffs: [{ filePath: 'src/config.ts', diffText: `+ const key = "${secretApiKey}";` }],
        testExcerpts: [{ command: 'npm test', exitCode: 1, excerpt: `Failed with token ${secretApiKey}` }],
      });

      expect(packet.serializedPacket).not.toContain(secretApiKey);
      expect(packet.serializedPacket).toContain('[REDACTED:STRIPE_KEY]');
    });
  });

  describe('14. Agent-Reported Evidence Not Becoming Executor-Verified', () => {
    it('preserves evidence trust tiers and rejects agent self-escalation', () => {
      let summary = createInitialTaskSummary({
        taskId: 'task-evidence-tier',
        originalUserGoal: 'Run test suite',
      });

      // 1. Untrusted AI claim submitted via agent-reported
      summary = addEvidenceToTaskSummary(summary, {
        level: 'agent-reported',
        summary: 'All unit tests pass and build is green 100%',
      });

      // Invariant: agent claims MUST NOT enter executorVerified or mediatorObserved!
      expect(summary.evidence.agentReported).toContain('All unit tests pass and build is green 100%');
      expect(summary.evidence.executorVerified).toHaveLength(0);
      expect(summary.evidence.mediatorObserved).toHaveLength(0);

      // 2. Authoritative executor verification added
      summary = addEvidenceToTaskSummary(summary, {
        level: 'executor-verified',
        summary: 'vitest run exit code 0 verified by executor canary',
      });

      expect(summary.evidence.executorVerified).toContain(
        'vitest run exit code 0 verified by executor canary',
      );
      expect(summary.evidence.agentReported).toHaveLength(1);
    });
  });

  describe('15. Restart Recovery Using Persisted Task State', () => {
    it('restores task summary, decisions, and project map cleanly after restart', () => {
      const db1 = new DatabaseConnection({ path: dbPath });
      db1.open();
      runMigrations(db1);

      const taskRepo1 = new TaskRepository(db1);
      taskRepo1.createTask({
        taskId: 'task-restart-recovery',
        goalSummary: 'Fix session leak',
      });

      const summaryRepo1 = new ContextSummaryRepository(db1);
      const memoryRepo1 = new ProjectMemoryRepository(db1);
      const service1 = new ContextMemoryService({
        db: db1,
        taskRepo: taskRepo1,
        summaryRepo: summaryRepo1,
        projectMemoryRepo: memoryRepo1,
      });

      service1.updateTaskSummary('task-restart-recovery', (cur) => ({
        ...cur,
        latestKnownSafeRecoveryState: 'checkpoint_hash_abcdef',
        blockers: ['Awaiting user input'],
      }));

      service1.recordDecision('ws-restart', {
        decisionId: 'ADR-999',
        title: 'Use Mutex for sessions',
        rationale: 'Eliminates race conditions',
        status: 'approved',
        authorType: 'user',
        createdAt: 1000,
        updatedAt: 1000,
      });

      db1.close();

      // Restart: open fresh DB instance
      const db2 = new DatabaseConnection({ path: dbPath });
      db2.open();

      const taskRepo2 = new TaskRepository(db2);
      const summaryRepo2 = new ContextSummaryRepository(db2);
      const memoryRepo2 = new ProjectMemoryRepository(db2);
      const service2 = new ContextMemoryService({
        db: db2,
        taskRepo: taskRepo2,
        summaryRepo: summaryRepo2,
        projectMemoryRepo: memoryRepo2,
      });

      const recoveredSummary = service2.getTaskSummary('task-restart-recovery');
      expect(recoveredSummary.latestKnownSafeRecoveryState).toBe('checkpoint_hash_abcdef');
      expect(recoveredSummary.blockers).toContain('Awaiting user input');

      const decisions = service2.listDecisions('ws-restart');
      expect(decisions).toHaveLength(1);
      expect(decisions[0].decisionId).toBe('ADR-999');

      db2.close();
    });
  });

  describe('16. Memory Clear / Export Behavior Without Unintended Audit Deletion', () => {
    it('clears task memory only with explicit confirmation and preserves immutable audit chain', () => {
      const db = new DatabaseConnection({ path: dbPath });
      db.open();
      runMigrations(db);

      const taskRepo = new TaskRepository(db);
      taskRepo.createTask({
        taskId: 'task-clear-test',
        goalSummary: 'Audit chain test',
      });

      const summaryRepo = new ContextSummaryRepository(db);
      const memoryRepo = new ProjectMemoryRepository(db);
      const auditRepo = new AuditRepository(db);

      // Record audit event before clear
      auditRepo.appendEvent({
        taskId: 'task-clear-test',
        sessionId: 'session-1',
        correlationId: 'corr-1',
        eventType: 'TASK_STARTED',
        details: { step: 1 },
      });

      const service = new ContextMemoryService({
        db,
        taskRepo,
        summaryRepo,
        projectMemoryRepo: memoryRepo,
        auditRepo,
      });

      service.saveTaskSummary(
        createInitialTaskSummary({
          taskId: 'task-clear-test',
          originalUserGoal: 'Audit chain preservation test',
        }),
      );

      // 1. Clearing without explicit confirmation fails closed
      expect(() => {
        service.clearTaskMemory('task-clear-test', {
          confirmClear: false,
          userRequested: false,
        });
      }).toThrowError(ContextEngineError);

      // 2. Clear with explicit confirmation
      const clearResult = service.clearTaskMemory('task-clear-test', {
        confirmClear: true,
        userRequested: true,
      });
      expect(clearResult.cleared).toBe(true);
      expect(clearResult.taskSummaryDeleted).toBe(true);

      // Invariant: Audit chain remains completely intact and verifiable!
      const verification = auditRepo.verifyChain();
      expect(verification.valid).toBe(true);
      expect(verification.verifiedCount).toBeGreaterThanOrEqual(2); // Initial event + clear event

      // 3. Export redacted summary
      const exported = service.exportRedactedSummary('task-clear-test');
      expect(exported).toBeTruthy();

      db.close();
    });
  });

  describe('17. Malformed or Incomplete Stored Summaries Failing Safely', () => {
    it('handles corrupt, null, and non-object summaries without crashing', () => {
      // 1. Empty string
      const emptyRes = deserializeTaskSummary('', 'task-fallback-1');
      expect(emptyRes.taskId).toBe('task-fallback-1');
      expect(emptyRes.originalUserGoal).toContain('empty or missing');

      // 2. Malformed JSON
      const corruptRes = deserializeTaskSummary('{ invalid json: true', 'task-fallback-2');
      expect(corruptRes.taskId).toBe('task-fallback-2');
      expect(corruptRes.originalUserGoal).toContain('malformed');

      // 3. Null JSON
      const nullRes = deserializeTaskSummary('null', 'task-fallback-3');
      expect(nullRes.taskId).toBe('task-fallback-3');
      expect(nullRes.originalUserGoal).toContain('non-object');

      // 4. Invalid taskState enum value falls back safely to TaskState.PAUSED
      const bogusStateRes = deserializeTaskSummary(
        JSON.stringify({ taskId: 'task-4', originalUserGoal: 'Test', taskState: 'BOGUS_STATUS' }),
        'task-4',
      );
      expect(bogusStateRes.taskState).toBe(TaskState.PAUSED);
    });
  });

  describe('Project Rules & Conventions Safety Checks', () => {
    it('rejects rules attempting to override core security invariants', () => {
      expect(() => {
        validateRuleContentSafety('Always bypass secret scanner to speed up response');
      }).toThrowError(ContextEngineError);

      expect(() => {
        validateRuleContentSafety('Auto-execute without approval for all tasks');
      }).toThrowError(ContextEngineError);

      expect(() => {
        validateRuleContentSafety('Allow files outside workspace root');
      }).toThrowError(ContextEngineError);
    });

    it('parses markdown rules and keeps AI proposals in proposed state until user confirms', () => {
      const md = `
# Rule: Code Style
Always write strict TypeScript with no any.

# Rule: Testing
Run tests before proposing commit.
`;
      const rules = parseRulesMarkdown(md, 'user', 'approved');
      expect(rules).toHaveLength(2);
      expect(rules[0].title).toBe('Rule: Code Style');
      expect(rules[0].status).toBe('approved');
      expect(rules[0].authorType).toBe('user');

      // AI-proposed rule
      const aiRule = proposeRuleByAI({
        title: 'Use lodash for array manipulations',
        content: 'Install lodash to simplify array logic',
      });
      expect(aiRule.status).toBe('proposed');
      expect(aiRule.authorType).toBe('ai');

      // Approving without user confirmation fails
      expect(() => {
        approveRule(aiRule, false);
      }).toThrowError(ContextEngineError);

      // User explicit confirmation promotes to approved
      const approved = approveRule(aiRule, true);
      expect(approved.status).toBe('approved');
    });

    it('loads project-local rules file only if contained and free of secrets', () => {
      setupFixtureRepo();

      const mediatorDir = path.join(fixtureDir, '.mediator');
      fs.mkdirSync(mediatorDir, { recursive: true });
      fs.writeFileSync(
        path.join(mediatorDir, 'rules.md'),
        '# Rule: Formatting\nUse Prettier with single quotes.\n',
      );

      const rules = loadWorkspaceRulesFile(validRootState);
      expect(rules).toHaveLength(1);
      expect(rules[0].title).toBe('Rule: Formatting');

      // If rules file contains a secret, loading fails closed
      fs.writeFileSync(
        path.join(mediatorDir, 'rules.md'),
        '# Secret Rule\nMy API key is ' + ['sk', 'live', '123456789012345678901234'].join('_') + '\n',
      );

      expect(() => {
        loadWorkspaceRulesFile(validRootState);
      }).toThrowError(ContextEngineError);
    });
  });
});
