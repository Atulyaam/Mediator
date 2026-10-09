/**
 * @mediator/workspace-boundary — Path Containment & Windows Path Security Tests (S05)
 *
 * Verifies all 15 required security behaviors:
 * 1. A normal in-root file path is accepted.
 * 2. A normal in-root nested file path is accepted.
 * 3. Parent-directory traversal is rejected (../).
 * 4. An outside absolute path is rejected.
 * 5. A sibling directory sharing the workspace name prefix is rejected (C:\project-evil vs C:\project).
 * 6. A symlink or junction targeting outside the root is rejected.
 * 7. An in-root symlink is handled according to the documented policy.
 * 8. Non-existent targets with a valid in-root parent are handled correctly.
 * 9. A non-existent target with an unsafe parent is rejected.
 * 10. Reserved device names and alternate data streams are rejected.
 * 11. Case-insensitive Windows path comparisons behave correctly.
 * 12. UNC and extended-length paths fail closed when unsupported.
 * 13. Unconfirmed or unresolved workspace roots deny access.
 * 14. A path replaced between validation and use is rejected (TOCTOU).
 * 15. Existing S01–S04 tests and behavior remain intact.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ErrorCode, type WorkspaceRootState } from '@mediator/shared-contracts';
import {
  type FileSystemAdapter,
  inspectWorkspaceRoot,
  confirmWorkspaceRoot,
  validateContainedPath,
  revalidateContainedPath,
  safeReadProjectFile,
  safeWriteProjectFile,
  safeDeleteProjectFile,
  isPathInsideRoot,
  hasAlternateDataStream,
  hasReservedDeviceName,
  hasMalformedWindowsComponents,
  normalizeWindowsPath,
} from './index.js';

describe('Sprint S05 — Path Containment & Windows Path Security', () => {
  let tempDir: string;
  let confirmedWorkspace: WorkspaceRootState;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s05-test-'));
    // Create typical project directory structure
    fs.mkdirSync(path.join(tempDir, 'src', 'components'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'console.log("hello");');
    fs.writeFileSync(path.join(tempDir, 'src', 'components', 'button.tsx'), '<button />');
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test Project');

    const inspected = inspectWorkspaceRoot(tempDir, 'ide');
    const confirmed = confirmWorkspaceRoot(inspected, true);
    if (!confirmed.ok) {
      throw new Error('Failed to setup confirmed workspace');
    }
    confirmedWorkspace = confirmed.value;
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  // ─── 1. Normal In-Root File Path ──────────────────────────────────────────

  it('1. accepts a normal in-root file path', () => {
    const res = validateContainedPath(confirmedWorkspace, 'README.md');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.inputPath).toBe('README.md');
      expect(res.value.exists).toBe(true);
      expect(res.value.relativePath).toBe('README.md');
      expect(isPathInsideRoot(confirmedWorkspace.canonicalPath!, res.value.resolvedPath)).toBe(true);
    }
  });

  // ─── 2. Normal In-Root Nested File Path ───────────────────────────────────

  it('2. accepts a normal in-root nested file path', () => {
    const res = validateContainedPath(confirmedWorkspace, 'src/components/button.tsx');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.exists).toBe(true);
      expect(res.value.relativePath).toBe('src/components/button.tsx');
      expect(isPathInsideRoot(confirmedWorkspace.canonicalPath!, res.value.resolvedPath)).toBe(true);
    }
  });

  it('2b. accepts nested paths with mixed Windows backslashes and slashes', () => {
    const res = validateContainedPath(confirmedWorkspace, 'src\\components/button.tsx');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.exists).toBe(true);
    }
  });

  // ─── 3. Parent-Directory Traversal Rejection ─────────────────────────────

  it('3. rejects parent-directory traversal (../)', () => {
    const res = validateContainedPath(confirmedWorkspace, '../outside.txt');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.PATH_TRAVERSAL);
    }
  });

  it('3b. rejects deep traversal escaping root (src/../../outside.txt)', () => {
    const res = validateContainedPath(confirmedWorkspace, 'src/../../outside.txt');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.PATH_TRAVERSAL);
    }
  });

  it('3c. rejects traversal with backslashes (..\\..\\Windows)', () => {
    const res = validateContainedPath(confirmedWorkspace, '..\\..\\Windows\\System32');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.PATH_TRAVERSAL);
    }
  });

  // ─── 4. Outside Absolute Path Rejection ───────────────────────────────────

  it('4. rejects an outside absolute path', () => {
    const outsideAbs = path.resolve(os.tmpdir(), 'outside_file_123.txt');
    const res = validateContainedPath(confirmedWorkspace, outsideAbs);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.PATH_OUTSIDE_ROOT);
    }
  });

  it('4b. rejects standard Windows system directory paths', () => {
    const res = validateContainedPath(confirmedWorkspace, 'C:\\Windows\\System32\\cmd.exe');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.PATH_OUTSIDE_ROOT);
    }
  });

  it('4c. accepts an in-root absolute path pointing to a project file', () => {
    const inRootAbs = path.join(confirmedWorkspace.canonicalPath!, 'src', 'index.ts');
    const res = validateContainedPath(confirmedWorkspace, inRootAbs);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.exists).toBe(true);
      expect(res.value.relativePath).toBe('src/index.ts');
    }
  });

  // ─── 5. Sibling Directory Prefix Attack Defense ───────────────────────────

  it('5. rejects a sibling directory sharing the workspace name prefix', () => {
    // If root is C:\project, C:\project-evil\secret.txt MUST NOT be considered inside root!
    const canonicalRoot = 'C:\\project';
    const siblingEvil = 'C:\\project-evil\\secret.txt';

    // Direct unit test of isPathInsideRoot prefix defense
    expect(isPathInsideRoot(canonicalRoot, siblingEvil)).toBe(false);
    expect(isPathInsideRoot(canonicalRoot, 'C:\\project\\file.txt')).toBe(true);
    expect(isPathInsideRoot(canonicalRoot, 'C:\\project')).toBe(true);

    // Through validateContainedPath with mock workspace
    const mockWs: WorkspaceRootState = {
      selectedPath: 'C:\\project',
      canonicalPath: 'C:\\project',
      selectionSource: 'ide',
      confirmationStatus: 'confirmed',
      resolutionStatus: 'resolved',
      cloudStatus: 'not_cloud',
    };

    const res = validateContainedPath(mockWs, siblingEvil);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.PATH_OUTSIDE_ROOT);
    }
  });

  it('5b. rejects relative traversal targeting sibling directory', () => {
    const mockWs: WorkspaceRootState = {
      selectedPath: 'C:\\project',
      canonicalPath: 'C:\\project',
      selectionSource: 'ide',
      confirmationStatus: 'confirmed',
      resolutionStatus: 'resolved',
      cloudStatus: 'not_cloud',
    };

    const res = validateContainedPath(mockWs, '../project-evil/payload.js');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.PATH_TRAVERSAL);
    }
  });

  // ─── 6. Symlink/Junction Targeting Outside Rejection ─────────────────────

  it('6. rejects a symlink or junction targeting outside the root', () => {
    // Test using mock adapter to guarantee deterministic test regardless of Windows symlink privileges
    const mockFs: FileSystemAdapter = {
      existsSync: (p: string) => {
        const norm = p.replace(/\\/g, '/');
        return norm.includes('link_outside') || norm.includes('secret.txt');
      },
      statSync: () => ({ isDirectory: () => false, isSymbolicLink: () => true }),
      realpathSync: (p: string) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.includes('link_outside')) {
          // Escapes to outside directory
          return 'C:/outside_system/secret.txt';
        }
        return p;
      },
    };

    const res = validateContainedPath(confirmedWorkspace, 'link_outside/secret.txt', {
      fsAdapter: mockFs,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.PATH_SYMLINK_ESCAPE);
    }
  });

  it('6b. real filesystem junction/symlink test (if OS allows symlinks)', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s05-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'SUPER_SECRET');
    const linkPath = path.join(tempDir, 'symlink_outside');

    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideDir, linkPath, 'junction');
      symlinkCreated = true;
    } catch {
      // On Windows without Developer Mode, symlink requires elevation; skip real OS symlink if EPERM
    }

    if (symlinkCreated) {
      const res = validateContainedPath(confirmedWorkspace, 'symlink_outside/secret.txt');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PATH_SYMLINK_ESCAPE);
      }
    }

    try {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  // ─── 7. In-Root Symlink Handling ──────────────────────────────────────────

  it('7. allows in-root symlinks whose target remains within canonical root', () => {
    const mockFs: FileSystemAdapter = {
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => false }),
      realpathSync: (_p: string) => {
        // Resolves to another in-root location
        return path.join(confirmedWorkspace.canonicalPath!, 'src', 'index.ts');
      },
    };

    const res = validateContainedPath(confirmedWorkspace, 'link_to_src/index.ts', {
      fsAdapter: mockFs,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.exists).toBe(true);
      expect(res.value.relativePath).toBe('src/index.ts');
    }
  });

  // ─── 8. Non-Existent Target with Valid Parent ─────────────────────────────

  it('8. handles non-existent targets with a valid in-root parent', () => {
    const res = validateContainedPath(confirmedWorkspace, 'src/new_file.ts');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.exists).toBe(false);
      expect(res.value.relativePath).toBe('src/new_file.ts');
      expect(isPathInsideRoot(confirmedWorkspace.canonicalPath!, res.value.resolvedPath)).toBe(true);
    }
  });

  it('8b. rejects non-existent target when mustExist option is true', () => {
    const res = validateContainedPath(confirmedWorkspace, 'src/non_existent.ts', {
      mustExist: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.PATH_DENIED);
    }
  });

  // ─── 9. Non-Existent Target with Unsafe Parent ────────────────────────────

  it('9. rejects non-existent target when parent directory is an escaping symlink', () => {
    const mockFs: FileSystemAdapter = {
      existsSync: (p: string) => {
        const norm = p.replace(/\\/g, '/');
        // Parent exists, target does not
        if (norm.endsWith('brand_new_file.ts')) return false;
        return true;
      },
      statSync: () => ({ isDirectory: () => true }),
      realpathSync: (p: string) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.includes('escaped_parent')) {
          return 'C:/Windows/Temp/escaped_parent';
        }
        return p;
      },
    };

    const res = validateContainedPath(confirmedWorkspace, 'escaped_parent/brand_new_file.ts', {
      fsAdapter: mockFs,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.PATH_SYMLINK_ESCAPE);
    }
  });

  // ─── 10. Reserved Device Names & Alternate Data Streams ───────────────────

  it('10a. rejects reserved Windows device names (CON, NUL, AUX, PRN, COM1-9, LPT1-9)', () => {
    const reservedNames = [
      'CON',
      'con.txt',
      'NUL',
      'nul.json',
      'AUX',
      'aux.c',
      'PRN',
      'prn.log',
      'COM1',
      'com1.dat',
      'COM9',
      'LPT1',
      'lpt9.txt',
      'src/con/file.txt',
      'src/components/NUL',
    ];

    for (const name of reservedNames) {
      const res = validateContainedPath(confirmedWorkspace, name);
      expect(res.ok, `Expected ${name} to be rejected as reserved device`).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PATH_RESERVED_DEVICE);
      }
    }
  });

  it('10b. rejects Alternate Data Streams (ADS syntax with colons)', () => {
    const adsPaths = [
      'file.txt:stream',
      'src/index.ts:hidden',
      'file.txt::$DATA',
      'folder:stream',
      'README.md:zone.identifier',
    ];

    for (const p of adsPaths) {
      const res = validateContainedPath(confirmedWorkspace, p);
      expect(res.ok, `Expected ${p} to be rejected as Alternate Data Stream`).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PATH_ALTERNATE_DATA_STREAM);
      }
    }
  });

  it('10c. rejects trailing dots and spaces in filenames', () => {
    const malformedPaths = [
      'file.txt.',
      'file.txt..',
      'test ',
      'src/trailing_dot.',
      'src/space_ending ',
      'bad|name.txt',
      'bad<name>.txt',
      'foo*bar.txt',
      'file\0null.txt',
    ];

    for (const p of malformedPaths) {
      const res = validateContainedPath(confirmedWorkspace, p);
      expect(res.ok, `Expected ${p} to be rejected as malformed`).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PATH_MALFORMED);
      }
    }
  });

  // ─── 11. Case-Insensitive Windows Path Comparisons ────────────────────────

  it('11. correctly matches and accepts case-insensitive Windows paths', () => {
    // Workspace canonical root is tempDir
    const upperCased = tempDir.toUpperCase();
    const mockWs: WorkspaceRootState = {
      ...confirmedWorkspace,
      canonicalPath: upperCased,
      selectedPath: tempDir.toLowerCase(),
    };

    const res = validateContainedPath(mockWs, 'SRC/INDEX.TS');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.exists).toBe(true);
    }
  });

  // ─── 12. UNC & Extended-Length Paths Fail Closed ──────────────────────────

  it('12. fails closed on UNC and unsupported network paths', () => {
    const uncPaths = [
      '\\\\server\\share\\secret.txt',
      '//server/share/secret.txt',
      '\\\\?\\UNC\\server\\share\\file.txt',
    ];

    for (const unc of uncPaths) {
      const res = validateContainedPath(confirmedWorkspace, unc);
      expect(res.ok, `Expected ${unc} to fail closed`).toBe(false);
      if (!res.ok) {
        expect([ErrorCode.PATH_OUTSIDE_ROOT, ErrorCode.PATH_MALFORMED]).toContain(res.error.code);
      }
    }
  });

  // ─── 13. Unconfirmed or Unresolved Workspace Roots Deny Access ────────────

  it('13a. denies access when workspace root confirmation is pending', () => {
    const pendingWs: WorkspaceRootState = {
      ...confirmedWorkspace,
      confirmationStatus: 'pending',
    };

    const res = validateContainedPath(pendingWs, 'README.md');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.WORKSPACE_CONFIRMATION_REQUIRED);
    }
  });

  it('13b. denies access when workspace root confirmation is denied', () => {
    const deniedWs: WorkspaceRootState = {
      ...confirmedWorkspace,
      confirmationStatus: 'denied',
    };

    const res = validateContainedPath(deniedWs, 'README.md');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.WORKSPACE_CONFIRMATION_DENIED);
    }
  });

  it('13c. denies access when workspace root is missing or unresolved', () => {
    const missingWs: WorkspaceRootState = {
      ...confirmedWorkspace,
      resolutionStatus: 'missing',
      canonicalPath: null,
    };

    const resMissing = validateContainedPath(missingWs, 'README.md');
    expect(resMissing.ok).toBe(false);
    if (!resMissing.ok) {
      expect(resMissing.error.code).toBe(ErrorCode.WORKSPACE_UNAVAILABLE);
    }

    const unresWs: WorkspaceRootState = {
      ...confirmedWorkspace,
      resolutionStatus: 'unresolved',
      canonicalPath: null,
    };

    const resUnres = validateContainedPath(unresWs, 'README.md');
    expect(resUnres.ok).toBe(false);
    if (!resUnres.ok) {
      expect(resUnres.error.code).toBe(ErrorCode.WORKSPACE_UNRESOLVED);
    }
  });

  // ─── 14. TOCTOU Race Detection & Safe I/O Operations ──────────────────────

  it('14a. revalidateContainedPath detects when target path shifted canonical identity', () => {
    const initial = validateContainedPath(confirmedWorkspace, 'README.md');
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;

    // Simulate adversarial swap between validation and access
    const mockFs: FileSystemAdapter = {
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => false }),
      realpathSync: () => 'C:/swapped_outside/README.md',
    };

    const recheck = revalidateContainedPath(confirmedWorkspace, initial.value, mockFs);
    expect(recheck.ok).toBe(false);
    if (!recheck.ok) {
      expect([ErrorCode.PATH_SYMLINK_ESCAPE, ErrorCode.PATH_DENIED]).toContain(recheck.error.code);
    }
  });

  it('14b. safeReadProjectFile reads file within workspace successfully', () => {
    const res = safeReadProjectFile(confirmedWorkspace, 'README.md');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBe('# Test Project');
    }
  });

  it('14c. safeWriteProjectFile writes file within workspace and validates containment', () => {
    const res = safeWriteProjectFile(confirmedWorkspace, 'src/created_by_test.txt', 'SAFE_CONTENT');
    expect(res.ok).toBe(true);

    // Verify file exists on real disk
    const content = fs.readFileSync(path.join(tempDir, 'src', 'created_by_test.txt'), 'utf8');
    expect(content).toBe('SAFE_CONTENT');
  });

  it('14d. safeDeleteProjectFile safely deletes file within workspace', () => {
    fs.writeFileSync(path.join(tempDir, 'to_delete.txt'), 'goodbye');
    const res = safeDeleteProjectFile(confirmedWorkspace, 'to_delete.txt');
    expect(res.ok).toBe(true);

    expect(fs.existsSync(path.join(tempDir, 'to_delete.txt'))).toBe(false);
  });

  it('14e. safeReadProjectFile rejects reading outside or traversal paths', () => {
    const res = safeReadProjectFile(confirmedWorkspace, '../secret.txt');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(ErrorCode.PATH_TRAVERSAL);
    }
  });

  // ─── 15. Helper Unit Tests (Sanity & Windows edge cases) ───────────────────

  it('15a. hasAlternateDataStream classifier', () => {
    expect(hasAlternateDataStream('file.txt:stream')).toBe(true);
    expect(hasAlternateDataStream('C:\\project\\file.txt:stream')).toBe(true);
    expect(hasAlternateDataStream('C:\\project\\file.txt')).toBe(false);
    expect(hasAlternateDataStream('src/index.ts')).toBe(false);
  });

  it('15b. hasReservedDeviceName classifier', () => {
    expect(hasReservedDeviceName('CON')).toBe(true);
    expect(hasReservedDeviceName('con.txt')).toBe(true);
    expect(hasReservedDeviceName('NUL')).toBe(true);
    expect(hasReservedDeviceName('com1')).toBe(true);
    expect(hasReservedDeviceName('LPT9.log')).toBe(true);
    expect(hasReservedDeviceName('normal_file.txt')).toBe(false);
    expect(hasReservedDeviceName('connection.ts')).toBe(false);
    expect(hasReservedDeviceName('nullifier.js')).toBe(false);
  });

  it('15c. hasMalformedWindowsComponents classifier', () => {
    expect(hasMalformedWindowsComponents('test.')).toBe(true);
    expect(hasMalformedWindowsComponents('test ')).toBe(true);
    expect(hasMalformedWindowsComponents('file<name>')).toBe(true);
    expect(hasMalformedWindowsComponents('file*name')).toBe(true);
    expect(hasMalformedWindowsComponents('file\0name')).toBe(true);
    expect(hasMalformedWindowsComponents('src/index.ts')).toBe(false);
  });

  it('15d. normalizeWindowsPath preserves NFC and standardizes drive letter', () => {
    expect(normalizeWindowsPath('c:\\project\\file.ts').startsWith('C:\\')).toBe(true);
    expect(normalizeWindowsPath('C:/project/file.ts')).toBe(normalizeWindowsPath('C:\\project\\file.ts'));
  });
});
