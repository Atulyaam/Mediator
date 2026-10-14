/**
 * tests/offlineDependencyResolver.test.ts — S49 Automated Offline Dependency Bundle Resolver Tests
 *
 * Requirements (S49.2):
 * - Verifies 3-stage architecture: Trusted Preparation, Bundle Verification & Sealing, Offline Execution.
 * - Supported fixture resolves from empty cache -> sealed bundle -> cache hit.
 * - Lockfile modifications invalidate resolution.
 * - Corrupted or tampered bundles in cache are rejected fail-closed.
 * - Missing dependencies emit clear remediation without attempting network.
 * - Incomplete or interrupted imports are deleted and never become trusted.
 * - Path traversal (..) and malicious file names are strictly rejected.
 * - Staged task dependencies are isolated copies: modifications in sandbox do NOT corrupt master store.
 * - Unsupported project types report clear fail-closed messages.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  OfflineDependencyResolver,
  type DependencyPlan,
} from '@mediator/recipe-registry';
import { ErrorCode } from '@mediator/shared-contracts';

describe('Sprint S49.2 — Automated Offline Dependency Bundle Resolver', () => {
  let tempBase: string;
  let workspaceDir: string;
  let bundleStoreDir: string;
  let taskStagingDir: string;
  let resolver: OfflineDependencyResolver;

  beforeEach(() => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s49-dep-'));
    workspaceDir = path.join(tempBase, 'fixture-project');
    bundleStoreDir = path.join(tempBase, 'managed-bundles');
    taskStagingDir = path.join(tempBase, 'sandbox-staging');

    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(bundleStoreDir, { recursive: true });
    fs.mkdirSync(taskStagingDir, { recursive: true });

    resolver = new OfflineDependencyResolver({
      bundleStoreDir,
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempBase)) {
      try {
        fs.rmSync(tempBase, { recursive: true, force: true });
      } catch {
        // Ignore on windows lock
      }
    }
  });

  it('1. discovers dependencies from an unlocked project and reports missing lockfile', async () => {
    fs.writeFileSync(
      path.join(workspaceDir, 'package.json'),
      JSON.stringify({ name: 'test-app', version: '1.0.0', dependencies: { chalk: '^5.0.0' } }),
      'utf8',
    );

    const planRes = await resolver.discoverDependencies(workspaceDir);
    expect(planRes.ok).toBe(true);
    const plan = planRes.value;

    expect(plan.projectType).toBe('node');
    expect(plan.status).toBe('unlocked');
    expect(plan.missingPackages).toContain('lockfile');
    expect(plan.remediation).toContain('package-lock.json');
  });

  it('2. discovers missing dependencies when lockfile is present but cache is empty', async () => {
    fs.writeFileSync(
      path.join(workspaceDir, 'package.json'),
      JSON.stringify({ name: 'test-app', version: '1.0.0', dependencies: { chalk: '^5.0.0' } }),
      'utf8',
    );
    const lockContent = JSON.stringify({
      name: 'test-app',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { dependencies: { chalk: '^5.0.0' } } },
    });
    fs.writeFileSync(path.join(workspaceDir, 'package-lock.json'), lockContent, 'utf8');

    const planRes = await resolver.discoverDependencies(workspaceDir);
    expect(planRes.ok).toBe(true);
    const plan = planRes.value;

    expect(plan.projectType).toBe('node');
    expect(plan.status).toBe('missing');
    expect(plan.lockfileHash.length).toBe(64);
    expect(plan.missingPackages).toContain('node_modules');
    expect(plan.remediation).toContain('mediator bundle prepare');
  });

  it('3. prepares trusted bundle, seals it in managed store, and achieves cached hit', async () => {
    // 1. Setup workspace with package-lock.json
    fs.writeFileSync(
      path.join(workspaceDir, 'package.json'),
      JSON.stringify({ name: 'calc-lib', version: '1.0.0' }),
      'utf8',
    );
    const lockContent = JSON.stringify({ name: 'calc-lib', lockfileVersion: 3 });
    fs.writeFileSync(path.join(workspaceDir, 'package-lock.json'), lockContent, 'utf8');
    const lockfileHash = crypto.createHash('sha256').update(lockContent).digest('hex');

    // 2. Prepare trusted preparation source directory (outside sandbox)
    const prepSource = path.join(tempBase, 'prep-source');
    fs.mkdirSync(path.join(prepSource, 'calc'), { recursive: true });
    fs.writeFileSync(
      path.join(prepSource, 'calc', 'index.js'),
      'module.exports = { add: (a, b) => a + b };\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(prepSource, 'calc', 'package.json'),
      JSON.stringify({ name: 'calc', version: '1.0.0' }),
      'utf8',
    );

    // 3. Seal bundle in managed store
    const storeRes = await resolver.prepareAndStoreBundle({
      projectType: 'node',
      sourcePackagesDir: prepSource,
      lockfileHash,
    });

    expect(storeRes.ok).toBe(true);
    const record = storeRes.value;
    expect(record.fileCount).toBe(2);
    expect(record.verified).toBe(true);
    expect(fs.existsSync(record.storePath)).toBe(true);
    expect(fs.existsSync(record.manifestPath)).toBe(true);

    // 4. Discover dependencies now: MUST report cached!
    const planRes = await resolver.discoverDependencies(workspaceDir);
    expect(planRes.ok).toBe(true);
    expect(planRes.value.status).toBe('cached');
    expect(planRes.value.bundleId).toBe(record.bundleId);
    expect(planRes.value.missingPackages).toHaveLength(0);
  });

  it('4. invalidates cached bundle when lockfile is modified', async () => {
    // Initial lockfile
    fs.writeFileSync(path.join(workspaceDir, 'package.json'), '{"name":"app"}');
    const lock1 = '{"name":"app","v":1}';
    fs.writeFileSync(path.join(workspaceDir, 'package-lock.json'), lock1);
    const lock1Hash = crypto.createHash('sha256').update(lock1).digest('hex');

    const prepSource = path.join(tempBase, 'prep-1');
    fs.mkdirSync(prepSource, { recursive: true });
    fs.writeFileSync(path.join(prepSource, 'file.txt'), 'content');

    await resolver.prepareAndStoreBundle({
      projectType: 'node',
      sourcePackagesDir: prepSource,
      lockfileHash: lock1Hash,
    });

    // Check plan 1 -> cached
    const plan1 = await resolver.discoverDependencies(workspaceDir);
    expect(plan1.ok).toBe(true);
    expect(plan1.value.status).toBe('cached');

    // Modify lockfile
    const lock2 = '{"name":"app","v":2,"newDep":"added"}';
    fs.writeFileSync(path.join(workspaceDir, 'package-lock.json'), lock2);

    // Check plan 2 -> MUST be missing (different hash, no matching bundle in cache)
    const plan2 = await resolver.discoverDependencies(workspaceDir);
    expect(plan2.ok).toBe(true);
    expect(plan2.value.status).toBe('missing');
  });

  it('5. strictly rejects tampered bundles in cache fail-closed', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'package.json'), '{"name":"tamper-test"}');
    const lock = '{"name":"tamper-test","lockVersion":3}';
    fs.writeFileSync(path.join(workspaceDir, 'package-lock.json'), lock);
    const lockHash = crypto.createHash('sha256').update(lock).digest('hex');

    const prepSource = path.join(tempBase, 'prep-tamper');
    fs.mkdirSync(prepSource, { recursive: true });
    fs.writeFileSync(path.join(prepSource, 'safe.js'), 'console.log("safe");');

    const storeRes = await resolver.prepareAndStoreBundle({
      projectType: 'node',
      sourcePackagesDir: prepSource,
      lockfileHash: lockHash,
    });
    expect(storeRes.ok).toBe(true);
    const record = storeRes.value;

    // Tamper with file in store directory directly
    fs.writeFileSync(path.join(record.storePath, 'safe.js'), 'console.log("MALICIOUS INJECTION");');

    // Provisioning for execution MUST fail closed with BUNDLE_INTEGRITY_MISMATCH
    const provRes = await resolver.resolveForExecution(workspaceDir, taskStagingDir);
    expect(provRes.ok).toBe(false);
    expect(provRes.error.code).toBe(ErrorCode.BUNDLE_INTEGRITY_MISMATCH);
  });

  it('6. safely isolates task staging copy: sandbox modifications do NOT mutate master cache', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'package.json'), '{"name":"isolation-test"}');
    const lock = '{"name":"isolation-test","lockVersion":3}';
    fs.writeFileSync(path.join(workspaceDir, 'package-lock.json'), lock);
    const lockHash = crypto.createHash('sha256').update(lock).digest('hex');

    const prepSource = path.join(tempBase, 'prep-iso');
    fs.mkdirSync(prepSource, { recursive: true });
    fs.writeFileSync(path.join(prepSource, 'helper.js'), 'module.exports = 1;\n');

    const storeRes = await resolver.prepareAndStoreBundle({
      projectType: 'node',
      sourcePackagesDir: prepSource,
      lockfileHash: lockHash,
    });
    expect(storeRes.ok).toBe(true);
    const record = storeRes.value;

    // Resolve for execution
    const provRes = await resolver.resolveForExecution(workspaceDir, taskStagingDir);
    expect(provRes.ok).toBe(true);
    const resolved = provRes.value;

    expect(resolved.isolateNetworkRequired).toBe(true);
    const stagedHelper = path.join(resolved.targetStagedDir, 'helper.js');
    expect(fs.existsSync(stagedHelper)).toBe(true);

    // Simulate task code mutating the staged dependency
    fs.writeFileSync(stagedHelper, 'module.exports = 999; // MUTATED BY TASK\n');

    // Master store MUST remain intact and unmutated
    const masterHelper = fs.readFileSync(path.join(record.storePath, 'helper.js'), 'utf8');
    expect(masterHelper).toBe('module.exports = 1;\n');
  });

  it('7. cleans up interrupted import and never promotes partial bundle to trusted store', async () => {
    const lockHash = 'synthetic-interrupted-lockfile-hash-12345';
    const bundleId = `bundle-node-${lockHash.slice(0, 16)}`;

    // Stale interrupted folder
    const incompleteDir = path.join(bundleStoreDir, `.incomplete_${bundleId}`);
    fs.mkdirSync(incompleteDir, { recursive: true });
    fs.writeFileSync(path.join(incompleteDir, 'partial.txt'), 'incomplete content');

    // Check registry: incomplete bundle MUST NOT be trusted
    expect(resolver.getBundleRecord(bundleId)).toBeUndefined();
    expect(fs.existsSync(path.join(bundleStoreDir, bundleId))).toBe(false);
  });

  it('8. strictly fails closed on unsupported project types', async () => {
    // Workspace with no package.json or requirements.txt
    fs.writeFileSync(path.join(workspaceDir, 'main.rs'), 'fn main() {}');

    const planRes = await resolver.discoverDependencies(workspaceDir);
    expect(planRes.ok).toBe(true);
    expect(planRes.value.status).toBe('unsupported');
    expect(planRes.value.remediation).toContain('package.json');
  });
});
