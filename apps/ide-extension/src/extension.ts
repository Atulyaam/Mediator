/**
 * Mediator IDE Extension — Entry Point
 *
 * Registers commands and status bar item.
 * start/stop commands change only local app state — they do NOT run shell commands.
 *
 * Exit gate requirement: "IDE panel reports accurate status and has no privileged execution path."
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
  createInitialState,
  withRunState,
  withWorkspace,
  withWorkspaceState,
  withNewTaskSession,
  getStatusBarText,
  getStatusBarTooltip,
  type MediatorLocalState,
} from './mediatorState.js';
import { confirmWorkspaceRoot, selectFromIdeFolders } from '@mediator/workspace-boundary';
import { MediatorPanel } from './panel.js';

// ─── Extension state (local only) ─────────────────────────────────────────

let _state: MediatorLocalState;
let _statusBar: vscode.StatusBarItem;

// ─── Activation ────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = detectWorkspaceRoot();

  _state = createInitialState(workspaceRoot);

  // Status bar — always visible, low priority (right side)
  _statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  _statusBar.command = 'mediator.showPanel';
  _statusBar.tooltip = 'Click to open Mediator Status Panel';
  updateStatusBar();
  _statusBar.show();
  context.subscriptions.push(_statusBar);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('mediator.start', () => cmdStart(context)),
    vscode.commands.registerCommand('mediator.stop', () => cmdStop()),
    vscode.commands.registerCommand('mediator.showPanel', () =>
      MediatorPanel.createOrShow(_state, context.extensionUri),
    ),
    vscode.commands.registerCommand('mediator.showCapabilities', () =>
      cmdShowCapabilities(),
    ),
  );

  // Watch for workspace root changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const newRoot = detectWorkspaceRoot();
      _state = withWorkspace(_state, newRoot, false);
      updateStatusBar();
    }),
  );

  logInfo('Mediator extension activated. Run state: stopped. Mode: Review-only (v1).');
}

export function deactivate(): void {
  logInfo('Mediator extension deactivated.');
}

// ─── Commands ──────────────────────────────────────────────────────────────

async function cmdStart(context: vscode.ExtensionContext): Promise<void> {
  if (_state.runState === 'running' || _state.runState === 'starting') {
    void vscode.window.showInformationMessage('Mediator is already running.');
    return;
  }

  // Guard: workspace must exist
  if (!_state.workspaceRoot) {
    void vscode.window.showErrorMessage(
      'Mediator: No workspace folder is open. Open a project folder first.',
    );
    return;
  }

  // First start: confirm canonical workspace root
  if (!_state.workspaceConfirmed) {
    const selected = _state.workspace?.selectedPath ?? _state.workspaceRoot;
    const canonical = _state.workspace?.canonicalPath ?? _state.workspaceRoot;
    const isRedirected = _state.workspace?.cloudStatus === 'onedrive_redirected';

    let promptMsg = `Mediator requires confirmation for the workspace root:\n\nSelected path: ${selected}\nCanonical root: ${canonical}`;
    if (isRedirected) {
      promptMsg += `\n(Storage: OneDrive redirected folder)`;
    }
    promptMsg += `\n\nIs this correct?`;

    const confirmation = await vscode.window.showInformationMessage(
      promptMsg,
      { modal: true },
      'Confirm',
      'Deny',
    );
    if (confirmation !== 'Confirm') {
      if (confirmation === 'Deny' && _state.workspace) {
        const denied = confirmWorkspaceRoot(_state.workspace, false);
        if (denied.ok) {
          _state = withWorkspaceState(_state, denied.value);
          updateStatusBar();
        }
      }
      void vscode.window.showWarningMessage(
        'Mediator: Workspace confirmation was denied or cancelled. Project file operations will remain blocked.',
      );
      return;
    }
    _state = withWorkspace(_state, _state.workspaceRoot, true);
  }

  // Transition: stopped → starting
  _state = withRunState(_state, 'starting');
  updateStatusBar();

  // NOTE: This does NOT start a shell process.
  // It transitions local state and creates a task session placeholder.
  // The actual Mediator core (CLI process) must be started separately.
  // In v1, this is Review-only — no core process is required for the panel.
  const taskId = `task-${crypto.randomUUID().slice(0, 8)}`;
  const sessionId = `session-${crypto.randomUUID().slice(0, 8)}`;
  const correlationId = `corr-${crypto.randomUUID().slice(0, 8)}`;

  _state = withNewTaskSession(_state, taskId, sessionId, correlationId);
  _state = withRunState(_state, 'running');
  updateStatusBar();

  // Open panel to show the running state
  MediatorPanel.createOrShow(_state, context.extensionUri);

  logInfo(`Mediator started. Task: ${taskId}. Mode: Review-only.`);
  void vscode.window.showInformationMessage(
    'Mediator started (Review-only mode). Attach a browser conversation to begin.',
  );
}

function cmdStop(): void {
  if (_state.runState === 'stopped' || _state.runState === 'stopping') {
    void vscode.window.showInformationMessage('Mediator is already stopped.');
    return;
  }

  // Transition: running → stopping → stopped
  _state = withRunState(_state, 'stopping');
  updateStatusBar();

  // NOTE: No shell process to kill — this is local state only in v1.
  // When the core process is wired in (S19+), this will also send a stop signal.
  _state = { ..._state, runState: 'stopped', taskSession: null };
  updateStatusBar();

  logInfo('Mediator stopped.');
  void vscode.window.showInformationMessage('Mediator stopped.');
}

function cmdShowCapabilities(): void {
  const cap = _state.capabilities;
  const lines = [
    `Mediator v${_state.version} — Capability Report`,
    `Mode: Review-only (V1, ADR-002)`,
    ``,
    `IDE Adapter:       ${cap.ideAdapter}`,
    `Executor:          ${cap.executor}`,
    `Browser Extension: ${cap.browserExtension}`,
    `Native Host:       ${cap.nativeHost}`,
    `MCP Server:        ${cap.mcpServer}`,
    ``,
    `Executor is DISABLED in Review-only mode.`,
    `See docs/SANDBOX_CAPABILITIES.md for the canary design.`,
    `Automatic execution requires a proven, canary-verified sandbox.`,
  ];

  void vscode.window.showInformationMessage(lines.join('\n'));
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function detectWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const paths = folders.map((f) => f.uri.fsPath);
  const selection = selectFromIdeFolders(paths);
  if (selection.ok) {
    return selection.value;
  }
  logInfo(`Multi-root workspace note: ${selection.error.message}`);
  const first = folders[0];
  if (!first) return null;
  return first.uri.fsPath;
}

function updateStatusBar(): void {
  _statusBar.text = getStatusBarText(_state);
  _statusBar.tooltip = getStatusBarTooltip(_state);

  // Color coding: error = red, running = green, else default
  if (_state.runState === 'error') {
    _statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (_state.runState === 'running') {
    _statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.activeBackground');
  } else {
    _statusBar.backgroundColor = undefined;
  }
}

function logInfo(message: string): void {
  // Structured log — module name, no secrets, no raw conversation content
  // eslint-disable-next-line no-console
  console.warn(`[mediator][ide-extension] ${message}`);
}
