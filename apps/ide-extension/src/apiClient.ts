/**
 * @mediator/ide-extension — Mediator Core API Client (Phase 6)
 *
 * Thin client connecting the IDE extension to the local Mediator Core loopback API (http://127.0.0.1:3300).
 * Handles authentication headers, error classification, and real backend task/conversation coordination.
 */

export interface IdeApiClientOptions {
  readonly baseUrl?: string;
  readonly token?: string;
}

export interface CoreStatusPayload {
  readonly ok: boolean;
  readonly status: string;
  readonly coreVersion: string;
  readonly protocolVersion: string;
  readonly workspaceRoot: string | null;
  readonly workspaceConfirmed: boolean;
  readonly activeProviderId: string;
  readonly loopStatus: string;
  readonly autopilotStatus: string;
  readonly pairingToken?: string;
}

export interface TaskRecordPayload {
  readonly id: string;
  readonly prompt: string;
  readonly providerId: string;
  readonly mode: string;
  readonly conversationId?: string;
  readonly roundCount: number;
  readonly state: string;
  readonly lastDiff?: string;
  readonly pendingApprovalId?: string;
  readonly conversationHistory?: readonly ConversationMessagePayload[];
}

export interface ConversationMessagePayload {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool' | 'system';
  readonly content: string;
  readonly timestamp: number;
  readonly commandRequest?: {
    readonly command: string;
    readonly args: Record<string, unknown>;
  };
  readonly commandResult?: {
    readonly command: string;
    readonly result?: unknown;
    readonly error?: string;
  };
  readonly proposal?: {
    readonly path: string;
    readonly content: string;
  };
  readonly testResult?: {
    readonly exitCode: number;
    readonly output: string;
    readonly passed: boolean;
  };
}

export interface ApprovalRecordPayload {
  readonly id: string;
  readonly taskId: string;
  readonly stageId: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'applied';
  readonly description?: string;
}

export class IdeApiClient {
  private baseUrl: string;
  private token: string;

  constructor(options?: IdeApiClientOptions) {
    this.baseUrl = (options?.baseUrl || 'http://127.0.0.1:3300').replace(/\/+$/, '');
    this.token = options?.token || '';
  }

