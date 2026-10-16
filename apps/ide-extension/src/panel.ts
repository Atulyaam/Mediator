/**
 * Mediator Status & Interactive Web-AI Workspace Panel (Phase 6)
 *
 * Exposes:
 * - One IDE input for task/sprint.
 * - Authenticated AI provider selection (Gemini Web, ChatGPT, DeepSeek, Claude — no API keys).
 * - Autopilot ON/OFF toggle.
 * - Start and Stop controls.
 * - Live task and persistent conversation status.
 * - Real-time execution timeline (prompts, captured responses, on-demand context commands, returned results, test runs, correction iterations).
 * - Continue execution follow-up input.
 * - Final diff review and explicit human approval controls.
 *
 * Functions strictly as a thin client of Mediator Core HTTP API (http://127.0.0.1:3300).
 */

import * as vscode from 'vscode';
import {
  type MediatorLocalState,
} from './mediatorState.js';
import {
  IdeApiClient,
  type TaskRecordPayload,
  type ConversationMessagePayload,
  type ApprovalRecordPayload,
} from './apiClient.js';

export class MediatorPanel {
  private static _instance: MediatorPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _apiClient = new IdeApiClient();
  private _disposables: vscode.Disposable[] = [];
  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  // Thin client backend synchronization state
  private _backendConnected = false;
  private _coreStatusText = 'OFFLINE';
  private _activeTaskId: string | null = null;
  private _activeTask: TaskRecordPayload | null = null;
  private _conversationHistory: readonly ConversationMessagePayload[] = [];
  private _autopilotEnabled = false;
  private _selectedProvider = 'gemini';
  private _pendingApprovals: readonly ApprovalRecordPayload[] = [];
  private _latestDiff: string | null = null;
  private _lastActionFeedback: string | null = null;

  private constructor(
    panel: vscode.WebviewPanel,
    private _state: MediatorLocalState,
  ) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Wire up interactive Webview message bridge to Mediator Core HTTP API
    this._panel.webview.onDidReceiveMessage(
      (msg: unknown) => {
        if (typeof msg === 'object' && msg !== null) {
          void this._handleWebviewMessage(msg as Record<string, unknown>);
        }
      },
      null,
      this._disposables,
    );

    // Initial poll & recurring synchronization
    void this._pollBackendState();
    this._pollTimer = setInterval(() => {
      void this._pollBackendState();
    }, 2000);

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
      'Mediator — Web-AI Workspace',
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

  private async _pollBackendState(): Promise<void> {
    try {
      const statusRes = await this._apiClient.getStatus();
      this._backendConnected = statusRes.ok;
      this._coreStatusText = statusRes.ok ? `ONLINE (${statusRes.coreVersion})` : 'UNREACHABLE';
      this._autopilotEnabled = statusRes.autopilotStatus === 'active';
      if (statusRes.activeProviderId) {
        this._selectedProvider = statusRes.activeProviderId;
      }

      // Check approvals
      const approvalsRes = await this._apiClient.listApprovals();
      if (approvalsRes.ok) {
        this._pendingApprovals = approvalsRes.approvals.filter((a) => a.status === 'pending');
      }

      // If no active task selected yet, pick latest from task list
      if (!this._activeTaskId) {
        const tasksRes = await this._apiClient.listTasks();
        if (tasksRes.ok && tasksRes.tasks.length > 0) {
          const first = tasksRes.tasks[0];
          if (first) {
            this._activeTaskId = first.id;
          }
        }
      }

      // Fetch active task details and conversation history
      if (this._activeTaskId) {
        const taskRes = await this._apiClient.getTask(this._activeTaskId);
        if (taskRes.ok) {
          this._activeTask = taskRes.task;
          if (taskRes.task.lastDiff) {
            this._latestDiff = taskRes.task.lastDiff;
          }
        }

        const convRes = await this._apiClient.getTaskConversation(this._activeTaskId);
        if (convRes.ok && convRes.conversation) {
          this._conversationHistory = convRes.conversation.history;
        }
      }

      this._update();
    } catch {
      this._backendConnected = false;
      this._coreStatusText = 'CORE OFFLINE (Run mediator server at 127.0.0.1:3300)';
      this._update();
    }
  }

