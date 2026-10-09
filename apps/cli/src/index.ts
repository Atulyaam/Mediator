#!/usr/bin/env node
/**
 * Mediator CLI — start/stop/status/diagnostics
 *
 * Sprint S04 — Authoritative workspace-selection and canonicalization flow.
 *
 * IMPORTANT: This CLI does NOT run arbitrary shell commands.
 * start/stop change local state only in V1 Review-only mode.
 * No AI text is ever passed to a shell from this process.
 */

import { PROTOCOL_VERSION } from '@mediator/shared-contracts';
import {
  parseCliWorkspaceArg,
  inspectWorkspaceRoot,
  confirmWorkspaceRoot,
  checkWorkspacePermittedForFileOps,
  validateContainedPath,
  type WorkspaceRootState,
} from '@mediator/workspace-boundary';

const VERSION = '0.0.1';
const allArgs = process.argv.slice(2);
const command = allArgs[0];

// Parse --workspace / -w if provided
const parsedWsRes = parseCliWorkspaceArg(allArgs);
const cliWorkspacePath = parsedWsRes.ok ? parsedWsRes.value : null;
const hasConfirmFlag = allArgs.includes('--confirm');

// Parse --target / -t if provided
function parseTargetArg(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--target' || a === '-t') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) return next;
    }
    if (a?.startsWith('--target=')) {
      return a.slice('--target='.length);
    }
  }
  return null;
}
const targetArg = parseTargetArg(allArgs);

function printUsage(): void {
  process.stdout.write(`
Mediator CLI v${VERSION} (Protocol v${PROTOCOL_VERSION})
Mode: Review-only (V1) — no automatic command execution

Usage:
  mediator status [--workspace <path>] [--confirm]                     Show status & workspace details
  mediator workspace --workspace <path> [--confirm] [--target <file>]  Inspect root & check path containment
  mediator start [--workspace <path>] [--confirm]                      Start Mediator (local state only)
  mediator stop                                                        Stop Mediator
  mediator capabilities                                                Show detected capabilities and execution GO/NO-GO
  mediator version                                                     Show version information
  mediator help                                                        Show this message

Options:
  -w, --workspace <path>  Explicitly specify workspace directory
  -t, --target <path>     Validate a file path against workspace containment
  --confirm               Explicitly confirm the workspace root

Security note:
  Mediator never executes arbitrary AI-provided commands.
  All execution requires a proven, canary-verified executor.
  Unconfirmed workspaces block all project file operations.
  See docs/SANDBOX_CAPABILITIES.md and ADR-002.

`);
}

function getWorkspaceState(explicitPath: string | null): WorkspaceRootState | null {
  if (!explicitPath) return null;
  let ws = inspectWorkspaceRoot(explicitPath, 'cli');
  if (hasConfirmFlag && ws.resolutionStatus === 'resolved') {
    const confRes = confirmWorkspaceRoot(ws, true);
    if (confRes.ok) ws = confRes.value;
  }
  return ws;
}

function formatWorkspaceReport(ws: WorkspaceRootState | null): string {
  if (!ws) {
    return `Workspace: not selected (pass --workspace <path> or open project folder in IDE)`;
  }

  const lines = [
    `Workspace Inspection (CLI):`,
    `  Selected path:       ${ws.selectedPath}`,
    `  Canonical root:      ${ws.canonicalPath ?? '(unresolved)'}`,
    `  Resolution status:   ${ws.resolutionStatus.toUpperCase()}`,
    `  Confirmation status: ${ws.confirmationStatus.toUpperCase()}`,
    `  Storage type:        ${ws.cloudStatus === 'onedrive_redirected' ? 'OneDrive Redirected' : ws.cloudStatus}`,
  ];

  if (ws.confirmationStatus !== 'confirmed') {
    lines.push(
      `  [!] File ops blocked: requires explicit user confirmation. Use --confirm to confirm.`,
    );
  } else {
    lines.push(`  [✓] Workspace confirmed and permitted for operations.`);
  }

  return lines.join('\n');
}

