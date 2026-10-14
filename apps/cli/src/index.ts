#!/usr/bin/env node
/**
 * Mediator CLI — Autonomous Coding Platform Command-Line Interface (Sprint S33.5)
 *
 * Implements authoritative commands:
 *   mediator status [--json]
 *   mediator doctor [--json]
 *   mediator providers [status|select <provider>] [--json]
 *   mediator workspace [show|select <path>] [--confirm] [--json]
 *   mediator task [create <prompt>|list|status <id>|pause <id>|resume <id>|cancel <id>] [--json]
 *   mediator stage [list|diff <id>|inspect <id>] [--json]
 *   mediator approval [list|resolve <id> <approve|reject>] [--json]
 *   mediator loop [status|enable|disable] [--json]
 *   mediator autopilot [status|enable|disable] [--json]
 *   mediator logs [--json]
 *   mediator config show [--json]
 *   mediator version [--json]
 *
 * Security:
 * - Operates authoritative MediatorCore contracts.
 * - Does NOT execute arbitrary shell commands.
 * - Fail-closed: Autopilot respects S00 NO-GO-AUTOEXEC gating.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, type RecipeId } from '@mediator/shared-contracts';
import { parseCliWorkspaceArg } from '@mediator/workspace-boundary';
import { MediatorCore, DoctorDiagnosticsService, MediatorHttpServer } from '@mediator/orchestrator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CLI_VERSION = '0.0.1';

// Shared in-process Core instance if not connecting to HTTP daemon
let _activeCore: MediatorCore | null = null;

export function getOrCreateCore(workspace?: string | null): MediatorCore {
  if (!_activeCore) {
    _activeCore = new MediatorCore({
      workspaceRoot: workspace ?? process.cwd(),
    });
  }
  return _activeCore;
}

export function resetCoreForTesting(core?: MediatorCore | null): void {
  _activeCore = core ?? null;
}

export interface CliExecutionResult {
  readonly exitCode: number;
  readonly output: string;
  readonly data?: unknown;
}

export async function runCli(args: readonly string[]): Promise<CliExecutionResult> {
  await Promise.resolve();
  const isJson = args.includes('--json');
  const cleanArgs = args.filter((a) => a !== '--json');
  const command = cleanArgs[0];
  const subCommand = cleanArgs[1];
  const arg3 = cleanArgs[2];
  const arg4 = cleanArgs[3];

  const parsedWs = parseCliWorkspaceArg(cleanArgs);
  const workspaceArg = parsedWs.ok ? parsedWs.value : null;
  const hasConfirm = cleanArgs.includes('--confirm');

  const core = getOrCreateCore(workspaceArg);

  if (workspaceArg) {
    core.setWorkspaceRoot(workspaceArg, hasConfirm);
  }

  switch (command) {
    case 'version':
    case '--version':
    case '-v': {
      const data = { version: CLI_VERSION, protocolVersion: PROTOCOL_VERSION };
      return {
        exitCode: 0,
        output: isJson ? JSON.stringify(data, null, 2) : `Mediator CLI v${CLI_VERSION} (Protocol v${PROTOCOL_VERSION})\n`,
        data,
      };
    }

    case 'status': {
      const state = core.getStateSnapshot();
      if (isJson) {
        return { exitCode: 0, output: JSON.stringify(state, null, 2), data: state };
      }
      const out = [
        `Mediator Platform Status (v${state.coreVersion})`,
        `Protocol:            v${state.protocolVersion}`,
        `Workspace:           ${state.workspaceRoot ?? '(not set)'} [${state.workspaceConfirmed ? 'CONFIRMED' : 'UNCONFIRMED'}]`,
        `Selected Provider:   ${state.activeProviderId} (${state.activeMode})`,
        `Provider Loop:       ${state.loopStatus.toUpperCase()}`,
        `Local Autopilot:     ${state.autopilotStatus.toUpperCase()} (Can run: ${state.autopilotCanRun ? 'YES' : 'NO — ' + state.s00Decision})`,
        `Active Task:         ${state.activeTaskId ?? 'None'}`,
        `Pending Approvals:   ${state.pendingApprovals.length}`,
        `Staged Batches:      ${state.recentStages.length}`,
        `Core Uptime:         ${state.uptimeSeconds}s`,
      ].join('\n');
      return { exitCode: 0, output: out + '\n', data: state };
    }

    case 'doctor': {
      const diagService = new DoctorDiagnosticsService({ core });
      const report = await diagService.runDiagnostics();

      const exportIdx = args.indexOf('--export');
      if (exportIdx !== -1) {
        const targetArg = args[exportIdx + 1];
        const targetPath =
          typeof targetArg === 'string' && !targetArg.startsWith('-') ? targetArg : undefined;
        const exportRes = diagService.exportSanitizedReport({
          report,
          outputPath: targetPath,
          explicitUserExportRequested: true,
        });
        if (!exportRes.ok) {
          return { exitCode: 1, output: `Error exporting diagnostics: ${exportRes.error.message}\n` };
        }
        const outMsg = targetPath
          ? `Sanitized diagnostics exported successfully to: ${targetPath}\n`
          : exportRes.value + '\n';
        return { exitCode: 0, output: outMsg, data: report };
      }

      if (isJson) {
        return { exitCode: 0, output: JSON.stringify({ ok: true, ...report }, null, 2), data: report };
      }

      const lines = [
        `============================================================`,
        `  Mediator Diagnostic Health & Setup Doctor (v${report.mediatorVersion})`,
        `============================================================`,
        `Overall Status:    ${report.overallStatus}`,
        `Platform:          ${report.osPlatform} (${report.osRelease}) | Node: ${report.nodeVersion}`,
        `Protocol Version:  v${report.protocolVersion}`,
        `Autopilot Policy:  ${report.autopilotPolicy} (Review-only V1 enforced)`,
        ``,
        `System Verification Checks:`,
      ];

      for (const c of report.checks) {
        const badge = `[${c.status}]`.padEnd(19);
        lines.push(`  ${badge} ${c.name}`);
        lines.push(`      Detail: ${c.detail}`);
        if (c.remediation) {
          lines.push(`      Action: ${c.remediation}`);
        }
      }

      lines.push(``);
      lines.push(`Export report: mediator doctor --export [path]`);
      lines.push(`============================================================`);

      const exitCode = report.overallStatus === 'UNHEALTHY' ? 1 : 0;
      return { exitCode, output: lines.join('\n') + '\n', data: report };
    }


    case 'providers': {
      if (subCommand === 'select' && arg3) {
        const selRes = core.selectProvider(arg3);
        if (!selRes.ok) {
          return { exitCode: 1, output: `Error: ${selRes.error.message}\n` };
        }
        const data = { selectedProvider: selRes.value };
        return {
          exitCode: 0,
          output: isJson ? JSON.stringify(data, null, 2) : `Selected provider switched to: ${selRes.value}\n`,
          data,
        };
      }
      // list / status
      const providers = core.getProvidersSync();
      if (isJson) {
        return { exitCode: 0, output: JSON.stringify(providers, null, 2), data: providers };
      }
      const lines = ['Supported AI Providers:\n'];
      for (const p of providers) {
        const activeMarker = p.providerId === core.getActiveProviderId() ? ' [ACTIVE]' : '';
        lines.push(`  • ${p.displayName.padEnd(18)} (${p.providerId})${activeMarker}`);
        lines.push(`    Mode: ${p.activeMode} | Status: ${p.status} | Model: ${p.selectedModelId}`);
      }
      return { exitCode: 0, output: lines.join('\n') + '\n', data: providers };
    }

    case 'workspace': {
      if (subCommand === 'select' && arg3) {
        const wsRes = core.setWorkspaceRoot(arg3, hasConfirm);
        if (!wsRes.ok) {
          return { exitCode: 1, output: `Error: ${wsRes.error.message}\n` };
        }
        const data = { workspaceRoot: wsRes.value, confirmed: core.isWorkspaceConfirmed() };
        return {
          exitCode: 0,
          output: isJson ? JSON.stringify(data, null, 2) : `Workspace root set to: ${wsRes.value} (confirmed: ${core.isWorkspaceConfirmed()})\n`,
          data,
        };
      }
      const data = {
        workspaceRoot: core.getWorkspaceRoot(),
        confirmed: core.isWorkspaceConfirmed(),
      };
      if (isJson) {
        return { exitCode: 0, output: JSON.stringify(data, null, 2), data };
      }
      return {
        exitCode: 0,
        output: `Active Workspace: ${data.workspaceRoot ?? '(none)'}\nStatus: ${data.confirmed ? 'CONFIRMED' : 'UNCONFIRMED'}\n`,
        data,
      };
    }

    case 'task': {
      if (subCommand === 'create' && arg3) {
        const taskRes = core.createTask({ prompt: arg3 });
        if (!taskRes.ok) {
          return { exitCode: 1, output: `Error: ${taskRes.error.message}\n` };
        }
        const data = taskRes.value;
        return {
          exitCode: 0,
          output: isJson ? JSON.stringify(data, null, 2) : `Task created: ${data.id}\nStatus: ${data.status}\nPrompt: "${data.prompt}"\n`,
          data,
        };
      }
      if (subCommand === 'list') {
        const tasks = core.listTasks();
        if (isJson) {
          return { exitCode: 0, output: JSON.stringify(tasks, null, 2), data: tasks };
        }
        if (tasks.length === 0) {
          return { exitCode: 0, output: 'No tasks found.\n', data: [] };
        }
        const lines = ['Mediator Tasks:\n'];
        for (const t of tasks) {
          lines.push(`  • ${t.id} [${t.status.toUpperCase()}] round=${t.roundNumber} provider=${t.providerId}`);
          lines.push(`    "${t.prompt.slice(0, 70)}"`);
        }
        return { exitCode: 0, output: lines.join('\n') + '\n', data: tasks };
      }
      if (subCommand === 'status' && arg3) {
        const task = core.getTask(arg3);
        if (!task) {
          return { exitCode: 1, output: `Error: Task "${arg3}" not found.\n` };
        }
        return {
          exitCode: 0,
          output: isJson ? JSON.stringify(task, null, 2) : `Task: ${task.id}\nStatus: ${task.status.toUpperCase()}\nRound: ${task.roundNumber}\nPrompt: "${task.prompt}"\nStages: ${task.stages.length}\nApprovals: ${task.approvals.length}\n`,
          data: task,
        };
      }
      if (subCommand === 'pause' && arg3) {
        const res = core.pauseTask(arg3);
        if (!res.ok) return { exitCode: 1, output: `Error: ${res.error.message}\n` };
        return {
          exitCode: 0,
          output: isJson ? JSON.stringify(res.value, null, 2) : `Task ${arg3} paused.\n`,
          data: res.value,
        };
      }
      if (subCommand === 'resume' && arg3) {
        const res = core.resumeTask(arg3);
        if (!res.ok) return { exitCode: 1, output: `Error: ${res.error.message}\n` };
        return {
          exitCode: 0,
          output: isJson ? JSON.stringify(res.value, null, 2) : `Task ${arg3} resumed.\n`,
          data: res.value,
        };
      }
      if (subCommand === 'cancel' && arg3) {
        const res = core.cancelTask(arg3);
        if (!res.ok) return { exitCode: 1, output: `Error: ${res.error.message}\n` };
        return {
          exitCode: 0,
          output: isJson ? JSON.stringify(res.value, null, 2) : `Task ${arg3} cancelled.\n`,
          data: res.value,
        };
      }
      if (subCommand === 'validate' && arg3) {
        const taskId = arg3;
        const recipeId = (arg4 as RecipeId) ?? ('python.test' as RecipeId);
        const res = await core.validateTaskOffline(taskId, recipeId);
        if (!res.ok) return { exitCode: 1, output: `Error: ${res.error.message}\n` };
        return {
          exitCode: res.value.exitCode,
          output: isJson
            ? JSON.stringify(res.value, null, 2)
            : `Offline Validation [${recipeId}]: ${res.value.passed ? 'PASSED' : 'FAILED'} (Exit code: ${res.value.exitCode})\n` +
              (res.value.stdout ? `STDOUT:\n${res.value.stdout}\n` : '') +
              (res.value.stderr ? `STDERR:\n${res.value.stderr}\n` : ''),
          data: res.value,
        };
      }
      return {
        exitCode: 1,
        output: 'Usage: mediator task <create <prompt> | list | status <id> | pause <id> | resume <id> | cancel <id> | validate <id> [recipeId]>\n',
      };
    }

    case 'stage': {
      if (subCommand === 'list') {
        const stages = core.listStages();
        if (isJson) return { exitCode: 0, output: JSON.stringify(stages, null, 2), data: stages };
        if (stages.length === 0) return { exitCode: 0, output: 'No stages currently staged.\n', data: [] };
        const lines = ['Staged Batches:\n'];
        for (const s of stages) {
          lines.push(`  • ${s.id} (task: ${s.taskId}, file: ${s.filePath})`);
        }
        return { exitCode: 0, output: lines.join('\n') + '\n', data: stages };
      }
      if (subCommand === 'diff' && arg3) {
        const diff = core.getStageDiff(arg3);
        if (diff === null) return { exitCode: 1, output: `Error: Stage "${arg3}" not found.\n` };
        return { exitCode: 0, output: diff + '\n', data: { stageId: arg3, diff } };
      }
      if (subCommand === 'apply' && arg3 && arg4) {
        const stageId = arg3;
        const approvalId = arg4;
        const res = await core.applyApprovedStage(stageId, approvalId, 'trusted_cli');
        if (!res.ok) {
          return { exitCode: 1, output: `Error: ${res.error.message}\n` };
        }
        return {
          exitCode: 0,
          output: isJson
            ? JSON.stringify(res.value, null, 2)
            : `Stage ${stageId} applied successfully to live workspace.\n` +
              `Transaction ID: ${res.value.transactionId}\n` +
              `Backup Dir:     ${res.value.backupDir}\n` +
              `Applied Files:  ${res.value.appliedFiles.join(', ')}\n`,
          data: res.value,
        };
      }
      if (subCommand === 'propose' && arg3 && arg4 && cleanArgs[4]) {
        const taskId = arg3;
        const relativePath = arg4;
        const proposedContent = cleanArgs[4];
        const res = await core.stageProposal({ taskId, relativePath, proposedContent });
        if (!res.ok) return { exitCode: 1, output: `Error: ${res.error.message}\n` };
        return {
          exitCode: 0,
          output: isJson
            ? JSON.stringify(res.value, null, 2)
            : `Proposed change staged (stage: ${res.value.stageId}, approval: ${res.value.approvalId})\nDiff:\n${res.value.diffPreview}\n`,
          data: res.value,
        };
      }
      return { exitCode: 1, output: 'Usage: mediator stage <list | diff <id> | apply <stageId> <approvalId> | propose <taskId> <path> <content>>\n' };
    }

    case 'approval': {
      if (subCommand === 'list') {
        const approvals = core.listApprovals();
        if (isJson) return { exitCode: 0, output: JSON.stringify(approvals, null, 2), data: approvals };
        if (approvals.length === 0) return { exitCode: 0, output: 'No pending approvals.\n', data: [] };
        const lines = ['Approvals:\n'];
        for (const a of approvals) {
          lines.push(`  • ${a.id} [${a.status.toUpperCase()}] task: ${a.taskId} — ${a.description}`);
        }
        return { exitCode: 0, output: lines.join('\n') + '\n', data: approvals };
      }
      if (subCommand === 'resolve' && arg3 && arg4) {
        const approved = arg4.toLowerCase() === 'approve' || arg4.toLowerCase() === 'true';
        const res = core.resolveApproval(arg3, approved);
        if (!res.ok) return { exitCode: 1, output: `Error: ${res.error.message}\n` };
        return {
          exitCode: 0,
          output: isJson ? JSON.stringify(res.value, null, 2) : `Approval ${arg3} resolved: ${res.value.status}.\n`,
          data: res.value,
        };
      }
      return { exitCode: 1, output: 'Usage: mediator approval <list | resolve <id> <approve|reject>>\n' };
    }

    case 'loop': {
      if (subCommand === 'enable') {
        const res = core.toggleLoop(true);
        return {
          exitCode: 0,
          output: isJson ? JSON.stringify(res, null, 2) : 'Provider Conversation Loop: ENABLED\n',
          data: res,
        };
      }
      if (subCommand === 'disable') {
        const res = core.toggleLoop(false);
        return {
          exitCode: 0,
          output: isJson ? JSON.stringify(res, null, 2) : 'Provider Conversation Loop: DISABLED\n',
          data: res,
        };
      }
      const data = core.getLoopStatus();
      return {
        exitCode: 0,
        output: isJson ? JSON.stringify(data, null, 2) : `Provider Conversation Loop: ${data.loopStatus.toUpperCase()} (enabled: ${data.loopEnabled})\n`,
        data,
      };
    }

    case 'autopilot': {
      if (subCommand === 'enable') {
        const res = core.toggleAutopilot(true);
        const out = isJson
          ? JSON.stringify(res, null, 2)
          : `Local Autopilot Status: ${res.autopilotStatus.toUpperCase()}\nCan Run: ${res.canRun ? 'YES' : 'NO'}\n` +
            (res.blockingReasons.length > 0 ? `Blocking Reasons:\n  • ${res.blockingReasons.join('\n  • ')}\n` : '');
        return { exitCode: 0, output: out, data: res };
      }
      if (subCommand === 'disable') {
        const res = core.toggleAutopilot(false);
        return {
          exitCode: 0,
          output: isJson ? JSON.stringify(res, null, 2) : 'Local Autopilot: DISABLED (OFF)\n',
          data: res,
        };
      }
      const data = core.getAutopilotStatus();
      const out = isJson
        ? JSON.stringify(data, null, 2)
        : `Local Autopilot: ${data.autopilotStatus.toUpperCase()} (enabled: ${data.autopilotEnabled})\nCan Run: ${data.canRun ? 'YES' : 'NO'}\n` +
          (data.blockingReasons.length > 0 ? `Blocking Reasons:\n  • ${data.blockingReasons.join('\n  • ')}\n` : '');
      return { exitCode: 0, output: out, data };
    }

    case 'logs': {
      const logs = core.getAuditLogs();
      if (isJson) return { exitCode: 0, output: JSON.stringify(logs, null, 2), data: logs };
      if (logs.length === 0) return { exitCode: 0, output: 'No audit logs recorded.\n', data: [] };
      const lines = ['Mediator Audit Logs:\n'];
      for (const l of logs) {
        lines.push(`  [${new Date(l.timestamp).toLocaleTimeString()}] ${l.type.padEnd(20)} ${l.message}`);
      }
      return { exitCode: 0, output: lines.join('\n') + '\n', data: logs };
    }

    case 'config': {
      if (subCommand === 'show') {
        const state = core.getStateSnapshot();
        const conf = {
          version: state.coreVersion,
          protocolVersion: state.protocolVersion,
          s00Decision: state.s00Decision,
          workspaceRoot: state.workspaceRoot,
          workspaceConfirmed: state.workspaceConfirmed,
          activeProvider: state.activeProviderId,
          activeMode: state.activeMode,
          loopEnabled: state.loopEnabled,
          autopilotEnabled: state.autopilotEnabled,
        };
        return { exitCode: 0, output: JSON.stringify(conf, null, 2) + '\n', data: conf };
      }
      return { exitCode: 1, output: 'Usage: mediator config show [--json]\n' };
    }

    case 'serve':
    case 'ui': {
      const portIdx = cleanArgs.indexOf('--port');
      const portRaw = portIdx !== -1 ? cleanArgs[portIdx + 1] : undefined;
      const portArg = portRaw ? parseInt(portRaw, 10) : undefined;
      const port = portArg !== undefined && !isNaN(portArg) && portArg >= 0 ? portArg : 3300;
      const staticDir = path.resolve(__dirname, '..', '..', 'standalone-ui');

      const server = new MediatorHttpServer(core, {
        port,
        staticDir: fs.existsSync(staticDir) ? staticDir : undefined,
      });

      const addr = await server.start();
      const token = core.getPairingToken();

      const out = [
        `============================================================`,
        `  Mediator HTTP Server & Standalone UI Daemon`,
        `============================================================`,
        `API URL:         ${addr.url}`,
        `UI URL:          ${addr.url}/`,
        `Pairing Token:   ${token}`,
        `Workspace:       ${core.getWorkspaceRoot() ?? '(none)'}`,
        `Status:          READY (Loopback strictly enforced: 127.0.0.1)`,
        `============================================================`,
      ].join('\n');

      if (isJson) {
        return {
          exitCode: 0,
          output: JSON.stringify({ ok: true, url: addr.url, port: addr.port, token }, null, 2) + '\n',
          data: { url: addr.url, port: addr.port, token, server },
        };
      }

      if (!process.env.VITEST) {
        process.stdout.write(out + '\nPress Ctrl+C to terminate.\n');
        await new Promise<void>(() => {});
      }

      return { exitCode: 0, output: out + '\n', data: { url: addr.url, port: addr.port, token, server } };
    }

    case 'help':
    case '--help':
    case '-h':
    case undefined:
    default: {
      const help = `
Mediator CLI v${CLI_VERSION} (Protocol v${PROTOCOL_VERSION})
Unified Autonomous Coding Platform

Usage:
  mediator status [--json]
  mediator doctor [--json]
  mediator providers [status | select <provider>] [--json]
  mediator workspace [show | select <path>] [--confirm] [--json]
  mediator task create "<prompt>" [--json]
  mediator task list [--json]
  mediator task status <task-id> [--json]
  mediator task pause <task-id> [--json]
  mediator task resume <task-id> [--json]
  mediator task cancel <task-id> [--json]
  mediator stage list [--json]
  mediator stage diff <stage-id> [--json]
  mediator approval list [--json]
  mediator approval resolve <approval-id> <approve|reject> [--json]
  mediator loop [status | enable | disable] [--json]
  mediator autopilot [status | enable | disable] [--json]
  mediator logs [--json]
  mediator config show [--json]
  mediator version [--json]

Options:
  --json     Emit machine-readable JSON output
  --confirm  Explicitly confirm workspace root permissions
  -w <path>  Specify workspace root directory

Security:
  - Arbitrary shell commands are strictly prohibited.
  - Autopilot execution is gated fail-closed under S00 NO-GO-AUTOEXEC.
  - Live workspace modification requires explicit human approval.
`;
      return { exitCode: command === 'help' || command === '--help' || !command ? 0 : 1, output: help };
    }
  }
}

// Direct invocation
if (typeof process !== 'undefined' && process.argv && !process.env.VITEST) {
  const isDirect = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js') || process.argv[1]?.includes('mediator');
  if (isDirect) {
    void runCli(process.argv.slice(2)).then((res) => {
      process.stdout.write(res.output);
      process.exit(res.exitCode);
    });
  }
}