  private async _handleWebviewMessage(msg: Record<string, unknown>): Promise<void> {
    const cmd = String(msg.command ?? '');

    try {
      switch (cmd) {
        case 'startTask': {
          const prompt = String(msg.prompt ?? '').trim();
          const providerId = String(msg.providerId ?? this._selectedProvider);
          const enableAutopilot = Boolean(msg.autopilot);

          if (!prompt) {
            void vscode.window.showWarningMessage('Mediator: Please enter task instructions.');
            return;
          }

          this._lastActionFeedback = 'Starting task on Mediator Core...';
          this._update();

          const createRes = await this._apiClient.createTask({
            prompt,
            providerId,
            mode: 'browser',
          });

          if (createRes.ok && createRes.task) {
            this._activeTaskId = createRes.task.id;
            this._activeTask = createRes.task;
            this._lastActionFeedback = `Task ${createRes.task.id} initialized.`;

            if (enableAutopilot) {
              this._lastActionFeedback = `Task ${createRes.task.id} started with Guarded Autopilot.`;
              // Trigger Autopilot in background
              void this._apiClient.runAutopilot(createRes.task.id).catch((err: Error) => {
                void vscode.window.showErrorMessage(`Autopilot error: ${err.message}`);
              });
            }

            void this._pollBackendState();
          }
          break;
        }

        case 'stopTask': {
          if (this._activeTaskId) {
            await this._apiClient.cancelAutopilot(this._activeTaskId, 'Stopped by user in IDE');
            this._lastActionFeedback = `Task ${this._activeTaskId} stopped.`;
            void vscode.window.showInformationMessage(`Mediator: Task ${this._activeTaskId} stopped.`);
            void this._pollBackendState();
          }
          break;
        }

        case 'toggleAutopilot': {
          const target = Boolean(msg.enable);
          const res = await this._apiClient.toggleAutopilot(target);
          this._autopilotEnabled = res.autopilotStatus === 'active';
          this._lastActionFeedback = `Autopilot set to ${this._autopilotEnabled ? 'ACTIVE' : 'OFF'}`;
          this._update();
          break;
        }

        case 'continueExecution': {
          const message = String(msg.message ?? '').trim();
          if (!this._activeTaskId) {
            void vscode.window.showWarningMessage('No active task to continue.');
            return;
          }
          if (!message) {
            void vscode.window.showWarningMessage('Please enter a follow-up instruction.');
            return;
          }

          this._lastActionFeedback = 'Submitting follow-up message to conversation...';
          this._update();

          await this._apiClient.submitFollowUpMessage(this._activeTaskId, message);
          this._lastActionFeedback = 'Follow-up submitted to conversation.';

          if (this._autopilotEnabled) {
            void this._apiClient.runAutopilot(this._activeTaskId).catch(() => {});
          }

          void this._pollBackendState();
          break;
        }

        case 'selectProvider': {
          const providerId = String(msg.providerId ?? '');
          if (providerId) {
            await this._apiClient.selectProvider(providerId);
            this._selectedProvider = providerId;
            this._lastActionFeedback = `Provider set to ${providerId}`;
            this._update();
          }
          break;
        }

        case 'approveStage': {
          const approvalId = String(msg.approvalId ?? '');
          const stageId = String(msg.stageId ?? '');
          if (approvalId) {
            await this._apiClient.resolveApproval(approvalId, true, 'Approved by user via IDE');
            if (stageId) {
              const applyRes = await this._apiClient.applyStage(stageId, approvalId);
              if (applyRes.ok) {
                this._lastActionFeedback = `Changes approved and applied to workspace!`;
                void vscode.window.showInformationMessage(`Mediator: Stage ${stageId} applied to workspace.`);
              }
            } else {
              this._lastActionFeedback = `Approval ${approvalId} granted.`;
            }
            void this._pollBackendState();
          }
          break;
        }

        case 'rejectStage': {
          const approvalId = String(msg.approvalId ?? '');
          if (approvalId) {
            await this._apiClient.resolveApproval(approvalId, false, 'Rejected by user via IDE');
            this._lastActionFeedback = `Changes rejected.`;
            void vscode.window.showInformationMessage(`Mediator: Proposal rejected.`);
            void this._pollBackendState();
          }
          break;
        }

        case 'refreshState': {
          void this._pollBackendState();
          break;
        }

        default:
          break;
      }
    } catch (err: unknown) {
      const msgStr = err instanceof Error ? err.message : String(err);
      this._lastActionFeedback = `Error: ${msgStr}`;
      void vscode.window.showErrorMessage(`Mediator Core error: ${msgStr}`);
      this._update();
    }
  }

