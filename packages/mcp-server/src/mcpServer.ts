/**
 * @mediator/mcp-server — Authoritative Read-Only MCP Context Server (Sprint S16)
 *
 * Implements local JSON-RPC 2.0 / MCP v1.0 context server.
 * Coordinates resource handlers, tool handlers, security filters, and audit.
 * Strictly prohibits mutations, shell execution, live apply, policy alterations,
 * and approval resolutions.
 */

import {
  type WorkspaceRootState,
} from '@mediator/shared-contracts';
import {
  type TaskRepository,
  type EvidenceRepository,
  type AuditRepository,
} from '@mediator/persistence';
import { type StageStore, type ReviewIntakeService } from '@mediator/stage-store';
import { type IdeWorkspaceAdapter } from '@mediator/ide-adapter-vscode';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  JsonRpcErrorCode,
  type JsonRpcRequest,
  type JsonRpcResponse,
  REGISTERED_RESOURCE_DEFINITIONS,
  REGISTERED_TOOL_DEFINITIONS,
  ResourceReadParamsSchema,
  ToolCallParamsSchema,
} from './mcpProtocolTypes.js';
import { McpSecurityFilter } from './mcpSecurityFilter.js';
import { McpResourceHandlers } from './mcpResourceHandlers.js';
import { McpToolHandlers } from './mcpToolHandlers.js';

export interface McpServerConfig {
  readonly taskRepo: TaskRepository;
  readonly stageStore: StageStore;
  readonly ideAdapter: IdeWorkspaceAdapter;
  readonly rootState: WorkspaceRootState;
  readonly evidenceRepo?: EvidenceRepository | undefined;
  readonly auditRepo?: AuditRepository | undefined;
  readonly reviewIntakeService?: ReviewIntakeService | undefined;
}

export class McpContextServer {
  private readonly securityFilter: McpSecurityFilter;
  private readonly resourceHandlers: McpResourceHandlers;
  private readonly toolHandlers: McpToolHandlers;
  private isRunning = false;

  constructor(private readonly config: McpServerConfig) {
    this.securityFilter = new McpSecurityFilter(config.taskRepo);
    this.resourceHandlers = new McpResourceHandlers({
      taskRepo: config.taskRepo,
      stageStore: config.stageStore,
      rootState: config.rootState,
      evidenceRepo: config.evidenceRepo,
      securityFilter: this.securityFilter,
    });
    this.toolHandlers = new McpToolHandlers({
      taskRepo: config.taskRepo,
      stageStore: config.stageStore,
      ideAdapter: config.ideAdapter,
      rootState: config.rootState,
      securityFilter: this.securityFilter,
      reviewIntakeService: config.reviewIntakeService,
    });
  }

  public start(): void {
    this.isRunning = true;
  }

