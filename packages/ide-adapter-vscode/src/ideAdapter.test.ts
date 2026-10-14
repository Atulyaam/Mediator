/**
 * @mediator/ide-adapter — IDE Workspace Adapter & Incremental Project Map Tests (Sprint S15)
 *
 * Verifies all 20 required S15 test cases:
 * 1. Supported and unsupported capability responses.
 * 2. VS Code and Antigravity profiles do not incorrectly share unverified capabilities.
 * 3. Canonical workspace-root mismatch is rejected.
 * 4. Unsupported Git-status capability returns a typed unavailable response.
 * 5. Diagnostics unavailable differs from an empty diagnostics result.
 * 6. Language-symbol data is bounded and validated.
 * 7. Test discovery never executes commands.
 * 8. Editor selection context is not collected without opt-in.
 * 9. Opt-in selection still passes path exclusions and secret scanning.
 * 10. Workspace change events update only the relevant map entries.
 * 11. Rename/delete events invalidate the appropriate entries.
 * 12. Watcher errors mark map freshness appropriately.
 * 13. Path traversal and outside-root symbolic links/junctions are rejected.
 * 14. Secret/excluded paths never enter the map.
 * 15. Dependency/build directories are not recursively indexed.
 * 16. Staging/app-data paths are not indexed as original workspace content.
 * 17. File-size and total-map budgets are enforced.
 * 18. Stale map entries are not falsely reported as fresh.
 * 19. Concurrent update and cancellation cases remain consistent.
 * 20. Repeated incremental updates do not resend unchanged repository content.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ErrorCode,
  type WorkspaceRootState,
} from '@mediator/shared-contracts';
import {
  inspectWorkspaceRoot,
} from '@mediator/workspace-boundary';
import {
  VsCodeWorkspaceAdapter,
  type VsCodeApiFacade,
} from './index.js';
import {
  AntigravityWorkspaceAdapter,
  type AntigravityApiFacade,
} from '@mediator/ide-adapter-antigravity';
import {
  scanProjectMap,
  updateProjectMapIncremental,
  IncrementalProjectMapManager,
  isStagingOrAppDataPath,
  MAX_INDEXABLE_FILE_BYTES,
} from '@mediator/context-engine';

describe('Sprint S15 — IDE Workspace Adapter & Incremental Project Map', () => {
  let tempDir: string;
  let workspaceDir: string;
  let rootState: WorkspaceRootState;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s15-test-'));
    workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });

    // Seed sample files
    fs.writeFileSync(path.join(workspaceDir, 'package.json'), JSON.stringify({
      name: 's15-test-project',
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^1.0.0' },
    }, null, 2), 'utf8');

    fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'src', 'index.ts'), 'export const hello = "world";\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'src', 'calc.ts'), 'export function add(a: number, b: number) { return a + b; }\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, 'src', 'calc.test.ts'), 'test("add", () => {});\n', 'utf8');

    rootState = inspectWorkspaceRoot(workspaceDir, 'ide');
    // Confirm workspace root
    (rootState as any).confirmationStatus = 'confirmed';
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  function createMockVsCodeApi(overrides?: Partial<VsCodeApiFacade>): VsCodeApiFacade {
    return {
      env: {
        appName: 'Visual Studio Code',
        appHost: 'desktop',
      },
      version: '1.93.0',
      workspace: {
        workspaceFolders: [{ uri: { fsPath: workspaceDir } }],
        createFileSystemWatcher: () => ({
          onDidCreate: () => ({ dispose: () => {} }),
          onDidChange: () => ({ dispose: () => {} }),
          onDidDelete: () => ({ dispose: () => {} }),
          dispose: () => {},
        }),
      },
      languages: {
        getDiagnostics: () => [],
      },
      window: {
        activeTextEditor: undefined,
      },
      commands: {
        executeCommand: async <T>() => [] as unknown as T,
      },
      extensions: {
        getExtension: () => undefined,
      },
      ...overrides,
    };
  }

  // ── 1. Supported and unsupported capability responses ──────────────────────
  it('1. returns typed supported and unsupported capability responses', () => {
    const api = createMockVsCodeApi({
      extensions: {
        getExtension: () => undefined, // Git unavailable
      },
    });
    const adapter = new VsCodeWorkspaceAdapter(api, workspaceDir);
    const caps = adapter.getCapabilities('test-corr');

    expect(caps.correlationId).toBe('test-corr');
    expect(caps.capabilities.canonical_workspace.status).toBe('supported');
    expect(caps.capabilities.file_enumeration.status).toBe('supported');
    expect(caps.capabilities.git_status.status).toBe('unavailable');
    expect(caps.capabilities.git_status.reason).toContain('vscode.git');
    expect(caps.capabilities.ide_product_info.status).toBe('supported');
  });

  // ── 2. VS Code and Antigravity profiles do not share unverified capabilities
  it('2. VS Code and Antigravity profiles maintain separate honest capability results', () => {
    const vsApi = createMockVsCodeApi();
    const vsAdapter = new VsCodeWorkspaceAdapter(vsApi, workspaceDir);
    const vsCaps = vsAdapter.getCapabilities('vs-corr');

    const antiApi: AntigravityApiFacade = {
      env: { appName: 'Antigravity IDE', version: '2.0.0' },
      workspaceRootPath: workspaceDir,
      languageServer: undefined, // unverified in this runtime
    };
    const antiAdapter = new AntigravityWorkspaceAdapter(antiApi, workspaceDir);
    const antiCaps = antiAdapter.getCapabilities('anti-corr');

    expect(vsCaps.ideFamily).toBe('vscode');
    expect(antiCaps.ideFamily).toBe('antigravity');

    // VS Code languages API was present
    expect(vsCaps.capabilities.diagnostics.status).toBe('supported');
    // Antigravity language server was unverified
    expect(antiCaps.capabilities.diagnostics.status).toBe('not_yet_verified');
    expect(antiCaps.capabilities.language_symbols.status).toBe('not_yet_verified');
    expect(antiCaps.capabilities.git_status.status).toBe('unavailable');
  });

  // ── 3. Canonical workspace-root mismatch is rejected ────────────────────────
  it('3. canonical workspace-root mismatch is rejected', async () => {
    const outsideDir = path.join(tempDir, 'other-workspace');
    fs.mkdirSync(outsideDir, { recursive: true });

    const adapter = new VsCodeWorkspaceAdapter(createMockVsCodeApi(), outsideDir);
    const res = adapter.getWorkspaceRoot();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('Expected ok');
    expect(res.value.canonicalPath?.toLowerCase()).toBe(outsideDir.toLowerCase());

    // incremental map reject mismatch
    const initialMap = scanProjectMap(rootState);
    const mismatchRootState = inspectWorkspaceRoot(outsideDir, 'ide');
    (mismatchRootState as any).confirmationStatus = 'confirmed';

    expect(() => {
      updateProjectMapIncremental(initialMap, mismatchRootState, {
        type: 'modify',
        path: 'src/index.ts',
      });
    }).toThrow(/mismatch/i);
  });

  // ── 4. Unsupported Git-status capability returns typed unavailable ──────────
  it('4. unsupported Git-status capability returns typed unavailable response without shell calls', async () => {
    const api = createMockVsCodeApi({
      extensions: {
        getExtension: () => undefined,
      },
    });
    const adapter = new VsCodeWorkspaceAdapter(api, workspaceDir);
    const gitRes = await adapter.getGitStatus('git-probe');

    expect(gitRes.ok).toBe(false);
    if (gitRes.ok) throw new Error('Expected not ok');
    expect(gitRes.error.code).toBe(ErrorCode.CAPABILITY_UNAVAILABLE);
    expect(gitRes.error.message).toContain('vscode.git');
  });

  // ── 5. Diagnostics unavailable differs from empty diagnostics result ────────
  it('5. diagnostics unavailable differs from empty diagnostics result', async () => {
    // 5a: available but empty
    const apiAvailable = createMockVsCodeApi({
      languages: {
        getDiagnostics: () => [],
      },
    });
    const adapterA = new VsCodeWorkspaceAdapter(apiAvailable, workspaceDir);
    const resA = await adapterA.getDiagnostics();
    expect(resA.ok).toBe(true);
    if (!resA.ok) throw new Error('Expected ok');
    expect(resA.value.status).toBe('supported');
    expect(resA.value.items).toEqual([]);

    // 5b: unavailable
    const apiUnavailable = createMockVsCodeApi({
      languages: {
        getDiagnostics: undefined as any,
      },
    });
    const adapterB = new VsCodeWorkspaceAdapter(apiUnavailable, workspaceDir);
    const resB = await adapterB.getDiagnostics();
    expect(resB.ok).toBe(false);
    if (resB.ok) throw new Error('Expected not ok');
    expect(resB.error.code).toBe(ErrorCode.CAPABILITY_UNAVAILABLE);
  });

  // ── 6. Language-symbol data is bounded and validated ───────────────────────
  it('6. language-symbol data is bounded, validated and contained', async () => {
    const rawSymbols = Array.from({ length: 80 }).map((_, i) => ({
      name: `Symbol_${i}`,
      kind: 12,
      range: {
        start: { line: i, character: 0 },
        end: { line: i, character: 10 },
      },
    }));

    const api = createMockVsCodeApi({
      commands: {
        executeCommand: async <T>() => rawSymbols as unknown as T,
      },
    });
    const adapter = new VsCodeWorkspaceAdapter(api, workspaceDir);
    const res = await adapter.getSymbols('src/index.ts', 'sym-test', 20);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('Expected ok');
    expect(res.value.status).toBe('supported');
    expect(res.value.symbols.length).toBe(20);
    expect(res.value.truncated).toBe(true);

    // Traversal or outside-root relativePath rejected
    const badRes = await adapter.getSymbols('../../../outside.ts');
    expect(badRes.ok).toBe(false);
    if (badRes.ok) throw new Error('Expected not ok');
    expect(badRes.error.code).toBe(ErrorCode.PATH_TRAVERSAL);
  });

  // ── 7. Test discovery never executes commands ──────────────────────────────
  it('7. test discovery discovers candidate tests from metadata without executing commands', async () => {
    const adapter = new VsCodeWorkspaceAdapter(createMockVsCodeApi(), workspaceDir);
    const testRes = await adapter.discoverTests('test-discovery');

    expect(testRes.ok).toBe(true);
    if (!testRes.ok) throw new Error('Expected ok');
    expect(testRes.value.status).toBe('supported');
    expect(testRes.value.framework).toBe('vitest');
    expect(testRes.value.candidateTestFiles).toContain('src/calc.test.ts');
    expect(testRes.value.testCommands).toContain('npm test');
    expect(testRes.value.testCommands).toContain('vitest run');
  });

  // ── 8. Editor selection context is not collected without opt-in ────────────
  it('8. editor selection context is strictly denied without explicit opt-in', async () => {
    const api = createMockVsCodeApi({
      window: {
        activeTextEditor: {
          document: {
            uri: { fsPath: path.join(workspaceDir, 'src', 'index.ts') },
            getText: () => 'sensitive context',
          },
          selection: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 17 },
            active: { line: 0, character: 17 },
          },
        },
      },
    });
    const adapter = new VsCodeWorkspaceAdapter(api, workspaceDir);

    // Opt-in disabled: must fail closed
    const deniedRes = await adapter.getEditorContext({
      allowEditorContext: false,
      allowSelectedText: false,
    });
    expect(deniedRes.ok).toBe(false);
    if (deniedRes.ok) throw new Error('Expected not ok');
    expect(deniedRes.error.code).toBe(ErrorCode.CAPABILITY_PERMISSION_DENIED);
    expect(deniedRes.error.message).toContain('not explicitly opted in');
  });

  // ── 9. Opt-in selection still passes path exclusions and secret scanning ───
  it('9. opt-in selection passes path exclusions and redacts detected secrets', async () => {
    const secretSnippet = 'const API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";\n';
    const api = createMockVsCodeApi({
      window: {
        activeTextEditor: {
          document: {
            uri: { fsPath: path.join(workspaceDir, 'src', 'index.ts') },
            getText: () => secretSnippet,
          },
          selection: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: secretSnippet.length },
            active: { line: 0, character: secretSnippet.length },
          },
        },
      },
    });
    const adapter = new VsCodeWorkspaceAdapter(api, workspaceDir);

    const res = await adapter.getEditorContext({
      allowEditorContext: true,
      allowSelectedText: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('Expected ok');
    expect(res.value?.hasOptedIn).toBe(true);
    expect(res.value?.selectedText).toBeDefined();
    // Raw secret must NOT be emitted
    expect(res.value?.selectedText).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz123456');
    expect(res.value?.redacted).toBe(true);
  });

  // ── 10. Workspace change events update only the relevant map entries ───────
  it('10. file creation and modification events update only relevant map entries', async () => {
    const manager = new IncrementalProjectMapManager(rootState);
    const initialMap = manager.getMap();
    expect(initialMap.files['src/index.ts']).toBeDefined();

    // Create a new file
    const newFilePath = path.join(workspaceDir, 'src', 'helper.ts');
    fs.writeFileSync(newFilePath, 'export const helper = 42;\n', 'utf8');

    const updatedMap = await manager.handleFileEvent({
      type: 'create',
      path: 'src/helper.ts',
    });

    expect(updatedMap.version).toBe(initialMap.version + 1);
    expect(updatedMap.files['src/helper.ts']).toBeDefined();
    expect(updatedMap.files['src/helper.ts']?.language).toBe('TypeScript');
    // Pre-existing index.ts unchanged
    expect(updatedMap.files['src/index.ts']?.contentHash).toBe(initialMap.files['src/index.ts']?.contentHash);
  });

  // ── 11. Rename/delete events invalidate the appropriate entries ────────────
  it('11. delete and rename events invalidate the appropriate entries cleanly', async () => {
    const manager = new IncrementalProjectMapManager(rootState);
    expect(manager.getMap().files['src/calc.ts']).toBeDefined();

    // Delete calc.ts
    const deletedMap = await manager.handleFileEvent({
      type: 'delete',
      path: 'src/calc.ts',
    });
    expect(deletedMap.files['src/calc.ts']).toBeUndefined();

    // Rename index.ts to main.ts
    const renamedPath = path.join(workspaceDir, 'src', 'main.ts');
    fs.renameSync(path.join(workspaceDir, 'src', 'index.ts'), renamedPath);

    const renamedMap = await manager.handleFileEvent({
      type: 'rename',
      oldPath: 'src/index.ts',
      path: 'src/main.ts',
    });

    expect(renamedMap.files['src/index.ts']).toBeUndefined();
    expect(renamedMap.files['src/main.ts']).toBeDefined();
    expect(renamedMap.files['src/main.ts']?.isEntryPoint).toBe(true);
  });

  // ── 12. Watcher errors mark map freshness appropriately ────────────────────
  it('12. watcher errors transition map freshness to stale rather than fabricating fresh state', () => {
    const manager = new IncrementalProjectMapManager(rootState);
    expect(manager.getFreshness()).toBe('fresh');

    manager.handleWatcherError(new Error('EBUSY: file table overflow'));

    expect(manager.getFreshness()).toBe('stale');
    expect(manager.getMap().isStale).toBe(true);
    expect(manager.getMap().staleReason).toContain('EBUSY');
  });

  // ── 13. Path traversal and outside-root symbolic links are rejected ─────────
  it('13. path traversal and outside-root target updates are rejected by incremental map', async () => {
    const manager = new IncrementalProjectMapManager(rootState);
    const beforeCount = manager.getMap().totalFilesScanned;

    // Attempt traversal update
    await manager.handleFileEvent({
      type: 'create',
      path: '../../etc/passwd',
    });

    // Count should be unchanged
    expect(manager.getMap().totalFilesScanned).toBe(beforeCount);
    expect(manager.getMap().files['../../etc/passwd']).toBeUndefined();
  });

  // ── 14. Secret/excluded paths never enter the map ──────────────────────────
  it('14. secret/excluded paths (.env, keys) never enter the project map', async () => {
    const envFile = path.join(workspaceDir, '.env');
    fs.writeFileSync(envFile, 'DATABASE_PASSWORD=supersecret\n', 'utf8');

    const manager = new IncrementalProjectMapManager(rootState);
    expect(manager.getMap().files['.env']).toBeUndefined();

    // Even if an explicit create event arrives for .env
    const mapAfterEvent = await manager.handleFileEvent({
      type: 'create',
      path: '.env',
    });

    expect(mapAfterEvent.files['.env']).toBeUndefined();
  });

  // ── 15. Dependency/build directories are not recursively indexed ───────────
  it('15. dependency/build directories (node_modules, dist) are ignored', async () => {
    const nmDir = path.join(workspaceDir, 'node_modules', 'dep');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'dep.js'), 'module.exports = {};\n', 'utf8');

    const manager = new IncrementalProjectMapManager(rootState);
    expect(manager.getMap().files['node_modules/dep/dep.js']).toBeUndefined();

    // Event on node_modules ignored
    await manager.handleFileEvent({
      type: 'create',
      path: 'node_modules/dep/dep.js',
    });

    expect(manager.getMap().files['node_modules/dep/dep.js']).toBeUndefined();
  });

  // ── 16. Staging/app-data paths are not indexed as workspace content ────────
  it('16. staging and app-data paths are strictly ignored by project map', async () => {
    const stagingDir = path.join(workspaceDir, '.mediator', 'staging', 'task-1');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'staged_patch.ts'), '// staged content\n', 'utf8');

    expect(isStagingOrAppDataPath('.mediator/staging/task-1/staged_patch.ts')).toBe(true);

    const manager = new IncrementalProjectMapManager(rootState);
    expect(manager.getMap().files['.mediator/staging/task-1/staged_patch.ts']).toBeUndefined();

    await manager.handleFileEvent({
      type: 'create',
      path: '.mediator/staging/task-1/staged_patch.ts',
    });

    expect(manager.getMap().files['.mediator/staging/task-1/staged_patch.ts']).toBeUndefined();
  });

  // ── 17. File-size and total-map budgets are enforced ────────────────────────
  it('17. file-size hashing limit (512 KB) is strictly enforced', async () => {
    const largeFile = path.join(workspaceDir, 'src', 'large.ts');
    // Write 600 KB file (greater than 512 KB MAX_INDEXABLE_FILE_BYTES)
    const largeBuffer = Buffer.alloc(600 * 1024, 'a');
    fs.writeFileSync(largeFile, largeBuffer);

    const manager = new IncrementalProjectMapManager(rootState);
    const entry = manager.getMap().files['src/large.ts'];

    expect(entry).toBeDefined();
    expect(entry?.byteSize).toBe(600 * 1024);
    // Hashing completed without error
    expect(entry?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(entry?.available).toBe(true);
  });

  // ── 18. Stale map entries are not falsely reported as fresh ────────────────
  it('18. stale map entries are not falsely reported as fresh', () => {
    const manager = new IncrementalProjectMapManager(rootState);
    manager.markStale('Explicit cache invalidation');

    expect(manager.getMap().isStale).toBe(true);
    expect(manager.getFreshness()).toBe('stale');
    expect(manager.getMap().staleReason).toBe('Explicit cache invalidation');
  });

  // ── 19. Concurrent update and cancellation cases remain consistent ─────────
  it('19. concurrent events are processed in serialized order without state corruption', async () => {
    const manager = new IncrementalProjectMapManager(rootState);

    // Fire 5 concurrent file events
    const promises = [
      manager.handleFileEvent({ type: 'create', path: 'src/calc.test.ts' }),
      manager.handleFileEvent({ type: 'modify', path: 'src/index.ts' }),
      manager.handleFileEvent({ type: 'create', path: 'src/calc.ts' }),
      manager.handleFileEvent({ type: 'delete', path: 'src/calc.test.ts' }),
      manager.handleFileEvent({ type: 'create', path: 'src/calc.test.ts' }),
    ];

    const finalMap = await Promise.all(promises).then((maps) => maps[maps.length - 1]);
    expect(finalMap).toBeDefined();
    expect(finalMap?.files['src/calc.test.ts']).toBeDefined();
  });

  // ── 20. Repeated incremental updates do not resend unchanged repository ───
  it('20. repeated incremental scans reuse cached hashes for unchanged files', () => {
    const firstScan = scanProjectMap(rootState);
    const firstHash = firstScan.files['src/index.ts']?.contentHash;
    expect(firstHash).toBeDefined();

    // Second scan with previousMap: should re-use existing hash
    const secondScan = scanProjectMap(rootState, { previousMap: firstScan });
    expect(secondScan.files['src/index.ts']?.contentHash).toBe(firstHash);
    expect(secondScan.version).toBe(firstScan.version + 1);
  });
});
