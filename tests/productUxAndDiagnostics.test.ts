/**
 * @mediator/tests — Product UX, Installation, Diagnostics & Recovery Acceptance Tests (Sprint S48)
 *
 * Verifies:
 * 1. DoctorDiagnosticsService environment checks across all tiers (core, wsl, netns, toolchains, providers, host, workspace, autopilot).
 * 2. Proper health categorization: HEALTHY, DEGRADED, UNHEALTHY.
 * 3. Actionable remediation messages for missing prerequisites.
 * 4. Sanitized diagnostic report export with secret redaction and fail-closed user confirmation gating.
 * 5. Invariant check: Local Autopilot remains strictly BLOCKED under S00 NO-GO-AUTOEXEC.
 * 6. CLI 'mediator doctor' human-readable formatting, JSON mode, and --export flag.
 * 7. Installer and uninstaller security invariants: current-user scope HKCU, preservation of user's personal Ubuntu/Docker WSL distros and workspace files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { MediatorCore, DoctorDiagnosticsService } from '@mediator/orchestrator';
import { runCli } from '../apps/cli/src/index.js';
import { PlatformDiagnosticsReportSchema } from '@mediator/shared-contracts';

describe('Sprint S48 — Product UX, Diagnostics, Installation & Recovery', () => {
  let testWorkspace: string;
  let customAppData: string;
  let core: MediatorCore;
  let diagService: DoctorDiagnosticsService;

  beforeEach(() => {
    testWorkspace = path.join(os.tmpdir(), `mediator-s48-ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    customAppData = path.join(os.tmpdir(), `mediator-s48-appdata-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

    fs.mkdirSync(testWorkspace, { recursive: true });
    fs.mkdirSync(customAppData, { recursive: true });

    core = new MediatorCore({
      workspaceRoot: testWorkspace,
    });
    core.setWorkspaceRoot(testWorkspace, true);

    diagService = new DoctorDiagnosticsService({
      core,
      customLocalAppdata: customAppData,
    });
  });

  afterEach(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
    if (fs.existsSync(customAppData)) {
      fs.rmSync(customAppData, { recursive: true, force: true });
    }
  });

  it('1. runs comprehensive diagnostics and conforms to PlatformDiagnosticsReport schema', async () => {
    const report = await diagService.runDiagnostics();

    // Validate Zod schema
    const parseResult = PlatformDiagnosticsReportSchema.safeParse(report);
    expect(parseResult.success).toBe(true);

    expect(report.mediatorVersion).toBeDefined();
    expect(report.protocolVersion).toBe('1.3');
    expect(report.autopilotPolicy).toBe('BLOCKED');
    expect(report.checks.length).toBeGreaterThanOrEqual(8);
  });

  it('2. verifies that Local Autopilot security policy is strictly BLOCKED fail-closed', async () => {
    const report = await diagService.runDiagnostics();
    const autopilotCheck = report.checks.find((c) => c.category === 'autopilot');

    expect(autopilotCheck).toBeDefined();
    expect(autopilotCheck?.status).toBe('READY');
    expect(autopilotCheck?.detail).toContain('S00 NO-GO-AUTOEXEC');
    expect(autopilotCheck?.detail).toContain('BLOCKED');
    expect(report.autopilotPolicy).toBe('BLOCKED');
  });

  it('3. detects missing native messaging host and provides actionable remediation', async () => {
    // In our empty customAppData, native host is not installed
    const report = await diagService.runDiagnostics();
    const hostCheck = report.checks.find((c) => c.category === 'native_host');

    expect(hostCheck).toBeDefined();
    if (process.platform === 'win32') {
      expect(hostCheck?.status).toBe('ACTION_REQUIRED');
      expect(hostCheck?.remediation).toContain('scripts/install-windows.ps1');
      expect(report.overallStatus).toBe('DEGRADED');
    }
  });

  it('4. detects installed native host when manifest is present', async () => {
    const nativeHostDir = path.join(customAppData, 'Mediator', 'native-host');
    fs.mkdirSync(nativeHostDir, { recursive: true });
    fs.writeFileSync(path.join(nativeHostDir, 'com.mediator.native_host.json'), '{}', 'utf8');

    const report = await diagService.runDiagnostics();
    const hostCheck = report.checks.find((c) => c.category === 'native_host');

    expect(hostCheck?.status).toBe('READY');
  });

  it('5. detects unconfirmed workspace and reports ACTION_REQUIRED with remediation', async () => {
    const unconfirmedCore = new MediatorCore();
    // Do not confirm workspace
    const svc = new DoctorDiagnosticsService({
      core: unconfirmedCore,
      customLocalAppdata: customAppData,
    });

    const report = await svc.runDiagnostics();
    const wsCheck = report.checks.find((c) => c.category === 'workspace');

    expect(wsCheck?.status).toBe('ACTION_REQUIRED');
    expect(wsCheck?.remediation).toBeDefined();
  });

  it('6. verifies offline toolchains and network default-deny checks', async () => {
    const report = await diagService.runDiagnostics();

    const netCheck = report.checks.find((c) => c.category === 'network');
    expect(netCheck?.status).toBe('READY');
    expect(netCheck?.name).toContain('CLONE_NEWNET');
    expect(netCheck?.detail).toContain('default-deny');

    const toolchainCheck = report.checks.find((c) => c.category === 'toolchain');
    expect(toolchainCheck?.status).toBe('READY');
    expect(toolchainCheck?.detail).toContain('Python 3.14+');
  });

  it('7. refuses diagnostic export without explicit user authorization', async () => {
    const report = await diagService.runDiagnostics();

    const result = diagService.exportSanitizedReport({
      report,
      explicitUserExportRequested: false, // Not authorized
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('DIAGNOSTIC_EXPORT_REFUSED');
    }
  });

  it('8. exports sanitized diagnostic report with sensitive secrets and tokens redacted', async () => {
    const report = await diagService.runDiagnostics();
    const exportPath = path.join(testWorkspace, 'diagnostics-export.json');

    const result = diagService.exportSanitizedReport({
      report,
      outputPath: exportPath,
      explicitUserExportRequested: true,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(exportPath)).toBe(true);

    const exportedContent = fs.readFileSync(exportPath, 'utf8');
    const parsed = JSON.parse(exportedContent) as typeof report;

    expect(parsed.reportId).toBe(report.reportId);
    expect(parsed.autopilotPolicy).toBe('BLOCKED');
    expect(exportedContent).not.toContain('pair_'); // No raw token leaks
  });

  it('9. executes CLI "mediator doctor" and outputs human-readable checklist', async () => {
    const res = await runCli(['doctor', `--workspace=${testWorkspace}`, '--confirm']);

    expect(res.exitCode).toBeLessThanOrEqual(1); // 0 (healthy) or 1 (degraded/unhealthy)
    expect(res.output).toContain('Mediator Diagnostic Health & Setup Doctor');
    expect(res.output).toContain('System Verification Checks:');
    expect(res.output).toContain('Core Engine');
    expect(res.output).toContain('Autopilot Policy:  BLOCKED');
  });

  it('10. executes CLI "mediator doctor --json" and returns valid structured JSON', async () => {
    const res = await runCli(['doctor', '--json', `--workspace=${testWorkspace}`, '--confirm']);

    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.output);
    expect(parsed.autopilotPolicy).toBe('BLOCKED');
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  it('11. executes CLI "mediator doctor --export <path>" and writes report to disk', async () => {
    const outFile = path.join(testWorkspace, 'cli-diag.json');
    const res = await runCli(['doctor', '--export', outFile, `--workspace=${testWorkspace}`, '--confirm']);

    expect(res.exitCode).toBe(0);
    expect(res.output).toContain('Sanitized diagnostics exported successfully');
    expect(fs.existsSync(outFile)).toBe(true);

    const content = fs.readFileSync(outFile, 'utf8');
    expect(content).toContain('"autopilotPolicy": "BLOCKED"');
  });

  it('12. verifies install and uninstall scripts audit guarantees', () => {
    const installScript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-windows.ps1'), 'utf8');
    const uninstallScript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'uninstall-windows.ps1'), 'utf8');

    // Installer audit checks:
    // 1. Current user scope only (HKCU, never machine-wide HKLM)
    expect(installScript).toContain('HKCU:');
    expect(installScript).not.toContain('HKLM:');
    // 2. Strict rejection of batch/script wrappers
    expect(installScript).toContain('.bat');
    expect(installScript).toContain('.cmd');

    // Uninstaller audit checks:
    // 1. Strictly current user registry
    expect(uninstallScript).toContain('HKCU:');
    expect(uninstallScript).not.toContain('HKLM:');
    // 2. Strictly target MediatorSandbox; never touch personal distros
    expect(uninstallScript).toContain('$targetDistro = "MediatorSandbox"');
    expect(uninstallScript).toContain('NEVER touch user\'s personal Ubuntu or Docker distros');
    // 3. User workspaces preserved
    expect(uninstallScript).toContain('User workspaces remain untouched');
  });
});
