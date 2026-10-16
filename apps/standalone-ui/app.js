/**
 * @mediator/standalone-ui — Standalone Dashboard Application Logic (Sprint S33 + S50 Polish)
 *
 * Coordinates real-time SSE updates, Core REST API operations, task lifecycle,
 * staged diff reviews, provider switching, Autopilot safety gating, and responsive UX.
 */

(function () {
  'use strict';

  // State
  let state = {
    coreVersion: '0.1.0-beta.1',
    protocolVersion: '1.3',
    workspaceRoot: null,
    workspaceConfirmed: false,
    activeProviderId: 'gemini',
    activeMode: 'browser',
    activeConversation: null,
    activeTaskId: null,
    tasks: [],
    loopEnabled: true,
    loopStatus: 'ready',
    autopilotEnabled: false,
    autopilotStatus: 'off',
    autopilotCanRun: false,
    autopilotBlockingReasons: [],
    providers: [],
    pendingApprovals: [],
    recentStages: [],
    uptimeSeconds: 0,
    pairingToken: '',
  };

  let token =
    new URLSearchParams(window.location.search).get('token') ||
    (() => {
      try { return localStorage.getItem('mediator_token') || ''; } catch (_) { return ''; }
    })();
  let eventSource = null;
  let activeDiagReport = null;
  let activeDiagFilter = 'ALL';
  let auditSearchQuery = '';
  let auditFilterType = 'ALL';
  let clearedAuditLogs = false;

  // ─── DOM References ────────────────────────────────────────────────────────

  const dom = {
    // Nav & Mobile Drawer
    navItems: document.querySelectorAll('.nav-item'),
    tabPanes: document.querySelectorAll('.tab-pane'),
    appSidebar: document.getElementById('app-sidebar'),
    sidebarBackdrop: document.getElementById('sidebar-backdrop'),
    btnMobileMenuToggle: document.getElementById('btn-mobile-menu-toggle'),
    brandHomeLink: document.getElementById('brand-home-link'),

    // Header
    coreStatusDot: document.getElementById('core-status-dot'),
    coreStatusText: document.getElementById('core-status-text'),
    apiEndpointBadge: document.getElementById('api-endpoint-badge'),
    apiUrlDisplay: document.getElementById('api-url-display'),
    btnConfigApi: document.getElementById('btn-config-api'),
    wsPathDisplay: document.getElementById('ws-path-display'),
    wsConfirmedBadge: document.getElementById('ws-confirmed-badge'),
    btnChangeWs: document.getElementById('btn-change-workspace'),
    loopToggleInput: document.getElementById('loop-toggle-input'),
    loopStatusBadge: document.getElementById('loop-status-badge'),
    autopilotToggleInput: document.getElementById('autopilot-toggle-input'),
    autopilotStatusBadge: document.getElementById('autopilot-status-badge'),
    tokenDisplay: document.getElementById('token-display'),
    btnCopyToken: document.getElementById('btn-copy-token'),

    // Sidebar stats
    sidebarActiveProvider: document.getElementById('sidebar-active-provider'),
    sidebarActiveTask: document.getElementById('sidebar-active-task'),
    sidebarUptime: document.getElementById('sidebar-uptime'),
    stagingBadge: document.getElementById('staging-badge'),

    // Dashboard
    dashWsRoot: document.getElementById('dash-workspace-root'),
    dashWsStatus: document.getElementById('dash-workspace-status'),
    dashProviderName: document.getElementById('dash-provider-name'),
    dashProviderMode: document.getElementById('dash-provider-mode'),
    dashLoopState: document.getElementById('dash-loop-state'),
    dashAutopilotState: document.getElementById('dash-autopilot-state'),
    dashNoTaskView: document.getElementById('dash-no-task-view'),
    dashActiveTaskView: document.getElementById('dash-active-task-view'),
    dashTaskId: document.getElementById('dash-task-id'),
    dashTaskPrompt: document.getElementById('dash-task-prompt'),
    dashTaskRound: document.getElementById('dash-task-round'),
    dashTaskApprovalStatus: document.getElementById('dash-task-approval-status'),
    dashTaskStatusBadge: document.getElementById('dash-task-status-badge'),
    btnDashPauseTask: document.getElementById('btn-dash-pause-task'),
    btnDashResumeTask: document.getElementById('btn-dash-resume-task'),
    btnDashCancelTask: document.getElementById('btn-dash-cancel-task'),
    dashPendingCountBadge: document.getElementById('dash-pending-count-badge'),
    dashApprovalsList: document.getElementById('dash-approvals-list'),
    dashAuditStream: document.getElementById('dash-audit-stream'),

    // Task Workspace
    taskProviderSelect: document.getElementById('task-provider-select'),
    taskModeSelect: document.getElementById('task-mode-select'),
    taskPromptInput: document.getElementById('task-prompt-input'),
    btnSubmitTask: document.getElementById('btn-submit-task'),
    btnTemplateLint: document.getElementById('btn-template-lint'),
    btnTemplateTest: document.getElementById('btn-template-test'),
    btnTemplateRefactor: document.getElementById('btn-template-refactor'),
    btnTemplateSecurity: document.getElementById('btn-template-security'),
    taskHistorySelect: document.getElementById('task-history-select'),
    flowRoundBadge: document.getElementById('flow-round-badge'),
    flowStatusBadge: document.getElementById('flow-status-badge'),
    simEnvelopeInput: document.getElementById('sim-envelope-input'),
    btnSimLoadValid: document.getElementById('btn-sim-load-valid'),
    btnSimDispatch: document.getElementById('btn-sim-dispatch'),
    diffViewBox: document.getElementById('diff-view-box'),
    diffStatsBadge: document.getElementById('diff-stats-badge'),
    btnCopyDiff: document.getElementById('btn-copy-diff'),
    btnApproveStage: document.getElementById('btn-approve-stage'),
    btnRejectStage: document.getElementById('btn-reject-stage'),
    btnTaskPause: document.getElementById('btn-task-pause'),
    btnTaskResume: document.getElementById('btn-task-resume'),
    btnTaskCancel: document.getElementById('btn-task-cancel'),

    // Staging Tab
    stagingList: document.getElementById('staging-list'),
    stagingDiffId: document.getElementById('staging-diff-id'),
    stagingDiffContent: document.getElementById('staging-diff-content'),
    btnCopyStageDiff: document.getElementById('btn-copy-stage-diff'),
    btnStageApprove: document.getElementById('btn-stage-approve'),
    btnStageReject: document.getElementById('btn-stage-reject'),

    // Autopilot Tab
    autopilotReasonsList: document.getElementById('autopilot-reasons-list'),
    btnRecheckAutopilot: document.getElementById('btn-recheck-autopilot'),

    // Audit Tab
    auditTableBody: document.getElementById('audit-table-body'),
    auditSearchInput: document.getElementById('audit-search-input'),
    auditFilterSelect: document.getElementById('audit-filter-select'),
    btnClearLogsView: document.getElementById('btn-clear-logs-view'),

    // Diagnostics Tab
    diagFilterGroup: document.getElementById('diag-filter-group'),
    btnRefreshDiag: document.getElementById('btn-refresh-diagnostics'),
    btnExportDiag: document.getElementById('btn-export-diagnostics'),

    // Workspace Modal
    wsModal: document.getElementById('ws-modal'),
    wsInputPath: document.getElementById('ws-input-path'),
    btnCloseWsModal: document.getElementById('btn-close-ws-modal'),
    btnCancelWsModal: document.getElementById('btn-cancel-ws-modal'),
    btnConfirmWsModal: document.getElementById('btn-confirm-ws-modal'),

    // API Config Modal
    apiConfigModal: document.getElementById('api-config-modal'),
    apiUrlInput: document.getElementById('api-url-input'),
    apiTokenInput: document.getElementById('api-token-input'),
    btnCloseApiModal: document.getElementById('btn-close-api-modal'),
    btnCancelApiModal: document.getElementById('btn-cancel-api-modal'),
    btnTestApiModal: document.getElementById('btn-test-api-modal'),
    btnSaveApiModal: document.getElementById('btn-save-api-modal'),

    // Toast Container
    toastContainer: document.getElementById('toast-container'),
  };

  // ─── Navigation & Mobile Drawer ────────────────────────────────────────────

  function switchTab(tabId) {
    dom.navItems.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });
    dom.tabPanes.forEach((pane) => {
      pane.classList.toggle('active', pane.id === tabId);
    });
    closeMobileDrawer();

    if (tabId === 'tab-diagnostics') {
      loadDiagnostics();
    }
  }

  function toggleMobileDrawer() {
    if (!dom.appSidebar) return;
    const isOpen = dom.appSidebar.classList.toggle('open');
    if (dom.btnMobileMenuToggle) {
      dom.btnMobileMenuToggle.classList.toggle('active', isOpen);
    }
    if (dom.sidebarBackdrop) {
      dom.sidebarBackdrop.classList.toggle('active', isOpen);
    }
  }

  function closeMobileDrawer() {
    if (dom.appSidebar) dom.appSidebar.classList.remove('open');
    if (dom.btnMobileMenuToggle) dom.btnMobileMenuToggle.classList.remove('active');
    if (dom.sidebarBackdrop) dom.sidebarBackdrop.classList.remove('active');
  }

  if (dom.btnMobileMenuToggle) {
    dom.btnMobileMenuToggle.addEventListener('click', toggleMobileDrawer);
  }
  if (dom.sidebarBackdrop) {
    dom.sidebarBackdrop.addEventListener('click', closeMobileDrawer);
  }
  if (dom.brandHomeLink) {
    dom.brandHomeLink.addEventListener('click', () => switchTab('tab-dashboard'));
  }

  dom.navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  const btnDashNewTask = document.getElementById('btn-dashboard-new-task');
  if (btnDashNewTask) {
    btnDashNewTask.addEventListener('click', () => switchTab('tab-workspace'));
  }
  const btnDashStartFirst = document.getElementById('btn-dash-start-first');
  if (btnDashStartFirst) {
    btnDashStartFirst.addEventListener('click', () => switchTab('tab-workspace'));
  }

  // ─── Robust Shared API Client & Response Handler ──────────────────────────

  class ApiError extends Error {
    constructor(code, message, status, endpoint, responseData) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
      this.endpoint = endpoint;
      this.responseData = responseData;
      this.timestamp = Date.now();
    }
  }

  function getApiBaseUrl() {
    // 1. Check URL query parameters ?api=... or ?port=...
    const urlParams = new URLSearchParams(window.location.search);
    const apiParam = urlParams.get('api');
    if (apiParam) {
      const clean = apiParam.replace(/\/+$/, '');
      try { localStorage.setItem('mediator_api_base', clean); } catch (_) {}
      return clean;
    }
    const portParam = urlParams.get('port');
    if (portParam) {
      const constructed = `${window.location.protocol}//${window.location.hostname}:${portParam}`;
      try { localStorage.setItem('mediator_api_base', constructed); } catch (_) {}
      return constructed;
    }

    // 2. Check localStorage
    try {
      const stored = localStorage.getItem('mediator_api_base');
      if (stored) return stored.replace(/\/+$/, '');
    } catch (_) {}

    // 3. When served from Live Server (port 5500) or dev servers (5173, 3000), target default Core port 3300
    const port = window.location.port;
    if (port === '5500' || port === '5173' || port === '3000') {
      return `${window.location.protocol}//${window.location.hostname}:3300`;
    }

    // 4. Default to origin or http://127.0.0.1:3300
    if (window.location.origin && window.location.origin !== 'null' && !window.location.protocol.startsWith('file')) {
      return window.location.origin.replace(/\/+$/, '');
    }
    return 'http://127.0.0.1:3300';
  }

  class ApiClient {
    constructor(options = {}) {
      this.baseUrl = (options.baseUrl || '').replace(/\/+$/, '');
      this.token = options.token || '';
      this.onAuthFailure = options.onAuthFailure;
      this.onError = options.onError;
    }

    setBaseUrl(url) {
      this.baseUrl = (url || '').replace(/\/+$/, '');
    }

    getBaseUrl() {
      return this.baseUrl;
    }

    setToken(token) {
      this.token = token || '';
    }

    getToken() {
      return this.token;
    }

    async request(endpoint, options = {}) {
      const isAbsolute = endpoint.startsWith('http://') || endpoint.startsWith('https://');
      let fullUrl = isAbsolute
        ? endpoint
        : `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

      // Append token query param if token exists and not already present
      if (this.token && !fullUrl.includes('token=')) {
        const sep = fullUrl.includes('?') ? '&' : '?';
        fullUrl = `${fullUrl}${sep}token=${encodeURIComponent(this.token)}`;
      }

      const headers = {
        Accept: 'application/json, text/plain, */*',
      };

      if (this.token) {
        headers['X-Mediator-Token'] = this.token;
      }

      let bodyStr = undefined;
      if (options.body !== undefined && options.body !== null) {
        if (typeof options.body === 'string') {
          bodyStr = options.body;
          if (!headers['Content-Type'] && (bodyStr.startsWith('{') || bodyStr.startsWith('['))) {
            headers['Content-Type'] = 'application/json';
          }
        } else {
          bodyStr = JSON.stringify(options.body);
          headers['Content-Type'] = 'application/json';
        }
      }

      if (options.headers) {
        Object.assign(headers, options.headers);
      }

      const fetchOptions = {
        ...options,
        headers,
        body: bodyStr,
      };

      let res;
      try {
        res = await fetch(fullUrl, fetchOptions);
      } catch (networkErr) {
        const isAbort = networkErr && networkErr.name === 'AbortError';
        const errMsg = isAbort
          ? `Request to ${endpoint} was aborted or timed out`
          : `Network connection failed connecting to Mediator Core at ${this.baseUrl || 'current origin'} (${networkErr?.message || 'fetch failed'})`;
        const apiErr = new ApiError('NETWORK_ERROR', errMsg, 0, endpoint);
        this.onError?.(apiErr);
        throw apiErr;
      }

      // Read response body AT MOST ONCE
      const rawText = await res.text();
      const trimmed = rawText.trim();
      const contentType = res.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');

      // 1. Handle HTTP 204 No Content
      if (res.status === 204) {
        if (!res.ok) {
          const err = new ApiError(
            `HTTP_${res.status}`,
            `HTTP ${res.status} error from ${endpoint}`,
            res.status,
            endpoint
          );
          this.onError?.(err);
          throw err;
        }
        return { ok: true, status: 204, data: null };
      }

      // 2. Handle empty response body
      if (trimmed.length === 0) {
        if (options.allowEmptyBody && res.ok) {
          return { ok: true, status: res.status, data: null };
        }
        const apiErr = new ApiError(
          'EMPTY_RESPONSE',
          `Unexpected empty response body from ${endpoint} (HTTP ${res.status})`,
          res.status,
          endpoint
        );
        this.onError?.(apiErr);
        throw apiErr;
      }

      // 3. Parse JSON safely
      let parsed;
      if (isJson || trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          parsed = JSON.parse(trimmed);
        } catch (parseErr) {
          const snippet = trimmed.slice(0, 100).replace(/[\r\n]+/g, ' ');
          const apiErr = new ApiError(
            'JSON_PARSE_ERROR',
            `Failed to parse JSON response from ${endpoint} (HTTP ${res.status}): ${parseErr?.message || 'invalid JSON'}. Snippet: "${snippet}"`,
            res.status,
            endpoint
          );
          this.onError?.(apiErr);
          throw apiErr;
        }
      } else {
        // Received non-JSON (e.g. HTML 404 from Live Server)
        const snippet = trimmed.slice(0, 100).replace(/[\r\n]+/g, ' ');
        const apiErr = new ApiError(
          'INVALID_CONTENT_TYPE',
          `Expected JSON response from ${endpoint} (HTTP ${res.status}), but received ${contentType || 'non-JSON'}. Snippet: "${snippet}"`,
          res.status,
          endpoint
        );
        this.onError?.(apiErr);
        throw apiErr;
      }

      // 4. Handle non-2xx responses
      if (!res.ok) {
        let serverCode = `HTTP_${res.status}`;
        let serverMsg = `HTTP ${res.status} error from ${endpoint}`;

        if (parsed && typeof parsed === 'object') {
          if (parsed.error) {
            if (typeof parsed.error === 'object' && parsed.error !== null) {
              serverCode = parsed.error.code || serverCode;
              serverMsg = parsed.error.message || serverCode;
            } else if (typeof parsed.error === 'string') {
              serverMsg = parsed.error;
            }
          } else if (parsed.message) {
            serverMsg = parsed.message;
          }
        }

        if (res.status === 401) {
          this.onAuthFailure?.();
        }

        const apiErr = new ApiError(serverCode, serverMsg, res.status, endpoint, parsed);
        this.onError?.(apiErr);
        throw apiErr;
      }

      return parsed;
    }

    async getStatus() {
      return this.request('/api/status');
    }

    async getWorkspace() {
      return this.request('/api/workspace');
    }

    async setWorkspace(root, confirm = true) {
      return this.request('/api/workspace', {
        method: 'POST',
        body: { root, confirm },
      });
    }
  }

  const apiClient = new ApiClient({
    baseUrl: getApiBaseUrl(),
    token: token,
    onError: (err) => {
      // Don't toast for background polling offline drops
      if (err.code !== 'NETWORK_ERROR') {
        showToast(err.message, 'error');
      }
    },
  });

  // Expose on window for diagnostics & testing
  window.ApiClient = ApiClient;
  window.ApiError = ApiError;
  window.apiClient = apiClient;

  async function api(path, options = {}) {
    return apiClient.request(path, options);
  }

  function updateApiDisplay() {
    if (dom.apiUrlDisplay) {
      dom.apiUrlDisplay.innerText = apiClient.getBaseUrl() || 'Origin';
    }
  }

  // ─── Workspace Fetch & Status ──────────────────────────────────────────────

  async function fetchWorkspaceStatus() {
    try {
      const res = await apiClient.getWorkspace();
      if (res.ok) {
        state.workspaceRoot = res.workspaceRoot;
        state.workspaceConfirmed = Boolean(res.confirmed);
        renderHeader();
      }
    } catch (err) {
      console.warn('Workspace status query failed:', err.message);
    }
  }

  // ─── Fetch Full Snapshot & Sync ────────────────────────────────────────────

  async function fetchState() {
    try {
      const res = await api('/api/state');
      if (res.ok && res.state) {
        state = res.state;
        if (state.pairingToken && !token) {
          token = state.pairingToken;
          apiClient.setToken(token);
        }
        if (state.workspaceRoot !== undefined) {
          state.workspaceConfirmed = Boolean(state.workspaceConfirmed);
        }
        renderAll();
      }
    } catch (err) {
      if (dom.coreStatusDot) {
        dom.coreStatusDot.classList.remove('pulse');
        dom.coreStatusDot.style.background = 'var(--accent-rose)';
      }
      if (dom.coreStatusText) {
        dom.coreStatusText.innerText = 'CORE OFFLINE';
      }
    }
  }

  // ─── SSE Real-Time Stream ──────────────────────────────────────────────────

  function connectSse() {
    if (eventSource) {
      eventSource.close();
    }

    const base = apiClient.getBaseUrl();
    const sseUrl = token ? `${base}/api/events?token=${encodeURIComponent(token)}` : `${base}/api/events`;
    eventSource = new EventSource(sseUrl);

    eventSource.onopen = () => {
      if (dom.coreStatusDot) {
        dom.coreStatusDot.classList.add('pulse');
        dom.coreStatusDot.style.background = 'var(--accent-emerald)';
      }
      if (dom.coreStatusText) {
        dom.coreStatusText.innerText = 'CORE ONLINE';
      }
    };

    eventSource.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data);
        handleCoreEvent(event);
      } catch (err) {
        console.error('Failed to parse SSE frame', err);
      }
    };

    eventSource.onerror = () => {
      if (dom.coreStatusDot) {
        dom.coreStatusDot.classList.remove('pulse');
        dom.coreStatusDot.style.background = 'var(--accent-amber)';
      }
      if (dom.coreStatusText) {
        dom.coreStatusText.innerText = 'RECONNECTING...';
      }
      eventSource.close();
      setTimeout(connectSse, 3000);
    };
  }

  function handleCoreEvent(event) {
    if (event.type === 'state:snapshot') {
      state = event.payload;
      renderAll();
      return;
    }

    // Refresh state on key transitions
    fetchState().catch(() => {});

    // Toast notifications
    if (event.type === 'task:created') {
      showToast(`Task ${event.payload.id} initialized`, 'info');
    } else if (event.type === 'stage:created') {
      showToast(`New code changes staged for review!`, 'success');
    } else if (event.type === 'approval:created') {
      showToast(`Human approval required for live patch.`, 'warning');
    } else if (event.type === 'workspace:changed') {
      showToast(`Workspace set to ${event.payload.workspaceRoot}`, 'info');
    }
  }

  // ─── Renderers ─────────────────────────────────────────────────────────────

  function renderAll() {
    renderHeader();
    renderDashboard();
    renderWorkspace();
    renderStaging();
    renderProviders();
    renderAutopilot();
    renderAuditLogs();
  }

  function renderHeader() {
    if (dom.wsPathDisplay) {
      dom.wsPathDisplay.innerText = state.workspaceRoot || 'No workspace selected';
    }
    if (dom.wsConfirmedBadge) {
      dom.wsConfirmedBadge.style.display = state.workspaceConfirmed ? 'inline-block' : 'none';
    }

    if (dom.loopToggleInput) {
      dom.loopToggleInput.checked = Boolean(state.loopEnabled);
    }
    if (dom.loopStatusBadge) {
      dom.loopStatusBadge.innerText = (state.loopStatus || 'READY').toUpperCase();
      dom.loopStatusBadge.className = `toggle-status ${state.loopEnabled ? 'badge-success' : 'badge-danger'}`;
    }

    if (dom.autopilotToggleInput) {
      dom.autopilotToggleInput.checked = Boolean(state.autopilotEnabled);
    }
    if (dom.autopilotStatusBadge) {
      dom.autopilotStatusBadge.innerText = (state.autopilotStatus || 'OFF').toUpperCase();
      dom.autopilotStatusBadge.className = `toggle-status ${
        state.autopilotStatus === 'ready'
          ? 'badge-success'
          : state.autopilotStatus === 'blocked'
          ? 'badge-danger'
          : 'badge-warning'
      }`;
    }

    if (dom.tokenDisplay) {
      dom.tokenDisplay.innerText = state.pairingToken || token || 'pair_...';
    }

    // Sidebar stats
    if (dom.sidebarActiveProvider) {
      dom.sidebarActiveProvider.innerText = capitalize(state.activeProviderId);
    }
    if (dom.sidebarActiveTask) {
      dom.sidebarActiveTask.innerText = state.activeTaskId || 'None';
    }
    if (dom.sidebarUptime) {
      dom.sidebarUptime.innerText = `${state.uptimeSeconds || 0}s`;
    }
    if (dom.stagingBadge) {
      dom.stagingBadge.innerText = (state.recentStages || []).length;
    }
  }

  function renderDashboard() {
    if (dom.dashWsRoot) {
      dom.dashWsRoot.innerText = state.workspaceRoot ? basename(state.workspaceRoot) : 'Unset';
    }
    if (dom.dashWsStatus) {
      dom.dashWsStatus.innerText = state.workspaceConfirmed ? 'Confirmed and permitted' : 'Requires confirmation';
    }

    if (dom.dashProviderName) {
      dom.dashProviderName.innerText = getProviderDisplayName(state.activeProviderId);
    }
    if (dom.dashProviderMode) {
      dom.dashProviderMode.innerText = state.activeMode === 'browser' ? 'Browser Bridge (Active Tab)' : 'Official API';
    }

    if (dom.dashLoopState) {
      dom.dashLoopState.innerText = state.loopEnabled ? 'Ready' : 'Disabled';
    }
    if (dom.dashAutopilotState) {
      dom.dashAutopilotState.innerText = (state.autopilotStatus || 'BLOCKED').toUpperCase();
    }

    // Active Task View
    const activeTask = (state.tasks || []).find((t) => t.id === state.activeTaskId);
    if (!activeTask) {
      if (dom.dashNoTaskView) dom.dashNoTaskView.classList.remove('hidden');
      if (dom.dashActiveTaskView) dom.dashActiveTaskView.classList.add('hidden');
      if (dom.dashTaskStatusBadge) dom.dashTaskStatusBadge.innerText = 'Idle';
    } else {
      if (dom.dashNoTaskView) dom.dashNoTaskView.classList.add('hidden');
      if (dom.dashActiveTaskView) dom.dashActiveTaskView.classList.remove('hidden');
      if (dom.dashTaskId) dom.dashTaskId.innerText = activeTask.id;
      if (dom.dashTaskPrompt) dom.dashTaskPrompt.innerText = activeTask.prompt;
      if (dom.dashTaskRound) dom.dashTaskRound.innerText = `Round ${activeTask.roundNumber || 1}`;
      if (dom.dashTaskStatusBadge) dom.dashTaskStatusBadge.innerText = (activeTask.status || 'running').toUpperCase();

      const pendingAppr = (state.pendingApprovals || []).find((a) => a.taskId === activeTask.id && a.status === 'pending');
      if (dom.dashTaskApprovalStatus) {
        dom.dashTaskApprovalStatus.innerText = pendingAppr ? 'Awaiting Human Approval' : 'None';
      }
    }

    // Pending Approvals
    const pending = (state.pendingApprovals || []).filter((a) => a.status === 'pending');
    if (dom.dashPendingCountBadge) {
      dom.dashPendingCountBadge.innerText = `${pending.length} Pending`;
    }
    if (dom.dashApprovalsList) {
      if (pending.length === 0) {
        dom.dashApprovalsList.innerHTML = '<div class="empty-state-sm">No pending approvals required.</div>';
      } else {
        dom.dashApprovalsList.innerHTML = pending
          .map(
            (appr) => `
            <div class="approval-card-item">
              <div class="approval-info">
                <strong>${escapeHtml(appr.description || 'Live Workspace Modification')}</strong>
                <div class="approval-sub">Task: ${escapeHtml(appr.taskId)} | Created: ${formatTime(appr.createdAt)}</div>
              </div>
              <div class="approval-btns">
                <button class="btn btn-xs btn-success" onclick="window.resolveApproval('${appr.id}', true)">Approve</button>
                <button class="btn btn-xs btn-danger" onclick="window.resolveApproval('${appr.id}', false)">Reject</button>
              </div>
            </div>
          `,
          )
          .join('');
      }
    }

    // Recent Audit Stream
    if (dom.dashAuditStream) {
      const recentStages = state.recentStages || [];
      if (recentStages.length === 0) {
        dom.dashAuditStream.innerHTML = '<div class="empty-state-sm">No recent events recorded.</div>';
      } else {
        dom.dashAuditStream.innerHTML = recentStages
          .slice(0, 5)
          .map(
            (st) => `
            <div class="audit-item">
              <span class="audit-time">Just now</span>
              <span class="audit-type badge">STAGE</span>
              <span class="audit-msg">Staged changes created for task <code>${escapeHtml(st.taskId)}</code></span>
            </div>
          `,
          )
          .join('');
      }
    }
  }

  function renderWorkspace() {
    if (dom.taskProviderSelect) dom.taskProviderSelect.value = state.activeProviderId;
    if (dom.taskModeSelect) dom.taskModeSelect.value = state.activeMode;

    // Task Switcher Options
    if (dom.taskHistorySelect) {
      const tasks = state.tasks || [];
      const currentSelected = dom.taskHistorySelect.value;
      dom.taskHistorySelect.innerHTML =
        '<option value="">-- Active & Recent Tasks (' + tasks.length + ') --</option>' +
        tasks
          .map(
            (t) =>
              `<option value="${t.id}" ${t.id === state.activeTaskId ? 'selected' : ''}>[${(t.status || 'idle').toUpperCase()}] ${t.id} — ${escapeHtml(
                (t.prompt || '').slice(0, 40),
              )}...</option>`,
          )
          .join('');
      if (currentSelected && tasks.some((t) => t.id === currentSelected)) {
        dom.taskHistorySelect.value = currentSelected;
      }
    }

    const activeTask = (state.tasks || []).find((t) => t.id === state.activeTaskId);
    if (activeTask) {
      if (dom.flowRoundBadge) dom.flowRoundBadge.innerText = `Round ${activeTask.roundNumber || 1}`;
      if (dom.flowStatusBadge) dom.flowStatusBadge.innerText = (activeTask.status || 'running').toUpperCase();

      // Update Workflow Stepper reactively
      updateStepper(activeTask.status);

      // Render Diff if present
      if (activeTask.lastDiff) {
        renderDiff(activeTask.lastDiff, dom.diffViewBox, dom.diffStatsBadge);
      } else {
        if (dom.diffViewBox) {
          dom.diffViewBox.innerHTML = '<div class="diff-placeholder">No staged diff available for this round.</div>';
        }
        if (dom.diffStatsBadge) dom.diffStatsBadge.innerText = '+0 / -0';
      }
    } else {
      if (dom.flowRoundBadge) dom.flowRoundBadge.innerText = 'Round 1';
      if (dom.flowStatusBadge) dom.flowStatusBadge.innerText = 'Idle';
      updateStepper('idle');
      if (dom.diffViewBox) {
        dom.diffViewBox.innerHTML = '<div class="diff-placeholder">Submit a task to observe provider diff proposals.</div>';
      }
      if (dom.diffStatsBadge) dom.diffStatsBadge.innerText = '+0 / -0';
    }
  }

  function updateStepper(status) {
    const s = (status || '').toLowerCase();
    const steps = [
      document.getElementById('step-1'),
      document.getElementById('step-2'),
      document.getElementById('step-3'),
      document.getElementById('step-4'),
      document.getElementById('step-5'),
    ];

    steps.forEach((el) => {
      if (!el) return;
      el.classList.remove('active', 'completed');
    });

    if (s === 'submitted' || s === 'created') {
      if (steps[0]) steps[0].classList.add('active');
    } else if (s === 'running' || s === 'capturing') {
      if (steps[0]) steps[0].classList.add('completed');
      if (steps[1]) steps[1].classList.add('active');
    } else if (s === 'validating' || s === 'intake') {
      if (steps[0]) steps[0].classList.add('completed');
      if (steps[1]) steps[1].classList.add('completed');
      if (steps[2]) steps[2].classList.add('active');
    } else if (s === 'staged' || s === 'ready_for_review') {
      if (steps[0]) steps[0].classList.add('completed');
      if (steps[1]) steps[1].classList.add('completed');
      if (steps[2]) steps[2].classList.add('completed');
      if (steps[3]) steps[3].classList.add('active');
    } else if (s === 'completed' || s === 'approved') {
      steps.forEach((el) => el && el.classList.add('completed'));
    } else {
      if (steps[0]) steps[0].classList.add('active');
    }
  }

  function renderDiff(diffText, containerEl, statsBadgeEl) {
    if (!containerEl) return;
    if (!diffText) {
      containerEl.innerHTML = '<div class="diff-placeholder">Empty diff.</div>';
      if (statsBadgeEl) statsBadgeEl.innerText = '+0 / -0';
      return;
    }

    let addCount = 0;
    let delCount = 0;
    const lines = diffText.split('\n');

    containerEl.innerHTML = lines
      .map((line) => {
        let cls = 'diff-line';
        if (line.startsWith('+') && !line.startsWith('+++')) {
          cls += ' add';
          addCount++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          cls += ' del';
          delCount++;
        } else if (line.startsWith('@@') || line.startsWith('diff') || line.startsWith('---') || line.startsWith('+++')) {
          cls += ' info';
        }
        return `<div class="${cls}">${escapeHtml(line)}</div>`;
      })
      .join('');

    if (statsBadgeEl) {
      statsBadgeEl.innerText = `+${addCount} / -${delCount}`;
    }
  }

  function renderStaging() {
    const stages = state.recentStages || [];
    if (!dom.stagingList) return;

    if (stages.length === 0) {
      dom.stagingList.innerHTML = '<div class="empty-state-sm">No shadow stages currently active.</div>';
      if (dom.stagingDiffId) dom.stagingDiffId.innerText = 'None selected';
      if (dom.stagingDiffContent) dom.stagingDiffContent.innerText = 'No stages staged.';
      return;
    }

    dom.stagingList.innerHTML = stages
      .map(
        (st, idx) => `
        <div class="stage-item ${idx === 0 ? 'selected' : ''}" data-stage-id="${st.id}" onclick="window.inspectStage('${st.id}')">
          <div class="stage-item-title font-mono">${escapeHtml(st.id)}</div>
          <div class="stage-item-sub">Task: ${escapeHtml(st.taskId)} | File: ${escapeHtml(st.filePath || 'multiple')}</div>
        </div>
      `,
      )
      .join('');

    if (stages[0]) {
      window.inspectStage(stages[0].id);
    }
  }

  function renderProviders() {
    const cards = [
      { id: 'gemini', elem: document.getElementById('card-provider-gemini'), convElem: document.getElementById('gemini-conv-id') },
      { id: 'openai', elem: document.getElementById('card-provider-openai'), convElem: document.getElementById('chatgpt-conv-id') },
      { id: 'deepseek', elem: document.getElementById('card-provider-deepseek'), convElem: document.getElementById('deepseek-conv-id') },
      { id: 'claude', elem: document.getElementById('card-provider-claude'), convElem: null },
    ];

    cards.forEach(({ id, elem, convElem }) => {
      if (!elem) return;
      const isSelected = state.activeProviderId === id;
      elem.style.borderColor = isSelected ? 'var(--accent-cyan)' : 'var(--border-subtle)';
      if (convElem) {
        convElem.innerText = state.activeConversation?.providerId === id ? state.activeConversation.conversationId || 'active-tab' : 'idle';
      }
    });
  }

  function renderAutopilot() {
    if (dom.autopilotReasonsList) {
      const reasons = state.autopilotBlockingReasons || [];
      if (reasons.length > 0) {
        dom.autopilotReasonsList.innerHTML = reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('');
      } else {
        dom.autopilotReasonsList.innerHTML =
          '<li>Authoritative S00 decision is NO-GO-AUTOEXEC (Review-only mode active; automated execution forbidden).</li>' +
          '<li>Child-process confinement is unverified (Job Object Required).</li>' +
          '<li>Network default-deny is unverified (Open on Windows 11 Home).</li>';
      }
    }
  }

  function renderAuditLogs() {
    if (!dom.auditTableBody) return;
    if (clearedAuditLogs) {
      dom.auditTableBody.innerHTML = '<tr><td colspan="3" class="text-muted text-center py-4">Audit log view cleared. New events will appear as they occur.</td></tr>';
      return;
    }

    const allEvents = [];
    (state.tasks || []).forEach((t) => {
      (t.events || []).forEach((e) => {
        allEvents.push({ ...e, taskId: t.id });
      });
    });
    allEvents.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // Filter events
    const filtered = allEvents.filter((ev) => {
      if (auditFilterType !== 'ALL') {
        const typeStr = (ev.type || '').toUpperCase();
        if (auditFilterType === 'TASK' && !typeStr.includes('TASK')) return false;
        if (auditFilterType === 'STAGE' && !typeStr.includes('STAGE') && !typeStr.includes('PATCH')) return false;
        if (auditFilterType === 'APPROVAL' && !typeStr.includes('APPROVAL')) return false;
        if (auditFilterType === 'SECURITY' && !typeStr.includes('AUTOPILOT') && !typeStr.includes('SECURITY')) return false;
      }

      if (auditSearchQuery) {
        const query = auditSearchQuery.toLowerCase();
        const msg = (ev.message || '').toLowerCase();
        const type = (ev.type || '').toLowerCase();
        const taskId = (ev.taskId || '').toLowerCase();
        return msg.includes(query) || type.includes(query) || taskId.includes(query);
      }

      return true;
    });

    if (filtered.length === 0) {
      dom.auditTableBody.innerHTML = '<tr><td colspan="3" class="text-muted text-center py-4">No audit events match current filters.</td></tr>';
      return;
    }

    dom.auditTableBody.innerHTML = filtered
      .slice(0, 100)
      .map(
        (ev) => `
        <tr>
          <td>${formatTime(ev.timestamp)}</td>
          <td><span class="badge font-mono">${escapeHtml(ev.type || 'EVENT')}</span></td>
          <td>[${escapeHtml(ev.taskId)}] ${escapeHtml(ev.message || '')}</td>
        </tr>
      `,
      )
      .join('');
  }

  // ─── Actions & Event Handlers ─────────────────────────────────────────────

  // Loop Toggle
  if (dom.loopToggleInput) {
    dom.loopToggleInput.addEventListener('change', async (e) => {
      try {
        const res = await api('/api/loop/toggle', {
          method: 'POST',
          body: JSON.stringify({ enable: e.target.checked }),
        });
        state.loopEnabled = res.loopEnabled;
        state.loopStatus = res.loopStatus;
        renderHeader();
        showToast(`Provider Loop ${res.loopEnabled ? 'Enabled' : 'Disabled'}`, 'info');
      } catch {
        e.target.checked = !e.target.checked;
      }
    });
  }

  // Autopilot Toggle (Fail-closed evaluation under S00)
  if (dom.autopilotToggleInput) {
    dom.autopilotToggleInput.addEventListener('change', async (e) => {
      try {
        const res = await api('/api/autopilot/toggle', {
          method: 'POST',
          body: JSON.stringify({ enable: e.target.checked }),
        });
        state.autopilotEnabled = res.autopilotEnabled;
        state.autopilotStatus = res.autopilotStatus;
        renderHeader();
        if (!res.canRun) {
          showToast(`Autopilot blocked by security gate (S00 NO-GO-AUTOEXEC)`, 'error');
        }
      } catch {
        e.target.checked = !e.target.checked;
      }
    });
  }

  // Submit Task Function
  async function submitTask() {
    if (!dom.taskPromptInput) return;
    const prompt = dom.taskPromptInput.value.trim();
    if (!prompt) {
      showToast('Please enter a task prompt', 'error');
      dom.taskPromptInput.focus();
      return;
    }

    try {
      if (dom.btnSubmitTask) dom.btnSubmitTask.disabled = true;
      const res = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          prompt,
          providerId: dom.taskProviderSelect ? dom.taskProviderSelect.value : state.activeProviderId,
          mode: dom.taskModeSelect ? dom.taskModeSelect.value : 'browser',
        }),
      });

      if (res.ok && res.task) {
        dom.taskPromptInput.value = '';
        state.activeTaskId = res.task.id;
        state.tasks = state.tasks || [];
        state.tasks.unshift(res.task);
        renderAll();
        showToast(`Task ${res.task.id} submitted!`, 'success');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      if (dom.btnSubmitTask) dom.btnSubmitTask.disabled = false;
    }
  }

  if (dom.btnSubmitTask) {
    dom.btnSubmitTask.addEventListener('click', submitTask);
  }

  // Keyboard Submit Shortcut (Ctrl+Enter / Cmd+Enter)
  if (dom.taskPromptInput) {
    dom.taskPromptInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        submitTask();
      }
    });
  }

  // Task Switcher Dropdown
  if (dom.taskHistorySelect) {
    dom.taskHistorySelect.addEventListener('change', (e) => {
      const selectedId = e.target.value;
      if (selectedId) {
        state.activeTaskId = selectedId;
        renderAll();
        showToast(`Switched view to task ${selectedId}`, 'info');
      }
    });
  }

  // Templates
  if (dom.btnTemplateLint) {
    dom.btnTemplateLint.addEventListener('click', () => {
      if (dom.taskPromptInput) {
        dom.taskPromptInput.value = 'Fix all lint errors and typecheck warnings across the workspace, ensuring no build regressions.';
        dom.taskPromptInput.focus();
      }
    });
  }
  if (dom.btnTemplateTest) {
    dom.btnTemplateTest.addEventListener('click', () => {
      if (dom.taskPromptInput) {
        dom.taskPromptInput.value = 'Add unit tests for the newly added services, validating edge cases, malformed inputs, and recovery.';
        dom.taskPromptInput.focus();
      }
    });
  }
  if (dom.btnTemplateRefactor) {
    dom.btnTemplateRefactor.addEventListener('click', () => {
      if (dom.taskPromptInput) {
        dom.taskPromptInput.value = 'Refactor the module for enhanced modularity, clean error boundaries, and eliminate duplicate logic.';
        dom.taskPromptInput.focus();
      }
    });
  }
  if (dom.btnTemplateSecurity) {
    dom.btnTemplateSecurity.addEventListener('click', () => {
      if (dom.taskPromptInput) {
        dom.taskPromptInput.value = 'Audit input validation, enforce path traversal bounds, sanitize diagnostic logs, and verify fail-closed boundaries.';
        dom.taskPromptInput.focus();
      }
    });
  }

  // Simulation Dispatch
  if (dom.btnSimLoadValid) {
    dom.btnSimLoadValid.addEventListener('click', () => {
      if (dom.simEnvelopeInput) {
        const taskId = state.activeTaskId || 'task_demo_1';
        dom.simEnvelopeInput.value = JSON.stringify(
          {
            protocolVersion: '1.3',
            taskId,
            sessionId: 'sess_' + taskId,
            nonce: 'nonce_1234567890abcdef',
            round: 1,
            sequence: 1,
            conversation: {
              provider: state.activeProviderId || 'gemini',
              conversationId: state.activeConversation?.conversationId || 'c1',
            },
            baseStateHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            status: 'continue',
            actions: [
              {
                id: 'act_patch_1',
                type: 'propose_patch',
                path: 'src/calc.js',
                expectedBaseHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                contentBlockId: 'cb_1',
              },
            ],
            contentBlocks: [
              {
                id: 'cb_1',
                delimiter: '---BLOCK-cb_1---',
                encoding: 'utf-8',
                byteLength: 58,
                sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                content: '// Fixed calculation\\nexport function add(a, b) {\\n  return a + b;\\n}\\n',
              },
            ],
          },
          null,
          2,
        );
      }
    });
  }

  if (dom.btnSimDispatch) {
    dom.btnSimDispatch.addEventListener('click', async () => {
      if (!state.activeTaskId) {
        showToast('No active task. Create a task first.', 'error');
        return;
      }
      const raw = dom.simEnvelopeInput ? dom.simEnvelopeInput.value.trim() : '';
      if (!raw) {
        showToast('Simulation envelope is empty.', 'error');
        return;
      }

      try {
        dom.btnSimDispatch.disabled = true;
        const res = await api(`/api/tasks/${state.activeTaskId}/response`, {
          method: 'POST',
          body: JSON.stringify({ response: raw }),
        });
        if (res.ok) {
          showToast('Provider response validated and staged!', 'success');
          fetchState().catch(() => {});
        }
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        dom.btnSimDispatch.disabled = false;
      }
    });
  }

  // Task Controls (Shared for both Dashboard and Workspace)
  async function pauseCurrentTask() {
    if (!state.activeTaskId) return;
    try {
      await api(`/api/tasks/${state.activeTaskId}/pause`, { method: 'POST' });
      showToast(`Task ${state.activeTaskId} paused`, 'info');
      fetchState().catch(() => {});
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
  async function resumeCurrentTask() {
    if (!state.activeTaskId) return;
    try {
      await api(`/api/tasks/${state.activeTaskId}/resume`, { method: 'POST' });
      showToast(`Task ${state.activeTaskId} resumed`, 'info');
      fetchState().catch(() => {});
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
  async function cancelCurrentTask() {
    if (!state.activeTaskId) return;
    try {
      await api(`/api/tasks/${state.activeTaskId}/cancel`, { method: 'POST' });
      showToast(`Task ${state.activeTaskId} cancelled`, 'warning');
      fetchState().catch(() => {});
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  if (dom.btnTaskPause) dom.btnTaskPause.addEventListener('click', pauseCurrentTask);
  if (dom.btnTaskResume) dom.btnTaskResume.addEventListener('click', resumeCurrentTask);
  if (dom.btnTaskCancel) dom.btnTaskCancel.addEventListener('click', cancelCurrentTask);
  if (dom.btnDashPauseTask) dom.btnDashPauseTask.addEventListener('click', pauseCurrentTask);
  if (dom.btnDashResumeTask) dom.btnDashResumeTask.addEventListener('click', resumeCurrentTask);
  if (dom.btnDashCancelTask) dom.btnDashCancelTask.addEventListener('click', cancelCurrentTask);

  // Copy Diff Action
  if (dom.btnCopyDiff) {
    dom.btnCopyDiff.addEventListener('click', () => {
      const activeTask = (state.tasks || []).find((t) => t.id === state.activeTaskId);
      const diff = activeTask?.lastDiff;
      if (diff) {
        navigator.clipboard.writeText(diff);
        dom.btnCopyDiff.innerText = '✓ Copied!';
        setTimeout(() => {
          dom.btnCopyDiff.innerText = '📋 Copy Diff';
        }, 1500);
        showToast('Diff copied to clipboard', 'info');
      } else {
        showToast('No diff available to copy', 'warning');
      }
    });
  }

  // Approvals
  window.resolveApproval = async (approvalId, approved) => {
    try {
      const pendingRec = (state.pendingApprovals || []).find((a) => a.id === approvalId);
      const stageId = pendingRec?.stageId;

      const res = await api(`/api/approvals/${approvalId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ approved, reason: approved ? 'Approved by user via UI' : 'Rejected by user' }),
      });
      if (res.ok) {
        const targetStageId = stageId || res.approval?.stageId;
        if (approved && targetStageId) {
          try {
            const applyRes = await api(`/api/stages/${targetStageId}/apply`, {
              method: 'POST',
              body: JSON.stringify({ approvalId, callerOrigin: 'trusted_ui' }),
            });
            if (applyRes.ok) {
              const txId = applyRes.result?.transactionId || 'complete';
              showToast(`Stage applied to workspace! Tx: ${txId}`, 'success');
            } else {
              showToast(`Apply failed: ${applyRes.error?.message || 'Unknown error'}`, 'error');
            }
          } catch (applyErr) {
            showToast(`Apply failed: ${applyErr.message}`, 'error');
          }
        } else {
          showToast(`Approval ${approvalId} ${approved ? 'approved' : 'rejected'}`, approved ? 'success' : 'warning');
        }
        await fetchState().catch(() => {});
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  if (dom.btnApproveStage) {
    dom.btnApproveStage.addEventListener('click', () => {
      const pending = (state.pendingApprovals || []).find((a) => a.status === 'pending');
      if (pending) {
        window.resolveApproval(pending.id, true);
      } else {
        showToast('No pending stage approval found.', 'warning');
      }
    });
  }

  if (dom.btnRejectStage) {
    dom.btnRejectStage.addEventListener('click', () => {
      const pending = (state.pendingApprovals || []).find((a) => a.status === 'pending');
      if (pending) {
        window.resolveApproval(pending.id, false);
      } else {
        showToast('No pending stage approval found.', 'warning');
      }
    });
  }

  // Inspect Stage in Staging Tab
  window.inspectStage = (stageId) => {
    const stages = state.recentStages || [];
    const st = stages.find((s) => s.id === stageId);
    if (st) {
      if (dom.stagingDiffId) dom.stagingDiffId.innerText = st.id;
      if (dom.stagingDiffContent) dom.stagingDiffContent.innerText = st.diffPreview || 'No diff preview recorded';

      // Update active selection highlighting
      document.querySelectorAll('.stage-item').forEach((el) => {
        el.classList.toggle('selected', el.getAttribute('data-stage-id') === stageId);
      });
    }
  };

  if (dom.btnCopyStageDiff) {
    dom.btnCopyStageDiff.addEventListener('click', () => {
      if (dom.stagingDiffContent && dom.stagingDiffContent.innerText) {
        navigator.clipboard.writeText(dom.stagingDiffContent.innerText);
        dom.btnCopyStageDiff.innerText = '✓ Copied!';
        setTimeout(() => {
          dom.btnCopyStageDiff.innerText = '📋 Copy Diff';
        }, 1500);
        showToast('Stage diff copied to clipboard', 'info');
      }
    });
  }

  if (dom.btnStageApprove) {
    dom.btnStageApprove.addEventListener('click', () => {
      const pending = (state.pendingApprovals || []).find((a) => a.status === 'pending');
      if (pending) {
        window.resolveApproval(pending.id, true);
      } else {
        showToast('No pending approval associated with this stage.', 'warning');
      }
    });
  }

  if (dom.btnStageReject) {
    dom.btnStageReject.addEventListener('click', () => {
      const pending = (state.pendingApprovals || []).find((a) => a.status === 'pending');
      if (pending) {
        window.resolveApproval(pending.id, false);
      } else {
        showToast('No pending approval associated with this stage.', 'warning');
      }
    });
  }

  // Provider selection
  window.selectProvider = async (providerId) => {
    try {
      const res = await api('/api/providers/select', {
        method: 'POST',
        body: JSON.stringify({ providerId }),
      });
      if (res.ok) {
        state.activeProviderId = res.selectedProvider;
        renderAll();
        showToast(`Active provider switched to ${getProviderDisplayName(providerId)}`, 'success');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // Re-check Autopilot Gating
  if (dom.btnRecheckAutopilot) {
    dom.btnRecheckAutopilot.addEventListener('click', async () => {
      try {
        dom.btnRecheckAutopilot.disabled = true;
        const res = await api('/api/diagnostics');
        if (res.ok && res.report) {
          showToast(`Security evaluation complete: Autopilot policy is ${res.report.autopilotPolicy} (S00 NO-GO)`, 'info');
          fetchState().catch(() => {});
        }
      } finally {
        dom.btnRecheckAutopilot.disabled = false;
      }
    });
  }

  // Workspace Switch Modal
  if (dom.btnChangeWs) {
    dom.btnChangeWs.addEventListener('click', async () => {
      try {
        const wsRes = await apiClient.getWorkspace();
        if (wsRes.ok) {
          state.workspaceRoot = wsRes.workspaceRoot;
          state.workspaceConfirmed = Boolean(wsRes.confirmed);
          renderHeader();
        }
      } catch (err) {
        console.warn('Could not refresh workspace before modal open:', err.message);
      }
      if (dom.wsInputPath) dom.wsInputPath.value = state.workspaceRoot || '';
      if (dom.wsModal) dom.wsModal.classList.remove('hidden');
    });
  }
  if (dom.btnCloseWsModal) {
    dom.btnCloseWsModal.addEventListener('click', () => dom.wsModal && dom.wsModal.classList.add('hidden'));
  }
  if (dom.btnCancelWsModal) {
    dom.btnCancelWsModal.addEventListener('click', () => dom.wsModal && dom.wsModal.classList.add('hidden'));
  }
  if (dom.btnConfirmWsModal) {
    dom.btnConfirmWsModal.addEventListener('click', async () => {
      const root = dom.wsInputPath ? dom.wsInputPath.value.trim() : '';
      if (!root) {
        showToast('Please provide a valid workspace directory path.', 'warning');
        return;
      }
      try {
        dom.btnConfirmWsModal.disabled = true;
        const res = await apiClient.setWorkspace(root, true);
        if (res.ok) {
          state.workspaceRoot = res.workspaceRoot;
          state.workspaceConfirmed = Boolean(res.confirmed);
          if (dom.wsModal) dom.wsModal.classList.add('hidden');
          showToast(`Active workspace updated to: ${res.workspaceRoot}`, 'success');
          renderHeader();
          fetchState().catch(() => {});
        }
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        dom.btnConfirmWsModal.disabled = false;
      }
    });
  }

  // API Endpoint Config Modal
  if (dom.btnConfigApi) {
    dom.btnConfigApi.addEventListener('click', () => {
      if (dom.apiUrlInput) dom.apiUrlInput.value = apiClient.getBaseUrl();
      if (dom.apiTokenInput) dom.apiTokenInput.value = apiClient.getToken();
      if (dom.apiConfigModal) dom.apiConfigModal.classList.remove('hidden');
    });
  }
  if (dom.btnCloseApiModal) {
    dom.btnCloseApiModal.addEventListener('click', () => {
      if (dom.apiConfigModal) dom.apiConfigModal.classList.add('hidden');
    });
  }
  if (dom.btnCancelApiModal) {
    dom.btnCancelApiModal.addEventListener('click', () => {
      if (dom.apiConfigModal) dom.apiConfigModal.classList.add('hidden');
    });
  }
  if (dom.btnTestApiModal) {
    dom.btnTestApiModal.addEventListener('click', async () => {
      const targetUrl = dom.apiUrlInput ? dom.apiUrlInput.value.trim() : '';
      const targetToken = dom.apiTokenInput ? dom.apiTokenInput.value.trim() : apiClient.getToken();
      if (!targetUrl) return;
      try {
        dom.btnTestApiModal.disabled = true;
        const testRes = await fetch(`${targetUrl.replace(/\/+$/, '')}/api/diagnostics`, {
          headers: targetToken ? { 'X-Mediator-Token': targetToken } : {},
        });
        if (testRes.ok) {
          showToast(`Successfully connected to Core API at ${targetUrl}!`, 'success');
        } else {
          showToast(`Core API returned HTTP ${testRes.status}`, 'warning');
        }
      } catch (err) {
        showToast(`Failed connecting to ${targetUrl}: ${err.message}`, 'error');
      } finally {
        dom.btnTestApiModal.disabled = false;
      }
    });
  }
  if (dom.btnSaveApiModal) {
    dom.btnSaveApiModal.addEventListener('click', async () => {
      const targetUrl = dom.apiUrlInput ? dom.apiUrlInput.value.trim() : '';
      const targetToken = dom.apiTokenInput ? dom.apiTokenInput.value.trim() : '';
      if (!targetUrl) return;
      const clean = targetUrl.replace(/\/+$/, '');
      try {
        localStorage.setItem('mediator_api_base', clean);
        if (targetToken) {
          localStorage.setItem('mediator_token', targetToken);
        }
      } catch (_) {}
      apiClient.setBaseUrl(clean);
      if (targetToken) {
        token = targetToken;
        apiClient.setToken(targetToken);
      }
      updateApiDisplay();
      if (dom.apiConfigModal) dom.apiConfigModal.classList.add('hidden');
      showToast(`Core API endpoint updated to ${clean}. Reconnecting...`, 'info');
      await initApp();
    });
  }

  // Token Copy
  if (dom.btnCopyToken) {
    dom.btnCopyToken.addEventListener('click', () => {
      const t = state.pairingToken || token;
      if (t) {
        navigator.clipboard.writeText(t);
        dom.btnCopyToken.innerText = '✓';
        setTimeout(() => {
          dom.btnCopyToken.innerText = '📋';
        }, 1500);
        showToast('Pairing token copied to clipboard', 'info');
      }
    });
  }

  // Audit Logs Search & Filters
  if (dom.auditSearchInput) {
    dom.auditSearchInput.addEventListener('input', (e) => {
      auditSearchQuery = e.target.value.trim();
      clearedAuditLogs = false;
      renderAuditLogs();
    });
  }
  if (dom.auditFilterSelect) {
    dom.auditFilterSelect.addEventListener('change', (e) => {
      auditFilterType = e.target.value;
      clearedAuditLogs = false;
      renderAuditLogs();
    });
  }
  if (dom.btnClearLogsView) {
    dom.btnClearLogsView.addEventListener('click', () => {
      clearedAuditLogs = true;
      renderAuditLogs();
      showToast('Audit log view cleared', 'info');
    });
  }

  // ─── Diagnostics & Health (S48) ───────────────────────────────────────────

  async function loadDiagnostics() {
    try {
      if (dom.btnRefreshDiag) dom.btnRefreshDiag.disabled = true;
      const res = await api('/api/diagnostics');
      if (res.ok && res.report) {
        activeDiagReport = res.report;
        renderDiagnostics(res.report);
      }
    } catch (err) {
      showToast('Failed to load diagnostics: ' + err.message, 'error');
    } finally {
      if (dom.btnRefreshDiag) dom.btnRefreshDiag.disabled = false;
    }
  }

  function renderDiagnostics(report) {
    const overallEl = document.getElementById('diag-overall-status');
    const descEl = document.getElementById('diag-overall-desc');
    const badgeEl = document.getElementById('diag-checks-count-badge');
    const tbody = document.getElementById('diag-checks-tbody');
    const navTag = document.getElementById('diagnostics-nav-tag');

    if (overallEl) overallEl.innerText = report.overallStatus;
    if (navTag) {
      navTag.innerText = report.overallStatus;
      navTag.className = `status-indicator-tag ${report.overallStatus === 'HEALTHY' ? 'tag-healthy' : 'tag-blocked'}`;
    }
    if (descEl) descEl.innerText = `${report.osPlatform} (${report.osRelease}) • Node ${report.nodeVersion}`;

    const filteredChecks = (report.checks || []).filter((c) => {
      if (activeDiagFilter === 'ALL') return true;
      return c.status === activeDiagFilter;
    });

    if (badgeEl) badgeEl.innerText = `${filteredChecks.length} Checks`;

    if (tbody) {
      if (filteredChecks.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-muted text-center py-4">No diagnostic checks match filter.</td></tr>';
        return;
      }

      tbody.innerHTML = filteredChecks
        .map((c) => {
          let badgeClass = 'badge-success';
          if (c.status === 'ACTION_REQUIRED') badgeClass = 'badge-warning';
          if (c.status === 'FAILED') badgeClass = 'badge-danger';
          if (c.status === 'UNSUPPORTED') badgeClass = 'badge-secondary';

          return `
            <tr>
              <td><span class="badge ${badgeClass}">${escapeHtml(c.status)}</span></td>
              <td class="font-bold">${escapeHtml(c.name)}</td>
              <td>${escapeHtml(c.detail)}</td>
              <td class="text-xs text-muted">${c.remediation ? escapeHtml(c.remediation) : '—'}</td>
            </tr>
          `;
        })
        .join('');
    }
  }

  // Diagnostic Filter Buttons
  if (dom.diagFilterGroup) {
    dom.diagFilterGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-filter]');
      if (!btn) return;
      dom.diagFilterGroup.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeDiagFilter = btn.getAttribute('data-filter');
      if (activeDiagReport) {
        renderDiagnostics(activeDiagReport);
      }
    });
  }

  if (dom.btnRefreshDiag) {
    dom.btnRefreshDiag.addEventListener('click', () => loadDiagnostics());
  }

  if (dom.btnExportDiag) {
    dom.btnExportDiag.addEventListener('click', async () => {
      try {
        const res = await api('/api/diagnostics/export', { method: 'POST' });
        if (res.ok && res.data) {
          const blob = new Blob([res.data], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `mediator-diagnostics-${Date.now()}.json`;
          a.click();
          URL.revokeObjectURL(url);
          showToast('Sanitized diagnostics exported!', 'success');
        }
      } catch (err) {
        showToast('Export failed: ' + err.message, 'error');
      }
    });
  }

  // ─── Global Keyboard Shortcuts ───────────────────────────────────────────

  window.addEventListener('keydown', (e) => {
    // If active modal is open, Escape closes it
    if (e.key === 'Escape') {
      if (dom.wsModal && !dom.wsModal.classList.contains('hidden')) {
        dom.wsModal.classList.add('hidden');
        return;
      }
      closeMobileDrawer();
      return;
    }

    // Tab switching (1-7) when not focused on text input / textarea
    const targetTag = e.target.tagName ? e.target.tagName.toLowerCase() : '';
    if (targetTag !== 'input' && targetTag !== 'textarea' && targetTag !== 'select') {
      const tabKeys = {
        '1': 'tab-dashboard',
        '2': 'tab-workspace',
        '3': 'tab-staging',
        '4': 'tab-providers',
        '5': 'tab-autopilot',
        '6': 'tab-audit',
        '7': 'tab-diagnostics',
      };
      if (tabKeys[e.key]) {
        e.preventDefault();
        switchTab(tabKeys[e.key]);
      }
    }
  });

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function showToast(msg, type = 'info') {
    if (!dom.toastContainer) return;
    const el = document.createElement('div');
    el.className = 'toast';

    let icon = 'ℹ️';
    if (type === 'error') {
      el.style.borderLeftColor = 'var(--accent-rose)';
      icon = '✕';
    } else if (type === 'success') {
      el.style.borderLeftColor = 'var(--accent-emerald)';
      icon = '✓';
    } else if (type === 'warning') {
      el.style.borderLeftColor = 'var(--accent-amber)';
      icon = '⚠️';
    }

    el.innerHTML = `
      <span style="font-weight: 700; font-size: 0.95rem;">${icon}</span>
      <span class="toast-msg">${escapeHtml(msg)}</span>
      <button class="toast-close-btn" title="Dismiss">✕</button>
    `;

    const closeBtn = el.querySelector('.toast-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => el.remove());
    }

    dom.toastContainer.appendChild(el);
    setTimeout(() => {
      if (el.parentNode) el.remove();
    }, 4500);
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function getProviderDisplayName(id) {
    const map = {
      gemini: 'Google Gemini',
      openai: 'OpenAI ChatGPT',
      deepseek: 'DeepSeek',
      claude: 'Anthropic Claude',
    };
    return map[id] || capitalize(id);
  }

  function basename(p) {
    if (!p) return '';
    const parts = p.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || p;
  }

  function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString();
  }

  function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    const div = document.createElement('div');
    div.innerText = text;
    return div.innerHTML;
  }

  // ─── Startup ─────────────────────────────────────────────────────────────

  async function initApp() {
    updateApiDisplay();

    // 1. Probe unauthenticated /api/status to verify core connectivity and establish pairing token
    try {
      const statusRes = await apiClient.getStatus();
      if (statusRes.ok) {
        const urlToken = new URLSearchParams(window.location.search).get('token');
        if (urlToken) {
          token = urlToken;
        } else if (statusRes.pairingToken) {
          token = statusRes.pairingToken;
        }
        apiClient.setToken(token);
        try { localStorage.setItem('mediator_token', token); } catch (_) {}
        if (statusRes.workspaceRoot !== undefined) {
          state.workspaceRoot = statusRes.workspaceRoot;
          state.workspaceConfirmed = Boolean(statusRes.workspaceConfirmed);
        }
        if (dom.coreStatusDot) {
          dom.coreStatusDot.classList.add('pulse');
          dom.coreStatusDot.style.background = 'var(--accent-emerald)';
        }
        if (dom.coreStatusText) {
          dom.coreStatusText.innerText = 'CORE ONLINE';
        }
        renderHeader();
      }
    } catch (err) {
      console.warn('Initial core status probe failed:', err.message);
    }

    // 2. Refresh workspace status and fetch state snapshot
    fetchWorkspaceStatus().finally(() => {
      fetchState().then(connectSse).catch(connectSse);
    });

    window.__mediatorState = state;
    window.getState = () => state;
  }

  initApp();
})();