  private _update(): void {
    const statusText = this._activeTask ? `Task ${this._activeTask.id}` : this._state.runState;
    this._panel.title = `Mediator — ${statusText}`;
    this._panel.webview.html = this._getHtml();
  }

  private _getHtml(): string {
    const s = this._state;
    const isOnline = this._backendConnected;
    const statusColor = isOnline ? '#10b981' : '#ef4444';
    const activeTask = this._activeTask;
    const history = this._conversationHistory;

    // Timeline HTML generation
    const timelineItems = history.length === 0
      ? `<div class="timeline-empty">No conversation messages yet. Enter task instructions and click <strong>Start Task</strong>.</div>`
      : history.map((msg, idx) => {
          const isUser = msg.role === 'user';
          const isAssistant = msg.role === 'assistant';
          const badgeClass = isUser ? 'badge-user' : isAssistant ? 'badge-assistant' : 'badge-tool';
          const roleLabel = isUser ? 'USER (IDE)' : isAssistant ? 'WEB AI' : 'MEDIATOR TOOL';

          let bodyContent = `<div class="msg-text">${esc(msg.content)}</div>`;

          if (msg.commandRequest) {
            bodyContent += `
              <div class="tool-call-box">
                <div class="tool-call-header">
                  <span class="tool-icon">⚡</span>
                  <strong>Requested Context Tool:</strong> <code>${esc(msg.commandRequest.command)}</code>
                </div>
                <pre class="tool-args font-mono">${esc(JSON.stringify(msg.commandRequest.args, null, 2))}</pre>
              </div>`;
          }

          if (msg.commandResult) {
            const hasErr = Boolean(msg.commandResult.error);
            const resSnippet = msg.commandResult.result !== undefined
              ? (typeof msg.commandResult.result === 'object' ? JSON.stringify(msg.commandResult.result, null, 2) : String(msg.commandResult.result))
              : (msg.commandResult.error ?? 'Done');
            bodyContent += `
              <div class="tool-result-box ${hasErr ? 'error' : ''}">
                <div class="tool-result-header">
                  <span>${hasErr ? '✕ Tool Execution Failed:' : '✓ Mediator Returned Context Result:'}</span>
                </div>
                <pre class="tool-result-output font-mono">${esc(resSnippet)}</pre>
              </div>`;
          }

          if (msg.proposal) {
            bodyContent += `
              <div class="proposal-box">
                <div class="proposal-header">
                  <span>📝 Proposed Code Edit: <code>${esc(msg.proposal.path)}</code></span>
                </div>
                <pre class="proposal-code font-mono">${esc(msg.proposal.content)}</pre>
              </div>`;
          }

          if (msg.testResult) {
            const passed = msg.testResult.passed;
            bodyContent += `
              <div class="test-result-box ${passed ? 'pass' : 'fail'}">
                <div class="test-result-header">
                  <strong>${passed ? '✓ Sandbox Verification Passed (Exit Code 0)' : `✕ Test Failure Returned to AI (Exit Code ${msg.testResult.exitCode})`}</strong>
                </div>
                <pre class="test-output font-mono">${esc(msg.testResult.output)}</pre>
              </div>`;
          }

          return `
            <div class="timeline-item ${isUser ? 'user-turn' : isAssistant ? 'ai-turn' : 'tool-turn'}">
              <div class="timeline-header">
                <span class="turn-num">#${idx + 1}</span>
                <span class="role-badge ${badgeClass}">${roleLabel}</span>
                <span class="timestamp">${new Date(msg.timestamp).toLocaleTimeString()}</span>
              </div>
              <div class="timeline-body">${bodyContent}</div>
            </div>`;
        }).join('');

    // Diffs & Approvals
    let diffApprovalHtml = '';
    const pendingApproval = this._pendingApprovals.length > 0 ? this._pendingApprovals[0] : null;

    if (this._latestDiff || pendingApproval) {
      diffApprovalHtml = `
        <div class="card diff-approval-card">
          <div class="card-header-row">
            <h2>Proposed Staged Diff & Human Approval</h2>
            <div class="approval-buttons">
              ${pendingApproval ? `
                <button class="btn btn-success" onclick="approveStage('${esc(pendingApproval.id)}', '${esc(pendingApproval.stageId)}')">
                  ✓ Approve & Apply to Workspace
                </button>
                <button class="btn btn-danger" onclick="rejectStage('${esc(pendingApproval.id)}')">
                  ✕ Reject Changes
                </button>
              ` : `
                <span class="badge badge-success">Diff Staged in Task Worktree</span>
              `}
            </div>
          </div>
          ${this._latestDiff ? `
            <pre class="diff-viewer font-mono"><code>${esc(this._latestDiff)}</code></pre>
          ` : `
            <div class="muted-note">Pending approval record: <code>${esc(pendingApproval?.id)}</code> for stage <code>${esc(pendingApproval?.stageId)}</code></div>
          `}
        </div>
      `;
    }

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Mediator — Web-AI Workspace</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #121212);
      --fg: var(--vscode-editor-foreground, #e2e8f0);
      --card-bg: var(--vscode-sideBar-background, #1e1e24);
      --border: var(--vscode-panel-border, #2d3748);
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --muted: var(--vscode-descriptionForeground, #94a3b8);
      --code-bg: var(--vscode-textCodeBlock-background, #0f172a);
      --emerald: #10b981;
      --amber: #f59e0b;
      --rose: #ef4444;
      --sky: #38bdf8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--bg);
      color: var(--fg);
      padding: 16px 20px;
      line-height: 1.5;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 18px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
    }
    .brand-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .status-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: ${statusColor};
      box-shadow: 0 0 8px ${statusColor}aa;
    }
    h1 { font-size: 1.25em; font-weight: 700; letter-spacing: -0.02em; }
    .core-tag { font-size: 0.8em; color: var(--muted); }
    .ws-pill {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 4px 12px;
      font-size: 0.85em;
    }
    .ws-confirmed { color: var(--emerald); font-weight: 600; margin-left: 6px; }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.15);
    }
    .card h2 {
      font-size: 0.85em;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--sky);
      margin-bottom: 12px;
    }
    .card-header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .form-group { margin-bottom: 14px; }
    .form-label { display: block; font-weight: 600; font-size: 0.88em; margin-bottom: 6px; color: var(--fg); }
    .form-textarea {
      width: 100%;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      color: var(--fg);
      font-family: inherit;
      font-size: 0.95em;
      resize: vertical;
      min-height: 85px;
    }
    .form-textarea:focus { outline: none; border-color: var(--accent); }

    .controls-grid {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 12px;
      align-items: center;
    }
    .form-select {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      color: var(--fg);
      font-size: 0.9em;
    }

    .autopilot-box {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--code-bg);
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
    }
    .autopilot-box input[type="checkbox"] { cursor: pointer; accent-color: var(--accent); }

