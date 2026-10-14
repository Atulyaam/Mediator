/**
 * @mediator/mcp-server — MCP Protocol & Schema Types (Sprint S16)
 *
 * Implements Model Context Protocol (MCP) v1.0 / JSON-RPC 2.0 specifications.
 * Strictly read-only contracts and explicit prohibition of mutation.
 */

import { z } from 'zod';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'mediator-mcp-server';
export const MCP_SERVER_VERSION = '0.0.1';

export const MAX_MCP_REQUEST_BYTES = 1024 * 1024; // 1 MB
export const MAX_MCP_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

// ─── JSON-RPC 2.0 ──────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown> | undefined;
}

export interface JsonRpcResponse<T = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: T | undefined;
  readonly error?: JsonRpcErrorObject | undefined;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom Mediator MCP Error Codes
  UNAUTHORIZED_TASK_SCOPE: -32001,
  MCP_MUTATION_PROHIBITED: -32002,
  OVERSIZED_PAYLOAD: -32003,
  RESOURCE_NOT_FOUND: -32004,
  CAPABILITY_UNAVAILABLE: -32005,
} as const;

// ─── Resource URIs ─────────────────────────────────────────────────────────

export const MCP_RESOURCE_URIS = {
  TASK_CURRENT: 'mediator://task/current',
  TASK_BRIEF: 'mediator://task/brief',
  TASK_ACCEPTANCE_CRITERIA: 'mediator://task/acceptance-criteria',
  TASK_CHANGED_FILES: 'mediator://task/changed-files',
  TASK_VERIFICATION_STATUS: 'mediator://task/verification-status',
  TASK_CONTEXT: 'mediator://task/context',
  PROJECT_RULES: 'mediator://project/rules',
} as const;

export type McpResourceUri = (typeof MCP_RESOURCE_URIS)[keyof typeof MCP_RESOURCE_URIS];

export const REGISTERED_RESOURCE_DEFINITIONS = [
  {
    uri: MCP_RESOURCE_URIS.TASK_CURRENT,
    name: 'Current Task Brief',
    description: 'Current active task goal, constraints, blockers, and status',
    mimeType: 'application/json',
  },
  {
    uri: MCP_RESOURCE_URIS.TASK_BRIEF,
    name: 'Task Brief (Alias)',
    description: 'Current active task goal and acceptance criteria',
    mimeType: 'application/json',
  },
  {
    uri: MCP_RESOURCE_URIS.TASK_ACCEPTANCE_CRITERIA,
    name: 'Task Acceptance Criteria',
    description: 'Strict acceptance criteria list for current task',
    mimeType: 'application/json',
  },
  {
    uri: MCP_RESOURCE_URIS.TASK_CHANGED_FILES,
    name: 'Task Changed Files',
    description: 'Summary of proposed staged file changes for current task',
    mimeType: 'application/json',
  },
  {
    uri: MCP_RESOURCE_URIS.TASK_VERIFICATION_STATUS,
    name: 'Task Verification Status',
    description: 'Evidence verification status and recorded test results',
    mimeType: 'application/json',
  },
  {
    uri: MCP_RESOURCE_URIS.TASK_CONTEXT,
    name: 'Task Context',
    description: 'Relevant compact context packet assembled for current task',
    mimeType: 'application/json',
  },
  {
    uri: MCP_RESOURCE_URIS.PROJECT_RULES,
    name: 'Project Rules',
    description: 'Approved project rules and architectural constraints (.mediator/rules.md)',
    mimeType: 'text/markdown',
  },
] as const;

// ─── Read-only Tools ───────────────────────────────────────────────────────

export const MCP_TOOL_NAMES = {
  GET_CAPABILITIES: 'mediator.get_capabilities',
  GET_TASK_BRIEF: 'mediator.get_task_brief',
  GET_RELEVANT_CONTEXT: 'mediator.get_relevant_context',
  GET_STAGED_CHANGES: 'mediator.get_staged_changes',
  GET_DIFF: 'mediator.get_diff',
  REQUEST_REVIEW: 'mediator.request_review',
} as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[keyof typeof MCP_TOOL_NAMES];

// ─── Explicitly Prohibited Operations ──────────────────────────────────────

export const FORBIDDEN_MCP_TOOLS: readonly string[] = [
  'run_command',
  'run_recipe',
  'run_shell',
  'execute_command',
  'execute_shell',
  'run_tests',
  'write_file',
  'create_file',
  'delete_file',
  'rename_file',
  'apply_patch',
  'apply_back',
  'resolve_approval',
  'approve_diff',
  'create_approval',
  'bypass_approval',
  'set_policy',
  'update_policy',
  'set_workspace_root',
  'switch_workspace',
  'resume_task',
  'stop_task',
  'discard_stage',
  'rollback',
  'mediator.run_recipe',
  'mediator.apply_back',
  'mediator.resolve_approval',
  'mediator.approve_diff',
  'mediator.write_file',
  'mediator.delete_file',
  'mediator.resume_task',
];

