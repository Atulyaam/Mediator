/**
 * @mediator/orchestrator — Loopback HTTP & SSE Server (Sprint S33.2)
 *
 * Secure local transport for the Standalone Mediator UI and external clients:
 * - Binds strictly to 127.0.0.1 (loopback only, never exposed to LAN or WAN).
 * - Authenticated with pairing token (header `X-Mediator-Token` or query `?token=`).
 * - Real-time SSE stream for synchronized cross-interface events.
 * - Serves Standalone UI static files or embedded fallback.
 * - Enforces bounded payload sizes and typed error responses.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type CanonicalProviderId, type ProviderMode, type RecipeId } from '@mediator/shared-contracts';
import { MediatorCore } from './mediatorCore.js';
import { DoctorDiagnosticsService } from './doctorDiagnosticsService.js';

export interface MediatorHttpServerOptions {
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly staticDir?: string | undefined;
}

export const DEFAULT_MEDIATOR_HTTP_PORT = 3300;

export class HttpBodyError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'HttpBodyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class MediatorHttpServer {
  private readonly server: http.Server;
  private readonly core: MediatorCore;
  private readonly diagnosticsService: DoctorDiagnosticsService;
  private readonly port: number;
  private readonly host: string;
  private readonly staticDir: string | null;
  private readonly sseClients = new Set<http.ServerResponse>();

  constructor(core: MediatorCore, options?: MediatorHttpServerOptions) {
    this.core = core;
    this.diagnosticsService = new DoctorDiagnosticsService({ core: this.core });
    this.port = options?.port !== undefined ? options.port : DEFAULT_MEDIATOR_HTTP_PORT;
    this.host = '127.0.0.1'; // Strictly loopback
    this.staticDir = options?.staticDir ?? null;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err: unknown) => {
        if (err instanceof HttpBodyError) {
          this.sendJson(res, err.statusCode, {
            ok: false,
            error: { code: err.code, message: err.message },
          });
        } else {
          this.sendJson(res, 500, {
            ok: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
      });
    });

    // Wire Core events to SSE stream
    this.core.subscribe((event) => {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of this.sseClients) {
        try {
          client.write(data);
        } catch {
          this.sseClients.delete(client);
        }
      }
    });
  }

  public async start(): Promise<{ port: number; host: string; url: string }> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to obtain server address'));
          return;
        }
        const resolvedPort = addr.port;
        resolve({
          port: resolvedPort,
          host: this.host,
          url: `http://${this.host}:${resolvedPort}`,
        });
      });
      this.server.on('error', reject);
    });
  }

  public async stop(): Promise<void> {
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();

    if (typeof this.server.closeAllConnections === 'function') {
      this.server.closeAllConnections();
    }

    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  public getAddress(): { port: number; host: string } | null {
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return null;
    return { port: addr.port, host: this.host };
  }

  // ─── Request Dispatcher ──────────────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    // CORS headers for local tools
    const origin = (req.headers.origin as string) || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Mediator-Token, Authorization, Accept');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Mediator-Token, Authorization, Accept',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // Static Assets
    if (!pathname.startsWith('/api/')) {
      this.serveStaticFile(pathname, res);
      return;
    }

    // Auth verification for /api/*
    const token =
      (req.headers['x-mediator-token'] as string | undefined) ??
      (parsedUrl.searchParams.get('token') ?? undefined);

    // Allow unauthenticated ping or handshake status if token query matches
    if (pathname !== '/api/status' && !this.core.verifyPairingToken(token)) {
      this.sendJson(res, 401, {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Valid X-Mediator-Token required' },
      });
      return;
    }

    // API Routing
    switch (pathname) {
      case '/api/status':
        this.sendJson(res, 200, {
          ok: true,
          status: 'ready',
          coreVersion: MediatorCore.VERSION,
          protocolVersion: MediatorCore.PROTOCOL_VERSION,
          workspaceRoot: this.core.getWorkspaceRoot(),
          workspaceConfirmed: this.core.isWorkspaceConfirmed(),
          activeProviderId: this.core.getActiveProviderId(),
          loopStatus: this.core.getLoopStatus(),
          autopilotStatus: this.core.getAutopilotStatus(),
          pairingToken: this.core.getPairingToken(),
        });
        break;

      case '/api/state':
        this.sendJson(res, 200, {
          ok: true,
          state: this.core.getStateSnapshot(),
        });
        break;

      case '/api/events':
        this.handleSse(req, res);
        break;

      case '/api/workspace':
        if (req.method === 'POST') {
          const body = await this.readJsonBody(req);
          const root =
            typeof body.root === 'string'
              ? body.root
              : typeof body.workspaceRoot === 'string'
                ? body.workspaceRoot
                : '';
          const confirm = Boolean(body.confirm);
          const wsRes = this.core.setWorkspaceRoot(root, confirm);
          if (!wsRes.ok) {
            this.sendJson(res, 400, { ok: false, error: wsRes.error });
          } else {
            this.sendJson(res, 200, {
              ok: true,
              workspaceRoot: wsRes.value,
              confirmed: this.core.isWorkspaceConfirmed(),
            });
          }
        } else if (req.method === 'GET') {
          this.sendJson(res, 200, {
            ok: true,
            workspaceRoot: this.core.getWorkspaceRoot(),
            confirmed: this.core.isWorkspaceConfirmed(),
          });
        } else {
          this.sendJson(res, 405, {
            ok: false,
            error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' },
          });
        }
        break;

      case '/api/providers':
        this.sendJson(res, 200, {
          ok: true,
          providers: this.core.listProviders(),
          activeProviderId: this.core.getActiveProviderId(),
          activeMode: this.core.getActiveMode(),
        });
        break;

      case '/api/providers/select':
        if (req.method === 'POST') {
          const body = await this.readJsonBody(req);
          const providerId = typeof body.providerId === 'string' ? body.providerId : '';
          const mode = typeof body.mode === 'string' ? (body.mode as ProviderMode) : undefined;
          const selRes = this.core.selectProvider(providerId, mode);
          if (!selRes.ok) {
            this.sendJson(res, 400, { ok: false, error: selRes.error });
          } else {
            this.sendJson(res, 200, { ok: true, selectedProvider: selRes.value });
          }
        } else {
          this.sendJson(res, 405, {
            ok: false,
            error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' },
          });
        }
        break;

      case '/api/tasks':
        if (req.method === 'POST') {
          const body = await this.readJsonBody(req);
          const prompt = typeof body.prompt === 'string' ? body.prompt : '';
          const providerId = typeof body.providerId === 'string' ? (body.providerId as CanonicalProviderId) : undefined;
          const mode = typeof body.mode === 'string' ? (body.mode as ProviderMode) : undefined;
          const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined;
          const taskRes = this.core.createTask({
            prompt,
            providerId,
            mode,
            conversationId,
          });
          if (!taskRes.ok) {
            this.sendJson(res, 400, { ok: false, error: taskRes.error });
          } else {
            this.sendJson(res, 201, { ok: true, task: taskRes.value });
          }
        } else {
          this.sendJson(res, 200, { ok: true, tasks: this.core.listTasks() });
        }
        break;

      case '/api/stages':
        this.sendJson(res, 200, { ok: true, stages: this.core.listStages() });
        break;

      case '/api/approvals':
        this.sendJson(res, 200, { ok: true, approvals: this.core.listApprovals() });
        break;

      case '/api/loop/toggle':
        if (req.method === 'POST') {
          const body = await this.readJsonBody(req);
          const enable = typeof body.enable === 'boolean' ? body.enable : undefined;
          const result = this.core.toggleLoop(enable);
          this.sendJson(res, 200, { ok: true, ...result });
        } else {
          this.sendJson(res, 200, { ok: true, ...this.core.getLoopStatus() });
        }
        break;

      case '/api/autopilot/toggle':
        if (req.method === 'POST') {
          const body = await this.readJsonBody(req);
          const enable = typeof body.enable === 'boolean' ? body.enable : undefined;
          const result = this.core.toggleAutopilot(enable);
          this.sendJson(res, 200, { ok: true, ...result });
        } else {
          this.sendJson(res, 200, { ok: true, ...this.core.getAutopilotStatus() });
        }
        break;

      case '/api/autopilot/run':
        if (req.method === 'POST') {
          const body = await this.readJsonBody(req);
          const taskId = typeof body.taskId === 'string' ? body.taskId : undefined;
          if (!taskId) {
            this.sendJson(res, 400, {
              ok: false,
              error: { code: 'MISSING_TASK_ID', message: 'Missing taskId in request body' },
            });
            return;
          }
          const config = typeof body.config === 'object' && body.config !== null ? body.config : undefined;
          const runRes = await this.core.runAutopilotTask(taskId, config);
          if (!runRes.ok) {
            this.sendJson(res, 400, { ok: false, error: runRes.error });
          } else {
            this.sendJson(res, 200, { ok: true, result: runRes.value });
          }
        } else {
          this.sendJson(res, 405, {
            ok: false,
            error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' },
          });
        }
        break;

      case '/api/autopilot/cancel':
        if (req.method === 'POST') {
          const body = await this.readJsonBody(req);
          const taskId = typeof body.taskId === 'string' ? body.taskId : undefined;
          const reason = typeof body.reason === 'string' ? body.reason : undefined;
          if (!taskId) {
            this.sendJson(res, 400, {
              ok: false,
              error: { code: 'MISSING_TASK_ID', message: 'Missing taskId in request body' },
            });
            return;
          }
          const cancelRes = this.core.cancelAutopilotTask(taskId, reason);
          if (!cancelRes.ok) {
            this.sendJson(res, 400, { ok: false, error: cancelRes.error });
          } else {
            this.sendJson(res, 200, { ok: true, cancelled: true });
          }
        } else {
          this.sendJson(res, 405, {
            ok: false,
            error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' },
          });
        }
        break;

      case '/api/logs':
        this.sendJson(res, 200, { ok: true, logs: this.core.getAuditLogs() });
        break;

      case '/api/diagnostics':
        if (req.method === 'GET') {
          const report = await this.diagnosticsService.runDiagnostics();
          this.sendJson(res, 200, { ok: true, report });
        } else {
          this.sendJson(res, 405, {
            ok: false,
            error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' },
          });
        }
        break;

      case '/api/diagnostics/export':
        if (req.method === 'POST') {
          const report = await this.diagnosticsService.runDiagnostics();
          const exportResult = this.diagnosticsService.exportSanitizedReport({
            report,
            explicitUserExportRequested: true,
          });
          if (!exportResult.ok) {
            this.sendJson(res, 400, { ok: false, error: exportResult.error });
          } else {
            this.sendJson(res, 200, { ok: true, data: exportResult.value });
          }
        } else {
          this.sendJson(res, 405, {
            ok: false,
            error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' },
          });
        }
        break;

      default:
        // Dynamic subroutes
        if (pathname.startsWith('/api/tasks/')) {
          await this.handleTaskSubroute(pathname, req, res);
        } else if (pathname.startsWith('/api/approvals/')) {
          await this.handleApprovalSubroute(pathname, req, res);
        } else if (pathname.startsWith('/api/stages')) {
          await this.handleStageSubroute(pathname, req, res);
        } else {
          this.sendJson(res, 404, {
            ok: false,
            error: { code: 'ENDPOINT_NOT_FOUND', message: `Endpoint '${pathname}' not found` },
          });
        }
        break;
    }
  }

  // ─── Dynamic Subroutes ───────────────────────────────────────────────────

  private async handleTaskSubroute(
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const parts = pathname.split('/').filter(Boolean); // ['api', 'tasks', '<id>', '<action>?']
    const taskId = parts[2];
    const action = parts[3];

    if (!taskId) {
      this.sendJson(res, 400, {
        ok: false,
        error: { code: 'MISSING_TASK_ID', message: 'Missing task ID' },
      });
      return;
    }

    if (!action) {
      const task = this.core.getTask(taskId);
      if (!task) {
        this.sendJson(res, 404, {
          ok: false,
          error: { code: 'TASK_NOT_FOUND', message: `Task ${taskId} not found` },
        });
      } else {
        this.sendJson(res, 200, { ok: true, task });
      }
      return;
    }

    if (action === 'pause') {
      const body = await this.readJsonBody(req);
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      const pauseRes = this.core.pauseTask(taskId, reason);
      if (!pauseRes.ok) {
        this.sendJson(res, 400, { ok: false, error: pauseRes.error });
      } else {
        this.sendJson(res, 200, { ok: true, task: pauseRes.value });
      }
    } else if (action === 'resume') {
      const resumeRes = this.core.resumeTask(taskId);
      if (!resumeRes.ok) {
        this.sendJson(res, 400, { ok: false, error: resumeRes.error });
      } else {
        this.sendJson(res, 200, { ok: true, task: resumeRes.value });
      }
    } else if (action === 'cancel') {
      const body = await this.readJsonBody(req);
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      const cancelRes = this.core.cancelTask(taskId, reason);
      if (!cancelRes.ok) {
        this.sendJson(res, 400, { ok: false, error: cancelRes.error });
      } else {
        this.sendJson(res, 200, { ok: true, task: cancelRes.value });
      }
    } else if (action === 'response') {
      const body = await this.readJsonBody(req);
      const rawPayload = body.envelope ?? body.response;
      if (!rawPayload) {
        this.sendJson(res, 400, {
          ok: false,
          error: { code: 'MISSING_PAYLOAD', message: 'Missing envelope/response payload' },
        });
        return;
      }
      const responsePayload = typeof rawPayload === 'string' ? rawPayload : (rawPayload as Record<string, unknown>);
      const roundRes = await this.core.submitProviderResponse(taskId, responsePayload);
      if (!roundRes.ok) {
        this.sendJson(res, 400, { ok: false, error: roundRes.error });
      } else {
        this.sendJson(res, 200, { ok: true, round: roundRes.value });
      }
    } else if (action === 'validate' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const recipeId: RecipeId = typeof body.recipeId === 'string' ? (body.recipeId as RecipeId) : 'python.test';
      const options =
        typeof body.options === 'object' && body.options !== null
          ? (body.options as { distroName?: string; linuxTaskWorkspaceRoot?: string; allowDefaultDistroForCanary?: boolean })
          : undefined;
      const valRes = await this.core.validateTaskOffline(taskId, recipeId, options);
      if (!valRes.ok) {
        this.sendJson(res, 400, { ok: false, error: valRes.error });
      } else {
        this.sendJson(res, 200, { ok: true, validation: valRes.value });
      }
    } else if (action === 'conversation') {
      const conv = this.core.getTaskConversation(taskId);
      this.sendJson(res, 200, { ok: true, conversation: conv });
    } else if (action === 'message' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const text = typeof body.message === 'string' ? body.message : '';
      if (!text.trim()) {
        this.sendJson(res, 400, { ok: false, error: { code: 'MISSING_MESSAGE', message: 'Message text is required' } });
        return;
      }
      const msgRes = await this.core.submitFollowUpMessage(taskId, text);
      if (!msgRes.ok) {
        this.sendJson(res, 400, { ok: false, error: msgRes.error });
      } else {
        this.sendJson(res, 200, { ok: true, reply: msgRes.value.reply, conversationId: msgRes.value.conversationId });
      }
    } else if (action === 'command' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const commandName = typeof body.command === 'string' ? body.command : '';
      const args = typeof body.args === 'object' && body.args !== null ? (body.args as Record<string, unknown>) : {};
      const cmdRes = await this.core.executeContextCommand(taskId, commandName, args);
      if (!cmdRes.ok) {
        this.sendJson(res, 400, { ok: false, error: cmdRes.error });
      } else {
        this.sendJson(res, 200, { ok: true, result: cmdRes.result });
      }
    } else if (action === 'autopilot' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const config = typeof body.config === 'object' && body.config !== null ? body.config : undefined;
      const autoRes = await this.core.runAutopilotTask(taskId, config);
      if (!autoRes.ok) {
        this.sendJson(res, 400, { ok: false, error: autoRes.error });
      } else {
        this.sendJson(res, 200, { ok: true, result: autoRes.value });
      }
    } else {
      this.sendJson(res, 404, {
        ok: false,
        error: { code: 'UNKNOWN_ACTION', message: `Unknown task action: ${action}` },
      });
    }
  }

  private async handleApprovalSubroute(
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const parts = pathname.split('/').filter(Boolean); // ['api', 'approvals', '<id>', 'resolve']
    const approvalId = parts[2];
    const action = parts[3];

    if (!approvalId) {
      this.sendJson(res, 400, {
        ok: false,
        error: { code: 'MISSING_APPROVAL_ID', message: 'Missing approval ID' },
      });
      return;
    }

    if (action === 'resolve' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const approved = Boolean(body.approved);
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      const resVal = this.core.resolveApproval(approvalId, approved, reason);
      if (!resVal.ok) {
        this.sendJson(res, 400, { ok: false, error: resVal.error });
      } else {
        this.sendJson(res, 200, { ok: true, approval: resVal.value });
      }
    } else {
      const app = this.core.getApproval(approvalId);
      if (!app) {
        this.sendJson(res, 404, {
          ok: false,
          error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval not found' },
        });
      } else {
        this.sendJson(res, 200, { ok: true, approval: app });
      }
    }
  }

  private async handleStageSubroute(
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const parts = pathname.split('/').filter(Boolean); // ['api', 'stages', '<id | propose>', '<apply>?']
    const sub = parts[2];
    const action = parts[3];

    if (sub === 'propose' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const propRes = await this.core.stageProposal({
        taskId: typeof body.taskId === 'string' ? body.taskId : '',
        relativePath: typeof body.relativePath === 'string' ? body.relativePath : '',
        proposedContent: typeof body.proposedContent === 'string' ? body.proposedContent : '',
        expectedBaseHash: typeof body.expectedBaseHash === 'string' ? body.expectedBaseHash : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
      });
      if (!propRes.ok) {
        this.sendJson(res, 400, { ok: false, error: propRes.error });
      } else {
        this.sendJson(res, 201, { ok: true, stage: propRes.value });
      }
      return;
    }

    if (!sub) {
      this.sendJson(res, 200, { ok: true, stages: this.core.listStages() });
      return;
    }

    if (action === 'apply' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId : '';
      const callerOrigin = body.callerOrigin === 'trusted_cli' ? 'trusted_cli' : 'trusted_ui';
      const applyRes = await this.core.applyApprovedStage(sub, approvalId, callerOrigin);
      if (!applyRes.ok) {
        this.sendJson(res, 400, { ok: false, error: applyRes.error });
      } else {
        this.sendJson(res, 200, { ok: true, result: applyRes.value });
      }
      return;
    }

    const diff = this.core.getStageDiff(sub);
    if (diff === null) {
      this.sendJson(res, 404, {
        ok: false,
        error: { code: 'STAGE_NOT_FOUND', message: 'Stage not found' },
      });
    } else {
      this.sendJson(res, 200, { ok: true, stageId: sub, diffPreview: diff });
    }
  }

  // ─── SSE Streaming ───────────────────────────────────────────────────────

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    res.write(`data: ${JSON.stringify({ type: 'state:snapshot', payload: this.core.getStateSnapshot() })}\n\n`);

    this.sseClients.add(res);

    req.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  // ─── Static File Serving ─────────────────────────────────────────────────

  private serveStaticFile(pathname: string, res: http.ServerResponse): void {
    if (this.staticDir && fs.existsSync(this.staticDir)) {
      const safePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.join(this.staticDir, safePath);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
        };
        const mime = mimeTypes[ext] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    // Fallback embedded dashboard
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(this.getFallbackDashboardHtml());
  }

  private getFallbackDashboardHtml(): string {
    const token = this.core.getPairingToken();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Mediator Core Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 2rem; }
    h1 { color: #38bdf8; }
    .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; border: 1px solid #334155; }
    .status { display: inline-block; padding: 0.25rem 0.5rem; border-radius: 4px; font-weight: bold; background: #059669; }
    pre { background: #020617; padding: 1rem; border-radius: 6px; overflow: auto; }
  </style>
</head>
<body>
  <h1>Mediator — Autonomous Coding Platform</h1>
  <div class="card">
    <h2>Core Service: <span class="status">ONLINE</span></h2>
    <p>Version: ${MediatorCore.VERSION} | Protocol: ${MediatorCore.PROTOCOL_VERSION}</p>
    <p>Pairing Token: <code>${token}</code></p>
  </div>
  <div class="card">
    <h3>Active State</h3>
    <pre id="state">Loading state...</pre>
  </div>
  <script>
    fetch('/api/state?token=${token}')
      .then(r => r.json())
      .then(d => { document.getElementById('state').innerText = JSON.stringify(d, null, 2); })
      .catch(e => { document.getElementById('state').innerText = String(e); });
  </script>
</body>
</html>`;
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  private async readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let body = '';
      let bytes = 0;
      const MAX_BYTES = 1024 * 1024; // 1 MiB limit

      req.on('data', (chunk: Buffer | string) => {
        bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        if (bytes > MAX_BYTES) {
          req.destroy(new HttpBodyError('PAYLOAD_TOO_LARGE', 'Payload Too Large', 413));
          reject(new HttpBodyError('PAYLOAD_TOO_LARGE', 'Payload Too Large', 413));
          return;
        }
        body += chunk.toString();
      });

      req.on('end', () => {
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(body) as unknown;
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            resolve(parsed as Record<string, unknown>);
          } else {
            resolve({ payload: parsed });
          }
        } catch {
          reject(new HttpBodyError('INVALID_JSON', 'Malformed JSON payload in request body', 400));
        }
      });

      req.on('error', reject);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    const payload = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload, 'utf8'),
    });
    res.end(payload);
  }
}
