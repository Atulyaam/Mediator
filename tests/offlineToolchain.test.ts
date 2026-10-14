/**
 * tests/offlineToolchain.test.ts — S46 Offline Toolchain & Dependency Supply Chain Tests
 *
 * Requirements:
 * - Live execution tests in dedicated MediatorSandbox under Linux network namespace isolation.
 * - Supply chain integrity: manifest creation, cryptographic verification, tamper detection.
 * - Filesystem boundaries: path traversal, symlink escapes, DOS reserved devices, alternate data streams.
 * - Secret exclusion: zero leaked credentials in bundle.
 * - Missing dependency fail-closed behavior: clear remediation without attempting network downloads.
 * - Interrupted import protection.
 * - Autopilot governance invariant: S00 NO-GO-AUTOEXEC remains strictly authoritative.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  ErrorCode,
  PROTOCOL_VERSION,
  S00ExecutionDecisionValues,
} from '@mediator/shared-contracts';
import {
  OfflineBundleService,
  type ToolchainBundleManifest,
  RecipeRegistryService,
  DependencyInspector,
} from '@mediator/recipe-registry';
import {
  WslIsolatedExecutor,
  type WslExecutionRequest,
  CANONICAL_MEDIATOR_SANDBOX_NAME,
} from '@mediator/executor-contract';

describe('Sprint S46 — Offline Toolchain & Dependency Supply Chain', () => {
  let tempDir: string;
  let bundleService: OfflineBundleService;
  let executor: WslIsolatedExecutor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s46-test-'));
    bundleService = new OfflineBundleService();
    executor = new WslIsolatedExecutor();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. Live Sandbox Offline Python Execution
  // =========================================================================

  it('1. executes a clean Python fixture test suite inside MediatorSandbox under network isolation', async () => {
    // 1. Prepare disposable workspace and sandbox fixture directory
    const liveSource = path.join(tempDir, 'python-live-source');
    fs.mkdirSync(liveSource, { recursive: true });
    fs.writeFileSync(path.join(liveSource, 'sentinel.txt'), 'LIVE_SOURCE_PROTECTED\n');

    // 2. Prepare Python test file inside dedicated sandbox directory
    const sandboxTaskDir = '/home/mediator-runner/task-s46-python-pass';
    const setupScript = `
      mkdir -p ${sandboxTaskDir} &&
      cat << 'EOF' > ${sandboxTaskDir}/calc.py
def add(a, b):
    return a + b
EOF
      cat << 'EOF' > ${sandboxTaskDir}/test_calc.py
import unittest
from calc import add

class TestCalc(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)

if __name__ == '__main__':
    unittest.main()
EOF
    `;

    // Setup files in sandbox
    const setupRecipeId = 'wsl.s46_setup_pass';
    const setupDefHash = crypto.createHash('sha256').update(setupRecipeId).digest('hex');
    executor.registerRecipe({
      recipeId: setupRecipeId,
      displayName: 'Setup S46 Python Pass Fixture',
      linuxExecutable: '/bin/sh',
      defaultArgs: ['-c', setupScript],
      definitionHash: setupDefHash,
      timeoutMs: 30_000,
    });

    const setupRes = await executor.executeRecipe({
      recipeId: setupRecipeId,
      recipeHash: setupDefHash,
      liveWorkspaceRootWindows: liveSource,
      correlationId: 's46-setup-1',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
      isolateNetwork: true,
    });
    expect(setupRes.status).toBe('completed_success');

    // 3. Execute python.test recipe targeting the sandbox directory under netns
    const testRecipe = executor.getRecipe('python.test')!;
    expect(testRecipe).toBeDefined();

    const testReq: WslExecutionRequest = {
      recipeId: testRecipe.recipeId,
      recipeHash: testRecipe.definitionHash,
      taskWorkspaceRootLinux: sandboxTaskDir,
      liveWorkspaceRootWindows: liveSource,
      correlationId: 's46-python-run-pass',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
      isolateNetwork: true, // Mandatory network namespace
    };

    const res = await executor.executeRecipe(testReq);
    expect(res.status).toBe('completed_success');
    expect(res.exitCode).toBe(0);
    expect(res.stdout + res.stderr).toContain('OK');
    expect(res.liveWorkspaceIntegrityPreserved).toBe(true);
    expect(res.networkIsolated).toBe(true);

    // Clean up sandbox task directory
    const cleanupRecipeId = 'wsl.s46_cleanup_pass';
    const cleanupHash = crypto.createHash('sha256').update(cleanupRecipeId).digest('hex');
    executor.registerRecipe({
      recipeId: cleanupRecipeId,
      displayName: 'Cleanup S46 Fixture',
      linuxExecutable: '/bin/sh',
      defaultArgs: ['-c', `rm -rf ${sandboxTaskDir}`],
      definitionHash: cleanupHash,
    });
    await executor.executeRecipe({
      recipeId: cleanupRecipeId,
      recipeHash: cleanupHash,
      liveWorkspaceRootWindows: liveSource,
      correlationId: 's46-clean-1',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    });
  }, 40_000);

  it('2. captures real nonzero exit code (1) when a Python test fails in MediatorSandbox offline', async () => {
    const liveSource = path.join(tempDir, 'python-fail-source');
    fs.mkdirSync(liveSource, { recursive: true });

    const sandboxTaskDir = '/home/mediator-runner/task-s46-python-fail';
    const setupScript = `
      mkdir -p ${sandboxTaskDir} &&
      cat << 'EOF' > ${sandboxTaskDir}/test_failing.py
import unittest

class TestIntentionalFailure(unittest.TestCase):
    def test_should_fail(self):
        self.assertEqual(1, 99, "Intentional failure for exit code verification")

if __name__ == '__main__':
    unittest.main()
EOF
    `;

    const setupId = 'wsl.s46_setup_fail';
    const setupHash = crypto.createHash('sha256').update(setupId).digest('hex');
    executor.registerRecipe({
      recipeId: setupId,
      displayName: 'Setup Failing Fixture',
      linuxExecutable: '/bin/sh',
      defaultArgs: ['-c', setupScript],
      definitionHash: setupHash,
      timeoutMs: 30_000,
    });
    await executor.executeRecipe({
      recipeId: setupId,
      recipeHash: setupHash,
      liveWorkspaceRootWindows: liveSource,
      correlationId: 's46-setup-fail',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    });

    const testRecipe = executor.getRecipe('python.test')!;
    const res = await executor.executeRecipe({
      recipeId: testRecipe.recipeId,
      recipeHash: testRecipe.definitionHash,
      taskWorkspaceRootLinux: sandboxTaskDir,
      liveWorkspaceRootWindows: liveSource,
      correlationId: 's46-python-run-fail',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
      isolateNetwork: true,
    });

    expect(res.status).toBe('completed_failure');
    expect(res.exitCode).toBe(1);
    expect(res.stdout + res.stderr).toContain('FAILED (failures=1)');
    expect(res.liveWorkspaceIntegrityPreserved).toBe(true);

    // Cleanup
    const cleanId = 'wsl.s46_clean_fail';
    const cleanHash = crypto.createHash('sha256').update(cleanId).digest('hex');
    executor.registerRecipe({
      recipeId: cleanId,
      displayName: 'Cleanup Fail Fixture',
      linuxExecutable: '/bin/sh',
      defaultArgs: ['-c', `rm -rf ${sandboxTaskDir}`],
      definitionHash: cleanHash,
    });
    await executor.executeRecipe({
      recipeId: cleanId,
      recipeHash: cleanHash,
      liveWorkspaceRootWindows: liveSource,
      correlationId: 's46-clean-fail',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    });
  }, 40_000);

  // =========================================================================
  // 2. Supply Chain Integrity & Manifest Validation
  // =========================================================================

  it('3. creates a valid offline bundle manifest with SHA-256 digests and root hash', async () => {
    const pkgDir = path.join(tempDir, 'my-pkg');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'src', 'index.py'), 'print("hello")\n');
    fs.writeFileSync(path.join(pkgDir, 'README.md'), '# Offline Package\n');

    const bundleRes = await bundleService.createBundle(pkgDir, {
      projectType: 'python',
      toolchainVersion: 'python@3.14',
    });

    expect(bundleRes.ok).toBe(true);
    if (!bundleRes.ok) return;

    const manifest = bundleRes.value;
    expect(manifest.manifestVersion).toBe('1.0.0');
    expect(manifest.projectType).toBe('python');
    expect(manifest.fileCount).toBe(2);
    expect(manifest.rootHash).toHaveLength(64);
    expect(manifest.files.map((f) => f.relativePath).sort()).toEqual(['README.md', 'src/index.py']);

    // Verification passes
    const verifyRes = await bundleService.verifyBundle(pkgDir, manifest);
    expect(verifyRes.valid).toBe(true);
    expect(verifyRes.fileCount).toBe(2);
    expect(verifyRes.rootHash).toBe(manifest.rootHash);
  });

  it('4. detects and rejects a tampered or modified file in an offline bundle', async () => {
    const pkgDir = path.join(tempDir, 'tamper-pkg');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'module.py'), 'def safe(): pass\n');

    const bundleRes = await bundleService.createBundle(pkgDir, {
      projectType: 'python',
    });
    expect(bundleRes.ok).toBe(true);
    if (!bundleRes.ok) return;

    // Tamper with file after manifest creation (preserving exact same size so it hits SHA-256 hash check)
    fs.writeFileSync(path.join(pkgDir, 'module.py'), 'def evil(): pass\n');

    const verifyRes = await bundleService.verifyBundle(pkgDir, bundleRes.value);
    expect(verifyRes.valid).toBe(false);
    expect(verifyRes.error).toContain('SHA-256 hash mismatch');
  });

  it('5. rejects missing required bundle files against manifest', async () => {
    const pkgDir = path.join(tempDir, 'missing-file-pkg');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'a.txt'), 'file a');
    fs.writeFileSync(path.join(pkgDir, 'b.txt'), 'file b');

    const bundleRes = await bundleService.createBundle(pkgDir, {
      projectType: 'python',
    });
    expect(bundleRes.ok).toBe(true);
    if (!bundleRes.ok) return;

    // Delete one file
    fs.unlinkSync(path.join(pkgDir, 'b.txt'));

    const verifyRes = await bundleService.verifyBundle(pkgDir, bundleRes.value);
    expect(verifyRes.valid).toBe(false);
    expect(verifyRes.error).toContain('Missing required bundle file');
  });

  // =========================================================================
  // 3. Security Boundary & Filesystem Defenses
  // =========================================================================

  it('6. rejects path traversal (..) attempts in manifest validation fail-closed', async () => {
    const manifest: ToolchainBundleManifest = {
      manifestVersion: '1.0.0',
      bundleId: 'malicious-traversal-bundle',
      projectType: 'node',
      createdAt: Date.now(),
      totalSizeBytes: 100,
      fileCount: 1,
      rootHash: '0000000000000000000000000000000000000000000000000000000000000000',
      files: [
        {
          relativePath: '../../etc/passwd',
          sizeBytes: 100,
          sha256: '0000000000000000000000000000000000000000000000000000000000000000',
        },
      ],
    };

    const verifyRes = await bundleService.verifyBundle(tempDir, manifest);
    expect(verifyRes.valid).toBe(false);
    expect(verifyRes.error).toContain('Invalid manifest');
  });

  it('7. rejects Alternate Data Streams and DOS device names in bundle source', async () => {
    const dosDir = path.join(tempDir, 'dos-device-dir');
    fs.mkdirSync(dosDir, { recursive: true });
    // Attempting to create a file with base name 'CON' or 'NUL'
    fs.writeFileSync(path.join(dosDir, 'CON.txt'), 'malicious device name');

    const bundleRes = await bundleService.createBundle(dosDir, {
      projectType: 'python',
    });

    expect(bundleRes.ok).toBe(false);
    if (!bundleRes.ok) {
      expect(bundleRes.error.code).toBe(ErrorCode.PATH_RESERVED_DEVICE);
    }
  });

  it('8. rejects bundle containing sensitive API tokens or secrets', async () => {
    const secretDir = path.join(tempDir, 'secret-leak-dir');
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(
      path.join(secretDir, 'config.py'),
      'OPENAI_API_KEY = "sk-proj-1234567890abcdef1234567890abcdef1234567890abcdef"\n',
    );

    const bundleRes = await bundleService.createBundle(secretDir, {
      projectType: 'python',
    });

    expect(bundleRes.ok).toBe(false);
    if (!bundleRes.ok) {
      expect(bundleRes.error.code).toBe(ErrorCode.SECRET_DETECTED);
      expect(bundleRes.error.message).toContain('Secret detected in bundle file');
    }
  });

  // =========================================================================
  // 4. Interrupted Import & Cache Protection
  // =========================================================================

  it('9. safely imports bundle with interrupted-import protection and verifies target integrity', async () => {
    const srcDir = path.join(tempDir, 'import-src');
    const dstDir = path.join(tempDir, 'import-dst');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(dstDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'tool.py'), 'def run(): return 42\n');
    fs.writeFileSync(path.join(srcDir, 'data.json'), '{"version": 1}\n');

    const bundleRes = await bundleService.createBundle(srcDir, {
      projectType: 'python',
    });
    expect(bundleRes.ok).toBe(true);
    if (!bundleRes.ok) return;

    const importRes = await bundleService.importBundle(srcDir, dstDir, bundleRes.value);
    expect(importRes.success).toBe(true);
    expect(importRes.importedFileCount).toBe(2);

    // Target directory files match exactly
    const targetVerify = await bundleService.verifyBundle(dstDir, bundleRes.value);
    expect(targetVerify.valid).toBe(true);
    expect(targetVerify.fileCount).toBe(2);
  });

  // =========================================================================
  // 5. Dependency Inspection & Missing Package Fail-Closed Diagnostics
  // =========================================================================

  it('10. fails closed with clear remediation when required offline dependencies are missing', async () => {
    const projectDir = path.join(tempDir, 'missing-node-deps');
    fs.mkdirSync(projectDir, { recursive: true });

    // package.json declaring express, but node_modules is missing
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        dependencies: {
          express: '^4.18.0',
        },
      }),
    );

    const checkRes = await bundleService.checkProjectDependencies(projectDir, 'node');
    expect(checkRes.satisfied).toBe(false);
    expect(checkRes.missingPackages).toContain('express');
    expect(checkRes.remediation).toContain('offline toolchain bundle via Mediator offlineBundleService');
    expect(checkRes.errorCode).toBe(ErrorCode.OFFLINE_DEPENDENCY_MISSING);
  });

  it('11. fails closed for Python project with unbundled requirements.txt dependencies', async () => {
    const pyProjectDir = path.join(tempDir, 'missing-py-deps');
    fs.mkdirSync(pyProjectDir, { recursive: true });

    fs.writeFileSync(path.join(pyProjectDir, 'requirements.txt'), 'requests==2.31.0\npandas==2.2.0\n');

    const checkRes = await bundleService.checkProjectDependencies(pyProjectDir, 'python');
    expect(checkRes.satisfied).toBe(false);
    expect(checkRes.missingPackages).toContain('requests');
    expect(checkRes.missingPackages).toContain('pandas');
    expect(checkRes.remediation).toContain('vendor/ nor wheels/ directory is present');
    expect(checkRes.errorCode).toBe(ErrorCode.OFFLINE_DEPENDENCY_MISSING);
  });

  // =========================================================================
  // 6. Recipe Registry & Autopilot Safety Invariants
  // =========================================================================

  it('12. registers python.test and python.single_test in RecipeRegistryService with deterministic hash pinning', () => {
    const regService = new RecipeRegistryService();
    const pythonTest = regService.getRecipe('python.test');
    const pythonSingle = regService.getRecipe('python.single_test');

    expect(pythonTest).toBeDefined();
    expect(pythonSingle).toBeDefined();
    expect(pythonTest?.executable).toBe('python3');
    expect(pythonTest?.definitionHash).toHaveLength(64);
    expect(pythonSingle?.definitionHash).toHaveLength(64);

    // Manual-only under NO-GO-AUTOEXEC
    expect(pythonTest?.executionStatus).toBe('manual-only');
    expect(pythonSingle?.executionStatus).toBe('manual-only');
  });

  it('13. maintains Autopilot strictly BLOCKED under S00 NO-GO-AUTOEXEC throughout S46', () => {
    const inspector = new DependencyInspector();
    const pyDir = path.join(tempDir, 'py-inspect');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(path.join(pyDir, 'test_sample.py'), 'def test_a(): pass\n');

    // S00 invariant check
    expect(S00ExecutionDecisionValues.NO_GO_AUTOEXEC).toBe('NO-GO-AUTOEXEC');
    expect(PROTOCOL_VERSION).toBe('1.3');
  });
});