    .btn {
      padding: 7px 16px;
      border-radius: 6px;
      border: none;
      font-weight: 600;
      font-size: 0.9em;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s ease;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-danger { background: var(--rose); color: #fff; }
    .btn-success { background: var(--emerald); color: #fff; }
    .btn-secondary { background: #334155; color: #fff; }
    .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--fg); }

    .status-banner {
      background: linear-gradient(135deg, #1e1b4b, #0f172a);
      border: 1px solid #4338ca;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }
    .banner-metric { display: flex; flex-direction: column; }
    .metric-label { font-size: 0.72em; text-transform: uppercase; color: #94a3b8; }
    .metric-val { font-weight: 700; font-size: 1.05em; color: #e0e7ff; }

    /* Timeline styling */
    .timeline-container {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 10px;
    }
    .timeline-item {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--code-bg);
      overflow: hidden;
    }
    .timeline-header {
      background: rgba(255,255,255,0.03);
      padding: 6px 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid var(--border);
      font-size: 0.82em;
    }
    .turn-num { font-weight: bold; color: var(--muted); }
    .role-badge {
      padding: 1px 7px;
      border-radius: 4px;
      font-weight: 700;
      font-size: 0.75em;
      letter-spacing: 0.04em;
    }
    .badge-user { background: #1e3a8a; color: #93c5fd; }
    .badge-assistant { background: #3b0764; color: #e9d5ff; }
    .badge-tool { background: #064e3b; color: #a7f3d0; }
    .timestamp { margin-left: auto; color: var(--muted); }

    .timeline-body { padding: 12px; font-size: 0.9em; }
    .msg-text { white-space: pre-wrap; margin-bottom: 8px; line-height: 1.5; }

    .tool-call-box, .tool-result-box, .proposal-box, .test-result-box {
      margin-top: 8px;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 0.85em;
    }
    .tool-call-box { background: #172554; border-left: 3px solid var(--sky); }
    .tool-result-box { background: #064e3b; border-left: 3px solid var(--emerald); }
    .tool-result-box.error { background: #450a0a; border-left: 3px solid var(--rose); }
    .proposal-box { background: #312e81; border-left: 3px solid #818cf8; }
    .test-result-box.pass { background: #064e3b; border-left: 3px solid var(--emerald); }
    .test-result-box.fail { background: #450a0a; border-left: 3px solid var(--rose); }

    pre.font-mono {
      font-family: var(--vscode-editor-font-family, Consolas, Monaco, monospace);
      font-size: 0.85em;
      overflow-x: auto;
      margin-top: 4px;
      padding: 6px;
      background: rgba(0,0,0,0.25);
      border-radius: 4px;
    }

    .diff-viewer {
      background: #020617;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid #1e293b;
      max-height: 260px;
      overflow: auto;
      color: #cbd5e1;
    }

    .feedback-bar {
      margin-top: 8px;
      padding: 6px 12px;
      background: #1e293b;
      border-radius: 4px;
      font-size: 0.82em;
      color: var(--sky);
    }
    .muted-note { color: var(--muted); font-size: 0.85em; font-style: italic; }
    .timeline-empty { padding: 30px; text-align: center; color: var(--muted); font-style: italic; }
  </style>
</head>
<body>
  <!-- Header -->
  <header>
    <div class="brand-group">
      <div class="status-dot"></div>
      <div>
        <h1>MEDIATOR</h1>
        <div class="core-tag">${esc(this._coreStatusText)}</div>
      </div>
    </div>
    <div class="ws-pill">
      WORKSPACE: <code>${esc(s.workspaceRoot ?? 'No workspace open')}</code>
      <span class="ws-confirmed">${s.workspaceConfirmed ? '✓ CONFIRMED' : '⚠ PENDING'}</span>
    </div>
  </header>

  <!-- Task Submission & Main Input -->
  <div class="card">
    <h2>1. Coding Task Input & Persistent AI Session</h2>
    <div class="form-group">
      <label class="form-label" for="taskPrompt">Task or Sprint Instructions (One IDE Input):</label>
      <textarea id="taskPrompt" class="form-textarea" placeholder="Describe the task or sprint (e.g. Build a portfolio website, or fix type coercion in add function)..."></textarea>
    </div>

    <div class="controls-grid">
      <div>
        <label class="form-label" for="providerSelect">Authenticated Web-AI Website (No API Keys):</label>
        <select id="providerSelect" class="form-select" onchange="onProviderChange(this.value)">
          <option value="gemini" ${this._selectedProvider === 'gemini' ? 'selected' : ''}>Google Gemini (gemini.google.com)</option>
          <option value="openai" ${this._selectedProvider === 'openai' ? 'selected' : ''}>OpenAI ChatGPT (chatgpt.com)</option>
          <option value="deepseek" ${this._selectedProvider === 'deepseek' ? 'selected' : ''}>DeepSeek (chat.deepseek.com)</option>
          <option value="claude" ${this._selectedProvider === 'claude' ? 'selected' : ''}>Anthropic Claude (claude.ai)</option>
        </select>
      </div>

      <div class="autopilot-box">
        <input type="checkbox" id="autopilotToggle" ${this._autopilotEnabled ? 'checked' : ''} onchange="onAutopilotToggle(this.checked)">
        <label for="autopilotToggle" style="font-weight:600; cursor:pointer;">
          Autopilot Loop: <span style="color:${this._autopilotEnabled ? 'var(--emerald)' : 'var(--muted)'};">${this._autopilotEnabled ? 'ENABLED' : 'OFF'}</span>
        </label>
      </div>

      <div style="display:flex; gap:8px;">
        <button class="btn btn-primary" onclick="startTask()">
          ▶ Start Task
        </button>
        <button class="btn btn-danger" onclick="stopTask()">
          ⏹ Stop
        </button>
      </div>
    </div>

    ${this._lastActionFeedback ? `<div class="feedback-bar">${esc(this._lastActionFeedback)}</div>` : ''}
  </div>

  <!-- Active Task Status Banner -->
  <div class="status-banner">
    <div class="banner-metric">
      <span class="metric-label">Active Task</span>
      <span class="metric-val font-mono">${esc(activeTask?.id ?? 'None')}</span>
    </div>
    <div class="banner-metric">
      <span class="metric-label">Provider Conversation</span>
      <span class="metric-val font-mono">${esc(activeTask?.conversationId ?? 'Persistent Web Session')}</span>
    </div>
    <div class="banner-metric">
      <span class="metric-label">Task State</span>
      <span class="metric-val" style="color:var(--sky);">${esc(activeTask?.state?.toUpperCase() ?? 'IDLE')}</span>
    </div>
    <div class="banner-metric">
      <span class="metric-label">Autopilot Mode</span>
      <span class="metric-val" style="color:${this._autopilotEnabled ? 'var(--emerald)' : 'var(--amber)'};">
        ${this._autopilotEnabled ? 'GUARDED AUTOPILOT' : 'ASSISTED / REVIEW-ONLY'}
      </span>
    </div>
    <div class="banner-metric">
      <span class="metric-label">Round / Iterations</span>
      <span class="metric-val">${activeTask?.roundCount ?? 0}</span>
    </div>
  </div>

  <!-- Real-Time Execution Timeline -->
  <div class="card">
    <div class="card-header-row">
      <h2>2. Persistent Conversation & Execution Timeline</h2>
      <button class="btn btn-outline" style="font-size:0.75em; padding:3px 8px;" onclick="refreshTimeline()">
        🔄 Refresh
      </button>
    </div>

    <div class="timeline-container">
      ${timelineItems}
    </div>

    <!-- Continue Execution Input -->
    <div style="margin-top:16px; padding-top:14px; border-top:1px solid var(--border);">
      <label class="form-label" for="followUpInput">Continue Conversation / Provide Direction:</label>
      <div style="display:flex; gap:8px;">
        <input type="text" id="followUpInput" class="form-textarea" style="min-height:36px; padding:6px 10px;" placeholder="Add follow-up instructions or answer AI question in this conversation..." onkeydown="if(event.key==='Enter') submitFollowUp()">
        <button class="btn btn-secondary" style="white-space:nowrap;" onclick="submitFollowUp()">
          Continue Execution ➔
        </button>
      </div>
    </div>
  </div>

  <!-- Final Diff Review & Approvals -->
  ${diffApprovalHtml}

  <!-- Interactive Scripts -->
  <script>
    const vscode = acquireVsCodeApi();

    function startTask() {
      const prompt = document.getElementById('taskPrompt').value.trim();
      const providerId = document.getElementById('providerSelect').value;
      const autopilot = document.getElementById('autopilotToggle').checked;
      vscode.postMessage({ command: 'startTask', prompt, providerId, autopilot });
    }

    function stopTask() {
      vscode.postMessage({ command: 'stopTask' });
    }

    function onAutopilotToggle(enable) {
      vscode.postMessage({ command: 'toggleAutopilot', enable });
    }

    function onProviderChange(providerId) {
      vscode.postMessage({ command: 'selectProvider', providerId });
    }

    function submitFollowUp() {
      const input = document.getElementById('followUpInput');
      const message = input.value.trim();
      if (!message) return;
      input.value = '';
      vscode.postMessage({ command: 'continueExecution', message });
    }

    function approveStage(approvalId, stageId) {
      vscode.postMessage({ command: 'approveStage', approvalId, stageId });
    }

    function rejectStage(approvalId) {
      vscode.postMessage({ command: 'rejectStage', approvalId });
    }

    function refreshTimeline() {
      vscode.postMessage({ command: 'refreshState' });
    }

    // Ctrl+Enter shortcut in task textarea
    document.getElementById('taskPrompt')?.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        startTask();
      }
    });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
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
