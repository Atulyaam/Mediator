/**
 * @mediator/standalone-ui — Robust Shared API Client & Response Handler
 *
 * Requirements:
 * - Read each response body at most once.
 * - Handle HTTP 204 No Content correctly without throwing JSON syntax errors.
 * - Handle intentionally empty response only when endpoint contract allows it.
 * - Check HTTP status and Content-Type before interpreting response body.
 * - Parse JSON safely and detect empty or malformed response bodies.
 * - For unexpected empty or non-JSON responses, return a typed ApiError with status and endpoint.
 * - For non-2xx responses, preserve structured server error code and message.
 * - Distinguish network/connectivity failures from HTTP failures and JSON parsing failures.
 * - Never convert an invalid response silently into {}, null, or fake success.
 */

export type ApiErrorCode = string;

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;
  public readonly endpoint: string;
  public readonly responseData?: unknown;
  public readonly timestamp: number;

  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    endpoint: string,
    responseData?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.endpoint = endpoint;
    this.responseData = responseData;
    this.timestamp = Date.now();
  }
}

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly onAuthFailure?: () => void;
  readonly onError?: (error: ApiError) => void;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  readonly body?: unknown;
  readonly allowEmptyBody?: boolean;
  readonly silent?: boolean;
}

export interface WorkspaceStatusResponse {
  readonly ok: boolean;
  readonly workspaceRoot: string | null;
  readonly confirmed: boolean;
}

export interface CoreStatusResponse {
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

export interface SetWorkspaceResponse {
  readonly ok: boolean;
  readonly workspaceRoot: string;
  readonly confirmed?: boolean;
}

export class ApiClient {
  private baseUrl: string;
  private token: string;
  private onAuthFailure?: () => void;
  private onError?: (error: ApiError) => void;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl || '').replace(/\/+$/, '');
    this.token = options.token || '';
    this.onAuthFailure = options.onAuthFailure;
    this.onError = options.onError;
  }

  public setBaseUrl(url: string): void {
    this.baseUrl = (url || '').replace(/\/+$/, '');
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

  public async request<T = unknown>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const isAbsolute = endpoint.startsWith('http://') || endpoint.startsWith('https://');
    let fullUrl = isAbsolute
      ? endpoint
      : `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

    // Append token query param if token exists and not already present
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

    let bodyStr: string | undefined = undefined;
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
      const customHeaders = options.headers as Record<string, string>;
      for (const [k, v] of Object.entries(customHeaders)) {
        headers[k] = v;
      }
    }

    const fetchOptions: RequestInit = {
      ...options,
      headers,
      body: bodyStr,
    };

    let res: Response;
    try {
      res = await fetch(fullUrl, fetchOptions);
    } catch (networkErr: unknown) {
      const isAbort = (networkErr as Error)?.name === 'AbortError';
      const errMsg = isAbort
        ? `Request to ${endpoint} was aborted or timed out`
        : `Network connection failed connecting to Mediator Core at ${this.baseUrl || 'current origin'} (${(networkErr as Error)?.message || 'fetch failed'})`;
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
          endpoint,
        );
        this.onError?.(err);
        throw err;
      }
      return { ok: true, status: 204, data: null } as unknown as T;
    }

    // 2. Handle empty response body
    if (trimmed.length === 0) {
      if (options.allowEmptyBody && res.ok) {
        return { ok: true, status: res.status, data: null } as unknown as T;
      }
      const apiErr = new ApiError(
        'EMPTY_RESPONSE',
        `Unexpected empty response body from ${endpoint} (HTTP ${res.status})`,
        res.status,
        endpoint,
      );
      this.onError?.(apiErr);
      throw apiErr;
    }

    // 3. Parse JSON safely
    let parsed: unknown = undefined;
    if (isJson || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch (parseErr: unknown) {
        const snippet = trimmed.slice(0, 100).replace(/[\r\n]+/g, ' ');
        const apiErr = new ApiError(
          'JSON_PARSE_ERROR',
          `Failed to parse JSON response from ${endpoint} (HTTP ${res.status}): ${(parseErr as Error)?.message || 'invalid JSON'}. Snippet: "${snippet}"`,
          res.status,
          endpoint,
        );
        this.onError?.(apiErr);
        throw apiErr;
      }
    } else {
      // Received non-JSON (e.g. HTML 404/500 from Live Server or static server)
      const snippet = trimmed.slice(0, 100).replace(/[\r\n]+/g, ' ');
      const apiErr = new ApiError(
        'INVALID_CONTENT_TYPE',
        `Expected JSON response from ${endpoint} (HTTP ${res.status}), but received ${contentType || 'non-JSON'}. Snippet: "${snippet}"`,
        res.status,
        endpoint,
      );
      this.onError?.(apiErr);
      throw apiErr;
    }

    // 4. Handle non-2xx responses
    if (!res.ok) {
      let serverCode = `HTTP_${res.status}`;
      let serverMsg = `HTTP ${res.status} error from ${endpoint}`;

      if (typeof parsed === 'object' && parsed !== null) {
        const parsedRecord = parsed as Record<string, unknown>;
        if (parsedRecord.error !== undefined && parsedRecord.error !== null) {
          if (typeof parsedRecord.error === 'object') {
            const errObj = parsedRecord.error as Record<string, unknown>;
            if (typeof errObj.code === 'string') {
              serverCode = errObj.code;
            }
            if (typeof errObj.message === 'string') {
              serverMsg = errObj.message;
            }
          } else if (typeof parsedRecord.error === 'string') {
            serverMsg = parsedRecord.error;
          }
        } else if (typeof parsedRecord.message === 'string') {
          serverMsg = parsedRecord.message;
        }
      }

      if (res.status === 401) {
        this.onAuthFailure?.();
      }

      const apiErr = new ApiError(serverCode, serverMsg, res.status, endpoint, parsed);
      this.onError?.(apiErr);
      throw apiErr;
    }

    return parsed as T;
  }

  // Active Workspace & Core Status API methods
  public async getStatus(): Promise<CoreStatusResponse> {
    return this.request<CoreStatusResponse>('/api/status');
  }

  public async getWorkspace(): Promise<WorkspaceStatusResponse> {
    return this.request<WorkspaceStatusResponse>('/api/workspace');
  }

  public async setWorkspace(root: string, confirm = true): Promise<SetWorkspaceResponse> {
    return this.request<SetWorkspaceResponse>('/api/workspace', {
      method: 'POST',
      body: { root, confirm },
    });
  }
}