function printStatus(): void {
  const ws = getWorkspaceState(cliWorkspacePath);

  process.stdout.write(`
Mediator v${VERSION}
Protocol: v${PROTOCOL_VERSION}
Mode: Review-only (V1)
Run state: stopped (core not yet connected — S19 sprint)
Execution GO/NO-GO: NO-GO-AUTOEXEC (Review-only, see ADR-002)

${formatWorkspaceReport(ws)}

Note: In V1, the CLI reports status. Full IPC to the core
      process will be wired in Sprint S19 (Native host + local IPC).

`);
}

function handleWorkspaceCommand(): void {
  if (!cliWorkspacePath) {
    process.stderr.write('Error: mediator workspace requires --workspace <path>\n\n');
    printUsage();
    process.exit(1);
  }

  const ws = getWorkspaceState(cliWorkspacePath);
  process.stdout.write(`\n${formatWorkspaceReport(ws)}\n\n`);

  if (!ws || ws.resolutionStatus !== 'resolved') {
    process.exit(1);
  }

  if (targetArg) {
    process.stdout.write(`Path Containment Check:\n  Target input:    ${targetArg}\n`);
    const valRes = validateContainedPath(ws, targetArg);
    if (!valRes.ok) {
      process.stdout.write(`  Containment:     DENIED\n  Error code:      ${valRes.error.code}\n  Reason:          ${valRes.error.message}\n\n`);
      process.exit(1);
    } else {
      process.stdout.write(`  Containment:     CONTAINED\n  Resolved path:   ${valRes.value.resolvedPath}\n  Relative path:   ${valRes.value.relativePath}\n  Exists on disk:  ${valRes.value.exists ? 'YES' : 'NO (new target)'}\n\n`);
    }
  }
}

function printCapabilities(): void {
  process.stdout.write(`
Mediator Capability Report
Version: ${VERSION}

  IDE Adapter:          available (when extension is loaded)
  Executor (auto-run):  DISABLED — Review-only mode (ADR-002)
  Browser Extension:    unknown — not yet deployed
  Native Host:          unknown — not yet registered (S19)
  MCP Server:           unavailable — not yet started (S16)

Execution decision: NO-GO-AUTOEXEC
  No documented programmatic API found for third-party tools to invoke
  the Antigravity terminal sandbox with a custom stage root and verified
  exit code. See docs/SANDBOX_CAPABILITIES.md.

  To enable execution, run the sandbox canary test and update
  docs/SANDBOX_CAPABILITIES.md. Then re-evaluate Sprint S21.

`);
}

function printVersion(): void {
  process.stdout.write(`mediator v${VERSION} (protocol v${PROTOCOL_VERSION})\n`);
}

switch (command) {
  case 'status':
    printStatus();
    break;
  case 'workspace':
    handleWorkspaceCommand();
    break;
  case 'start': {
    process.stdout.write('Mediator start requested.\n');
    process.stdout.write('Review-only mode: local state change only. No shell commands run.\n');

    const ws = getWorkspaceState(cliWorkspacePath);
    if (ws) {
      const permRes = checkWorkspacePermittedForFileOps(ws);
      if (!permRes.ok) {
        process.stdout.write(`Warning: ${permRes.error.message}\n`);
      } else {
        process.stdout.write(`Workspace confirmed: ${permRes.value}\n`);
      }
    } else {
      process.stdout.write('Note: No workspace specified via --workspace. IDE will supply workspace root.\n');
    }
    process.stdout.write('Start the IDE extension for the full UI experience.\n');
    break;
  }
  case 'stop':
    process.stdout.write('Mediator stop requested.\n');
    process.stdout.write('Local state cleared. No processes terminated (none were started).\n');
    break;
  case 'capabilities':
    printCapabilities();
    break;
  case 'version':
    printVersion();
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printUsage();
    break;
  default:
    process.stderr.write(`Unknown command: ${command}\n`);
    printUsage();
    process.exit(1);
}
