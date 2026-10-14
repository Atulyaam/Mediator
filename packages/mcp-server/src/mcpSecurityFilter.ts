/**
 * @mediator/mcp-server — Security & Scope Filter (Sprint S16)
 *
 * Enforces:
 * - Task/session scope validation
 * - Request & response size boundaries
 * - Secret exclusion, pattern scanning, and redaction
 * - Absolute denial of mutation tools & privilege escalation
 */

import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
} from '@mediator/shared-contracts';
import {
  scanContent,
  shouldBlockContent,
  redactContent,
} from '@mediator/context-security';
import { type TaskRepository, type TaskRecord } from '@mediator/persistence';
import {
  MAX_MCP_REQUEST_BYTES,
  MAX_MCP_RESPONSE_BYTES,
  FORBIDDEN_MCP_TOOLS,
} from './mcpProtocolTypes.js';

export class McpSecurityFilter {
  constructor(private readonly taskRepo: TaskRepository) {}

  public validateTaskScope(
    taskId: string,
    _sessionId: string,
  ): Result<TaskRecord, MediatorError> {
    if (!taskId || taskId.trim().length === 0) {
      return err(
        makeMediatorError(
          ErrorCode.UNAUTHORIZED_TASK_SCOPE,
          'Missing taskId in MCP request scope',
        ),
      );
    }

    const task = this.taskRepo.getTask(taskId);
    if (!task) {
      return err(
        makeMediatorError(
          ErrorCode.UNAUTHORIZED_TASK_SCOPE,
          `Unauthorized task scope: task "${taskId}" does not exist in local task ledger`,
        ),
      );
    }

    return ok(task);
  }

  public checkRequestPayloadSize(raw: string | Buffer): Result<void, MediatorError> {
    const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length;
    if (bytes > MAX_MCP_REQUEST_BYTES) {
      return err(
        makeMediatorError(
          ErrorCode.OVERSIZED_INPUT,
          `MCP request payload exceeds maximum allowed size (${bytes} > ${MAX_MCP_REQUEST_BYTES} bytes)`,
        ),
      );
    }
    return ok(undefined);
  }

  public checkOperationAllowed(name: string): Result<void, MediatorError> {
    const lower = name.toLowerCase().trim();
    for (const forbidden of FORBIDDEN_MCP_TOOLS) {
      if (lower === forbidden.toLowerCase() || lower.endsWith(forbidden.toLowerCase())) {
        return err(
          makeMediatorError(
            ErrorCode.MCP_MUTATION_PROHIBITED,
            `Forbidden operation: "${name}". MCP context server is strictly read-only and prohibits live file mutations, shell commands, policy edits, and approval resolutions.`,
          ),
        );
      }
    }
    return ok(undefined);
  }

  public sanitizeAndBoundOutput<T>(
    output: T,
    _sourceLabel: string,
  ): Result<T, MediatorError> {
    const rawStr = typeof output === 'string' ? output : JSON.stringify(output);
    const bytes = Buffer.byteLength(rawStr, 'utf8');

    if (bytes > MAX_MCP_RESPONSE_BYTES) {
      return err(
        makeMediatorError(
          ErrorCode.OVERSIZED_INPUT,
          `MCP response exceeds max output size (${bytes} > ${MAX_MCP_RESPONSE_BYTES} bytes)`,
        ),
      );
    }

    // Run S06 secret scanner
    const scan = scanContent(rawStr);
    if (scan.ok && shouldBlockContent(scan.value)) {
      const red = redactContent(rawStr, scan.value);
      if (typeof output === 'string') {
        return ok(red.redactedContent as unknown as T);
      }
      try {
        const parsed = JSON.parse(red.redactedContent) as T;
        return ok(parsed);
      } catch {
        return ok(red.redactedContent as unknown as T);
      }
    }

    return ok(output);
  }
}
