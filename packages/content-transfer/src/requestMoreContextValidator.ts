/**
 * @mediator/content-transfer — request_more_context Validator (S09)
 *
 * Requirements:
 * - Validates typed parameters for request_more_context:
 *   - Workspace-relative pathHints and topicHints
 *   - Byte budget limit (<= 1 MB)
 *   - Max excerpts limit (<= 20)
 *   - Clear reason for the request
 * - Rejects:
 *   - Absolute or outside-workspace paths (e.g. C:\..., /etc/...)
 *   - Parent traversal (../)
 *   - Secret paths (matching MANDATORY_EXCLUSIONS from S06)
 *   - Excessive budgets or excerpts
 *   - Unknown injection fields
 */

import { z } from 'zod';
import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
} from '@mediator/shared-contracts';
import { isRelativePathSafe } from '@mediator/context-security';
import { checkPathExclusion, MANDATORY_EXCLUSIONS } from '@mediator/context-security';

export const MAX_CONTEXT_BYTE_BUDGET = 1024 * 1024; // 1 MB
export const MAX_CONTEXT_EXCERPTS = 20;

export interface ValidatedRequestMoreContext {
  readonly taskId: string;
  readonly reason: string;
  readonly pathHints: readonly string[];
  readonly topicHints: readonly string[];
  readonly byteBudget: number;
  readonly maxExcerpts: number;
}

const DisallowedInjectionKeys = ['command', 'exec', 'shell', 'spawn', 'script', 'sudo', 'bypass', 'force'];

export const RequestMoreContextParamSchema = z.object({
  taskId: z.string().min(1, 'taskId is required'),
  reason: z.string().min(1, 'reason is required'),
  pathHints: z.array(z.string()).optional(),
  filePaths: z.array(z.string()).optional(), // alias
  topicHints: z.array(z.string()).optional(),
  byteBudget: z.number().int().positive().max(MAX_CONTEXT_BYTE_BUDGET).optional(),
  maxBytes: z.number().int().positive().max(MAX_CONTEXT_BYTE_BUDGET).optional(), // alias
  maxExcerpts: z.number().int().positive().max(MAX_CONTEXT_EXCERPTS).optional(),
}).passthrough();

export function validateRequestMoreContext(
  params: unknown,
): Result<ValidatedRequestMoreContext, MediatorError> {
  if (typeof params !== 'object' || params === null) {
    return err(
      makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Parameters must be a non-null object'),
    );
  }

  // Check injection keys
  for (const key of Object.keys(params as Record<string, unknown>)) {
    if (DisallowedInjectionKeys.includes(key.toLowerCase())) {
      return err(
        makeMediatorError(
          ErrorCode.SCHEMA_INVALID,
          `Disallowed parameter '${key}' detected in request_more_context.`,
        ),
      );
    }
  }

  const parsed = RequestMoreContextParamSchema.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(
      makeMediatorError(
        ErrorCode.SCHEMA_INVALID,
        `Invalid request_more_context parameters: ${issue?.message ?? 'unknown'}`,
      ),
    );
  }

  const data = parsed.data;
  const pathHints = [...(data.pathHints ?? []), ...(data.filePaths ?? [])];
  const topicHints = data.topicHints ?? [];
  const byteBudget = data.byteBudget ?? data.maxBytes ?? (256 * 1024); // default 256 KB
  const maxExcerpts = data.maxExcerpts ?? 10;

  // Validate every path hint against containment (S04/S05) and secret exclusions (S06)
  for (const hint of pathHints) {
    // 1. Lexical and containment check: must be workspace-relative
    if (!isRelativePathSafe(hint)) {
      return err(
        makeMediatorError(
          ErrorCode.PATH_OUTSIDE_ROOT,
          `Path hint '${hint}' escapes workspace or is an outside absolute path. Only workspace-relative paths permitted.`,
        ),
      );
    }

    // 2. Secret path check
    const excl = checkPathExclusion(hint, MANDATORY_EXCLUSIONS);
    if (excl.excluded) {
      return err(
        makeMediatorError(
          ErrorCode.PATH_PROTECTED,
          `Path hint '${hint}' targets a sensitive secret file (${excl.reason ?? excl.ruleId ?? 'excluded'}).`,
        ),
      );
    }
  }

  return ok({
    taskId: data.taskId,
    reason: data.reason,
    pathHints,
    topicHints,
    byteBudget,
    maxExcerpts,
  });
}
