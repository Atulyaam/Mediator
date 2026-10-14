/**
 * Mediator Status WebView Panel
 *
 * Shows: run state, workspace, task state, capabilities.
 * NO privileged execution. Read-only display of local state.
 */

import * as vscode from 'vscode';
import {
  type MediatorLocalState,
  type CapabilityStatus,
  type ProviderSelectionState,
  formatCapabilityStatus,
} from './mediatorState.js';
import { type ReviewPanelState } from './diffPanelController.js';
import { type HandoffPanelState } from './handoffPanelController.js';

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

  ${this._renderReviewState(s.reviewState)}

  ${this._renderHandoffState(s.handoffState)}

  ${this._renderMultiProviderSettings(s.providerState)}

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

  ${this._renderRecipesState()}
  ${this._renderRecoveryAndBudgetState()}
  ${this._renderAutopilotGateState()}

  <div class="card" style="background:linear-gradient(135deg, #1e293b, #0f172a); border: 1px solid #38bdf8;">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <div>
        <h2 style="margin:0 0 4px 0; color:#38bdf8;">Standalone Mediator UI</h2>
        <p style="margin:0; font-size:0.85em; color:#94a3b8;">
          Full visual dashboard, provider conversation loop, shadow staging diffs, and live audit telemetry.
        </p>
      </div>
      <a href="http://127.0.0.1:41234" target="_blank" style="background:linear-gradient(135deg, #06b6d4, #38bdf8); color:#020617; padding:8px 16px; border-radius:6px; font-weight:bold; text-decoration:none; display:inline-block;">
        Launch UI ↗
      </a>
    </div>
  </div>

  <footer>Mediator v${esc(s.version)} · Local-first · No telemetry</footer>