  public stop(): void {
    this.isRunning = false;
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public async handleRequest(
    rawRequest: string | JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const startTime = Date.now();
    let req: JsonRpcRequest;
    let reqId: string | number | null = null;

    // 1. Parse JSON if string
    if (typeof rawRequest === 'string') {
      const sizeCheck = this.securityFilter.checkRequestPayloadSize(rawRequest);
      if (!sizeCheck.ok) {
        return {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: JsonRpcErrorCode.OVERSIZED_PAYLOAD,
            message: sizeCheck.error.message,
          },
        };
      }

      try {
        req = JSON.parse(rawRequest) as JsonRpcRequest;
      } catch (parseErr: unknown) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        return {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: JsonRpcErrorCode.PARSE_ERROR,
            message: `JSON-RPC parse error: ${msg}`,
          },
        };
      }
    } else {
      req = rawRequest;
    }

    reqId = req.id ?? null;

    // 2. Validate JSON-RPC 2.0 structure
    if (req.jsonrpc !== '2.0' || !req.method || typeof req.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id: reqId,
        error: {
          code: JsonRpcErrorCode.INVALID_REQUEST,
          message: 'Invalid JSON-RPC request: missing or invalid "jsonrpc" / "method"',
        },
      };
    }

    // 3. Prohibit known mutation methods unconditionally
    const allowedCheck = this.securityFilter.checkOperationAllowed(req.method);
    if (!allowedCheck.ok) {
      this.recordAudit(req, 'denied', allowedCheck.error.code, startTime);
      return {
        jsonrpc: '2.0',
        id: reqId,
        error: {
          code: JsonRpcErrorCode.MCP_MUTATION_PROHIBITED,
          message: allowedCheck.error.message,
        },
      };
    }

    // 4. Method Dispatch
    try {
      switch (req.method) {
        case 'initialize': {
          const result = {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              resources: { subscribe: false, listChanged: false },
              tools: { listChanged: false },
            },
            serverInfo: {
              name: MCP_SERVER_NAME,
              version: MCP_SERVER_VERSION,
            },
          };
          this.recordAudit(req, 'allowed', 'OK', startTime);
          return { jsonrpc: '2.0', id: reqId, result };
        }

        case 'notifications/initialized': {
          return { jsonrpc: '2.0', id: reqId, result: {} };
        }

        case 'ping': {
          return { jsonrpc: '2.0', id: reqId, result: {} };
        }

        case 'resources/list': {
          const result = {
            resources: REGISTERED_RESOURCE_DEFINITIONS,
          };
          this.recordAudit(req, 'allowed', 'OK', startTime);
          return { jsonrpc: '2.0', id: reqId, result };
        }

        case 'resources/read': {
          const parsed = ResourceReadParamsSchema.safeParse(req.params);
          if (!parsed.success) {
            this.recordAudit(req, 'error', 'INVALID_PARAMS', startTime);
            return {
              jsonrpc: '2.0',
              id: reqId,
              error: {
                code: JsonRpcErrorCode.INVALID_PARAMS,
                message: `Invalid parameters for resources/read: ${parsed.error.message}`,
              },
            };
          }

          const res = await this.resourceHandlers.readResource(
            parsed.data.uri,
            parsed.data.taskId,
            parsed.data.sessionId,
          );

          if (!res.ok) {
            const code = res.error.code === 'UNAUTHORIZED_TASK_SCOPE'
              ? JsonRpcErrorCode.UNAUTHORIZED_TASK_SCOPE
              : JsonRpcErrorCode.RESOURCE_NOT_FOUND;
            this.recordAudit(req, 'denied', res.error.code, startTime);
            return {
              jsonrpc: '2.0',
              id: reqId,
              error: { code, message: res.error.message },
            };
          }

          this.recordAudit(req, 'allowed', 'OK', startTime);
          return {
            jsonrpc: '2.0',
            id: reqId,
            result: {
              contents: [res.value],
            },
          };
        }

        case 'tools/list': {
          const result = {
            tools: REGISTERED_TOOL_DEFINITIONS,
          };
          this.recordAudit(req, 'allowed', 'OK', startTime);
          return { jsonrpc: '2.0', id: reqId, result };
        }

        case 'tools/call': {
          const parsed = ToolCallParamsSchema.safeParse(req.params);
          if (!parsed.success) {
            this.recordAudit(req, 'error', 'INVALID_PARAMS', startTime);
            return {
              jsonrpc: '2.0',
              id: reqId,
              error: {
                code: JsonRpcErrorCode.INVALID_PARAMS,
                message: `Invalid parameters for tools/call: ${parsed.error.message}`,
              },
            };
          }

          const res = await this.toolHandlers.callTool(
            parsed.data.name,
            parsed.data.arguments,
          );

          if (!res.ok) {
            let code: number = JsonRpcErrorCode.INTERNAL_ERROR;
            if (res.error.code === 'MCP_MUTATION_PROHIBITED') {
              code = JsonRpcErrorCode.MCP_MUTATION_PROHIBITED;
            } else if (res.error.code === 'UNAUTHORIZED_TASK_SCOPE') {
              code = JsonRpcErrorCode.UNAUTHORIZED_TASK_SCOPE;
            } else if (
              res.error.code === 'SCHEMA_INVALID' ||
              res.error.code === 'PATH_EXCLUDED' ||
              res.error.code === 'PATH_TRAVERSAL' ||
              res.error.code === 'PATH_OUTSIDE_ROOT'
            ) {
              code = JsonRpcErrorCode.INVALID_PARAMS;
            } else if (res.error.code === 'ACTION_NOT_FOUND') {
              code = JsonRpcErrorCode.METHOD_NOT_FOUND;
            } else if (res.error.code === 'STAGE_NOT_FOUND') {
              code = JsonRpcErrorCode.RESOURCE_NOT_FOUND;
            }

            this.recordAudit(req, 'denied', res.error.code, startTime);
            return {
              jsonrpc: '2.0',
              id: reqId,
              error: { code, message: res.error.message },
            };
          }

          this.recordAudit(req, 'allowed', 'OK', startTime);
          return {
            jsonrpc: '2.0',
            id: reqId,
            result: {
              content: [
                {
                  type: 'text',
                  text: typeof res.value === 'string' ? res.value : JSON.stringify(res.value, null, 2),
                },
              ],
            },
          };
        }

        default: {
          this.recordAudit(req, 'denied', 'METHOD_NOT_FOUND', startTime);
          return {
            jsonrpc: '2.0',
            id: reqId,
            error: {
              code: JsonRpcErrorCode.METHOD_NOT_FOUND,
              message: `Unknown method "${req.method}". MCP context server exposes only registered read resources and tools.`,
            },
          };
        }
      }
    } catch (err_: unknown) {
      const msg = err_ instanceof Error ? err_.message : String(err_);
      this.recordAudit(req, 'error', 'INTERNAL_ERROR', startTime);
      return {
        jsonrpc: '2.0',
        id: reqId,
        error: {
          code: JsonRpcErrorCode.INTERNAL_ERROR,
          message: `Internal error processing MCP request: ${msg}`,
        },
      };
    }
  }

  private recordAudit(
    req: JsonRpcRequest,
    outcome: 'allowed' | 'denied' | 'error',
    code: string,
    startTime: number,
  ): void {
    if (!this.config.auditRepo) return;
    try {
      const args = (req.params?.arguments as Record<string, unknown> | undefined) ?? {};
      const taskId =
        typeof req.params?.taskId === 'string'
          ? req.params.taskId
          : typeof args.taskId === 'string'
            ? args.taskId
            : 'global';
      const sessionId =
        typeof req.params?.sessionId === 'string'
          ? req.params.sessionId
          : typeof args.sessionId === 'string'
            ? args.sessionId
            : 'global';
      const correlationId =
        typeof req.params?.correlationId === 'string'
          ? req.params.correlationId
          : typeof args.correlationId === 'string'
            ? args.correlationId
            : 'mcp-req';

      this.config.auditRepo.appendEvent({
        taskId,
        sessionId,
        correlationId,
        eventType: `mcp.${req.method}`,
        actor: 'mcp-caller',
        outcome: outcome === 'error' ? 'error' : outcome,
        details: {
          method: req.method,
          resultCode: code,
          durationMs: Date.now() - startTime,
        },
      });
    } catch {
      // Audit failure must not crash server
    }
  }
}
