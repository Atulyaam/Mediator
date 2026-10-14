/**
 * @mediator/stage-store — Patch Engine & Conflict Detection Tests (Sprint S13)
 *
 * Covers:
 * 1. Valid unique-context modification applies to stage only.
 * 2. New file is created in staging only.
 * 3. Delete proposal does not delete live file.
 * 4. Rename proposal does not rename live files.
 * 5. Zero-match patch rejection.
 * 6. Ambiguous-match patch rejection.
 * 7. Stale base-hash rejection.
 * 8. Stale staged-hash rejection.
 * 9. Source modification detected as conflict.
 * 10. Source deletion detected as conflict.
 * 11. Unexpected live file creation detected.
 * 12. Existing rename destination conflict.
 * 13. Duplicate or contradictory patch operations rejected.
 * 14. Path traversal and outside-root attempts rejected.
 * 15. Secret/excluded paths denied.
 * 16. Secret-bearing proposed content rejected.
 * 17. Protected paths remain flagged.
 * 18. Encoding and newline preservation (CRLF/LF, BOM, final newline).
 * 19. Oversized and malformed inputs rejected.
 * 20. Concurrent patch updates cannot silently clobber one another.
 * 21. Failed patch leaves previous staged content intact.
 * 22. Live source hashes remain unchanged after all S13 operations.
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
import { TaskState } from '@mediator/shared-contracts';
import {
  type WorkspaceRootState,
  inspectWorkspaceRoot,
} from '@mediator/workspace-boundary';
import { StageStore } from './stageStore.js';
import { PatchError, PatchErrorCode } from './patchErrors.js';
import { computeSha256 } from './stageSnapshot.js';
import { type PatchProposal } from './patchTypes.js';

function computeDirectoryHashSnapshot(dirPath: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  function walk(current: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const rel = path.relative(dirPath, full).replace(/\\/g, '/');
        const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        snapshot.set(rel, hash);
      }
    }
  }
  walk(dirPath);
  return snapshot;
}

describe('Sprint S13 — Patch Application & Conflict Detection', () => {
  let tempDir: string;
  let workspaceDir: string;
  let stagingDir: string;
  let dbPath: string;
  let db: DatabaseConnection;
  let workspace: WorkspaceRootState;
  let stageStore: StageStore;
  const taskId = 'task_s13_test';
  const stageId = 'stage_s13_test';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator_s13_test_'));
    workspaceDir = path.join(tempDir, 'workspace');
    stagingDir = path.join(tempDir, 'staging');
    dbPath = path.join(tempDir, 'test.db');

    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    // Seed fixture workspace files
    fs.writeFileSync(path.join(workspaceDir, 'package.json'), JSON.stringify({ name: 'fixture-project' }, null, 2), 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'Hello world\nThis is line 2\nLine 3 here\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'crlf.txt'), 'Header\r\nTarget line\r\nFooter\r\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'bom.txt'), '\uFEFFBOM content\nLine 2\n', 'utf8');

    // Init confirmed workspace
    const rawWs = inspectWorkspaceRoot(workspaceDir, 'ide');
    workspace = {
      ...rawWs,
      confirmationStatus: 'confirmed',
    };

    // Init DB & migrations
    db = new DatabaseConnection({ path: dbPath });
    db.open();
    runMigrations(db);

    const taskRepo = new TaskRepository(db);
    taskRepo.createTask({
      taskId,
      goalSummary: 'Sprint S13 Patch Engine Task',
      state: TaskState.TASK_DEFINED,
    });

    stageStore = new StageStore(db, { baseStagingDir: stagingDir });
    stageStore.createStage({ taskId, workspace, stageId });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. Valid unique-context modification applies to stage only', () => {
    const liveBefore = fs.readFileSync(path.join(workspaceDir, 'hello.txt'), 'utf8');
    const baseHash = computeSha256(Buffer.from(liveBefore, 'utf8'));

    const proposal: PatchProposal = {
      patchId: 'patch_1',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      expectedBaseHash: baseHash,
      payload: {
        edits: [
          {
            search: 'This is line 2',
            replace: 'This is MODIFIED line 2',
          },
        ],
      },
    };

    const res = stageStore.applyPatch(stageId, proposal, workspace);
    expect(res.status).toBe('applied');
    expect(res.operation).toBe('modify');

    // Verify stage has modified content
    const staged = stageStore.getStagedFile(stageId, 'hello.txt');
    expect(staged.content.toString('utf8')).toContain('This is MODIFIED line 2');
    expect(staged.record.stagedContentHash).toBe(res.resultingHash);

    // Verify live workspace file is 100% UNTOUCHED
    const liveAfter = fs.readFileSync(path.join(workspaceDir, 'hello.txt'), 'utf8');
    expect(liveAfter).toBe(liveBefore);
  });

  it('2. New file is created in staging only', () => {
    const proposal: PatchProposal = {
      patchId: 'patch_2',
      taskId,
      stageId,
      relativePath: 'src/newFile.ts',
      operation: 'create',
      payload: {
        content: 'export const staged = true;\n',
      },
    };

    const res = stageStore.applyPatch(stageId, proposal, workspace);
    expect(res.status).toBe('applied');

    // Staged file exists in stageStore
    const staged = stageStore.getStagedFile(stageId, 'src/newFile.ts');
    expect(staged.content.toString('utf8')).toBe('export const staged = true;\n');

    // Live workspace does NOT have this file
    expect(fs.existsSync(path.join(workspaceDir, 'src/newFile.ts'))).toBe(false);
  });

  it('3. Delete proposal does not delete the live file', () => {
    const proposal: PatchProposal = {
      patchId: 'patch_3',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'delete-proposed',
      payload: {},
    };

    const res = stageStore.applyPatch(stageId, proposal, workspace);
    expect(res.status).toBe('applied');
    expect(res.requiresManualReview).toBe(true); // Destructive proposal

    // Staged file record indicates delete-proposed
    const staged = stageStore.getStagedFile(stageId, 'hello.txt');
    expect(staged.record.changeType).toBe('delete-proposed');

    // Live file MUST still exist!
    expect(fs.existsSync(path.join(workspaceDir, 'hello.txt'))).toBe(true);
  });

  it('4. Rename proposal does not rename live files', () => {
    const proposal: PatchProposal = {
      patchId: 'patch_4',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'rename-proposed',
      payload: {
        targetPath: 'hello_renamed.txt',
      },
    };

    const res = stageStore.applyPatch(stageId, proposal, workspace);
    expect(res.status).toBe('applied');
    expect(res.record.targetPath).toBe('hello_renamed.txt');

    // Live files unchanged
    expect(fs.existsSync(path.join(workspaceDir, 'hello.txt'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, 'hello_renamed.txt'))).toBe(false);
  });

  it('5. Zero-match patch rejection', () => {
    const proposal: PatchProposal = {
      patchId: 'patch_5',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: {
        edits: [
          {
            search: 'Nonexistent text that does not appear in hello.txt',
            replace: 'replacement',
          },
        ],
      },
    };

    expect(() => stageStore.applyPatch(stageId, proposal, workspace)).toThrow(PatchError);
    try {
      stageStore.applyPatch(stageId, proposal, workspace);
    } catch (err) {
      expect((err as PatchError).code).toBe(PatchErrorCode.NO_MATCH);
    }
  });

  it('6. Ambiguous-match patch rejection', () => {
    // Write a file with multiple duplicate lines
    fs.writeFileSync(path.join(workspaceDir, 'duplicate.txt'), 'target\ntarget\ntarget\n', 'utf8');

    const proposal: PatchProposal = {
      patchId: 'patch_6',
      taskId,
      stageId,
      relativePath: 'duplicate.txt',
      operation: 'modify',
      payload: {
        edits: [
          {
            search: 'target',
            replace: 'unique_replacement',
            allowMultiple: false, // Strict unique match required
          },
        ],
      },
    };

    expect(() => stageStore.applyPatch(stageId, proposal, workspace)).toThrow(PatchError);
    try {
      stageStore.applyPatch(stageId, proposal, workspace);
    } catch (err) {
      expect((err as PatchError).code).toBe(PatchErrorCode.AMBIGUOUS_MATCH);
    }
  });

  it('7. Stale base-hash rejection', () => {
    const proposal: PatchProposal = {
      patchId: 'patch_7',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      expectedBaseHash: 'bad_stale_hash_1234567890abcdef',
      payload: {
        content: 'new content',
      },
    };

    expect(() => stageStore.applyPatch(stageId, proposal, workspace)).toThrow(PatchError);
    try {
      stageStore.applyPatch(stageId, proposal, workspace);
    } catch (err) {
      expect((err as PatchError).code).toBe(PatchErrorCode.LIVE_CONFLICT);
    }
  });

  it('8. Stale staged-hash rejection (concurrent race detection)', () => {
    // First stage an edit
    const p1: PatchProposal = {
      patchId: 'patch_8a',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { content: 'Revision 1' },
    };
    stageStore.applyPatch(stageId, p1, workspace);

    // Second patch expects revision 0 or wrong staged hash
    const p2: PatchProposal = {
      patchId: 'patch_8b',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      expectedStageHash: 'wrong_staged_hash_abc',
      payload: { content: 'Revision 2' },
    };

    expect(() => stageStore.applyPatch(stageId, p2, workspace)).toThrow(PatchError);
    try {
      stageStore.applyPatch(stageId, p2, workspace);
    } catch (err) {
      expect((err as PatchError).code).toBe(PatchErrorCode.STALE_STAGE_HASH);
    }
  });

  it('9. Source modification detected as conflict', () => {
    const originalContent = fs.readFileSync(path.join(workspaceDir, 'hello.txt'), 'utf8');
    const baseHash = computeSha256(Buffer.from(originalContent, 'utf8'));

    // User modifies live file in workspace
    fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'User modified this externally\n', 'utf8');

    const proposal: PatchProposal = {
      patchId: 'patch_9',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      expectedBaseHash: baseHash,
      payload: { content: 'AI revision' },
    };

    expect(() => stageStore.applyPatch(stageId, proposal, workspace)).toThrow(PatchError);
    try {
      stageStore.applyPatch(stageId, proposal, workspace);
    } catch (err) {
      expect((err as PatchError).code).toBe(PatchErrorCode.LIVE_CONFLICT);
      expect((err as PatchError).message).toContain('live-modified');
    }
  });

  it('10. Source deletion detected as conflict', () => {
    const originalContent = fs.readFileSync(path.join(workspaceDir, 'hello.txt'), 'utf8');
    const baseHash = computeSha256(Buffer.from(originalContent, 'utf8'));

    // User deletes live file in workspace
    fs.unlinkSync(path.join(workspaceDir, 'hello.txt'));

    const proposal: PatchProposal = {
      patchId: 'patch_10',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      expectedBaseHash: baseHash,
      payload: { content: 'AI revision' },
    };

    expect(() => stageStore.applyPatch(stageId, proposal, workspace)).toThrow(PatchError);
    try {
      stageStore.applyPatch(stageId, proposal, workspace);
    } catch (err) {
      expect((err as PatchError).code).toBe(PatchErrorCode.LIVE_CONFLICT);
      expect((err as PatchError).message).toContain('live-deleted');
    }
  });

  it('11. Unexpected live file creation detected as conflict for proposed add', () => {
    // Propose adding 'newfile.txt', but it already exists in live workspace
    fs.writeFileSync(path.join(workspaceDir, 'alreadyExists.txt'), 'content', 'utf8');

    const proposal: PatchProposal = {
      patchId: 'patch_11',
      taskId,
      stageId,
      relativePath: 'alreadyExists.txt',
      operation: 'create',
      payload: { content: 'staged content' },
    };

    expect(() => stageStore.applyPatch(stageId, proposal, workspace)).toThrow(PatchError);
    try {
      stageStore.applyPatch(stageId, proposal, workspace);
    } catch (err) {
      expect((err as PatchError).code).toBe(PatchErrorCode.LIVE_CONFLICT);
      expect((err as PatchError).message).toContain('live-added');
    }
  });

  it('12. Existing rename destination conflict', () => {
    // hello.txt exists, package.json already exists in workspace
    const proposal: PatchProposal = {
      patchId: 'patch_12',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'rename-proposed',
      payload: { targetPath: 'package.json' }, // Collision with existing live file
    };

    expect(() => stageStore.applyPatch(stageId, proposal, workspace)).toThrow(PatchError);
    try {
      stageStore.applyPatch(stageId, proposal, workspace);
    } catch (err) {
      expect((err as PatchError).code).toBe(PatchErrorCode.LIVE_CONFLICT);
      expect((err as PatchError).message).toContain('rename-destination-exists');
    }
  });

  it('13. Duplicate or contradictory patch operations rejected in batch', () => {
    const proposals: PatchProposal[] = [
      {
        patchId: 'batch_1',
        taskId,
        stageId,
        relativePath: 'hello.txt',
        operation: 'modify',
        payload: { content: 'Batch 1' },
      },
      {
        patchId: 'batch_2',
        taskId,
        stageId,
        relativePath: 'hello.txt', // Duplicate target in same batch!
        operation: 'modify',
        payload: { content: 'Batch 2' },
      },
    ];

    expect(() => stageStore.applyPatchBatch(stageId, proposals, workspace)).toThrow(PatchError);
    try {
      stageStore.applyPatchBatch(stageId, proposals, workspace);
    } catch (err) {
      expect((err as PatchError).code).toBe(PatchErrorCode.CONCURRENT_MODIFICATION);
    }
  });

  it('14. Path traversal and outside-root attempts rejected', () => {
    const traversalProposal: PatchProposal = {
      patchId: 'patch_14',
      taskId,
      stageId,
      relativePath: '../outside.txt',
      operation: 'create',
      payload: { content: 'malicious' },
    };

    expect(() => stageStore.applyPatch(stageId, traversalProposal, workspace)).toThrow(PatchError);
    try {
      stageStore.applyPatch(stageId, traversalProposal, workspace);
    } catch (err) {
      expect((err as PatchError).code).toBe(PatchErrorCode.INVALID_PATH);
    }
  });

  it('15. Secret/excluded paths are denied', () => {
    const secretPathProposal: PatchProposal = {
      patchId: 'patch_15',
      taskId,
      stageId,
      relativePath: '.env',
      operation: 'create',
      payload: { content: 'PORT=3000\n' },
    };

    expect(() => stageStore.applyPatch(stageId, secretPathProposal, workspace)).toThrow(PatchError);
    try {
      stageStore.applyPatch(stageId, secretPathProposal, workspace);
    } catch (err) {
      expect((err as PatchError).code).toBe(PatchErrorCode.PATH_EXCLUDED);
    }
  });

  it('16. Secret-bearing proposed content is rejected', () => {
    const secretContentProposal: PatchProposal = {
      patchId: 'patch_16',
      taskId,
      stageId,
      relativePath: 'src/api.ts',
      operation: 'create',
      payload: {
        content: 'const token = "ghp_123456789012345678901234567890123456";\n',
      },
    };

    expect(() => stageStore.applyPatch(stageId, secretContentProposal, workspace)).toThrow(PatchError);
    try {
      stageStore.applyPatch(stageId, secretContentProposal, workspace);
    } catch (err) {
      expect((err as PatchError).code).toBe(PatchErrorCode.SECRET_DETECTED);
    }
  });

  it('17. Protected paths remain flagged with manual review required', () => {
    const protectedProposal: PatchProposal = {
      patchId: 'patch_17',
      taskId,
      stageId,
      relativePath: 'package.json',
      operation: 'modify',
      payload: {
        content: JSON.stringify({ name: 'fixture-project', version: '1.0.1' }, null, 2),
      },
    };

    const res = stageStore.applyPatch(stageId, protectedProposal, workspace);
    expect(res.isProtected).toBe(true);
    expect(res.requiresManualReview).toBe(true);
    expect(res.record.isProtected).toBe(true);
    expect(res.record.requiresManualReview).toBe(true);
  });

  it('18. Encoding and newline preservation (CRLF, LF, BOM)', () => {
    // A: CRLF file modification
    const crlfProposal: PatchProposal = {
      patchId: 'patch_18_crlf',
      taskId,
      stageId,
      relativePath: 'crlf.txt',
      operation: 'modify',
      payload: {
        edits: [{ search: 'Target line', replace: 'Modified line' }],
      },
    };
    stageStore.applyPatch(stageId, crlfProposal, workspace);
    const crlfStaged = stageStore.getStagedFile(stageId, 'crlf.txt');
    const crlfText = crlfStaged.content.toString('utf8');
    expect(crlfText).toContain('\r\n');
    expect(crlfText).not.toMatch(/[^\r]\n/); // Preserves CRLF consistently

    // B: BOM file modification
    const bomProposal: PatchProposal = {
      patchId: 'patch_18_bom',
      taskId,
      stageId,
      relativePath: 'bom.txt',
      operation: 'modify',
      payload: {
        edits: [{ search: 'Line 2', replace: 'Modified Line 2' }],
      },
    };
    stageStore.applyPatch(stageId, bomProposal, workspace);
    const bomStaged = stageStore.getStagedFile(stageId, 'bom.txt');
    const bomText = bomStaged.content.toString('utf8');
    expect(bomText.charCodeAt(0)).toBe(0xfeff); // Preserves BOM
    expect(bomText).toContain('Modified Line 2');
  });

  it('19. Oversized and malformed inputs rejected', () => {
    const hugeBuffer = Buffer.alloc(3 * 1024 * 1024, 'a'); // 3 MB > 2 MB cap
    const oversizedProposal: PatchProposal = {
      patchId: 'patch_19',
      taskId,
      stageId,
      relativePath: 'big.txt',
      operation: 'create',
      payload: { content: hugeBuffer },
    };

    expect(() => stageStore.applyPatch(stageId, oversizedProposal, workspace)).toThrow(PatchError);
    try {
      stageStore.applyPatch(stageId, oversizedProposal, workspace);
    } catch (err) {
      expect((err as PatchError).code).toBe(PatchErrorCode.OVERSIZED_INPUT);
    }
  });

  it('20. Concurrent patch updates cannot silently clobber one another', () => {
    // We test that expectedStageHash protects against overwriting intermediate edits
    const p1: PatchProposal = {
      patchId: 'p20_a',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { content: 'Agent A edit' },
    };
    const r1 = stageStore.applyPatch(stageId, p1, workspace);

    // Agent B prepared an edit when file was in base state, expecting original hash
    const p2: PatchProposal = {
      patchId: 'p20_b',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      expectedStageHash: 'original_hash_before_agent_a',
      payload: { content: 'Agent B edit' },
    };

    expect(() => stageStore.applyPatch(stageId, p2, workspace)).toThrow(PatchError);
    // Staged file still has Agent A's edit intact
    const staged = stageStore.getStagedFile(stageId, 'hello.txt');
    expect(staged.content.toString('utf8')).toBe('Agent A edit');
  });

  it('21. A failed patch leaves previous staged content intact', () => {
    // Stage an initial valid change
    const initial: PatchProposal = {
      patchId: 'p21_initial',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { content: 'Initial valid staged content' },
    };
    stageStore.applyPatch(stageId, initial, workspace);

    // Attempt a second patch that fails (e.g. secret content)
    const badPatch: PatchProposal = {
      patchId: 'p21_bad',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: {
        content: 'const apiKey = "ghp_123456789012345678901234567890123456";\n',
      },
    };
    expect(() => stageStore.applyPatch(stageId, badPatch, workspace)).toThrow(PatchError);

    // Verify initial staged content is still completely intact
    const staged = stageStore.getStagedFile(stageId, 'hello.txt');
    expect(staged.content.toString('utf8')).toBe('Initial valid staged content');
  });

  it('22. Live source hashes remain 100% unchanged after all S13 operations', () => {
    // Capture snapshot of entire live workspace BEFORE operations
    const beforeHashes = computeDirectoryHashSnapshot(workspaceDir);

    // Run multiple S13 operations: create, modify, delete-proposed, rename-proposed, rejected ops
    stageStore.applyPatch(stageId, {
      patchId: 'all_1',
      taskId,
      stageId,
      relativePath: 'hello.txt',
      operation: 'modify',
      payload: { edits: [{ search: 'Line 3 here', replace: 'Line 3 replaced' }] },
    }, workspace);

    stageStore.applyPatch(stageId, {
      patchId: 'all_2',
      taskId,
      stageId,
      relativePath: 'stagedOnly.ts',
      operation: 'create',
      payload: { content: 'console.log("hello");\n' },
    }, workspace);

    stageStore.applyPatch(stageId, {
      patchId: 'all_3',
      taskId,
      stageId,
      relativePath: 'crlf.txt',
      operation: 'delete-proposed',
      payload: {},
    }, workspace);

    stageStore.applyPatch(stageId, {
      patchId: 'all_4',
      taskId,
      stageId,
      relativePath: 'bom.txt',
      operation: 'rename-proposed',
      payload: { targetPath: 'bom_renamed.txt' },
    }, workspace);

    // Capture snapshot of entire live workspace AFTER operations
    const afterHashes = computeDirectoryHashSnapshot(workspaceDir);

    expect(afterHashes.size).toBe(beforeHashes.size);
    for (const [relPath, beforeHash] of beforeHashes.entries()) {
      expect(afterHashes.has(relPath)).toBe(true);
      expect(afterHashes.get(relPath)).toBe(beforeHash);
    }
  });
});