</body>
</html>`;
  }

  private _renderReviewState(reviewState: ReviewPanelState | null): string {
    if (!reviewState) {
      return '';
    }

    const approval = reviewState.activeApproval;
    let approvalHtml = '';
    if (approval) {
      const expiresSec = Math.max(0, Math.round((approval.expiresAt - Date.now()) / 1000));
      const expiryText = approval.status === 'pending'
        ? `<span style="color:#f59e0b; font-size:0.85em; margin-left:8px;">(Expires in ${expiresSec}s)</span>`
        : '';
      approvalHtml = `
        <div style="background:#1e1b4b; border:1px solid #4338ca; border-radius:4px; padding:10px; margin-bottom:12px;">
          <strong>Approval Request:</strong> <code>${esc(approval.approvalId)}</code> &nbsp;·&nbsp;
          Status: <span style="color:#38bdf8">${esc(approval.status.toUpperCase())}</span>
          ${expiryText}
        </div>
      `;
    }

    const itemsHtml = reviewState.items.map((item) => {
      const protectedTag = item.isProtected ? '<span style="color:#f59e0b; margin-left:6px; font-size:0.8em;">[PROTECTED]</span>' : '';
      const destructiveTag = item.isDestructive ? '<span style="color:#ec4899; margin-left:6px; font-size:0.8em;">[DESTRUCTIVE]</span>' : '';
      const conflictHtml = item.conflictStatus !== 'clean' ? `
        <div style="padding:6px 12px; background:#450a0a; color:#fca5a5; font-size:0.85em;">
          <strong>Conflict:</strong> ${esc(item.conflictReason ?? item.conflictStatus)}
        </div>
      ` : '';
      const diffHtml = item.diff.diffText ? `
        <pre style="margin:0; padding:10px; font-size:0.85em; overflow-x:auto; max-height:200px; color:#e2e8f0;"><code>${esc(item.diff.diffText)}</code></pre>
      ` : `<div style="padding:8px 12px; color:var(--muted); font-size:0.85em;">No text diff available (metadata proposal or binary content)</div>`;

      return `
        <div style="border:1px solid var(--border); border-radius:4px; margin-bottom:10px; background:var(--code-bg); overflow:hidden;">
          <div style="padding:8px 12px; background:var(--card-bg); display:flex; justify-content:space-between; align-items:center;">
            <div>
              <strong>${esc(item.relativePath)}</strong>
              ${protectedTag}
              ${destructiveTag}
            </div>
            <div style="font-size:0.85em; color:var(--muted);">
              <span style="color:#10b981;">+${item.diff.stats.additions}</span> /
              <span style="color:#ef4444;">-${item.diff.stats.deletions}</span>
              &nbsp;·&nbsp; <code>${esc(item.changeType)}</code>
            </div>
          </div>
          ${conflictHtml}
          ${diffHtml}
        </div>
      `;
    }).join('');

    return `
      <div class="card">
        <h2>Staged Changes & Diff Preview</h2>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <div>
            Stage: <code>${esc(reviewState.stageId)}</code> &nbsp;·&nbsp;
            Status: <strong style="color:#a78bfa">${esc(reviewState.status.toUpperCase())}</strong>
          </div>
          <div>
            ${reviewState.conflictsCount > 0 ? `<span style="background:#7f1d1d; color:#fca5a5; padding:2px 8px; border-radius:4px; font-size:0.8em; margin-right:4px;">⚠ ${reviewState.conflictsCount} CONFLICTS</span>` : ''}
            ${reviewState.protectedCount > 0 ? `<span style="background:#78350f; color:#fcd34d; padding:2px 8px; border-radius:4px; font-size:0.8em; margin-right:4px;">🛡 ${reviewState.protectedCount} PROTECTED</span>` : ''}
            ${reviewState.destructiveCount > 0 ? `<span style="background:#831843; color:#fbcfe8; padding:2px 8px; border-radius:4px; font-size:0.8em;">⚡ ${reviewState.destructiveCount} DESTRUCTIVE</span>` : ''}
          </div>
        </div>

        ${approvalHtml}
        ${itemsHtml}

        <div style="margin-top:14px; display:flex; gap:8px;">
          <button style="background:#059669; color:#fff; border:none; padding:6px 14px; border-radius:4px; cursor:pointer;" onclick="vscode.postMessage({command:'approve'})">Approve Once</button>
          <button style="background:#dc2626; color:#fff; border:none; padding:6px 14px; border-radius:4px; cursor:pointer;" onclick="vscode.postMessage({command:'deny'})">Deny</button>
          <button style="background:#4b5563; color:#fff; border:none; padding:6px 14px; border-radius:4px; cursor:pointer;" onclick="vscode.postMessage({command:'pause'})">Pause</button>
          <button style="background:#374151; color:#fff; border:none; padding:6px 14px; border-radius:4px; cursor:pointer;" onclick="vscode.postMessage({command:'stop'})">Stop</button>
        </div>
      </div>
    `;
  }

  private _renderHandoffState(handoffState: HandoffPanelState | null): string {
    if (!handoffState) {
      return `
        <div class="card">
          <h2>IDE Agent Handoff (Pull-based)</h2>
          <p style="color:var(--muted); font-size:0.9em;">
            No active handoff prepared. Mediator uses a manual, pull-based workflow: prepare bounded instructions, copy them to your IDE agent, and ingest the agent's reported results.
          </p>
          <button style="background:#2563eb; color:#fff; border:none; padding:6px 14px; border-radius:4px; cursor:pointer;" onclick="vscode.postMessage({command:'prepareHandoff'})">Prepare IDE Agent Handoff</button>
        </div>
      `;
    }

    const h = handoffState.currentHandoff;
    if (!h) {
      return `
        <div class="card">
          <h2>IDE Agent Handoff (Pull-based)</h2>
          <p style="color:var(--muted); font-size:0.9em;">${esc(handoffState.statusMessage ?? '')}</p>
          <button style="background:#2563eb; color:#fff; border:none; padding:6px 14px; border-radius:4px; cursor:pointer;" onclick="vscode.postMessage({command:'prepareHandoff'})">Prepare IDE Agent Handoff</button>
        </div>
      `;
    }

    const expiresSec = Math.max(0, Math.round((h.expiresAt - Date.now()) / 1000));
    const statusColor: Record<string, string> = {
      prepared: '#38bdf8',
      'waiting-for-agent': '#f59e0b',
      'report-received': '#10b981',
      'review-required': '#ec4899',
      cancelled: '#6b7280',
      expired: '#ef4444',
      rejected: '#ef4444',
    };
    const color = statusColor[h.status] ?? '#9ca3af';

    let promptPreviewHtml = '';
    if (handoffState.promptText) {
      promptPreviewHtml = `
        <div style="margin:10px 0;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <label style="font-weight:600; font-size:0.85em;">Bounded Handoff Prompt:</label>
            <span style="font-size:0.8em; color:var(--muted);">Hash: <code>${esc(h.promptHash.slice(0, 12))}...</code></span>
          </div>
          <pre style="margin:0; padding:10px; font-size:0.82em; background:var(--code-bg); max-height:160px; overflow-y:auto; border-radius:4px; border:1px solid var(--border);"><code>${esc(handoffState.promptText)}</code></pre>
        </div>
      `;
    }

    let pendingReviewsHtml = '';
    if (handoffState.pendingReviewRequests.length > 0) {
      const items = handoffState.pendingReviewRequests.map((req) => `
        <div style="background:#1e1b4b; border:1px solid #4338ca; border-radius:4px; padding:8px 12px; margin-bottom:8px;">
          <div style="display:flex; justify-content:space-between;">
            <strong>Request:</strong> <code>${esc(req.requestId)}</code>
            <span style="color:#f59e0b; font-size:0.85em;">PENDING REVIEW ONLY</span>
          </div>
          <div style="font-size:0.85em; color:var(--muted); margin:4px 0;">
            Scope: <code>${esc(req.requestedScope.join(', ') || 'workspace')}</code> · Origin: <code>${esc(req.origin)}</code>
          </div>
          <div style="display:flex; gap:6px; margin-top:6px;">
            <button style="background:#059669; color:#fff; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:0.8em;" onclick="vscode.postMessage({command:'resolveReviewRequest', requestId:'${esc(req.requestId)}', decision:'approved'})">Approve (Local UI)</button>
            <button style="background:#dc2626; color:#fff; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:0.8em;" onclick="vscode.postMessage({command:'resolveReviewRequest', requestId:'${esc(req.requestId)}', decision:'rejected'})">Reject</button>
          </div>
        </div>
      `).join('');

      pendingReviewsHtml = `
        <div style="margin:12px 0;">
          <h3 style="font-size:0.95em; margin-bottom:6px;">Pending Review Requests (${handoffState.pendingReviewRequests.length})</h3>
          ${items}
        </div>
      `;
    }

    let ingestStatusHtml = '';
    if (handoffState.lastIngestResult) {
      const res = handoffState.lastIngestResult;
      const discBadge = res.discrepancies.length > 0
        ? `<span style="color:#f59e0b;">(${res.discrepancies.length} path discrepancies detected)</span>`
        : '<span style="color:#10b981;">(Paths match staged changes)</span>';
      ingestStatusHtml = `
        <div style="padding:6px 10px; background:#064e3b; border-radius:4px; font-size:0.85em; margin:8px 0;">
          ✓ Report ingested successfully. Provenance: <strong>agent-reported</strong> (untrusted). ${discBadge}
        </div>
      `;
    } else if (handoffState.lastIngestError) {
      ingestStatusHtml = `
        <div style="padding:6px 10px; background:#450a0a; color:#fca5a5; border-radius:4px; font-size:0.85em; margin:8px 0;">
          ✕ ${esc(handoffState.lastIngestError)}
        </div>
      `;
    }

    return `
      <div class="card">
        <h2>IDE Agent Handoff (Pull-based)</h2>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <div>
            Handoff: <code>${esc(h.handoffId)}</code> &nbsp;·&nbsp;
            Status: <strong style="color:${color}">${esc(h.status.toUpperCase())}</strong>
          </div>
          <div style="font-size:0.85em; color:var(--muted);">
            Expires in ${expiresSec}s
          </div>
        </div>

        <div style="font-size:0.85em; color:var(--muted); margin-bottom:8px;">
          Task: <code>${esc(h.taskId)}</code> · Session: <code>${esc(h.sessionId)}</code> · Schema: <code>v${esc(h.expectedReportSchemaVersion)}</code>
        </div>

        <div style="padding:6px 10px; background:#1e293b; border-radius:4px; font-size:0.8em; color:#94a3b8; margin-bottom:10px;">
          ℹ <strong>Pull-based workflow:</strong> Mediator never automatically sends data to external agents. Copy prompt to your agent, then paste the report below.
        </div>

        ${promptPreviewHtml}
        ${ingestStatusHtml}
        ${pendingReviewsHtml}

        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
          <button style="background:#2563eb; color:#fff; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;" onclick="vscode.postMessage({command:'copyPrompt'})">Copy Handoff Prompt</button>
          <button style="background:#d97706; color:#fff; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;" onclick="vscode.postMessage({command:'markWaiting'})">Waiting for IDE Agent</button>
          <button style="background:#059669; color:#fff; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;" onclick="vscode.postMessage({command:'pasteReport'})">Paste/Ingest Report</button>
          <button style="background:#dc2626; color:#fff; border:none; padding:6px 12px; border-radius:4px; cursor:pointer;" onclick="vscode.postMessage({command:'cancelHandoff'})">Cancel Handoff</button>
        </div>
      </div>
    `;
  }

  private _renderRecipesState(): string {
    const recipes = [
      { id: 'project.test', cmd: 'npm test', desc: 'Execute project test suite against isolated stage', status: 'manual-only', hash: '5b8b9...' },
      { id: 'project.lint', cmd: 'npm run lint', desc: 'Execute ESLint checks across project files', status: 'manual-only', hash: '8f2a1...' },
      { id: 'project.typecheck', cmd: 'npm run typecheck', desc: 'Perform static type analysis with TypeScript compiler', status: 'manual-only', hash: '7c4e2...' },
      { id: 'project.build', cmd: 'npm run build', desc: 'Compile project artifacts using npm run build', status: 'manual-only', hash: '2d9c0...' },
      { id: 'project.single_test', cmd: 'npm test -- <path>', desc: 'Execute single test file with strict path containment', status: 'manual-only', hash: '3e1f7...' },
      { id: 'git.status', cmd: 'git status --short', desc: 'Inspect working copy modifications safely', status: 'manual-only', hash: '1b4d8...' },
      { id: 'git.diff', cmd: 'git diff', desc: 'Inspect unstaged diffs safely', status: 'manual-only', hash: '6a0f3...' },
    ];

    const rows = recipes.map((r) => `
      <div style="border-bottom:1px solid var(--border); padding:8px 0;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <strong><code>${esc(r.id)}</code></strong> &nbsp;
            <span style="font-size:0.8em; color:#f59e0b; background:#451a03; padding:2px 6px; border-radius:3px;">${esc(r.status.toUpperCase())}</span>
          </div>
          <span style="font-size:0.8em; color:var(--muted);">Hash: <code>${esc(r.hash)}</code></span>
        </div>
        <p style="font-size:0.85em; color:var(--muted); margin:4px 0;">${esc(r.desc)}</p>
        <div style="display:flex; justify-content:space-between; align-items:center; background:var(--code-bg); padding:4px 8px; border-radius:3px; margin-top:4px;">
          <code style="font-size:0.85em;">${esc(r.cmd)}</code>
          <button style="background:#2563eb; color:#fff; border:none; padding:2px 8px; border-radius:3px; cursor:pointer; font-size:0.75em;" onclick="navigator.clipboard.writeText('${esc(r.cmd)}')">Copy</button>
        </div>
      </div>
    `).join('');

    return `
      <div class="card">
        <h2>Approved Recipes & Safe Manual Instructions</h2>
        <div style="padding:6px 10px; background:#1e293b; border-radius:4px; font-size:0.85em; color:#94a3b8; margin-bottom:10px;">
          ⚠ <strong>Manual Execution Only — Not Run or Verified by Mediator</strong><br>
          Under S00 decision <code>NO-GO-AUTOEXEC</code>, automatic command execution is disabled. You may copy the verified recipe commands below and run them manually in your IDE terminal.
        </div>
        ${rows}
      </div>
    `;
  }

  private _renderRecoveryAndBudgetState(): string {
    return `
      <div class="card">
        <h2>Crash Recovery, Loop Guard & Observability (S25)</h2>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div>
            Recovery Status: <strong style="color:#10b981;">CLEAN / RECOVERED</strong>
          </div>
          <span style="font-size:0.8em; color:var(--muted);">Loop Guard: <strong>ACTIVE</strong></span>
        </div>
        <div style="padding:6px 10px; background:#1e293b; border-radius:4px; font-size:0.8em; color:#94a3b8; margin-bottom:10px;">
          ℹ <strong>No-Replay Invariant:</strong> In-flight actions with unknown completion are never blindly replayed after restart. They require explicit verification or manual reconciliation.
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:0.85em; margin-bottom:10px;">
          <div style="background:var(--code-bg); padding:6px 10px; border-radius:3px;">
            <span style="color:var(--muted);">Budget Limits:</span><br>
            Max Rounds: <strong>5</strong> · Transitions: <strong>30</strong>
          </div>
          <div style="background:var(--code-bg); padding:6px 10px; border-radius:3px;">
            <span style="color:var(--muted);">Context Compaction:</span><br>
            Delta: <strong>Active</strong> · Repetition Ratio: <strong>0.00</strong>
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button style="background:#2563eb; color:#fff; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:0.8em;" onclick="vscode.postMessage({command:'reconcileState'})">Reconcile / Safe Resume</button>
          <button style="background:#4b5563; color:#fff; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:0.8em;" onclick="vscode.postMessage({command:'exportDebugBundle'})">Export Redacted Debug Bundle</button>
        </div>
      </div>
    `;
  }

  private _renderAutopilotGateState(): string {
    return `
      <div class="card">
        <h2>Autopilot Gate Review (S26)</h2>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div>
            Eligibility Status: <strong style="color:#f59e0b;">DEFERRED (NO-GO-AUTOEXEC)</strong>
          </div>
          <span style="font-size:0.8em; color:#ef4444; background:#450a0a; padding:2px 6px; border-radius:3px;">DISABLED</span>
        </div>
        <div style="padding:6px 10px; background:#451a03; border-radius:4px; font-size:0.85em; color:#fde68a; margin-bottom:10px;">
          ⚠ <strong>Prerequisite Evaluation Failed (Outcome B):</strong><br>
          Under canonical S00 decision <code>NO-GO-AUTOEXEC</code>, Autopilot is strictly disabled.
          The following mandatory capabilities remain <strong>UNKNOWN</strong>:
          <ul style="margin:4px 0 0 16px; padding:0;">
            <li><code>process.childProcessesConfined</code> (Host child-process confinement)</li>
            <li><code>network.networkDefaultDeny</code> (Host network isolation)</li>
            <li><code>limits.capturesRealExitCode</code> (Host exit-code capture)</li>
          </ul>
        </div>
        <p style="font-size:0.8em; color:var(--muted); margin:0;">
          User opt-in or settings cannot bypass these security gates. Mediator remains strictly in Assisted / Review-only mode.
        </p>
      </div>
    `;
  }

  private _renderMultiProviderSettings(providerState?: ProviderSelectionState): string {
    if (!providerState) {
      return '';
    }

    const statusColors: Record<string, string> = {
      connected: '#10b981',
      configured: '#38bdf8',
      'not-configured': '#94a3b8',
      'auth-failed': '#ef4444',
      'rate-limited': '#f59e0b',
      error: '#ef4444',
      disabled: '#6b7280',
    };

    const providersHtml = providerState.providers.map((p) => {
      const isActive = p.id === providerState.activeProviderId;
      const statusColor = statusColors[p.status] ?? '#94a3b8';
      const borderStyle = isActive ? 'border: 2px solid #3b82f6;' : 'border: 1px solid var(--border);';
      const activeTag = isActive ? '<span style="background:#1d4ed8; color:#fff; padding:2px 8px; border-radius:3px; font-size:0.75em; font-weight:bold;">ACTIVE PROVIDER</span>' : '';

      const modesBadge = p.supportedModes.map((m) => {
        const isCurrentMode = isActive && m === providerState.activeMode;
        const bg = isCurrentMode ? '#047857' : '#334155';
        const label = m === 'browser' ? 'Mode A: Browser' : m === 'api' ? 'Mode B: API' : 'Manual Handoff';
        return `<span style="background:${bg}; color:#f8fafc; padding:2px 6px; border-radius:3px; font-size:0.75em; margin-right:4px;">${esc(label)}</span>`;
      }).join('');

      const credStatus = p.hasCredential
        ? `<span style="color:#10b981;">✓ Key Stored (••••${esc(p.keyLastFour ?? '****')})</span>`
        : `<span style="color:#94a3b8;">No API key stored (AES-256-GCM secure store)</span>`;

      const errorHtml = p.lastError ? `
        <div style="background:#450a0a; color:#fca5a5; padding:6px 10px; border-radius:4px; font-size:0.8em; margin-top:8px;">
          <strong>Error:</strong> ${esc(p.lastError)}
        </div>
      ` : '';

      return `
        <div style="background:var(--code-bg); ${borderStyle} border-radius:6px; padding:12px; margin-bottom:12px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <div>
              <strong style="font-size:1.05em;">${esc(p.name)}</strong> &nbsp;
              <code>${esc(p.id)}</code> &nbsp;
              ${activeTag}
            </div>
            <div>
              Status: <span style="color:${statusColor}; font-weight:600;">${esc(String(p.status).toUpperCase())}</span>
            </div>
          </div>

          <div style="margin-bottom:8px;">
            <span style="font-size:0.8em; color:var(--muted); margin-right:6px;">Supported Modes:</span>
            ${modesBadge}
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:0.85em; margin-bottom:8px;">
            <div>
              <span style="color:var(--muted);">Selected Model:</span> <strong><code>${esc(p.selectedModelId)}</code></strong>
            </div>
            <div>
              <span style="color:var(--muted);">Credentials:</span> ${credStatus}
            </div>
          </div>

          ${errorHtml}

          <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:10px;">
            ${!isActive ? `<button style="background:#2563eb; color:#fff; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:0.8em;" onclick="vscode.postMessage({command:'selectProvider', providerId:'${esc(p.id)}'})">Switch to ${esc(p.name)}</button>` : ''}
            <button style="background:#334155; color:#fff; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:0.8em;" onclick="vscode.postMessage({command:'testProvider', providerId:'${esc(p.id)}'})">Test Connection</button>
            <button style="background:#334155; color:#fff; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:0.8em;" onclick="vscode.postMessage({command:'configureProviderCredential', providerId:'${esc(p.id)}'})">Configure Key</button>
            ${p.hasCredential ? `<button style="background:#dc2626; color:#fff; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:0.8em;" onclick="vscode.postMessage({command:'removeProviderCredential', providerId:'${esc(p.id)}'})">Delete Key</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="card">
        <h2>AI Providers & Connection Modes (S29–S32)</h2>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <div>
            Active: <strong style="color:#38bdf8;">${esc(String(providerState.activeProviderId).toUpperCase())}</strong> &nbsp;·&nbsp;
            Mode: <strong style="color:#10b981;">${esc(String(providerState.activeMode).toUpperCase())}</strong> &nbsp;·&nbsp;
            Model: <code>${esc(providerState.activeModelId)}</code>
          </div>
        </div>
        <div style="padding:6px 10px; background:#1e293b; border-radius:4px; font-size:0.8em; color:#94a3b8; margin-bottom:12px;">
          🛡 <strong>Safety & Session Isolation Invariants:</strong><br>
          • <strong>Mode A (Browser Session Bridge):</strong> Attaches to explicitly selected browser chat. Requires explicit send confirmation. Never transmits API keys.<br>
          • <strong>Mode B (Official API Connection):</strong> Uses encrypted credentials (AES-256-GCM). Isolated API sessions, never continues browser chats.<br>
          • <strong>No Silent Fallback:</strong> Failures never trigger automatic provider or mode switching. Stale approvals are invalidated on provider switch.
        </div>
        ${providersHtml}
      </div>
    `;
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

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function capRow(label: string, status: CapabilityStatus): string {
  const cls = status === 'available' ? 'ok' : status === 'disabled' ? 'dis' : 'no';
  const text = formatCapabilityStatus(status);
  return `<div class="cap"><span class="cap-name">${label}</span><span class="cap-val ${cls}">${text}</span></div>`;
}