  public setBaseUrl(url: string): void {
    this.baseUrl = (url || 'http://127.0.0.1:3300').replace(/\/+$/, '');
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public setToken(token: string): void {
    this.token = token || '';
  }

  public getToken(): string {
    return this.token;
  }

  private async request<T = unknown>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const isAbsolute = endpoint.startsWith('http://') || endpoint.startsWith('https://');
    let fullUrl = isAbsolute
      ? endpoint
      : `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

    if (this.token && !fullUrl.includes('token=')) {
      const sep = fullUrl.includes('?') ? '&' : '?';
      fullUrl = `${fullUrl}${sep}token=${encodeURIComponent(this.token)}`;
    }

    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
    };

    if (this.token) {
      headers['X-Mediator-Token'] = this.token;
    }

    if (options.body && typeof options.body === 'string') {
      headers['Content-Type'] = 'application/json';
    }

    const mergedInit: RequestInit = {
      ...options,
      headers: {
        ...headers,
        ...(options.headers as Record<string, string> | undefined),
      },
    };

    const res = await fetch(fullUrl, mergedInit);
    const text = await res.text();
    const trimmed = text.trim();

    if (!trimmed) {
      if (res.ok) {
        return { ok: true } as unknown as T;
      }
      throw new Error(`Empty response from Core API ${endpoint} (HTTP ${res.status})`);
    }

    try {
      const data = JSON.parse(trimmed) as T;
      if (!res.ok) {
        const errorRecord = data as Record<string, unknown>;
        const errMsg =
          typeof errorRecord.error === 'object' && errorRecord.error !== null
            ? (errorRecord.error as Record<string, string>).message ?? JSON.stringify(errorRecord.error)
            : typeof errorRecord.error === 'string'
              ? errorRecord.error
              : typeof errorRecord.message === 'string'
                ? errorRecord.message
                : `HTTP ${res.status} error from ${endpoint}`;
        throw new Error(errMsg);
      }
      return data;
    } catch (parseErr) {
      if (!res.ok) {
        throw new Error(`Core API error ${res.status}: ${trimmed.slice(0, 150)}`);
      }
      throw parseErr;
    }
  }

  public async getStatus(): Promise<CoreStatusPayload> {
    const res = await this.request<CoreStatusPayload>('/api/status');
    if (res.pairingToken && !this.token) {
      this.token = res.pairingToken;
    }
    return res;
  }

  public async getWorkspace(): Promise<{ ok: boolean; workspaceRoot: string | null; confirmed: boolean }> {
    return this.request('/api/workspace');
  }

  public async setWorkspace(root: string, confirm = true): Promise<{ ok: boolean; workspaceRoot: string; confirmed?: boolean }> {
    return this.request('/api/workspace', {
      method: 'POST',
      body: JSON.stringify({ root, confirm }),
    });
  }

  public async listProviders(): Promise<{ ok: boolean; providers: unknown[]; activeProviderId: string; activeMode: string }> {
    return this.request('/api/providers');
  }

  public async selectProvider(providerId: string): Promise<{ ok: boolean; selectedProvider: string }> {
    return this.request('/api/providers/select', {
      method: 'POST',
      body: JSON.stringify({ providerId }),
    });
  }

  public async createTask(params: {
    prompt: string;
    providerId?: string;
    mode?: string;
    conversationId?: string;
  }): Promise<{ ok: boolean; task: TaskRecordPayload }> {
    return this.request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        prompt: params.prompt,
        providerId: params.providerId ?? 'gemini',
        mode: params.mode ?? 'browser',
        conversationId: params.conversationId,
      }),
    });
  }

  public async listTasks(): Promise<{ ok: boolean; tasks: TaskRecordPayload[] }> {
    return this.request('/api/tasks');
  }

  public async getTask(taskId: string): Promise<{ ok: boolean; task: TaskRecordPayload }> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}`);
  }

  public async getTaskConversation(taskId: string): Promise<{
    ok: boolean;
    conversation: {
      taskId: string;
      providerId: string;
      conversationId: string;
      history: readonly ConversationMessagePayload[];
      iterationCount: number;
      maxIterations: number;
    } | null;
  }> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/conversation`);
  }

  public async submitFollowUpMessage(taskId: string, message: string): Promise<{ ok: boolean; conversation?: unknown }> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/message`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  public async executeContextCommand(
    taskId: string,
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/command`, {
      method: 'POST',
      body: JSON.stringify({ command, args }),
    });
  }

  public async getAutopilotStatus(): Promise<{ ok: boolean; autopilotStatus: string; autopilotPolicy: string }> {
    return this.request('/api/autopilot/toggle');
  }

  public async toggleAutopilot(enable?: boolean): Promise<{ ok: boolean; autopilotStatus: string; autopilotPolicy: string }> {
    return this.request('/api/autopilot/toggle', {
      method: 'POST',
      body: JSON.stringify({ enable }),
    });
  }

  public async runAutopilot(taskId: string, config?: unknown): Promise<{ ok: boolean; result?: unknown }> {
    return this.request('/api/autopilot/run', {
      method: 'POST',
      body: JSON.stringify({ taskId, config }),
    });
  }

  public async cancelAutopilot(taskId: string, reason?: string): Promise<{ ok: boolean; cancelled: boolean }> {
    return this.request('/api/autopilot/cancel', {
      method: 'POST',
      body: JSON.stringify({ taskId, reason }),
    });
  }

  public async listApprovals(): Promise<{ ok: boolean; approvals: ApprovalRecordPayload[] }> {
    return this.request('/api/approvals');
  }

  public async resolveApproval(approvalId: string, approved: boolean, reason?: string): Promise<{ ok: boolean; approval?: ApprovalRecordPayload }> {
    return this.request(`/api/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ approved, reason }),
    });
  }

  public async applyStage(stageId: string, approvalId: string): Promise<{ ok: boolean; result?: { transactionId?: string } }> {
    return this.request(`/api/stages/${encodeURIComponent(stageId)}/apply`, {
      method: 'POST',
      body: JSON.stringify({ approvalId, callerOrigin: 'trusted_ide' }),
    });
  }
}
