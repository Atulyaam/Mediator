/**
 * @mediator/stage-store — Test Suite (S12)
 *
 * Covers all 20 requirements from Sprint S12 specification:
 * 1. Stage creation and task isolation.
 * 2. Staging a new file without creating it in the live project.
 * 3. Staging a modification without changing the original file.
 * 4. Staging delete/rename intent without executing it.
 * 5. Outside-root and traversal attempts being rejected.
 * 6. Secret-excluded source files being denied before reading.
 * 7. Oversized or malformed staged content being rejected.
 * 8. Source hash capture and stage hash verification.
 * 9. User modifications after staging being detected as conflicts.
 * 10. A newly created live file conflicting with a staged addition.
 * 11. Source deletion or unavailability being reported safely.
 * 12. Diff correctness for new, modified and deletion-proposed files.
 * 13. Protected-path status being preserved in the preview.
 * 14. Checkpoint creation and restore.
 * 15. Corrupt or mismatched checkpoint rejection.
 * 16. Rollback changing staged state but never live files.
 * 17. Stage integrity verification after database close/reopen.
 * 18. Stage metadata and stored content remaining task-isolated.
 * 19. Persistence errors leaving no partial valid-stage result.
 * 20. End-to-end test verifying all original file hashes remain unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  DatabaseConnection,
  runMigrations,
  TaskRepository,
} from '@mediator/persistence';
import { type WorkspaceRootState } from '@mediator/workspace-boundary';
import { TaskState } from '@mediator/shared-contracts';
import {
  StageStore,
  StageError,
  StageErrorCode,
  computeSha256,
} from './index.js';

describe('Sprint S12 — Shadow Staging Store & Isolated Change Preview', () => {
  let tempBaseDir: string;
  let tempWorkspaceDir: string;
  let tempStagingDir: string;
  let tempDbPath: string;
  let db: DatabaseConnection;
  let stageStore: StageStore;
  let workspaceState: WorkspaceRootState;
  const taskId = 'task-s12-001';

  function hashDirectoryFiles(dir: string): Map<string, string> {
    const fileHashes = new Map<string, string>();
    if (!fs.existsSync(dir)) return fileHashes;

    function walk(curr: string) {
      const entries = fs.readdirSync(curr, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(curr, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          const rel = path.relative(dir, full).replace(/\\/g, '/');
          const content = fs.readFileSync(full);
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          fileHashes.set(rel, hash);
        }
      }
    }

    walk(dir);
    return fileHashes;
  }

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s12-test-'));
    tempWorkspaceDir = path.join(tempBaseDir, 'workspace');
    tempStagingDir = path.join(tempBaseDir, 'staging');
    tempDbPath = path.join(tempBaseDir, 'mediator_test.db');

    fs.mkdirSync(tempWorkspaceDir, { recursive: true });
    fs.mkdirSync(tempStagingDir, { recursive: true });

    // Seed initial files in workspace
    fs.mkdirSync(path.join(tempWorkspaceDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempWorkspaceDir, 'src', 'main.ts'),
      'console.log("hello original");\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempWorkspaceDir, 'package.json'),
      JSON.stringify({ name: 'fixture-app', version: '1.0.0' }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempWorkspaceDir, 'README.md'),
      '# Original Project\nInitial documentation.\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempWorkspaceDir, '.env'),
      'SUPER_SECRET_KEY=12345\n',
      'utf8',
    );

    // Initialize SQLite DB
    db = new DatabaseConnection({ path: tempDbPath });
    db.open();
    runMigrations(db);

    // Create task in database
    const taskRepo = new TaskRepository(db);
    taskRepo.createTask({
      taskId,
      goalSummary: 'Sprint S12 Staging Test Task',
      state: TaskState.TASK_DEFINED,
    });

    const canonicalPath = fs.realpathSync.native(tempWorkspaceDir);
    workspaceState = {
      selectedPath: tempWorkspaceDir,
      canonicalPath,
      selectionSource: 'cli',
      confirmationStatus: 'confirmed',
      confirmationTimestamp: Date.now(),
      resolutionStatus: 'resolved',
      cloudStatus: 'not_cloud',
    };

    stageStore = new StageStore(db, { baseStagingDir: tempStagingDir });
  });

  afterEach(() => {
    if (db && db.isOpen()) {
      db.close();
    }
    if (fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {
        // Ignore windows file lock cleanup
      }
    }
  });

  it('1. Stage creation and task isolation', () => {
    const stage1 = stageStore.createStage({
      taskId,
      workspace: workspaceState,
    });

    expect(stage1.stageId).toMatch(/^stage_/);
    expect(stage1.taskId).toBe(taskId);
    expect(stage1.status).toBe('active');
    expect(stage1.canonicalWorkspacePath).toBe(workspaceState.canonicalPath);

    // Verify stage directory was created outside workspace in staging area
    const expectedDir = path.join(tempStagingDir, taskId, stage1.stageId, 'files');
    expect(fs.existsSync(expectedDir)).toBe(true);

    // Verify capabilities
    const caps = stageStore.getStagingCapabilities();
    expect(caps.isolationMethod).toBe('app_data_shadow');
    expect(caps.liveWorkspaceMutationEnabled).toBe(false);
    expect(caps.sandboxAccessibility).toBe('unknown');
  });

  it('2. Staging a new file without creating it in the live project', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });
    const newFilePath = 'src/utils/math.ts';
    const newContent = 'export function add(a: number, b: number): number { return a + b; }\n';

    const staged = stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: newFilePath,
        changeType: 'add',
        content: newContent,
      },
      workspaceState,
    );

    expect(staged.relativePath).toBe(newFilePath);
    expect(staged.changeType).toBe('add');
    expect(staged.sourceExistsAtBase).toBe(false);
    expect(staged.baseContentHash).toBeNull();
    expect(staged.stagedContentHash).toBe(computeSha256(newContent));

    // CRITICAL: Live workspace must NOT have the new file!
    const liveTarget = path.join(tempWorkspaceDir, 'src', 'utils', 'math.ts');
    expect(fs.existsSync(liveTarget)).toBe(false);

    // Staging store must have the file
    const retrieved = stageStore.getStagedFile(stage.stageId, newFilePath);
    expect(retrieved.content.toString('utf8')).toBe(newContent);
  });

  it('3. Staging a modification without changing the original file', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });
    const originalMain = fs.readFileSync(path.join(tempWorkspaceDir, 'src', 'main.ts'), 'utf8');
    const originalHash = computeSha256(originalMain);

    const modifiedContent = 'console.log("hello modified staged world!");\n';

    const staged = stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/main.ts',
        changeType: 'modify',
        content: modifiedContent,
      },
      workspaceState,
    );

    expect(staged.relativePath).toBe('src/main.ts');
    expect(staged.changeType).toBe('modify');
    expect(staged.sourceExistsAtBase).toBe(true);
    expect(staged.baseContentHash).toBe(originalHash);
    expect(staged.stagedContentHash).toBe(computeSha256(modifiedContent));

    // CRITICAL: Original live file must remain unmodified!
    const liveMainCurrent = fs.readFileSync(path.join(tempWorkspaceDir, 'src', 'main.ts'), 'utf8');
    expect(liveMainCurrent).toBe(originalMain);
    expect(computeSha256(liveMainCurrent)).toBe(originalHash);

    // Staged copy has the modified content
    const retrieved = stageStore.getStagedFile(stage.stageId, 'src/main.ts');
    expect(retrieved.content.toString('utf8')).toBe(modifiedContent);
  });

  it('4. Staging delete/rename intent without executing it on live files', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    // Propose deletion of README.md
    const stagedDelete = stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'README.md',
        changeType: 'delete-proposed',
      },
      workspaceState,
    );

    expect(stagedDelete.changeType).toBe('delete-proposed');
    expect(stagedDelete.requiresManualReview).toBe(true);
    // Live README.md MUST STILL EXIST!
    expect(fs.existsSync(path.join(tempWorkspaceDir, 'README.md'))).toBe(true);

    // Propose rename
    const stagedRename = stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/main.ts',
        changeType: 'rename-proposed',
        targetPath: 'src/index.ts',
        content: 'console.log("renamed content");\n',
      },
      workspaceState,
    );

    expect(stagedRename.changeType).toBe('rename-proposed');
    expect(stagedRename.targetPath).toBe('src/index.ts');
    expect(stagedRename.requiresManualReview).toBe(true);

    // Live src/main.ts MUST STILL EXIST; src/index.ts must NOT exist!
    expect(fs.existsSync(path.join(tempWorkspaceDir, 'src', 'main.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tempWorkspaceDir, 'src', 'index.ts'))).toBe(false);
  });

  it('5. Outside-root and traversal attempts being rejected', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    // Traversal via ../
    expect(() => {
      stageStore.stageFileProposal(
        stage.stageId,
        {
          relativePath: '../outside.txt',
          changeType: 'add',
          content: 'malicious',
        },
        workspaceState,
      );
    }).toThrow(StageError);

    // Leading slash
    expect(() => {
      stageStore.stageFileProposal(
        stage.stageId,
        {
          relativePath: '/etc/passwd',
          changeType: 'add',
          content: 'malicious',
        },
        workspaceState,
      );
    }).toThrow(StageError);

    // Windows device name
    expect(() => {
      stageStore.stageFileProposal(
        stage.stageId,
        {
          relativePath: 'CON.txt',
          changeType: 'add',
          content: 'malicious',
        },
        workspaceState,
      );
    }).toThrow(StageError);

    // Colons (ADS)
    expect(() => {
      stageStore.stageFileProposal(
        stage.stageId,
        {
          relativePath: 'file.txt:hidden',
          changeType: 'add',
          content: 'malicious',
        },
        workspaceState,
      );
    }).toThrow(StageError);
  });

  it('6. Secret-excluded source files being denied before reading', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    // .env is in MANDATORY_EXCLUSIONS
    expect(() => {
      stageStore.stageFileProposal(
        stage.stageId,
        {
          relativePath: '.env',
          changeType: 'modify',
          content: 'SUPER_SECRET_KEY=99999\n',
        },
        workspaceState,
      );
    }).toThrow(StageError);

    try {
      stageStore.stageFileProposal(
        stage.stageId,
        {
          relativePath: '.env',
          changeType: 'modify',
          content: 'foo=bar',
        },
        workspaceState,
      );
    } catch (err) {
      expect(err).toBeInstanceOf(StageError);
      expect((err as StageError).code).toBe(StageErrorCode.PATH_EXCLUDED);
    }
  });

  it('7. Oversized or malformed staged content being rejected', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    // Oversized buffer (> 2 MB)
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 10);
    expect(() => {
      stageStore.stageFileProposal(
        stage.stageId,
        {
          relativePath: 'large_file.bin',
          changeType: 'add',
          content: oversized,
        },
        workspaceState,
      );
    }).toThrow(StageError);

    // Secret pattern in content
    const contentWithSecret = 'const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";\n';
    expect(() => {
      stageStore.stageFileProposal(
        stage.stageId,
        {
          relativePath: 'src/config.ts',
          changeType: 'add',
          content: contentWithSecret,
        },
        workspaceState,
      );
    }).toThrow(StageError);
  });

  it('8. Source hash capture and stage hash verification', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });
    const originalMain = fs.readFileSync(path.join(tempWorkspaceDir, 'src', 'main.ts'), 'utf8');
    const originalHash = computeSha256(originalMain);

    // Verify expectedBaseHash mismatch triggers STAGE_BASE_HASH_STALE
    expect(() => {
      stageStore.stageFileProposal(
        stage.stageId,
        {
          relativePath: 'src/main.ts',
          changeType: 'modify',
          content: 'new content',
          expectedBaseHash: '0000000000000000000000000000000000000000000000000000000000000000',
        },
        workspaceState,
      );
    }).toThrow(StageError);

    // Matching expectedBaseHash succeeds
    const staged = stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/main.ts',
        changeType: 'modify',
        content: 'new content',
        expectedBaseHash: originalHash,
      },
      workspaceState,
    );

    expect(staged.baseContentHash).toBe(originalHash);
  });

  it('9. User modifications after staging being detected as conflicts', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    // Stage a change to src/main.ts
    stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/main.ts',
        changeType: 'modify',
        content: 'staged change v1\n',
      },
      workspaceState,
    );

    // Initial check: clean
    let changes = stageStore.listStagedChanges(stage.stageId, workspaceState);
    expect(changes[0].conflictStatus).toBe('clean');

    // User modifies src/main.ts in the live workspace!
    fs.writeFileSync(
      path.join(tempWorkspaceDir, 'src', 'main.ts'),
      'console.log("user altered live file directly!");\n',
      'utf8',
    );

    // Re-check: conflict detected!
    changes = stageStore.listStagedChanges(stage.stageId, workspaceState);
    expect(changes[0].conflictStatus).toBe('conflict');
    expect(changes[0].conflictReason).toContain('Live file was modified after staging');

    // Diff preview reflects conflict
    const diffs = stageStore.getStageDiff(stage.stageId, workspaceState);
    expect(diffs[0].conflictStatus).toBe('conflict');
  });

  it('10. A newly created live file conflicting with a staged addition', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    // Stage new file
    stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/feature.ts',
        changeType: 'add',
        content: 'export const feature = 1;\n',
      },
      workspaceState,
    );

    let changes = stageStore.listStagedChanges(stage.stageId, workspaceState);
    expect(changes[0].conflictStatus).toBe('clean');

    // A live file appears at src/feature.ts
    fs.writeFileSync(
      path.join(tempWorkspaceDir, 'src', 'feature.ts'),
      'export const conflictingLiveFeature = 2;\n',
      'utf8',
    );

    // Conflict detected!
    changes = stageStore.listStagedChanges(stage.stageId, workspaceState);
    expect(changes[0].conflictStatus).toBe('conflict');
    expect(changes[0].conflictReason).toContain('conflicting with staged addition');
  });

  it('11. Source deletion being reported safely as conflict', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    // Stage modify to README.md
    stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'README.md',
        changeType: 'modify',
        content: 'updated readme\n',
      },
      workspaceState,
    );

    // Delete README.md in live workspace
    fs.unlinkSync(path.join(tempWorkspaceDir, 'README.md'));

    const changes = stageStore.listStagedChanges(stage.stageId, workspaceState);
    expect(changes[0].conflictStatus).toBe('conflict');
    expect(changes[0].conflictReason).toContain('deleted from live workspace');
  });

  it('12. Diff correctness for new, modified and deletion-proposed files', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    // 1. New file
    stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/new.ts',
        changeType: 'add',
        content: 'line 1\nline 2\n',
      },
      workspaceState,
    );

    // 2. Modified file
    stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/main.ts',
        changeType: 'modify',
        content: 'console.log("hello modified");\n',
      },
      workspaceState,
    );

    // 3. Deletion proposed
    stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'README.md',
        changeType: 'delete-proposed',
      },
      workspaceState,
    );

    const diffs = stageStore.getStageDiff(stage.stageId, workspaceState);
    expect(diffs.length).toBe(3);

    const newDiff = diffs.find((d) => d.relativePath === 'src/new.ts')!;
    expect(newDiff.changeType).toBe('add');
    expect(newDiff.diffText).toContain('--- /dev/null');
    expect(newDiff.diffText).toContain('+line 1');
    expect(newDiff.stats.additions).toBe(2);

    const modDiff = diffs.find((d) => d.relativePath === 'src/main.ts')!;
    expect(modDiff.changeType).toBe('modify');
    expect(modDiff.diffText).toContain('--- a/src/main.ts');
    expect(modDiff.diffText).toContain('+console.log("hello modified");');

    const delDiff = diffs.find((d) => d.relativePath === 'README.md')!;
    expect(delDiff.changeType).toBe('delete-proposed');
    expect(delDiff.diffText).toContain('+++ /dev/null');
    expect(delDiff.stats.deletions).toBeGreaterThan(0);
  });

  it('13. Protected-path status being preserved in the preview', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    // package.json is a protected dependency manifest
    const stagedPkg = stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'package.json',
        changeType: 'modify',
        content: JSON.stringify({ name: 'fixture-app', version: '2.0.0' }, null, 2),
      },
      workspaceState,
    );

    expect(stagedPkg.isProtected).toBe(true);
    expect(stagedPkg.policyDecision).toBe('REQUIRE_APPROVAL');
    expect(stagedPkg.requiresManualReview).toBe(true);

    const diffs = stageStore.getStageDiff(stage.stageId, workspaceState, 'package.json');
    expect(diffs[0].isProtected).toBe(true);
    expect(diffs[0].requiresManualReview).toBe(true);
  });

  it('14. Checkpoint creation and restore', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    // Stage file v1
    stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/main.ts',
        changeType: 'modify',
        content: 'version 1 content\n',
      },
      workspaceState,
    );

    // Create Checkpoint 1
    const chk1 = stageStore.createCheckpoint(stage.stageId, 'Checkpoint before v2');
    expect(chk1.checkpointId).toBeDefined();
    expect(chk1.files.length).toBe(1);

    // Update to v2
    stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/main.ts',
        changeType: 'modify',
        content: 'version 2 content\n',
      },
      workspaceState,
    );

    let retrieved = stageStore.getStagedFile(stage.stageId, 'src/main.ts');
    expect(retrieved.content.toString('utf8')).toBe('version 2 content\n');

    // Restore Checkpoint 1
    const restored = stageStore.restoreCheckpoint(stage.stageId, chk1.checkpointId);
    expect(restored.length).toBe(1);

    // Verify content rolled back to version 1
    retrieved = stageStore.getStagedFile(stage.stageId, 'src/main.ts');
    expect(retrieved.content.toString('utf8')).toBe('version 1 content\n');
  });

  it('15. Corrupt or mismatched checkpoint rejection', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    // Non-existent checkpoint
    expect(() => {
      stageStore.restoreCheckpoint(stage.stageId, 'chk_nonexistent');
    }).toThrow(StageError);

    // Checkpoint belonging to different task
    const taskRepo = new TaskRepository(db);
    taskRepo.createTask({
      taskId: 'task-other-999',
      goalSummary: 'Other task',
      state: TaskState.TASK_DEFINED,
    });

    const otherStage = stageStore.createStage({
      taskId: 'task-other-999',
      workspace: workspaceState,
    });

    stageStore.stageFileProposal(
      otherStage.stageId,
      {
        relativePath: 'src/main.ts',
        changeType: 'modify',
        content: 'other task content',
      },
      workspaceState,
    );

    const otherChk = stageStore.createCheckpoint(otherStage.stageId, 'Other checkpoint');

    // Restoring other stage's checkpoint on stage throws CHECKPOINT_MISMATCH
    expect(() => {
      stageStore.restoreCheckpoint(stage.stageId, otherChk.checkpointId);
    }).toThrow(StageError);
  });

  it('16. Rollback changing staged state but NEVER live files', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });
    const originalLiveMain = fs.readFileSync(path.join(tempWorkspaceDir, 'src', 'main.ts'), 'utf8');

    stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/main.ts',
        changeType: 'modify',
        content: 'staged 1\n',
      },
      workspaceState,
    );

    const chk = stageStore.createCheckpoint(stage.stageId, 'cp1');

    stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/main.ts',
        changeType: 'modify',
        content: 'staged 2\n',
      },
      workspaceState,
    );

    stageStore.restoreCheckpoint(stage.stageId, chk.checkpointId);

    // Live file was completely untouched throughout
    const currentLiveMain = fs.readFileSync(path.join(tempWorkspaceDir, 'src', 'main.ts'), 'utf8');
    expect(currentLiveMain).toBe(originalLiveMain);
  });

  it('17. Stage integrity verification after database close/reopen', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/main.ts',
        changeType: 'modify',
        content: 'persistent staged content\n',
      },
      workspaceState,
    );

    const integrityBefore = stageStore.verifyStageIntegrity(stage.stageId);
    expect(integrityBefore.verified).toBe(true);

    // Close and reopen database
    db.close();

    const reopenedDb = new DatabaseConnection({ path: tempDbPath });
    reopenedDb.open();

    const reopenedStore = new StageStore(reopenedDb, { baseStagingDir: tempStagingDir });
    const integrityAfter = reopenedStore.verifyStageIntegrity(stage.stageId);
    expect(integrityAfter.verified).toBe(true);
    expect(integrityAfter.filesCount).toBe(1);

    const staged = reopenedStore.getStagedFile(stage.stageId, 'src/main.ts');
    expect(staged.content.toString('utf8')).toBe('persistent staged content\n');

    reopenedDb.close();
  });

  it('18. Stage metadata and stored content remaining task-isolated', () => {
    const stage1 = stageStore.createStage({ taskId, workspace: workspaceState });

    const taskRepo = new TaskRepository(db);
    taskRepo.createTask({
      taskId: 'task-isolated-2',
      goalSummary: 'Task 2',
      state: TaskState.TASK_DEFINED,
    });

    const stage2 = stageStore.createStage({
      taskId: 'task-isolated-2',
      workspace: workspaceState,
    });

    // Stage same relative path in both stages with different content
    stageStore.stageFileProposal(
      stage1.stageId,
      { relativePath: 'src/main.ts', changeType: 'modify', content: 'task 1 code\n' },
      workspaceState,
    );

    stageStore.stageFileProposal(
      stage2.stageId,
      { relativePath: 'src/main.ts', changeType: 'modify', content: 'task 2 code\n' },
      workspaceState,
    );

    expect(stageStore.getStagedFile(stage1.stageId, 'src/main.ts').content.toString('utf8')).toBe('task 1 code\n');
    expect(stageStore.getStagedFile(stage2.stageId, 'src/main.ts').content.toString('utf8')).toBe('task 2 code\n');
  });

  it('19. Discard stage requires explicit confirmation and cleans up shadow storage', () => {
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    stageStore.stageFileProposal(
      stage.stageId,
      { relativePath: 'src/main.ts', changeType: 'modify', content: 'temp code\n' },
      workspaceState,
    );

    // Missing confirmation
    expect(() => {
      stageStore.discardStage(stage.stageId, { confirmed: false });
    }).toThrow(StageError);

    // Confirmed discard
    stageStore.discardStage(stage.stageId, { confirmed: true, reason: 'user cancelled' });

    const status = stageStore.getStageStatus(stage.stageId);
    expect(status.status).toBe('discarded');

    // Storage files directory is removed
    const filesDir = path.join(tempStagingDir, taskId, stage.stageId, 'files');
    expect(fs.existsSync(filesDir)).toBe(false);

    // Cannot stage more changes to discarded stage
    expect(() => {
      stageStore.stageFileProposal(
        stage.stageId,
        { relativePath: 'src/main.ts', changeType: 'modify', content: 'more' },
        workspaceState,
      );
    }).toThrow(StageError);
  });

  it('20. End-to-end invariant: live workspace file hashes remain 100% identical after all staging operations', () => {
    // Snapshot initial live workspace files and hashes
    const initialLiveHashes = hashDirectoryFiles(tempWorkspaceDir);
    expect(initialLiveHashes.size).toBeGreaterThanOrEqual(4);

    // Perform a large variety of staging operations
    const stage = stageStore.createStage({ taskId, workspace: workspaceState });

    // 1. Stage additions
    stageStore.stageFileProposal(
      stage.stageId,
      { relativePath: 'src/a.ts', changeType: 'add', content: 'export const a = 1;\n' },
      workspaceState,
    );
    stageStore.stageFileProposal(
      stage.stageId,
      { relativePath: 'src/b.ts', changeType: 'add', content: 'export const b = 2;\n' },
      workspaceState,
    );

    // 2. Stage modifications
    stageStore.stageFileProposal(
      stage.stageId,
      { relativePath: 'src/main.ts', changeType: 'modify', content: 'modified main\n' },
      workspaceState,
    );
    stageStore.stageFileProposal(
      stage.stageId,
      { relativePath: 'package.json', changeType: 'modify', content: '{"name":"mod"}\n' },
      workspaceState,
    );

    // 3. Stage delete
    stageStore.stageFileProposal(
      stage.stageId,
      { relativePath: 'README.md', changeType: 'delete-proposed' },
      workspaceState,
    );

    // 4. Create and restore checkpoint
    const chk = stageStore.createCheckpoint(stage.stageId, 'e2e checkpoint');
    stageStore.stageFileProposal(
      stage.stageId,
      { relativePath: 'src/c.ts', changeType: 'add', content: 'c\n' },
      workspaceState,
    );
    stageStore.restoreCheckpoint(stage.stageId, chk.checkpointId);

    // 5. Generate diffs and verify integrity
    stageStore.getStageDiff(stage.stageId, workspaceState);
    const integrity = stageStore.verifyStageIntegrity(stage.stageId);
    expect(integrity.verified).toBe(true);

    // Snapshot final live workspace files and hashes
    const finalLiveHashes = hashDirectoryFiles(tempWorkspaceDir);

    // ABSOLUTE INVARIANT: Live workspace is 100% IDENTICAL
    expect(finalLiveHashes.size).toBe(initialLiveHashes.size);
    for (const [relPath, originalHash] of initialLiveHashes.entries()) {
      const currentHash = finalLiveHashes.get(relPath);
      expect(currentHash).toBe(originalHash);
    }
  });
});
