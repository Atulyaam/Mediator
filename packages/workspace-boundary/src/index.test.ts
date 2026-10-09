import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  selectFromIdeFolders,
  selectExplicitIdeFolder,
  parseCliWorkspaceArg,
  reconcileSelections,
  inspectWorkspaceRoot,
  resolveWorkspaceRoot,
  confirmWorkspaceRoot,
  updateWorkspaceRoot,
  checkWorkspacePermittedForFileOps,
  detectCloudStatus,
  type FileSystemAdapter,
} from './index.js';
import { ErrorCode } from '@mediator/shared-contracts';

describe('Sprint S04 — Canonical Workspace Root', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s04-test-'));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors on windows locks
    }
  });

  // ─── 1. Valid workspace selection and canonical resolution ─────────────────
  describe('1. Valid workspace selection and canonical resolution', () => {
    it('resolves an existing directory to its canonical path', () => {
      const res = resolveWorkspaceRoot(tempDir, 'ide');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.selectedPath).toBe(tempDir);
        expect(res.value.canonicalPath).toBeTruthy();
        expect(res.value.selectionSource).toBe('ide');
        expect(res.value.confirmationStatus).toBe('pending');
        expect(res.value.resolutionStatus).toBe('resolved');
      }
    });

    it('separate selectedPath and canonicalPath are tracked', () => {
      const subDir = path.join(tempDir, 'sub');
      fs.mkdirSync(subDir);
      // selectedPath with redundant slashes / relative components
      const unnormalized = `${subDir}${path.sep}.${path.sep}`;
      const res = resolveWorkspaceRoot(unnormalized, 'cli');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.selectedPath).toBe(unnormalized.trim());
        // canonicalPath must be the clean canonical absolute path
        expect(res.value.canonicalPath).toBe(fs.realpathSync.native ? fs.realpathSync.native(subDir) : fs.realpathSync(subDir));
      }
    });
  });

  // ─── 2. Missing or empty workspace selection ───────────────────────────────
  describe('2. Missing or empty workspace selection', () => {
    it('rejects empty string in resolveWorkspaceRoot', () => {
      const res = resolveWorkspaceRoot('', 'cli');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.WORKSPACE_UNRESOLVED);
      }
    });

    it('rejects whitespace-only path', () => {
      const res = resolveWorkspaceRoot('   ', 'ide');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.WORKSPACE_UNRESOLVED);
      }
    });

    it('selectFromIdeFolders returns WORKSPACE_NOT_SELECTED on empty array', () => {
      const res = selectFromIdeFolders([]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.WORKSPACE_NOT_SELECTED);
      }
    });

    it('parseCliWorkspaceArg returns WORKSPACE_NOT_SELECTED when flag has missing value', () => {
      const res = parseCliWorkspaceArg(['--workspace']);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.WORKSPACE_NOT_SELECTED);
      }
    });

    it('parseCliWorkspaceArg returns null when flag is not provided', () => {
      const res = parseCliWorkspaceArg(['--other-flag', 'value']);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBeNull();
      }
    });
  });

  // ─── 3. Nonexistent or inaccessible workspace ──────────────────────────────
  describe('3. Nonexistent or inaccessible workspace', () => {
    it('returns WORKSPACE_UNAVAILABLE when directory does not exist', () => {
      const nonExistent = path.join(tempDir, 'does-not-exist-dir');
      const res = resolveWorkspaceRoot(nonExistent, 'ide');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.WORKSPACE_UNAVAILABLE);
        expect(res.error.detail?.['status']).toBe('missing');
      }
    });

    it('inspectWorkspaceRoot marks missing path as missing without throwing', () => {
      const nonExistent = path.join(tempDir, 'ghost-folder');
      const state = inspectWorkspaceRoot(nonExistent, 'cli');
      expect(state.resolutionStatus).toBe('missing');
      expect(state.canonicalPath).toBeNull();
      expect(state.confirmationStatus).toBe('pending');
    });

    it('handles inaccessible workspace via mock adapter', () => {
      const mockAdapter: FileSystemAdapter = {
        existsSync: () => true,
        statSync: () => {
          throw new Error('EACCES: permission denied');
        },
        realpathSync: () => {
          throw new Error('EACCES');
        },
      };

      const res = resolveWorkspaceRoot('/inaccessible/folder', 'ide', mockAdapter);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.WORKSPACE_UNAVAILABLE);
        expect(res.error.detail?.['status']).toBe('unavailable');
      }
    });

    it('rejects a file path when directory is required', () => {
      const filePath = path.join(tempDir, 'regular-file.txt');
      fs.writeFileSync(filePath, 'hello');
      const res = resolveWorkspaceRoot(filePath, 'ide');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.WORKSPACE_UNAVAILABLE);
      }
    });
  });

  // ─── 4. IDE multi-root workspace selection ─────────────────────────────────
  describe('4. IDE multi-root workspace selection', () => {
    it('rejects multi-root workspace without explicit choice in v1', () => {
      const folders = ['/workspace/project-a', '/workspace/project-b'];
      const res = selectFromIdeFolders(folders);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.WORKSPACE_MULTIPLE_ROOTS);
      }
    });

    it('allows choosing a specific root via selectExplicitIdeFolder by index', () => {
      const folders = ['/workspace/project-a', '/workspace/project-b'];
      const res = selectExplicitIdeFolder(folders, 1);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe('/workspace/project-b');
      }
    });

    it('allows choosing a specific root via selectExplicitIdeFolder by path', () => {
      const folders = ['/workspace/project-a', '/workspace/project-b'];
      const res = selectExplicitIdeFolder(folders, '/workspace/project-a');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe('/workspace/project-a');
      }
    });

    it('rejects out of bounds index in selectExplicitIdeFolder', () => {
      const folders = ['/workspace/project-a'];
      const res = selectExplicitIdeFolder(folders, 5);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.WORKSPACE_NOT_SELECTED);
      }
    });
  });

  // ─── 5. IDE/CLI workspace mismatch ─────────────────────────────────────────
  describe('5. IDE/CLI workspace mismatch', () => {
    it('returns error when IDE and CLI select different workspaces', () => {
      const dirA = path.join(tempDir, 'dirA');
      const dirB = path.join(tempDir, 'dirB');
      fs.mkdirSync(dirA);
      fs.mkdirSync(dirB);

      const res = reconcileSelections(dirA, dirB);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.WORKSPACE_MISMATCH);
        expect(res.error.message).toContain('disagree');
      }
    });

    it('succeeds when IDE and CLI point to the same workspace', () => {
      const res = reconcileSelections(tempDir, tempDir);
      expect(res.ok).toBe(true);
    });

    it('returns IDE selection when only IDE is provided', () => {
      const res = reconcileSelections(tempDir, null);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toBe(tempDir);
    });

    it('returns CLI selection when only CLI is provided', () => {
      const res = reconcileSelections(null, tempDir);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toBe(tempDir);
    });

    it('returns WORKSPACE_NOT_SELECTED when neither is provided', () => {
      const res = reconcileSelections(null, null);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.WORKSPACE_NOT_SELECTED);
      }
    });
  });

  // ─── 6. Explicit confirmation required before file operations ──────────────
  describe('6. Explicit confirmation required before file operations', () => {
    it('blocks file operations when workspace is pending confirmation', () => {
      const rootRes = resolveWorkspaceRoot(tempDir, 'ide');
      expect(rootRes.ok).toBe(true);
      if (!rootRes.ok) return;

      const permRes = checkWorkspacePermittedForFileOps(rootRes.value);
      expect(permRes.ok).toBe(false);
      if (!permRes.ok) {
        expect(permRes.error.code).toBe(ErrorCode.WORKSPACE_CONFIRMATION_REQUIRED);
      }
    });

    it('allows file operations once workspace is confirmed', () => {
      const rootRes = resolveWorkspaceRoot(tempDir, 'ide');
      expect(rootRes.ok).toBe(true);
      if (!rootRes.ok) return;

      const confirmedRes = confirmWorkspaceRoot(rootRes.value, true);
      expect(confirmedRes.ok).toBe(true);
      if (!confirmedRes.ok) return;

      const permRes = checkWorkspacePermittedForFileOps(confirmedRes.value);
      expect(permRes.ok).toBe(true);
      if (permRes.ok) {
        expect(permRes.value).toBe(confirmedRes.value.canonicalPath);
      }
    });

    it('blocks file operations when workspace is null or undefined', () => {
      const permResNull = checkWorkspacePermittedForFileOps(null);
      expect(permResNull.ok).toBe(false);
      if (!permResNull.ok) {
        expect(permResNull.error.code).toBe(ErrorCode.WORKSPACE_NOT_SELECTED);
      }
    });
  });

  // ─── 7. Confirmation denial blocks operations ──────────────────────────────
  describe('7. Confirmation denial blocks operations', () => {
    it('sets confirmationStatus to denied when user denies confirmation', () => {
      const rootRes = resolveWorkspaceRoot(tempDir, 'ide');
      expect(rootRes.ok).toBe(true);
      if (!rootRes.ok) return;

      const deniedRes = confirmWorkspaceRoot(rootRes.value, false);
      expect(deniedRes.ok).toBe(true);
      if (deniedRes.ok) {
        expect(deniedRes.value.confirmationStatus).toBe('denied');
        expect(deniedRes.value.confirmationTimestamp).toBeDefined();
      }
    });

    it('checkWorkspacePermittedForFileOps returns WORKSPACE_CONFIRMATION_DENIED on denied root', () => {
      const rootRes = resolveWorkspaceRoot(tempDir, 'ide');
      if (!rootRes.ok) return;

      const deniedRes = confirmWorkspaceRoot(rootRes.value, false);
      if (!deniedRes.ok) return;

      const permRes = checkWorkspacePermittedForFileOps(deniedRes.value);
      expect(permRes.ok).toBe(false);
      if (!permRes.ok) {
        expect(permRes.error.code).toBe(ErrorCode.WORKSPACE_CONFIRMATION_DENIED);
        expect(permRes.error.message).toContain('blocked');
      }
    });
  });

  // ─── 8. Canonical-path change invalidates earlier confirmation ─────────────
  describe('8. Canonical-path change invalidates earlier confirmation', () => {
    it('resets confirmationStatus to pending when canonical path changes', () => {
      const dir1 = path.join(tempDir, 'project-v1');
      const dir2 = path.join(tempDir, 'project-v2');
      fs.mkdirSync(dir1);
      fs.mkdirSync(dir2);

      const rootRes = resolveWorkspaceRoot(dir1, 'ide');
      if (!rootRes.ok) return;

      const confirmedRes = confirmWorkspaceRoot(rootRes.value, true, 1000);
      if (!confirmedRes.ok) return;
      expect(confirmedRes.value.confirmationStatus).toBe('confirmed');

      // Update to dir2
      const updatedRes = updateWorkspaceRoot(confirmedRes.value, dir2, 'ide');
      expect(updatedRes.ok).toBe(true);
      if (updatedRes.ok) {
        expect(updatedRes.value.confirmationStatus).toBe('pending');
        expect(updatedRes.value.confirmationTimestamp).toBeUndefined();
        expect(updatedRes.value.canonicalPath).toContain('project-v2');
      }
    });

    it('preserves confirmation if updated path resolves to the same canonical directory', () => {
      const rootRes = resolveWorkspaceRoot(tempDir, 'ide');
      if (!rootRes.ok) return;

      const confirmedRes = confirmWorkspaceRoot(rootRes.value, true, 2000);
      if (!confirmedRes.ok) return;

      // Update with redundant dot path that resolves to the exact same directory
      const redundantPath = path.join(tempDir, '.', '.');
      const updatedRes = updateWorkspaceRoot(confirmedRes.value, redundantPath, 'ide');
      expect(updatedRes.ok).toBe(true);
      if (updatedRes.ok) {
        expect(updatedRes.value.confirmationStatus).toBe('confirmed');
        expect(updatedRes.value.confirmationTimestamp).toBe(2000);
      }
    });
  });

  // ─── 9. OneDrive-style redirected paths ────────────────────────────────────
  describe('9. OneDrive-style redirected paths are displayed rather than blanket-rejected', () => {
    it('detects onedrive_redirected and resolves successfully', () => {
      const mockOneDriveAdapter: FileSystemAdapter = {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => true }),
        realpathSync: (p) => {
          // Simulate Windows Desktop redirection to OneDrive
          return 'C:\\Users\\MockUser\\OneDrive\\Desktop\\MyProject';
        },
      };

      const selected = 'C:\\Users\\MockUser\\Desktop\\MyProject';
      const res = resolveWorkspaceRoot(selected, 'ide', mockOneDriveAdapter);

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.selectedPath).toBe(selected);
        expect(res.value.canonicalPath).toBe('C:\\Users\\MockUser\\OneDrive\\Desktop\\MyProject');
        expect(res.value.cloudStatus).toBe('onedrive_redirected');
        expect(res.value.resolutionStatus).toBe('resolved');
      }
    });

    it('allows confirming a OneDrive-redirected workspace', () => {
      const mockOneDriveAdapter: FileSystemAdapter = {
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => true }),
        realpathSync: () => 'C:\\Users\\MockUser\\OneDrive\\Desktop\\MyProject',
      };

      const selected = 'C:\\Users\\MockUser\\Desktop\\MyProject';
      const res = resolveWorkspaceRoot(selected, 'ide', mockOneDriveAdapter);
      if (!res.ok) return;

      const confirmed = confirmWorkspaceRoot(res.value, true);
      expect(confirmed.ok).toBe(true);
      if (confirmed.ok) {
        expect(confirmed.value.confirmationStatus).toBe('confirmed');
        const fileOpCheck = checkWorkspacePermittedForFileOps(confirmed.value);
        expect(fileOpCheck.ok).toBe(true);
        if (fileOpCheck.ok) {
          expect(fileOpCheck.value).toBe('C:\\Users\\MockUser\\OneDrive\\Desktop\\MyProject');
        }
      }
    });
  });

  // ─── 10. Unknown cloud-placeholder status ──────────────────────────────────
  describe('10. Unknown cloud-placeholder status remains explicitly unknown', () => {
    it('reports unknown when path is missing or cannot be reliably established', () => {
      expect(detectCloudStatus('/some/missing/path', null)).toBe('unknown');
    });

    it('reports not_cloud when canonical path is known and non-cloud', () => {
      expect(detectCloudStatus('C:\\Dev\\LocalProject', 'C:\\Dev\\LocalProject')).toBe('not_cloud');
    });
  });

  // ─── 11. No hard-coded user paths or silent fallback ───────────────────────
  describe('11. No hard-coded user paths or silent fallback', () => {
    it('does not fall back to process.cwd() or os.homedir() when path is empty or invalid', () => {
      const state = inspectWorkspaceRoot('', 'ide');
      expect(state.canonicalPath).toBeNull();
      expect(state.resolutionStatus).toBe('unresolved');
      // Must NOT be cwd or homedir
      expect(state.canonicalPath).not.toBe(process.cwd());
      expect(state.canonicalPath).not.toBe(os.homedir());
    });

    it('does not fall back to sample C:\\Users path on failure', () => {
      const state = inspectWorkspaceRoot('invalid???path', 'cli');
      expect(state.canonicalPath).toBeNull();
      expect(state.resolutionStatus).not.toBe('resolved');
    });
  });
});
