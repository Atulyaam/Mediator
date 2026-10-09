/**
 * Mediator Status WebView Panel
 *
 * Shows: run state, workspace, task state, capabilities.
 * NO privileged execution. Read-only display of local state.
 */

import * as vscode from 'vscode';
import {
  type MediatorLocalState,
  formatCapabilityStatus,
} from './mediatorState.js';

export class MediatorPanel {
  private static _instance: MediatorPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private _state: MediatorLocalState,
  ) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._update();
  }

  static createOrShow(state: MediatorLocalState, extensionUri: vscode.Uri): MediatorPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (MediatorPanel._instance) {
      MediatorPanel._instance._panel.reveal(column);
      MediatorPanel._instance.update(state);
      return MediatorPanel._instance;
    }

    const panel = vscode.window.createWebviewPanel(
      'mediatorStatus',
      'Mediator Status',
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    MediatorPanel._instance = new MediatorPanel(panel, state);
    return MediatorPanel._instance;
  }

  update(state: MediatorLocalState): void {
    this._state = state;
    this._update();
  }

  private _update(): void {
    this._panel.title = `Mediator — ${this._state.runState}`;
    this._panel.webview.html = this._getHtml();
  }

  private _getHtml(): string {
    const s = this._state;
    const caps = s.capabilities;

    const statusColor = {
      stopped: '#6b7280',
      starting: '#f59e0b',
      running: '#10b981',
      stopping: '#f59e0b',
      error: '#ef4444',
    }[s.runState];

    const taskHtml = s.taskSession
      ? `
        <div class="card">
          <h2>Active Task</h2>
          <table>
            <tr><td>Task ID</td><td><code>${esc(s.taskSession.taskId)}</code></td></tr>
            <tr><td>Session ID</td><td><code>${esc(s.taskSession.sessionId)}</code></td></tr>
            <tr><td>State</td><td><span class="state">${esc(s.taskSession.state)}</span></td></tr>
            <tr><td>Round</td><td>${s.taskSession.roundCount} / ${s.taskSession.maxRounds}</td></tr>
          </table>
        </div>`
      : `<div class="card muted"><p>No active task. Start Mediator and attach a conversation to begin.</p></div>`;

    const errorHtml = s.errorMessage
      ? `<div class="card error"><strong>Error:</strong> ${esc(s.errorMessage)}</div>`
      : '';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>Mediator Status</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-sideBar-background, #1e1e1e);
      --border: var(--vscode-panel-border, #333);
      --accent: #7c3aed;
      --muted: var(--vscode-descriptionForeground, #888);
      --code-bg: var(--vscode-textCodeBlock-background, #252526);
      --error-bg: #3b0a0a;
      --error-fg: #fca5a5;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--bg);
      color: var(--fg);
      padding: 20px;
      line-height: 1.6;
    }
    header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .status-dot {
      width: 12px; height: 12px;
      border-radius: 50%;
      background: ${statusColor};
      flex-shrink: 0;
      box-shadow: 0 0 6px ${statusColor}88;
    }
    h1 { font-size: 1.2em; font-weight: 600; }
    .run-state { font-size: 0.85em; color: var(--muted); margin-top: 2px; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .card h2 { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 10px; }
    .card.muted p { color: var(--muted); font-style: italic; }
    .card.error { background: var(--error-bg); border-color: #7f1d1d; color: var(--error-fg); }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 4px 8px 4px 0; vertical-align: top; }
    td:first-child { color: var(--muted); width: 130px; white-space: nowrap; }
    code { background: var(--code-bg); padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
    .state { font-family: monospace; font-size: 0.9em; color: #a78bfa; }
    .cap { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid var(--border); }
    .cap:last-child { border-bottom: none; }
    .cap-name { color: var(--muted); }
    .cap-val { font-size: 0.85em; }
    .cap-val.ok { color: #10b981; }
    .cap-val.no { color: #6b7280; }
    .cap-val.dis { color: #f59e0b; }
    .mode-badge {
      display: inline-block;
      background: #1e1b4b;
      color: #a5b4fc;
      border: 1px solid #4338ca;
      border-radius: 4px;
      padding: 2px 10px;
      font-size: 0.8em;
      font-weight: 600;
      letter-spacing: 0.05em;
    }
    footer { color: var(--muted); font-size: 0.75em; margin-top: 24px; text-align: center; }
  </style>
</head>
<body>
  <header>
    <div class="status-dot"></div>
    <div>
      <h1>Mediator</h1>
      <div class="run-state">${esc(s.runState.toUpperCase())} &nbsp;·&nbsp; v${esc(s.version)} &nbsp;·&nbsp; <span class="mode-badge">REVIEW-ONLY</span></div>
    </div>
  </header>

  ${errorHtml}

  <div class="card">
    <h2>Workspace</h2>
    <table>
      <tr>
        <td>Selected Path</td>
        <td>${s.workspace?.selectedPath ? `<code>${esc(s.workspace.selectedPath)}</code>` : (s.workspaceRoot ? `<code>${esc(s.workspaceRoot)}</code>` : '<span style="color:var(--muted)">Not selected</span>')}</td>
      </tr>
      <tr>
        <td>Canonical Root</td>
        <td>${s.workspace?.canonicalPath ? `<code>${esc(s.workspace.canonicalPath)}</code>` : (s.workspace?.resolutionStatus === 'missing' ? '<span style="color:#ef4444">Missing / Not found</span>' : '<span style="color:var(--muted)">Unresolved</span>')}</td>
      </tr>
      <tr>
        <td>Confirmation</td>
        <td>${
          s.workspace?.confirmationStatus === 'confirmed' || (s.workspaceConfirmed && !s.workspace)
            ? '<span style="color:#10b981">✓ Confirmed</span>'
            : s.workspace?.confirmationStatus === 'denied'
              ? '<span style="color:#ef4444">✗ Denied</span>'
              : '<span style="color:#f59e0b">⚠ Awaiting confirmation</span>'
        }</td>
      </tr>
      <tr>
        <td>Storage Type</td>
        <td>${
          s.workspace?.cloudStatus === 'onedrive_redirected'
            ? '<span style="color:#60a5fa">OneDrive Redirected</span>'
            : s.workspace?.cloudStatus === 'cloud_placeholder'
              ? '<span style="color:#f59e0b">Cloud Placeholder</span>'
              : s.workspace?.cloudStatus === 'not_cloud'
                ? '<span>Local Storage</span>'
                : '<span style="color:var(--muted)">Unknown</span>'
        }</td>
      </tr>
      <tr>
        <td>Resolution</td>
        <td>${
          s.workspace?.resolutionStatus === 'resolved'
            ? '<span style="color:#10b981">Resolved</span>'
            : s.workspace?.resolutionStatus === 'missing'
              ? '<span style="color:#ef4444">Missing</span>'
              : s.workspace?.resolutionStatus === 'unavailable'
                ? '<span style="color:#ef4444">Inaccessible</span>'
                : '<span style="color:var(--muted)">Unresolved</span>'
        }</td>
      </tr>
    </table>
  </div>

  ${taskHtml}

  <div class="card">
    <h2>Detected Capabilities</h2>
    ${capRow('IDE Adapter', caps.ideAdapter)}
    ${capRow('Executor (auto-run)', caps.executor)}
    ${capRow('Browser Extension', caps.browserExtension)}
    ${capRow('Native Host', caps.nativeHost)}
    ${capRow('MCP Server', caps.mcpServer)}
  </div>

  <div class="card">
    <h2>Execution Mode</h2>
    <p>
      <strong>Review-only (v1)</strong> — Changes are staged in a shadow copy.
      You review the diff and approve before anything is applied to your project.
      Automatic command execution is disabled until a verified executor sandbox is proven.
      See <code>docs/SANDBOX_CAPABILITIES.md</code> and <code>ADR-002</code>.
    </p>
  </div>

  <footer>Mediator v${esc(s.version)} · Local-first · No telemetry</footer>
</body>
</html>`;
  }

  dispose(): void {
    MediatorPanel._instance = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function capRow(label: string, status: import('./mediatorState.js').CapabilityStatus): string {
  const cls = status === 'available' ? 'ok' : status === 'disabled' ? 'dis' : 'no';
  const text = formatCapabilityStatus(status);
  return `<div class="cap"><span class="cap-name">${label}</span><span class="cap-val ${cls}">${text}</span></div>`;
}
