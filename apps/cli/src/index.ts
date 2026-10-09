#!/usr/bin/env node
/**
 * Mediator CLI — start/stop/status/diagnostics
 *
 * IMPORTANT: This CLI does NOT run arbitrary shell commands.
 * start/stop change local state only in V1 Review-only mode.
 * No AI text is ever passed to a shell from this process.
 */

import { PROTOCOL_VERSION } from '@mediator/shared-contracts';

const VERSION = '0.0.1';
const args = process.argv.slice(2);
const command = args[0];

function printUsage(): void {
  process.stdout.write(`
Mediator CLI v${VERSION} (Protocol v${PROTOCOL_VERSION})
Mode: Review-only (V1) — no automatic command execution

Usage:
  mediator status       Show current Mediator status
  mediator start        Start Mediator (Review-only mode — local state only)
  mediator stop         Stop Mediator
  mediator capabilities Show detected capabilities and execution GO/NO-GO
  mediator version      Show version information
  mediator help         Show this message

Security note:
  Mediator never executes arbitrary AI-provided commands.
  All execution requires a proven, canary-verified executor.
  See docs/SANDBOX_CAPABILITIES.md and ADR-002.

`);
}

function printStatus(): void {
  process.stdout.write(`
Mediator v${VERSION}
Protocol: v${PROTOCOL_VERSION}
Mode: Review-only (V1)
Run state: stopped (core not yet connected — S19 sprint)
Execution GO/NO-GO: NO-GO-AUTOEXEC (Review-only, see ADR-002)
Workspace: determined by IDE workspace root at runtime

Note: In V1, the CLI reports status. Full IPC to the core
      process will be wired in Sprint S19 (Native host + local IPC).

`);
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
  case 'start':
    process.stdout.write('Mediator start requested.\n');
    process.stdout.write('Review-only mode: local state change only. No shell commands run.\n');
    process.stdout.write('Start the IDE extension for the full UI experience.\n');
    break;
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