// ─── Zod Schemas for Validation ────────────────────────────────────────────

export const BaseMcpScopeSchema = z.object({
  taskId: z.string().min(1, 'taskId is required'),
  sessionId: z.string().min(1, 'sessionId is required'),
  correlationId: z.string().optional(),
});

export const ResourceReadParamsSchema = z.object({
  uri: z.string().min(1, 'Resource uri is required'),
  taskId: z.string().min(1, 'taskId is required'),
  sessionId: z.string().min(1, 'sessionId is required'),
  correlationId: z.string().optional(),
});

export const GetCapabilitiesArgsSchema = z.object({
  taskId: z.string().min(1, 'taskId is required').optional(),
  sessionId: z.string().min(1, 'sessionId is required').optional(),
  correlationId: z.string().optional(),
});

export const GetTaskBriefArgsSchema = BaseMcpScopeSchema.extend({
  includeDecisions: z.boolean().optional(),
});

export const GetRelevantContextArgsSchema = BaseMcpScopeSchema.extend({
  maxBytes: z.number().int().positive().max(512 * 1024).optional(),
  requestedFilePaths: z.array(z.string()).max(20).optional(),
});

export const GetStagedChangesArgsSchema = BaseMcpScopeSchema.extend({
  stageId: z.string().optional(),
});

export const GetDiffArgsSchema = BaseMcpScopeSchema.extend({
  stageId: z.string().optional(),
  relativePath: z.string().optional(),
  maxLines: z.number().int().positive().max(1000).optional(),
  maxBytes: z.number().int().positive().max(128 * 1024).optional(),
});

export const RequestReviewArgsSchema = BaseMcpScopeSchema.extend({
  actionId: z.string().optional(),
  stageId: z.string().optional(),
  payloadHash: z.string().optional(),
  requestedScope: z.array(z.string()).min(1, 'requestedScope must not be empty'),
  reason: z.string().min(1, 'reason is required').max(2048),
});

export const ToolCallParamsSchema = z.object({
  name: z.string().min(1, 'Tool name is required'),
  arguments: z.record(z.unknown()).default({}),
});

export const REGISTERED_TOOL_DEFINITIONS = [
  {
    name: MCP_TOOL_NAMES.GET_CAPABILITIES,
    description: 'Get detected IDE capabilities, version info, and verified runtime status',
    inputSchema: {
      type: 'object',
      properties: {
        correlationId: { type: 'string', description: 'Optional request correlation ID' },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.GET_TASK_BRIEF,
    description: 'Get current authorized task brief, goals, acceptance criteria, and constraints',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'sessionId'],
      properties: {
        taskId: { type: 'string' },
        sessionId: { type: 'string' },
        includeDecisions: { type: 'boolean' },
        correlationId: { type: 'string' },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.GET_RELEVANT_CONTEXT,
    description: 'Get bounded, relevance-ranked context packet from context engine',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'sessionId'],
      properties: {
        taskId: { type: 'string' },
        sessionId: { type: 'string' },
        maxBytes: { type: 'number', maximum: 524288 },
        requestedFilePaths: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        correlationId: { type: 'string' },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.GET_STAGED_CHANGES,
    description: 'List proposed staged changes and conflict flags for current task',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'sessionId'],
      properties: {
        taskId: { type: 'string' },
        sessionId: { type: 'string' },
        stageId: { type: 'string' },
        correlationId: { type: 'string' },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.GET_DIFF,
    description: 'Get isolated unified diff preview for staged changes',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'sessionId'],
      properties: {
        taskId: { type: 'string' },
        sessionId: { type: 'string' },
        stageId: { type: 'string' },
        relativePath: { type: 'string' },
        maxLines: { type: 'number', maximum: 1000 },
        maxBytes: { type: 'number', maximum: 131072 },
        correlationId: { type: 'string' },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.REQUEST_REVIEW,
    description: 'Submit a request for human review in the IDE UI. Note: This creates a pending review request only; it does not approve or authorize changes.',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'sessionId', 'requestedScope', 'reason'],
      properties: {
        taskId: { type: 'string' },
        sessionId: { type: 'string' },
        actionId: { type: 'string' },
        stageId: { type: 'string' },
        payloadHash: { type: 'string' },
        requestedScope: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
        correlationId: { type: 'string' },
      },
    },
  },
] as const;
