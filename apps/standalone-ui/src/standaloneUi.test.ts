/**
 * @mediator/standalone-ui — Standalone Dashboard Unit & Integration Tests (Sprint S33.2 + S50 Polish)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import { MediatorCore } from '@mediator/orchestrator';
import { MediatorHttpServer } from '@mediator/orchestrator';
import { ApiClient, ApiError } from './apiClient';

describe('Sprint S33.2 & S50 — Standalone Mediator UI & Responsive UX', () => {
  const uiDir = path.resolve(__dirname, '..');
  let core: MediatorCore;
  let server: MediatorHttpServer;

  beforeEach(() => {
    core = new MediatorCore();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('1. validates that index.html contains all required dashboard sections and controls', () => {
    const htmlPath = path.join(uiDir, 'index.html');
    expect(fs.existsSync(htmlPath)).toBe(true);

    const content = fs.readFileSync(htmlPath, 'utf8');

    // Branding & Core Status
    expect(content).toContain('MEDIATOR');
    expect(content).toContain('CORE ONLINE');

    // Controls & Toggles
    expect(content).toContain('Provider Loop');
    expect(content).toContain('Local Autopilot');
    expect(content).toContain('WORKSPACE:');

    // Tabs
    expect(content).toContain('Dashboard');
    expect(content).toContain('Task Workspace');
    expect(content).toContain('Staging & Diffs');
    expect(content).toContain('Provider Hub');
    expect(content).toContain('Autopilot Safety');
    expect(content).toContain('Audit Logs');
    expect(content).toContain('Diagnostics & Health');

    // Target providers
    expect(content).toContain('Google Gemini');
    expect(content).toContain('OpenAI ChatGPT');
    expect(content).toContain('DeepSeek');

    // Security Invariants
    expect(content).toContain('NO-GO-AUTOEXEC');
    expect(content).toContain('FAIL-CLOSED');

    // S50 Responsive & Interactive Enhancements
    expect(content).toContain('btn-mobile-menu-toggle');
    expect(content).toContain('sidebar-backdrop');
    expect(content).toContain('task-history-select');
    expect(content).toContain('btn-template-refactor');
    expect(content).toContain('btn-template-security');
    expect(content).toContain('diff-stats-badge');
    expect(content).toContain('btn-copy-diff');
    expect(content).toContain('audit-search-input');
    expect(content).toContain('audit-filter-select');
    expect(content).toContain('diag-filter-group');
  });

  it('2. validates that styles.css implements modern dark glassmorphic design system and responsive media queries', () => {
    const cssPath = path.join(uiDir, 'styles.css');
    expect(fs.existsSync(cssPath)).toBe(true);

    const css = fs.readFileSync(cssPath, 'utf8');
    expect(css).toContain('--bg-base: #070b14');
    expect(css).toContain('--accent-cyan');
    expect(css).toContain('--backdrop-blur');
    expect(css).toContain('.app-header');
    expect(css).toContain('.diff-line');
    expect(css).toContain('.modal-card');

    // Responsive Media Queries & Component Styling
    expect(css).toContain('@media (max-width: 992px)');
    expect(css).toContain('@media (max-width: 768px)');
    expect(css).toContain('@media (max-width: 480px)');
    expect(css).toContain('.mobile-menu-btn');
    expect(css).toContain('.sidebar-backdrop');
    expect(css).toContain('.workspace-grid');
    expect(css).toContain('.staging-layout');
    expect(css).toContain('.approval-card-item');
    expect(css).toContain('.diff-stats-badge');
    expect(css).toContain('.table-responsive');
  });

  it('3. serves the standalone UI static files through MediatorHttpServer with correct MIME types', async () => {
    server = new MediatorHttpServer(core, { port: 0, staticDir: uiDir });
    const { port } = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    // Index
    const indexRes = await fetch(`${baseUrl}/`);
    expect(indexRes.status).toBe(200);
    expect(indexRes.headers.get('content-type')).toContain('text/html');
    const indexHtml = await indexRes.text();
    expect(indexHtml).toContain('Mediator — Unified Autonomous Coding Platform');

    // CSS
    const cssRes = await fetch(`${baseUrl}/styles.css`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get('content-type')).toContain('text/css');

    // JS
    const jsRes = await fetch(`${baseUrl}/app.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get('content-type')).toContain('application/javascript');
    const jsText = await jsRes.text();
    expect(jsText).toContain('connectSse');
    expect(jsText).toContain('toggleMobileDrawer');
  });

  it('4. serves /api/diagnostics and /api/diagnostics/export with valid schema and sanitization', async () => {
    server = new MediatorHttpServer(core, { port: 0 });
    const { port } = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;
    const token = core.getPairingToken();
    const headers = { 'X-Mediator-Token': token };

    const diagRes = await fetch(`${baseUrl}/api/diagnostics`, { headers });
    expect(diagRes.status).toBe(200);
    const diagData = await diagRes.json();
    expect(diagData.ok).toBe(true);
    expect(diagData.report.autopilotPolicy).toBe('BLOCKED');
    expect(diagData.report.checks.length).toBeGreaterThan(0);

    const exportRes = await fetch(`${baseUrl}/api/diagnostics/export`, { method: 'POST', headers });
    expect(exportRes.status).toBe(200);
    const exportData = await exportRes.json();
    expect(exportData.ok).toBe(true);
    expect(typeof exportData.data).toBe('string');
    expect(exportData.data).toContain('"autopilotPolicy": "BLOCKED"');
  });
});

describe('Sprint S50.1 — Shared API Client & Active Workspace Regression Suite', () => {
  let mockServer: http.Server | null = null;
  let mockPort = 0;
  let core: MediatorCore;
  let httpServer: MediatorHttpServer;

  beforeEach(() => {
    core = new MediatorCore();
  });

  afterEach(async () => {
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
      mockServer = null;
    }
    if (httpServer) {
      await httpServer.stop();
    }
  });

  async function startMockServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
  ): Promise<number> {
    return new Promise((resolve) => {
      mockServer = http.createServer(handler);
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer!.address() as { port: number };
        mockPort = addr.port;
        resolve(mockPort);
      });
    });
  }

  // 1. Valid JSON success response
  it('1. handles valid JSON success responses cleanly', async () => {
    const port = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'pong', payload: { count: 42 } }));
    });

    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await client.request<{ ok: boolean; message: string; payload: { count: number } }>('/api/ping');

    expect(result.ok).toBe(true);
    expect(result.message).toBe('pong');
    expect(result.payload.count).toBe(42);
  });

  // 2. Empty body with HTTP 200
  it('2. detects unexpected empty body on HTTP 200 and throws EMPTY_RESPONSE without crashing JSON parser', async () => {
    const port = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(''); // Unexpected empty body
    });

    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}` });

    await expect(client.request('/api/empty')).rejects.toThrowError(ApiError);
    await expect(client.request('/api/empty')).rejects.toMatchObject({
      code: 'EMPTY_RESPONSE',
      status: 200,
      endpoint: '/api/empty',
    });

    // Allowed empty body contract
    const allowed = await client.request<{ ok: boolean; status: number; data: null }>('/api/empty', {
      allowEmptyBody: true,
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.status).toBe(200);
    expect(allowed.data).toBeNull();
  });

  // 3. Expected HTTP 204 response
  it('3. handles expected HTTP 204 No Content without invoking JSON parser or throwing syntax error', async () => {
    const port = await startMockServer((req, res) => {
      res.writeHead(204);
      res.end(); // Intentionally no content
    });

    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await client.request<{ ok: boolean; status: number; data: null }>('/api/nocontent');

    expect(result.ok).toBe(true);
    expect(result.status).toBe(204);
    expect(result.data).toBeNull();
  });

  // 4. Malformed JSON
  it('4. detects malformed JSON and throws JSON_PARSE_ERROR with sanitized snippet and endpoint', async () => {
    const port = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{ "corrupt": [1, 2, '); // Syntax error
    });

    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}` });

    await expect(client.request('/api/corrupt')).rejects.toThrowError(ApiError);
    await expect(client.request('/api/corrupt')).rejects.toMatchObject({
      code: 'JSON_PARSE_ERROR',
      status: 200,
      endpoint: '/api/corrupt',
    });
  });

  // 5. HTML or plain-text server error
  it('5. detects HTML or plain-text response (e.g. Live Server 404) and throws INVALID_CONTENT_TYPE', async () => {
    const port = await startMockServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>Cannot GET /api/workspace</body></html>');
    });

    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}` });

    await expect(client.request('/api/workspace')).rejects.toThrowError(ApiError);
    await expect(client.request('/api/workspace')).rejects.toMatchObject({
      code: 'INVALID_CONTENT_TYPE',
      status: 404,
      endpoint: '/api/workspace',
    });
  });

  // 6. JSON error response with non-2xx status
  it('6. preserves structured server error code and message from non-2xx responses', async () => {
    const port = await startMockServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: 'INVALID_WORKSPACE_PATH', message: 'The path is outside permitted boundaries' },
        })
      );
    });

    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}` });

    await expect(client.request('/api/workspace')).rejects.toThrowError(ApiError);
    await expect(client.request('/api/workspace')).rejects.toMatchObject({
      code: 'INVALID_WORKSPACE_PATH',
      message: 'The path is outside permitted boundaries',
      status: 400,
      endpoint: '/api/workspace',
    });
  });

  // 7. API server unavailable
  it('7. captures network failures as NETWORK_ERROR with status 0', async () => {
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:59998' }); // Unbound port

    await expect(client.request('/api/state')).rejects.toThrowError(ApiError);
    await expect(client.request('/api/state')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: 0,
      endpoint: '/api/state',
    });
  });

  // 8. Incorrect route or method
  it('8. handles 404 ENDPOINT_NOT_FOUND and 405 METHOD_NOT_ALLOWED correctly on MediatorHttpServer', async () => {
    httpServer = new MediatorHttpServer(core, { port: 0 });
    const { port } = await httpServer.start();
    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}`, token: core.getPairingToken() });

    // 404 for unknown endpoint
    await expect(client.request('/api/unknown_endpoint')).rejects.toMatchObject({
      code: 'ENDPOINT_NOT_FOUND',
      status: 404,
      endpoint: '/api/unknown_endpoint',
    });

    // 405 for disallowed method on /api/workspace
    await expect(
      client.request('/api/workspace', { method: 'DELETE' })
    ).rejects.toMatchObject({
      code: 'METHOD_NOT_ALLOWED',
      status: 405,
      endpoint: '/api/workspace',
    });
  });

  // 9. CORS and preflight handling
  it('9. responds to OPTIONS preflight with 204 and required CORS headers for cross-origin UI', async () => {
    httpServer = new MediatorHttpServer(core, { port: 0 });
    const { port } = await httpServer.start();

    const preflightRes = await fetch(`http://127.0.0.1:${port}/api/workspace`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:5500',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, X-Mediator-Token',
      },
    });

    expect(preflightRes.status).toBe(204);
    expect(preflightRes.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5500');
    expect(preflightRes.headers.get('access-control-allow-methods')).toContain('POST');
    expect(preflightRes.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  // 10. No active workspace
  it('10. returns valid documented empty state { ok: true, workspaceRoot: null, confirmed: false } when no workspace selected', async () => {
    httpServer = new MediatorHttpServer(core, { port: 0 });
    const { port } = await httpServer.start();
    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}`, token: core.getPairingToken() });

    const wsStatus = await client.getWorkspace();
    expect(wsStatus.ok).toBe(true);
    expect(wsStatus.workspaceRoot).toBeNull();
    expect(wsStatus.confirmed).toBe(false);
  });

  // 11. Valid active workspace
  it('11. sets and retrieves valid active workspace root with confirmation', async () => {
    httpServer = new MediatorHttpServer(core, { port: 0 });
    const { port } = await httpServer.start();
    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}`, token: core.getPairingToken() });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-test-ws-'));

    try {
      const setRes = await client.setWorkspace(tempDir, true);
      expect(setRes.ok).toBe(true);
      expect(path.resolve(setRes.workspaceRoot)).toBe(path.resolve(tempDir));
      expect(setRes.confirmed).toBe(true);

      const statusRes = await client.getWorkspace();
      expect(statusRes.ok).toBe(true);
      expect(path.resolve(statusRes.workspaceRoot!)).toBe(path.resolve(tempDir));
      expect(statusRes.confirmed).toBe(true);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  // 12. Invalid or inaccessible workspace
  it('12. rejects invalid or non-existent workspace path with 400 and does not mutate active workspace', async () => {
    httpServer = new MediatorHttpServer(core, { port: 0 });
    const { port } = await httpServer.start();
    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}`, token: core.getPairingToken() });

    const invalidPath = path.join(os.tmpdir(), 'mediator-nonexistent-path-987654321');

    await expect(client.setWorkspace(invalidPath, true)).rejects.toMatchObject({
      status: 400,
    });

    // Workspace remains unselected
    const statusRes = await client.getWorkspace();
    expect(statusRes.workspaceRoot).toBeNull();
  });

  // 13. Duplicate requests and UI recovery after an error
  it('13. allows client to recover immediately and make successful requests after an error without corrupted state', async () => {
    httpServer = new MediatorHttpServer(core, { port: 0 });
    const { port } = await httpServer.start();
    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}`, token: core.getPairingToken() });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-test-recovery-'));

    try {
      // 1. Initial failing request
      await expect(client.setWorkspace('/nonexistent/bogus/path', true)).rejects.toThrow();

      // 2. Recovery: immediately submit valid workspace
      const setRes = await client.setWorkspace(tempDir, true);
      expect(setRes.ok).toBe(true);
      expect(path.resolve(setRes.workspaceRoot)).toBe(path.resolve(tempDir));

      // 3. Subsequent request confirms workspace
      const getRes = await client.getWorkspace();
      expect(getRes.ok).toBe(true);
      expect(path.resolve(getRes.workspaceRoot!)).toBe(path.resolve(tempDir));
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  // 14. Unauthenticated /api/status endpoint returning pairing token
  it('14. probes unauthenticated /api/status returning ready status, versions, and pairingToken for local UI pairing', async () => {
    httpServer = new MediatorHttpServer(core, { port: 0 });
    const { port } = await httpServer.start();

    // Client has NO token initially
    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}` });
    const statusRes = await client.getStatus();

    expect(statusRes.ok).toBe(true);
    expect(statusRes.status).toBe('ready');
    expect(statusRes.coreVersion).toBe(MediatorCore.VERSION);
    expect(statusRes.protocolVersion).toBe(MediatorCore.PROTOCOL_VERSION);
    expect(statusRes.pairingToken).toBe(core.getPairingToken());
  });

  // 15. getStatus() enabling automatic token pairing for subsequent authenticated calls
  it('15. enables automatic token discovery and pairing through getStatus() for subsequent authenticated requests', async () => {
    httpServer = new MediatorHttpServer(core, { port: 0 });
    const { port } = await httpServer.start();

    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}` });

    // Calling authenticated endpoint directly without token throws 401 UNAUTHORIZED
    await expect(client.getWorkspace()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });

    // Pair through /api/status
    const status = await client.getStatus();
    expect(status.pairingToken).toBeTruthy();
    client.setToken(status.pairingToken!);

    // Subsequent workspace request succeeds
    const ws = await client.getWorkspace();
    expect(ws.ok).toBe(true);
    expect(ws.workspaceRoot).toBeNull();
  });

  // 16. Write requests are never retried automatically on failure
  it('16. strictly avoids automatic retries for non-idempotent write requests on failure', async () => {
    let callCount = 0;
    const port = await startMockServer((req, res) => {
      callCount++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'FAIL', message: 'Simulated backend crash' } }));
    });

    const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}` });

    await expect(
      client.request('/api/workspace', { method: 'POST', body: { root: '/some/dir' } })
    ).rejects.toThrow();

    // Exactly one call was dispatched (no duplicate / retry calls)
    expect(callCount).toBe(1);
  });
});

