/**
 * @mediator/cli — Comprehensive CLI Unit Tests (Sprint S33.5)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { runCli, CLI_VERSION } from './index.js';

describe('Sprint S33.5 — Mediator CLI', () => {
  let tempWs: string;

  beforeEach(() => {
    tempWs = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-cli-test-'));
  });

  it('1. reports version correctly in human-readable and JSON format', async () => {
    const textRes = await runCli(['version']);
    expect(textRes.exitCode).toBe(0);
    expect(textRes.output).toContain(`Mediator CLI v${CLI_VERSION}`);

    const jsonRes = await runCli(['version', '--json']);
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.output);
    expect(parsed.version).toBe(CLI_VERSION);
    expect(parsed.protocolVersion).toBe('1.3');
  });

  it('2. reports platform status and doctor diagnostics', async () => {
    const statusRes = await runCli(['status', '--workspace', tempWs, '--confirm']);
    expect(statusRes.exitCode).toBe(0);
    expect(statusRes.output).toContain('Mediator Platform Status');
    expect(statusRes.output).toContain('CONFIRMED');

    const docRes = await runCli(['doctor', '--json']);
    expect(docRes.exitCode).toBe(0);
    const docParsed = JSON.parse(docRes.output);
    expect(docParsed.ok).toBe(true);
    expect(docParsed.checks.length).toBeGreaterThan(0);
  });

  it('3. lists providers and selects DeepSeek without error', async () => {
    const listRes = await runCli(['providers']);
    expect(listRes.exitCode).toBe(0);
    expect(listRes.output).toContain('Google Gemini');
    expect(listRes.output).toContain('DeepSeek');

    const selRes = await runCli(['providers', 'select', 'deepseek']);
    expect(selRes.exitCode).toBe(0);
    expect(selRes.output).toContain('Selected provider switched to: deepseek');

    const listJson = await runCli(['providers', '--json']);
    expect(listJson.exitCode).toBe(0);
    const providers = JSON.parse(listJson.output);
    expect(providers.find((p: any) => p.providerId === 'deepseek')).toBeDefined();
  });

  it('4. manages task creation, listing, pausing, and resuming', async () => {
    const createRes = await runCli(['task', 'create', 'Write a test suite for CLI']);
    expect(createRes.exitCode).toBe(0);
    expect(createRes.output).toContain('Task created:');
    const taskId = (createRes.data as any).id;

    // List
    const listRes = await runCli(['task', 'list']);
    expect(listRes.exitCode).toBe(0);
    expect(listRes.output).toContain(taskId);

    // Status
    const statRes = await runCli(['task', 'status', taskId]);
    expect(statRes.exitCode).toBe(0);
    expect(statRes.output).toContain('RUNNING');

    // Pause
    const pauseRes = await runCli(['task', 'pause', taskId]);
    expect(pauseRes.exitCode).toBe(0);
    expect(pauseRes.output).toContain('paused');

    // Resume
    const resumeRes = await runCli(['task', 'resume', taskId]);
    expect(resumeRes.exitCode).toBe(0);
    expect(resumeRes.output).toContain('resumed');
  });

  it('5. controls provider conversation loop independently of Autopilot', async () => {
    const disRes = await runCli(['loop', 'disable']);
    expect(disRes.exitCode).toBe(0);
    expect(disRes.output).toContain('DISABLED');

    const enRes = await runCli(['loop', 'enable']);
    expect(enRes.exitCode).toBe(0);
    expect(enRes.output).toContain('ENABLED');

    const statusRes = await runCli(['loop']);
    expect(statusRes.exitCode).toBe(0);
    expect(statusRes.output).toContain('READY');
  });

  it('6. fails closed when autopilot enable is invoked under S00 NO-GO-AUTOEXEC', async () => {
    const autoStatus = await runCli(['autopilot']);
    expect(autoStatus.exitCode).toBe(0);
    expect(autoStatus.output).toContain('OFF');
    expect(autoStatus.output).toContain('Can Run: NO');

    // Attempt enable
    const autoEnable = await runCli(['autopilot', 'enable']);
    expect(autoEnable.exitCode).toBe(0);
    expect(autoEnable.output).toContain('BLOCKED');
    expect(autoEnable.output).toContain('Can Run: NO');
    expect(autoEnable.output).toContain('NO-GO-AUTOEXEC');
  });

  it('7. displays config and handles invalid commands safely without arbitrary execution', async () => {
    const confRes = await runCli(['config', 'show']);
    expect(confRes.exitCode).toBe(0);
    const conf = JSON.parse(confRes.output);
    expect(conf.s00Decision).toBe('NO-GO-AUTOEXEC');

    // Unknown command fails cleanly with exitCode 1 and help text
    const unknownRes = await runCli(['rm -rf /']);
    expect(unknownRes.exitCode).toBe(1);
    expect(unknownRes.output).toContain('Usage:');
  });

  it('8. launches loopback HTTP server and UI daemon via serve --json', async () => {
    const serveRes = await runCli(['serve', '--port', '0', '--json']);
    expect(serveRes.exitCode).toBe(0);
    const parsed = JSON.parse(serveRes.output);
    expect(parsed.ok).toBe(true);
    expect(parsed.url).toContain('http://127.0.0.1:');
    expect(parsed.token).toContain('pair_');

    const server = (serveRes.data as any)?.server;
    if (server) {
      await server.stop();
    }
  });
});

