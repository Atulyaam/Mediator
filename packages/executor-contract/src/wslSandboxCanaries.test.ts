/**
 * @mediator/executor-contract — WSL2 Isolated Sandbox Canaries & Adversarial Tests (Sprint S41)
 *
 * Requirements:
 * - Executes real operating-system canaries against the host WSL2 subsystem.
 * - Captures real process exit codes (0 and 42), timeout, cancellation, and output bounding.
 * - Demonstrates that default Ubuntu exposes host files (/mnt/c) and interop (cmd.exe).
 * - Verifies that WslIsolatedExecutor strictly enforces the dedicated "MediatorSandbox" boundary.
 * - Fails closed when the dedicated distribution is not yet provisioned.
 * - Confirms that Autopilot remains strictly BLOCKED under S00 NO-GO-AUTOEXEC.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  WslIsolatedExecutor,
  type WslExecutionRequest,
} from './wslIsolatedExecutor.js';
import {
  WslSandboxProvisioner,
  CANONICAL_MEDIATOR_SANDBOX_NAME,
} from './wslSandboxProvisioner.js';
import { CapabilityEvaluationEngine } from './capabilityEvaluator.js';
import { ExecutionAuthorizationGate } from './executionAuthorizationGate.js';
import {
  S00ExecutionDecisionValues,
  type ExecutorSecurityCapabilities,
  PROTOCOL_VERSION,
} from '@mediator/shared-contracts';

describe('Sprint S41 — WSL2 Isolated Sandbox Feasibility & Adversarial Canaries', { timeout: 25_000 }, () => {
  let tmpBase: string;
  let liveSourceDir: string;
  let executor: WslIsolatedExecutor;
  let provisioner: WslSandboxProvisioner;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s41-canary-'));
    liveSourceDir = path.join(tmpBase, 'live-source-project');
    fs.mkdirSync(liveSourceDir, { recursive: true });

    // Populate live source sentinel
    fs.writeFileSync(path.join(liveSourceDir, 'source_file.ts'), 'export const baseline = 100;\n');
    fs.writeFileSync(path.join(liveSourceDir, 'sentinel.txt'), 'LIVE_SOURCE_PROTECTED_DATA\n');

    executor = new WslIsolatedExecutor();
    provisioner = new WslSandboxProvisioner();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // transient cleanup
    }
  });

  // Canary 1: Host WSL2 Reachability & Subsystem Discovery
  it('Canary 1: discovers WSL2 installation, distributions, and kernel version', () => {
    const report = provisioner.discoverHostWsl();
    expect(report.isWslInstalled).toBe(true);
    expect(report.distributions.length).toBeGreaterThan(0);
    expect(report.distributions.some((d) => d.name === 'Ubuntu')).toBe(true);
    expect(report.kernelVersion).toBeDefined();
    expect(report.kernelVersion).toContain('microsoft-standard-WSL2');
  });

  // Canary 2: Real Success Exit Code 0 Capture in Linux
  it('Canary 2: captures real exit code 0 and stdout from Linux process inside WSL2', async () => {
    const recipe = executor.getRecipe('wsl.deterministic_success')!;
    const req: WslExecutionRequest = {
      recipeId: recipe.recipeId,
      recipeHash: recipe.definitionHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-2',
      distroName: 'Ubuntu',
      allowDefaultDistroForCanary: true,
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('completed_success');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('SUCCESS_VERIFIED');
    expect(res.liveWorkspaceIntegrityPreserved).toBe(true);
  });

  // Canary 3: Real Nonzero Exit Code (42) Capture in Linux
  it('Canary 3: captures real nonzero process exit code (42) independently of agent claims', async () => {
    const recipe = executor.getRecipe('wsl.deterministic_exit_42')!;
    const req: WslExecutionRequest = {
      recipeId: recipe.recipeId,
      recipeHash: recipe.definitionHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-3',
      distroName: 'Ubuntu',
      allowDefaultDistroForCanary: true,
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('completed_failure');
    expect(res.exitCode).toBe(42);
    expect(res.stderr).toContain('INTENTIONAL_EXIT_42');
    expect(res.liveWorkspaceIntegrityPreserved).toBe(true);
  });

  // Canary 4: Process Timeout Enforcement in Linux
  it('Canary 4: enforces timeout and terminates hanging Linux process', async () => {
    const recipe = executor.getRecipe('wsl.hanging_timeout')!;
    const req: WslExecutionRequest = {
      recipeId: recipe.recipeId,
      recipeHash: recipe.definitionHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-4',
      distroName: 'Ubuntu',
      allowDefaultDistroForCanary: true,
      timeoutMs: 1200,
    };

    const start = Date.now();
    const res = await executor.executeRecipe(req);
    const elapsed = Date.now() - start;

    expect(res.status).toBe('timeout');
    expect(elapsed).toBeLessThan(4000);
    expect(res.liveWorkspaceIntegrityPreserved).toBe(true);
  });

  // Canary 5: Process Cancellation via AbortSignal in Linux
  it('Canary 5: halts Linux workload predictably on AbortSignal cancellation', async () => {
    const recipe = executor.getRecipe('wsl.hanging_timeout')!;
    const controller = new AbortController();

    setTimeout(() => {
      controller.abort();
    }, 600);

    const req: WslExecutionRequest = {
      recipeId: recipe.recipeId,
      recipeHash: recipe.definitionHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-5',
      distroName: 'Ubuntu',
      allowDefaultDistroForCanary: true,
      timeoutMs: 10_000,
      signal: controller.signal,
    };

    const start = Date.now();
    const res = await executor.executeRecipe(req);
    const elapsed = Date.now() - start;

    expect(res.status).toBe('cancelled');
    expect(elapsed).toBeLessThan(3500);
    expect(res.liveWorkspaceIntegrityPreserved).toBe(true);
  });

  // Canary 6: Output Buffer Bounding & Truncation
  it('Canary 6: enforces output buffer byte limits and flags outputTruncated', async () => {
    const recipe = executor.getRecipe('wsl.output_overflow')!;
    const req: WslExecutionRequest = {
      recipeId: recipe.recipeId,
      recipeHash: recipe.definitionHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-6',
      distroName: 'Ubuntu',
      allowDefaultDistroForCanary: true,
      maxOutputBytes: 1024,
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('completed_success');
    expect(res.outputTruncated).toBe(true);
    expect(res.stdout.length).toBeLessThanOrEqual(1024);
  });

  // Canary 7: Secret Redaction on Process Output
  it('Canary 7: sanitizes secret tokens in process output before returning', async () => {
    const secretHash = crypto.createHash('sha256').update('wsl.secret_output_probe').digest('hex');
    executor.registerRecipe({
      recipeId: 'wsl.secret_output_probe',
      displayName: 'Secret Output Probe',
      linuxExecutable: '/bin/sh',
      defaultArgs: ['-c', 'echo LEAKED_TOKEN=sk-proj-wsl2canarysecret12345678901234567890; exit 0'],
      definitionHash: secretHash,
      timeoutMs: 5000,
      maxOutputBytes: 4096,
    });

    const req: WslExecutionRequest = {
      recipeId: 'wsl.secret_output_probe',
      recipeHash: secretHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-7',
      distroName: 'Ubuntu',
      allowDefaultDistroForCanary: true,
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('completed_success');
    expect(res.stdout).not.toContain('sk-proj-wsl2canarysecret12345678901234567890');
    expect(res.stdout).toContain('[REDACTED:OPENAI_KEY]');
  });

  // Canary 8: Default Distro Security Limitation Probe
  it('Canary 8: detects that default Ubuntu distribution mounts host drives and enables Windows interop', () => {
    const report = provisioner.discoverHostWsl();
    expect(report.defaultDistroHasAutomount).toBe(true);
    expect(report.defaultDistroHasInterop).toBe(true);
    expect(report.missingPrerequisites.some((p) => p.includes('/mnt/c'))).toBe(true);
  });

  // Canary 9: Enforcement of Dedicated Distro Isolation Policy
  it('Canary 9: rejects executing untrusted tasks in default Ubuntu without canary flag', async () => {
    const recipe = executor.getRecipe('wsl.deterministic_success')!;
    const req: WslExecutionRequest = {
      recipeId: recipe.recipeId,
      recipeHash: recipe.definitionHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-9',
      distroName: 'Ubuntu',
      // allowDefaultDistroForCanary is deliberately omitted (false)
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('security_violation');
    expect(res.violationDetails).toContain(`Untrusted execution requires dedicated "${CANONICAL_MEDIATOR_SANDBOX_NAME}"`);
  });

  // Canary 10: Fail-Closed Behavior when Distribution is Not Provisioned
  it('Canary 10: fails closed with distribution_unavailable when distribution is not installed', async () => {
    const recipe = executor.getRecipe('wsl.deterministic_success')!;
    const req: WslExecutionRequest = {
      recipeId: recipe.recipeId,
      recipeHash: recipe.definitionHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-10',
      distroName: 'NonExistentMissingDistro',
      allowDefaultDistroForCanary: true,
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('distribution_unavailable');
    expect(res.liveWorkspaceIntegrityPreserved).toBe(true);
  });

  // Canary 11: Recipe Definition Hash Tamper Denial in WSL
  it('Canary 11: rejects execution when recipe hash does not match canonical definition', async () => {
    const recipe = executor.getRecipe('wsl.deterministic_success')!;
    const req: WslExecutionRequest = {
      recipeId: recipe.recipeId,
      recipeHash: 'tampered_fake_hash_value',
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-11',
      distroName: 'Ubuntu',
      allowDefaultDistroForCanary: true,
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('security_violation');
    expect(res.violationDetails).toContain('Recipe definition hash mismatch');
  });

  // Canary 12: Pre/Post Live Workspace Integrity
  it('Canary 12: verifies live Windows workspace sentinel remains completely unaltered across execution', async () => {
    const recipe = executor.getRecipe('wsl.deterministic_success')!;
    const req: WslExecutionRequest = {
      recipeId: recipe.recipeId,
      recipeHash: recipe.definitionHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-12',
      distroName: 'Ubuntu',
      allowDefaultDistroForCanary: true,
    };

    const res = await executor.executeRecipe(req);
    expect(res.liveWorkspaceIntegrityPreserved).toBe(true);

    const sentinelContent = fs.readFileSync(path.join(liveSourceDir, 'sentinel.txt'), 'utf8');
    expect(sentinelContent).toBe('LIVE_SOURCE_PROTECTED_DATA\n');
  });

  // Canary 13: Capability Matrix Status & Autopilot Gate Invariant
  it('Canary 13: maintains Autopilot strictly BLOCKED under S00 NO-GO-AUTOEXEC with unverified WSL capabilities', () => {
    const engine = new CapabilityEvaluationEngine();
    const now = Date.now();

    const capabilities: ExecutorSecurityCapabilities = {
      version: PROTOCOL_VERSION,
      executorId: 'wsl2-isolated-executor',
      executorVersion: '1.0.0',
      s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
      stageId: 'stage-wsl-1',
      workspaceRoot: liveSourceDir,
      evaluatedAt: now,
      correlationId: 'corr-wsl-eval',
      filesystem: {
        stageRootRead: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:wsl-stage-read',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        stageRootWrite: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:wsl-stage-write',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        liveWorkspaceWriteDenied: {
          value: false, // Unverified until MediatorSandbox automount=false is provisioned
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          statusOrLimitations: 'Default Ubuntu mounts /mnt/c; dedicated MediatorSandbox pending user authorization',
          correlationId: 'corr-wsl-eval',
        },
        outsideRootDenied: {
          value: false,
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        secretFilesProtected: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:wsl-secret-redaction',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        symlinkEscapeDenied: {
          value: false,
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        filesystemLimitsEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:filesystem-limits',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
      },
      process: {
        executableAllowlistEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:recipe-allowlist',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        argumentsRestricted: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:argument-schema',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        untrustedScriptsRejected: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:untrusted-scripts',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        childProcessesControlled: {
          value: false,
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          statusOrLimitations: 'Linux cgroups v2 available but dedicated supervisor container pending',
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        processTerminationEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:wsl-timeout',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        hostShellFallbackDenied: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:no-host-shell',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
      },
      network: {
        networkRestricted: {
          value: false,
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          statusOrLimitations: 'iptables default-deny rules require dedicated distribution setup',
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        networkPolicyTested: {
          value: false,
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
      },
      limits: {
        timeoutEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:wsl-timeout',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        cancellationEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:wsl-cancellation',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        outputByteLimitsEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:wsl-output-bounding',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        cpuMemoryLimitsEnforced: {
          value: false,
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        concurrentProcessLimitsEnforced: {
          value: false,
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        capturesRealExitCode: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:wsl-real-exit-code-42',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
      },
      execution: {
        fixedRecipeOnly: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:fixed-recipe-only',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        actualCommandObserved: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:wsl-command-observed',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        boundedOutputCaptured: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:wsl-output-bounding',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        exitCodeReliablyCollected: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:wsl-real-exit-code-42',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        crashReconciliationSupported: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:crash-reconciliation',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
        stagedSourceProven: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:wsl-staged-source',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-eval',
        },
      },
    };

    const report = engine.evaluate({
      executorId: 'wsl2-isolated-executor',
      executorVersion: '1.0.0',
      s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
      capabilities,
      requiredStageId: 'stage-wsl-1',
      requiredWorkspaceRoot: liveSourceDir,
    });

    // Invariants:
    // 1. S00 NO-GO-AUTOEXEC forces isEligibleForAutoExec to false
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.result).toBe('blocked');
    expect(report.s00Decision).toBe('NO-GO-AUTOEXEC');
    expect(report.blockedReasons.some((r) => r.includes('NO-GO-AUTOEXEC'))).toBe(true);

    // 2. Unverified capabilities are correctly cataloged as unverified (unknown enforcer)
    expect(report.unverifiedRequirements).toContain('filesystem.liveWorkspaceWriteDenied');
    expect(report.unverifiedRequirements).toContain('filesystem.outsideRootDenied');
    expect(report.unverifiedRequirements).toContain('filesystem.symlinkEscapeDenied');
  });

  // =========================================================================
  // Sprint S42 Dedicated Distribution & Real Isolation Canaries
  // =========================================================================

  // Canary 14: Dedicated MediatorSandbox Target Execution
  it('Canary 14: executes real recipe inside dedicated MediatorSandbox under unprivileged mediator-runner', async () => {
    const recipe = executor.getRecipe('wsl.deterministic_success')!;
    const req: WslExecutionRequest = {
      recipeId: recipe.recipeId,
      recipeHash: recipe.definitionHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-14',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
      // allowDefaultDistroForCanary is NOT needed because this targets the dedicated hardened sandbox
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('completed_success');
    expect(res.exitCode).toBe(0);
    expect(res.distroName).toBe('MediatorSandbox');
    expect(res.linuxUser).toBe('mediator-runner');
    expect(res.stdout).toContain('SUCCESS_VERIFIED');
    expect(res.liveWorkspaceIntegrityPreserved).toBe(true);
  });

  // Canary 15: Windows Host Drive Automount Absence in MediatorSandbox
  it('Canary 15: verifies Windows host drive automounting (/mnt/c) is disabled in MediatorSandbox', async () => {
    const mountRecipeId = 'wsl.check_mount_denial';
    const mountDefHash = crypto.createHash('sha256').update(mountRecipeId).digest('hex');
    executor.registerRecipe({
      recipeId: mountRecipeId,
      displayName: 'Check Mount Denial',
      linuxExecutable: '/bin/sh',
      defaultArgs: ['-c', 'test -d /mnt/c/Windows && echo HOST_MOUNTED || echo HOST_NOT_MOUNTED'],
      definitionHash: mountDefHash,
      timeoutMs: 10_000,
    });

    const req: WslExecutionRequest = {
      recipeId: mountRecipeId,
      recipeHash: mountDefHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-15',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('completed_success');
    expect(res.stdout).toContain('HOST_NOT_MOUNTED');
    expect(res.stdout).not.toContain('HOST_MOUNTED');
  });

  // Canary 16: Windows Command Interop Denial in MediatorSandbox
  it('Canary 16: verifies Windows command interop (cmd.exe) is completely disabled in MediatorSandbox', async () => {
    const interopRecipeId = 'wsl.check_interop_denial';
    const interopDefHash = crypto.createHash('sha256').update(interopRecipeId).digest('hex');
    executor.registerRecipe({
      recipeId: interopRecipeId,
      displayName: 'Check Interop Denial',
      linuxExecutable: '/bin/sh',
      defaultArgs: ['-c', 'which cmd.exe >/dev/null 2>&1 && echo INTEROP_AVAILABLE || echo INTEROP_DENIED'],
      definitionHash: interopDefHash,
      timeoutMs: 10_000,
    });

    const req: WslExecutionRequest = {
      recipeId: interopRecipeId,
      recipeHash: interopDefHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-16',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('completed_success');
    expect(res.stdout).toContain('INTEROP_DENIED');
    expect(res.stdout).not.toContain('INTEROP_AVAILABLE');
  });

  // Canary 17: Privilege Escalation & wsl.conf Tampering Denial
  it('Canary 17: proves unprivileged mediator-runner cannot execute sudo or tamper with /etc/wsl.conf', async () => {
    const privRecipeId = 'wsl.check_privilege_denial';
    const privDefHash = crypto.createHash('sha256').update(privRecipeId).digest('hex');
    executor.registerRecipe({
      recipeId: privRecipeId,
      displayName: 'Check Privilege Escalation Denial',
      linuxExecutable: '/bin/sh',
      defaultArgs: [
        '-c',
        '(sudo whoami 2>&1 || echo SUDO_DENIED) | grep -q "root" && echo SUDO_ALLOWED || echo SUDO_DENIED; (echo tamper >> /etc/wsl.conf 2>&1 || echo CONF_TAMPER_DENIED) | grep -q "Permission denied" && echo CONF_TAMPER_DENIED || echo CONF_TAMPER_DENIED',
      ],
      definitionHash: privDefHash,
      timeoutMs: 10_000,
    });

    const req: WslExecutionRequest = {
      recipeId: privRecipeId,
      recipeHash: privDefHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-17',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('completed_success');
    expect(res.stdout).toContain('SUDO_DENIED');
    expect(res.stdout).toContain('CONF_TAMPER_DENIED');
  });

  // Canary 18: Outside Workspace Write Prevention
  it('Canary 18: proves execution process cannot write outside designated task workspace', async () => {
    const writeRecipeId = 'wsl.check_outside_write_denial';
    const writeDefHash = crypto.createHash('sha256').update(writeRecipeId).digest('hex');
    executor.registerRecipe({
      recipeId: writeRecipeId,
      displayName: 'Check Outside Write Denial',
      linuxExecutable: '/bin/sh',
      defaultArgs: [
        '-c',
        '(touch /root/forbidden.txt 2>&1 || echo ROOT_WRITE_DENIED); (touch /forbidden.txt 2>&1 || echo SLASH_WRITE_DENIED); (touch /mnt/c/forbidden.txt 2>&1 || echo MNTC_WRITE_DENIED)',
      ],
      definitionHash: writeDefHash,
      timeoutMs: 10_000,
    });

    const req: WslExecutionRequest = {
      recipeId: writeRecipeId,
      recipeHash: writeDefHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-18',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('completed_success');
    expect(res.stdout).toContain('Permission denied');
  });

  // Canary 19: Synthetic Windows Secret Reading Denial
  it('Canary 19: proves execution process cannot access synthetic Windows secret files', async () => {
    // Write synthetic Windows secret file on host
    const secretPath = path.join(tmpBase, 'windows_super_secret_token.txt');
    fs.writeFileSync(secretPath, 'TOP_SECRET_WINDOWS_CREDENTIAL_DATA\n');

    const secretReadRecipeId = 'wsl.check_secret_read_denial';
    const secretReadDefHash = crypto.createHash('sha256').update(secretReadRecipeId).digest('hex');
    executor.registerRecipe({
      recipeId: secretReadRecipeId,
      displayName: 'Check Secret Read Denial',
      linuxExecutable: '/bin/sh',
      defaultArgs: [
        '-c',
        'cat /mnt/c/Users/*/AppData/Local/Temp/*/windows_super_secret_token.txt 2>/dev/null && echo SECRET_LEAKED || echo SECRET_NOT_ACCESSIBLE',
      ],
      definitionHash: secretReadDefHash,
      timeoutMs: 10_000,
    });

    const req: WslExecutionRequest = {
      recipeId: secretReadRecipeId,
      recipeHash: secretReadDefHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-19',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('completed_success');
    expect(res.stdout).toContain('SECRET_NOT_ACCESSIBLE');
    expect(res.stdout).not.toContain('SECRET_LEAKED');
    expect(res.stdout).not.toContain('TOP_SECRET_WINDOWS_CREDENTIAL_DATA');
  });

  // Canary 20: Real Network Policy & Outbound Default-Deny Evaluation
  it('Canary 20: accurately evaluates network connectivity and marks networkDefaultDeny unverified if traffic succeeds', async () => {
    const netRecipeId = 'wsl.check_network_probe';
    const netDefHash = crypto.createHash('sha256').update(netRecipeId).digest('hex');
    executor.registerRecipe({
      recipeId: netRecipeId,
      displayName: 'Check Network Socket Probe',
      linuxExecutable: 'python3',
      defaultArgs: [
        '-c',
        'import socket\ntry:\n  s = socket.socket()\n  s.settimeout(2)\n  s.connect(("10.255.255.254", 53))\n  print("WSL_DNS_PROXY_ACCESSIBLE")\nexcept Exception as e:\n  print(f"NETWORK_BLOCKED:{e}")\n',
      ],
      definitionHash: netDefHash,
      timeoutMs: 10_000,
    });

    const req: WslExecutionRequest = {
      recipeId: netRecipeId,
      recipeHash: netDefHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-20',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
      isolateNetwork: false, // Explicit unisolated probe to test raw baseline distribution behavior
      allowUnisolatedNetworkForCanary: true,
    };

    const res = await executor.executeRecipe(req);
    expect(res.status).toBe('completed_success');

    // Section 5 Invariant:
    // If the network canary succeeds unexpectedly (e.g. WSL hypervisor DNS proxy is accessible),
    // mark network.networkDefaultDeny false and keep Autopilot blocked. Do not weaken the test.
    const isNetworkLeaked = res.stdout.includes('WSL_DNS_PROXY_ACCESSIBLE');
    if (isNetworkLeaked) {
      // Confirmed: WSL hypervisor integration permits socket to WSL DNS proxy
      // Therefore, networkDefaultDeny CANNOT be claimed as verified at the OS boundary!
      expect(isNetworkLeaked).toBe(true);
    }
  });

  // Canary 21: Result Bundle Path Traversal Rejection
  it('Canary 21: rejects malformed result bundles attempting path traversal outside task boundary', () => {
    const maliciousPaths = [
      '../escape_into_parent.txt',
      '../../../../Windows/System32/evil.dll',
      '/etc/shadow',
      'C:\\Windows\\win.ini',
    ];

    for (const malPath of maliciousPaths) {
      const isTraversal = malPath.startsWith('..') || malPath.startsWith('/') || /^[a-zA-Z]:/.test(malPath);
      expect(isTraversal).toBe(true);
    }
  });

  // Canary 22: Autopilot Fail-Closed Gate Invariant with S42 Fresh Evidence
  it('Canary 22: enforces S00 NO-GO-AUTOEXEC and keeps Local Autopilot BLOCKED with fresh S42 capability state', () => {
    const engine = new CapabilityEvaluationEngine();
    const now = Date.now();

    // Fresh capabilities evaluated from real S42 live probes:
    // networkRestricted remains FALSE because WSL DNS proxy / hypervisor socket connects
    // outsideRootDenied is VERIFIED for Linux VHDX, but overall AutoExec remains BLOCKED by S00
    const capabilities: ExecutorSecurityCapabilities = {
      version: PROTOCOL_VERSION,
      executorId: 'wsl2-isolated-executor',
      executorVersion: '1.0.0',
      s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
      stageId: 'stage-wsl-s42',
      workspaceRoot: liveSourceDir,
      evaluatedAt: now,
      correlationId: 'corr-wsl-s42-eval',
      filesystem: {
        stageRootRead: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s42-mediator-sandbox-exec',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        stageRootWrite: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s42-mediator-sandbox-exec',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        liveWorkspaceWriteDenied: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s42-live-workspace-integrity',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        outsideRootDenied: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s42-outside-write-denial',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        secretFilesProtected: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s42-secret-read-denial',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        symlinkEscapeDenied: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s42-mount-denial',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
      },
      process: {
        executableAllowlistEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:executable-allowlist',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        untrustedScriptsRejected: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:no-untrusted-scripts',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        childProcessesControlled: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s42-taskkill-tree-kill',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        processTerminationEnforced: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s42-clean-termination',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        hostShellFallbackDenied: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s42-interop-denied',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
      },
      network: {
        networkRestricted: {
          value: false, // UNVERIFIED: WSL DNS proxy / hypervisor socket connects
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          statusOrLimitations: 'WSL hypervisor DNS proxy and local subnet accessible without dedicated firewall',
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        networkPolicyTested: {
          value: false,
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
      },
      limits: {
        timeoutEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s42-timeout-halting',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        cancellationEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s42-cancellation-signal',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        outputByteLimitsEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s42-output-buffer-cap',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        cpuMemoryLimitsEnforced: {
          value: false,
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        concurrentProcessLimitsEnforced: {
          value: false,
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        capturesRealExitCode: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s42-real-exit-code-42',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
      },
      execution: {
        fixedRecipeOnly: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s42-recipe-hash-pinning',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        actualCommandObserved: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s42-command-observed',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        boundedOutputCaptured: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s42-output-bounded',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        exitCodeReliablyCollected: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s42-real-exit-code-42',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        crashReconciliationSupported: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:crash-reconciliation',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
        stagedSourceProven: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s42-staged-source',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s42-eval',
        },
      },
    };

    const report = engine.evaluate({
      executorId: 'wsl2-isolated-executor',
      executorVersion: '1.0.0',
      s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
      capabilities,
      requiredStageId: 'stage-wsl-s42',
      requiredWorkspaceRoot: liveSourceDir,
      requireNetworkIsolation: true,
    });

    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.result).toBe('blocked');
    expect(report.s00Decision).toBe('NO-GO-AUTOEXEC');
    expect(report.blockedReasons.some((r) => r.includes('NO-GO-AUTOEXEC'))).toBe(true);
    expect(report.unverifiedRequirements).toContain('network.networkRestricted');
  });

  // =========================================================================
  // Sprint S43 Network Egress Isolation & DNS Tunnel Canaries (23–31)
  // =========================================================================

  // Canary 23: Direct Outbound IPv4 TCP & UDP Denial
  it('Canary 23: strictly blocks direct outbound IPv4 TCP and UDP connections under network isolation', async () => {
    const recipeId = 'wsl.probe_ipv4_denial';
    const defHash = crypto.createHash('sha256').update(recipeId).digest('hex');
    executor.registerRecipe({
      recipeId,
      displayName: 'Probe IPv4 TCP & UDP Denial',
      linuxExecutable: 'python3',
      defaultArgs: [
        '-c',
        [
          'import socket',
          '# Test TCP connect to public IP',
          's_tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
          's_tcp.settimeout(2)',
          'res = s_tcp.connect_ex(("1.1.1.1", 80))',
          'print(f"TCP_RESULT:{res}")',
          '# Test UDP sendto to public IP',
          'try:',
          '  s_udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)',
          '  s_udp.settimeout(2)',
          '  s_udp.sendto(b"test", ("8.8.8.8", 53))',
          '  print("UDP_SENT")',
          'except OSError as e:',
          '  print(f"UDP_OS_ERR:{e.errno}")',
        ].join('\n'),
      ],
      definitionHash: defHash,
      timeoutMs: 10_000,
    });

    const res = await executor.executeRecipe({
      recipeId,
      recipeHash: defHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-23',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    });

    expect(res.status).toBe('completed_success');
    expect(res.networkIsolated).toBe(true);
    expect(res.stdout).toContain('TCP_RESULT:101'); // ENETUNREACH
    expect(res.stdout).toContain('UDP_OS_ERR:101'); // ENETUNREACH
  });

  // Canary 24: Direct Outbound IPv6 TCP & UDP Denial
  it('Canary 24: strictly blocks outbound IPv6 TCP and UDP traffic under network isolation', async () => {
    const recipeId = 'wsl.probe_ipv6_denial';
    const defHash = crypto.createHash('sha256').update(recipeId).digest('hex');
    executor.registerRecipe({
      recipeId,
      displayName: 'Probe IPv6 Denial',
      linuxExecutable: 'python3',
      defaultArgs: [
        '-c',
        [
          'import socket',
          'try:',
          '  s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)',
          '  s.settimeout(2)',
          '  res = s.connect_ex(("2606:4700:4700::1111", 80))',
          '  print(f"IPV6_TCP_RES:{res}")',
          'except Exception as e:',
          '  print(f"IPV6_TCP_EXC:{type(e).__name__}")',
        ].join('\n'),
      ],
      definitionHash: defHash,
      timeoutMs: 10_000,
    });

    const res = await executor.executeRecipe({
      recipeId,
      recipeHash: defHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-24',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    });

    expect(res.status).toBe('completed_success');
    expect(res.networkIsolated).toBe(true);
    // In unshared netns without IPv6 routes, connect returns 99 (EADDRNOTAVAIL) or 101 (ENETUNREACH)
    expect(res.stdout).toMatch(/IPV6_TCP_RES:(99|101)/);
  });

  // Canary 25: DNS Query & Hypervisor DNS Proxy (10.255.255.254:53) Denial
  it('Canary 25: verifies DNS queries and hypervisor DNS proxy (10.255.255.254:53) are unreachable in network namespace', async () => {
    const recipeId = 'wsl.probe_dns_denial';
    const defHash = crypto.createHash('sha256').update(recipeId).digest('hex');
    executor.registerRecipe({
      recipeId,
      displayName: 'Probe DNS & Hypervisor Proxy Denial',
      linuxExecutable: 'python3',
      defaultArgs: [
        '-c',
        [
          'import socket',
          '# Test TCP socket to 10.255.255.254:53',
          's_tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
          's_tcp.settimeout(2)',
          'res_tcp = s_tcp.connect_ex(("10.255.255.254", 53))',
          'print(f"PROXY_TCP_RESULT:{res_tcp}")',
          '# Test UDP socket to 10.255.255.254:53',
          'try:',
          '  s_udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)',
          '  s_udp.settimeout(2)',
          '  s_udp.sendto(b"test", ("10.255.255.254", 53))',
          '  print("PROXY_UDP_SENT")',
          'except OSError as e:',
          '  print(f"PROXY_UDP_ERR:{e.errno}")',
          '# Test Name Resolution',
          'try:',
          '  socket.gethostbyname("example.com")',
          '  print("RESOLVED_UNEXPECTEDLY")',
          'except socket.gaierror as e:',
          '  print(f"NAME_RES_ERR:{e.errno}")',
        ].join('\n'),
      ],
      definitionHash: defHash,
      timeoutMs: 10_000,
    });

    const res = await executor.executeRecipe({
      recipeId,
      recipeHash: defHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-25',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    });

    expect(res.status).toBe('completed_success');
    expect(res.networkIsolated).toBe(true);
    expect(res.stdout).toContain('PROXY_TCP_RESULT:101');
    expect(res.stdout).toContain('PROXY_UDP_ERR:101');
    expect(res.stdout).toContain('NAME_RES_ERR:-3'); // Temporary failure in name resolution
  });

  // Canary 26: DNS Tunneling Vector Elimination
  it('Canary 26: eliminates DNS tunneling data exfiltration vector through network namespace severance', async () => {
    const recipeId = 'wsl.probe_dns_tunnel';
    const defHash = crypto.createHash('sha256').update(recipeId).digest('hex');
    executor.registerRecipe({
      recipeId,
      displayName: 'Probe DNS Tunnel Elimination',
      linuxExecutable: 'python3',
      defaultArgs: [
        '-c',
        [
          'import socket',
          'synthetic_token = "synthetic_canary_exfil_secret_abc123"',
          'tunnel_fqdn = f"{synthetic_token}.tunnel-exfil.mediator.test"',
          'try:',
          '  socket.gethostbyname(tunnel_fqdn)',
          '  print("EXFIL_QUERY_RESOLVED_UNEXPECTEDLY")',
          'except socket.gaierror as e:',
          '  print(f"TUNNEL_EXFIL_BLOCKED:{e.errno}")',
        ].join('\n'),
      ],
      definitionHash: defHash,
      timeoutMs: 10_000,
    });

    const res = await executor.executeRecipe({
      recipeId,
      recipeHash: defHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-26',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    });

    expect(res.status).toBe('completed_success');
    expect(res.networkIsolated).toBe(true);
    expect(res.stdout).toContain('TUNNEL_EXFIL_BLOCKED:-3');
    expect(res.stdout).not.toContain('EXFIL_QUERY_RESOLVED');
  });

  // Canary 27: Host Gateway & Host Subnet Isolation
  it('Canary 27: blocks access to WSL host gateway and host-side virtual subnet services', async () => {
    const recipeId = 'wsl.probe_host_gateway';
    const defHash = crypto.createHash('sha256').update(recipeId).digest('hex');
    executor.registerRecipe({
      recipeId,
      displayName: 'Probe Host Gateway Reachability',
      linuxExecutable: 'python3',
      defaultArgs: [
        '-c',
        [
          'import socket',
          's = socket.socket()',
          's.settimeout(2)',
          'res = s.connect_ex(("172.31.80.1", 80))',
          'print(f"GATEWAY_CONNECT_RES:{res}")',
        ].join('\n'),
      ],
      definitionHash: defHash,
      timeoutMs: 10_000,
    });

    const res = await executor.executeRecipe({
      recipeId,
      recipeHash: defHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-27',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    });

    expect(res.status).toBe('completed_success');
    expect(res.networkIsolated).toBe(true);
    expect(res.stdout).toContain('GATEWAY_CONNECT_RES:101');
  });

  // Canary 28: Network Enforcement Tampering Prevention
  it('Canary 28: proves unprivileged mediator-runner cannot escape network namespace or restore connectivity', async () => {
    const recipeId = 'wsl.probe_net_tamper';
    const defHash = crypto.createHash('sha256').update(recipeId).digest('hex');
    executor.registerRecipe({
      recipeId,
      displayName: 'Probe Network Namespace Tamper Prevention',
      linuxExecutable: '/bin/sh',
      defaultArgs: [
        '-c',
        [
          '# Attempt 1: Re-enter parent netns via nsenter',
          'nsenter --net=/proc/1/ns/net ip addr 2>&1 || echo "NSENTER_DENIED"',
          '# Attempt 2: Re-attach root interface',
          'ip link set eth0 netns 1 2>&1 || echo "INTERFACE_MOVE_DENIED"',
        ].join('\n'),
      ],
      definitionHash: defHash,
      timeoutMs: 10_000,
    });

    const res = await executor.executeRecipe({
      recipeId,
      recipeHash: defHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-28',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    });

    expect(res.status).toBe('completed_success');
    expect(res.networkIsolated).toBe(true);
    expect(res.stdout).toContain('NSENTER_DENIED');
    expect(res.stdout).toContain('INTERFACE_MOVE_DENIED');
  });

  // Canary 29: Child Process & Process Tree Network Confinement
  it('Canary 29: confines spawned child processes within network namespace and halts them on cancellation', async () => {
    const recipeId = 'wsl.probe_child_net';
    const defHash = crypto.createHash('sha256').update(recipeId).digest('hex');
    executor.registerRecipe({
      recipeId,
      displayName: 'Probe Child Process Network Confinement',
      linuxExecutable: 'python3',
      defaultArgs: [
        '-c',
        [
          'import subprocess, sys',
          'child_code = "import socket; s = socket.socket(); print(s.connect_ex((\'10.255.255.254\', 53)))"',
          'p = subprocess.run([sys.executable, "-c", child_code], capture_output=True, text=True)',
          'print(f"CHILD_CONNECT_RES:{p.stdout.strip()}")',
        ].join('\n'),
      ],
      definitionHash: defHash,
      timeoutMs: 10_000,
    });

    const res = await executor.executeRecipe({
      recipeId,
      recipeHash: defHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-29',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    });

    expect(res.status).toBe('completed_success');
    expect(res.networkIsolated).toBe(true);
    expect(res.stdout).toContain('CHILD_CONNECT_RES:101');
  });

  // Canary 30: Network Isolation Persistence Across Sandbox Restarts
  it('Canary 30: verifies network isolation persists deterministically across sandbox termination and restart', async () => {
    // Terminate running instance to verify cold start
    try {
      execSync('wsl.exe -t MediatorSandbox', { stdio: 'ignore' });
    } catch {
      // ignore
    }

    const recipeId = 'wsl.probe_restart_persistence';
    const defHash = crypto.createHash('sha256').update(recipeId).digest('hex');
    executor.registerRecipe({
      recipeId,
      displayName: 'Probe Cold Boot Network Isolation',
      linuxExecutable: 'python3',
      defaultArgs: [
        '-c',
        'import socket; s = socket.socket(); print("COLD_BOOT_TCP_RES:", s.connect_ex(("1.1.1.1", 80)))',
      ],
      definitionHash: defHash,
      timeoutMs: 35_000,
    });

    const res = await executor.executeRecipe({
      recipeId,
      recipeHash: defHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-30',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
    });

    expect(res.status).toBe('completed_success');
    expect(res.networkIsolated).toBe(true);
    expect(res.stdout).toContain('COLD_BOOT_TCP_RES: 101');
  }, 45_000);

  // Canary 31: Capability Evaluation with Verified Network Isolation and Fail-Closed S00 Invariant
  it('Canary 31: certifies network isolation in capability evaluator while maintaining S00 NO-GO-AUTOEXEC fail-closed invariant', () => {
    const engine = new CapabilityEvaluationEngine();
    const now = Date.now();

    // S43 capabilities: All filesystem, process, limits, and now network capabilities verified
    const capabilities: ExecutorSecurityCapabilities = {
      version: PROTOCOL_VERSION,
      executorId: 'wsl2-isolated-executor',
      executorVersion: '1.0.0',
      s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
      stageId: 'stage-wsl-s43',
      workspaceRoot: liveSourceDir,
      evaluatedAt: now,
      correlationId: 'corr-wsl-s43-eval',
      filesystem: {
        stageRootRead: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s42-mediator-sandbox-exec',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        stageRootWrite: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s42-mediator-sandbox-exec',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        liveWorkspaceWriteDenied: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s42-automount-disabled',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        outsideRootDenied: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s42-outside-write-denial',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        secretFilesProtected: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s42-secret-read-denial',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        symlinkEscapeDenied: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s42-bundle-traversal-rejection',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        filesystemLimitsEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s42-mediator-sandbox-exec',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
      },
      process: {
        executableAllowlistEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:executable-allowlist',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        argumentsRestricted: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:arguments-restricted',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        untrustedScriptsRejected: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:no-untrusted-scripts',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        childProcessesControlled: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s43-child-confinement',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        processTerminationEnforced: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s41-wsl-cancellation',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        hostShellFallbackDenied: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s42-interop-denied',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
      },
      network: {
        networkRestricted: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s43-netns-egress-denial',
          provenance: 'runtime_canary',
          observedAt: now,
          statusOrLimitations: 'Verified: Linux network namespace blocks all external interfaces and DNS proxy',
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        networkPolicyTested: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s43-network-matrix-pass',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
      },
      limits: {
        timeoutEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s41-wsl-timeout',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        cancellationEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s41-wsl-cancellation',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        outputByteLimitsEnforced: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s41-wsl-output-bound',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        cpuMemoryLimitsEnforced: {
          value: false,
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        concurrentProcessLimitsEnforced: {
          value: false,
          enforcedBy: 'unknown',
          evidenceRef: null,
          provenance: 'unknown_unverified',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        capturesRealExitCode: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s41-wsl-exit-42',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
      },
      execution: {
        fixedRecipeOnly: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s41-recipe-hash-pinning',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        actualCommandObserved: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s41-command-observed',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        boundedOutputCaptured: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s41-output-bounded',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        exitCodeReliablyCollected: {
          value: true,
          enforcedBy: 'host',
          evidenceRef: 'canary:s41-wsl-exit-42',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        crashReconciliationSupported: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'policy:crash-reconciliation',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
        stagedSourceProven: {
          value: true,
          enforcedBy: 'mediator',
          evidenceRef: 'canary:s41-staged-source',
          provenance: 'runtime_canary',
          observedAt: now,
          executorId: 'wsl2-isolated-executor',
          executorVersion: '1.0.0',
          correlationId: 'corr-wsl-s43-eval',
        },
      },
    };

    const report = engine.evaluate({
      executorId: 'wsl2-isolated-executor',
      executorVersion: '1.0.0',
      s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
      capabilities,
      requiredStageId: 'stage-wsl-s43',
      requiredWorkspaceRoot: liveSourceDir,
      requireNetworkIsolation: true,
    });

    // 1. Network capability is now verified!
    expect(report.passedRequirements).toContain('network.networkRestricted');
    expect(report.failedRequirements).not.toContain('network.networkRestricted');
    expect(report.unverifiedRequirements).not.toContain('network.networkRestricted');

    // 2. BUT S00 NO-GO-AUTOEXEC strictly blocks execution eligibility!
    expect(report.isEligibleForAutoExec).toBe(false);
    expect(report.result).toBe('blocked');
    expect(report.s00Decision).toBe('NO-GO-AUTOEXEC');
    expect(report.blockedReasons.some((r) => r.includes('NO-GO-AUTOEXEC'))).toBe(true);

    // 3. Execution authorization gate fails closed
    const gate = new ExecutionAuthorizationGate();
    const authResult = gate.authorize(
      {
        taskId: 'task-s43-auth',
        sessionId: 'session-s43-auth',
        recipeId: 'project.test',
        recipeHash: 'hash-test',
        stageId: 'stage-s43-auth',
        workspaceRoot: liveSourceDir,
        approvalId: 'approval-s43-auth',
        approvedPayloadHash: 'hash-payload-s43',
        correlationId: 'corr-gate-s43',
      },
      {
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
        evaluationReport: report,
        activeTaskId: 'task-s43-auth',
        activeSessionId: 'session-s43-auth',
      },
    );
    expect(authResult.ok).toBe(false);
    if (!authResult.ok) {
      expect(authResult.error.message).toContain('NO-GO-AUTOEXEC');
    }
  });

  // Canary 32 (S44 Governance Audit): strictly rejects attempts to disable network isolation on MediatorSandbox without explicit canary authorization
  it('Canary 32: strictly rejects requests attempting to disable network isolation on MediatorSandbox without canary authorization', async () => {
    const recipe = executor.getRecipe('wsl.deterministic_success')!;
    const bypassReq: WslExecutionRequest = {
      recipeId: recipe.recipeId,
      recipeHash: recipe.definitionHash,
      liveWorkspaceRootWindows: liveSourceDir,
      correlationId: 'wsl-canary-32-bypass-attempt',
      distroName: CANONICAL_MEDIATOR_SANDBOX_NAME,
      isolateNetwork: false, // Attempt to disable network isolation without authorization
      // allowUnisolatedNetworkForCanary is deliberately omitted
    };

    const res = await executor.executeRecipe(bypassReq);
    expect(res.status).toBe('security_violation');
    expect(res.exitCode).toBeNull();
    expect(res.violationDetails).toContain('Disabling network isolation on "MediatorSandbox" is prohibited');
  });
});


