/**
 * @mediator/protocol — Protocol Envelope Types & Normalizer (S08)
 *
 * Requirements:
 * - Versioned envelope containing:
 *   - protocol_version
 *   - task_id
 *   - session_id
 *   - nonce
 *   - round
 *   - sequence
 *   - action_id (optional packet action_id or action-level identifier)
 *   - provider_id
 *   - conversation_id
 *   - message_or_branch_id (where available)
 *   - base_state_hash
 *   - actions
 *   - canonical status: 'continue' | 'await_user' | 'complete'
 * - Rejection of unknown actions, unknown fields (strict mode), missing fields,
 *   malformed identifiers, invalid status values, oversized envelopes.
 * - Rejection of conflicting completion signals (e.g. separate 'complete' action).
 */

import { z } from 'zod';
import {
  PROTOCOL_VERSION,
  ErrorCode,
  type ErrorCodeValue,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
  MAX_ENVELOPE_RAW_BYTES,
} from '@mediator/shared-contracts';
import { CANONICAL_ACTION_IDS } from '@mediator/policy-engine';

export const CanonicalEnvelopeStatus = {
  CONTINUE: 'continue',
  AWAIT_USER: 'await_user',
  COMPLETE: 'complete',
  PROPOSED_COMPLETE: 'proposed_complete',
} as const;

export type CanonicalEnvelopeStatusValue =
  (typeof CanonicalEnvelopeStatus)[keyof typeof CanonicalEnvelopeStatus];

export interface NormalizedAction {
  readonly id: string;
  readonly type: string;
  readonly parameters?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface CanonicalEnvelope {
  readonly protocolVersion: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly round: number;
  readonly sequence: number;
  readonly actionId?: string | undefined;
  readonly providerId: string;
  readonly conversationId: string;
  readonly messageOrBranchId?: string | undefined;
  readonly baseStateHash: string;
  readonly status: CanonicalEnvelopeStatusValue;
  readonly actions: readonly NormalizedAction[];
  readonly contentBlocks: readonly unknown[];
  readonly rawBytesLength: number;
}

// ─── Actions with conflicting completion signals ───────────────────────────
const CONFLICTING_COMPLETION_ACTION_NAMES = new Set([
  'complete',
  'finish',
  'done',
  'complete_task',
  'finish_task',
  'task_complete',
]);

// ─── Base Hash Validator ───────────────────────────────────────────────────
const SHA256_REGEX = /^(sha256:)?[a-f0-9]{64}$/i;

export function normalizeSha256(hash: string): string {
  const clean = hash.trim().toLowerCase();
  return clean.startsWith('sha256:') ? clean.slice(7) : clean;
}

// ─── Zod Schema for Raw Wire Envelope (flexible camelCase / snake_case) ────

const RawActionSchema = z.object({
  id: z.string().min(1, 'Action id is required'),
  type: z.string().min(1, 'Action type is required'),
}).passthrough();

export const WireEnvelopeSchema = z.object({
  // Protocol Version
  protocol_version: z.string().optional(),
  protocolVersion: z.string().optional(),

  // Task & Session
  task_id: z.string().optional(),
  taskId: z.string().optional(),
  session_id: z.string().optional(),
  sessionId: z.string().optional(),

  // Nonce
  nonce: z.string().optional(),

  // Round & Sequence
  round: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]).optional(),
  sequence: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]).optional(),

  // Optional packet action_id
  action_id: z.string().optional(),
  actionId: z.string().optional(),

  // Provider / Conversation
  provider_id: z.string().optional(),
  providerId: z.string().optional(),
  conversation_id: z.string().optional(),
  conversationId: z.string().optional(),
  message_or_branch_id: z.string().optional(),
  messageOrBranchId: z.string().optional(),

  // Nested conversation identity (as in shared-contracts)
  conversation: z.object({
    provider: z.string().optional(),
    providerId: z.string().optional(),
    provider_id: z.string().optional(),
    conversationId: z.string().optional(),
    conversation_id: z.string().optional(),
    branchId: z.string().optional(),
    branch_id: z.string().optional(),
    messageId: z.string().optional(),
    message_id: z.string().optional(),
    tabId: z.number().optional(),
    tab_id: z.number().optional(),
  }).optional(),

  // Base State Hash
  base_state_hash: z.string().optional(),
  baseStateHash: z.string().optional(),

  // Status
  status: z.string().optional(),

  // Actions
  actions: z.array(RawActionSchema).optional(),

  // Content blocks
  content_blocks: z.array(z.unknown()).optional(),
  contentBlocks: z.array(z.unknown()).optional(),
}).passthrough();

/**
 * Normalizes and strictly validates a raw wire envelope.
 * Returns typed errors for missing fields, malformed values, conflicting signals, etc.
 */
export function parseAndValidateEnvelope(
  rawInput: unknown,
): Result<CanonicalEnvelope, MediatorError> {
  if (typeof rawInput !== 'object' || rawInput === null) {
    return err(
      makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Envelope input must be a non-null object', {
        detail: { receivedType: typeof rawInput },
      }),
    );
  }

  // 1. Raw byte length check
  let rawString: string;
  try {
    rawString = JSON.stringify(rawInput);
  } catch (errJson) {
    return err(
      makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Envelope cannot be serialized to JSON', {
        detail: { error: String(errJson) },
      }),
    );
  }

  const rawBytesLength = Buffer.byteLength(rawString, 'utf8');
  if (rawBytesLength > MAX_ENVELOPE_RAW_BYTES) {
    return err(
      makeMediatorError(
        ErrorCode.OVERSIZED_INPUT,
        `Envelope exceeds maximum size of ${MAX_ENVELOPE_RAW_BYTES} bytes (actual: ${rawBytesLength} bytes)`,
        { detail: { byteLength: rawBytesLength, maxAllowed: MAX_ENVELOPE_RAW_BYTES } },
      ),
    );
  }

  // 2. Parse wire schema
  const parsed = WireEnvelopeSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(
      makeMediatorError(ErrorCode.SCHEMA_INVALID, `Malformed envelope: ${issue?.message ?? 'unknown'}`),
    );
  }

  const data = parsed.data;

  // 3. Extract and validate required fields
  const protocolVersion = data.protocol_version ?? data.protocolVersion;
  if (!protocolVersion) {
    return err(makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Missing required field: protocol_version'));
  }
  if (protocolVersion !== PROTOCOL_VERSION) {
    return err(
      makeMediatorError(
        ErrorCode.PROTOCOL_VERSION_UNSUPPORTED,
        `Unsupported protocol version '${protocolVersion}'. Expected '${PROTOCOL_VERSION}'`,
      ),
    );
  }

  const taskId = data.task_id ?? data.taskId;
  if (!taskId || taskId.trim().length === 0) {
    return err(makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Missing required field: task_id'));
  }

  const sessionId = data.session_id ?? data.sessionId;
  if (!sessionId || sessionId.trim().length === 0) {
    return err(makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Missing required field: session_id'));
  }

  const nonce = data.nonce;
  if (!nonce || nonce.trim().length < 8) {
    return err(makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Missing or invalid nonce (must be at least 8 chars)'));
  }

  if (data.round === undefined || typeof data.round !== 'number' || data.round < 0) {
    return err(makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Missing or invalid round (must be non-negative integer)'));
  }
  const round = data.round;

  if (data.sequence === undefined || typeof data.sequence !== 'number' || data.sequence < 0) {
    return err(makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Missing or invalid sequence (must be non-negative integer)'));
  }
  const sequence = data.sequence;

  // Provider ID
  const providerId =
    data.provider_id ??
    data.providerId ??
    data.conversation?.provider ??
    data.conversation?.providerId ??
    data.conversation?.provider_id;
  if (!providerId || providerId.trim().length === 0) {
    return err(makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Missing required field: provider_id'));
  }

  // Conversation ID
  const conversationId =
    data.conversation_id ??
    data.conversationId ??
    data.conversation?.conversationId ??
    data.conversation?.conversation_id;
  if (!conversationId || conversationId.trim().length === 0) {
    return err(makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Missing required field: conversation_id'));
  }

  // Message or branch ID
  const messageOrBranchId =
    data.message_or_branch_id ??
    data.messageOrBranchId ??
    data.conversation?.branchId ??
    data.conversation?.branch_id ??
    data.conversation?.messageId ??
    data.conversation?.message_id;

  // Base state hash
  const rawBaseHash = data.base_state_hash ?? data.baseStateHash;
  if (!rawBaseHash || !SHA256_REGEX.test(rawBaseHash.trim())) {
    return err(
      makeMediatorError(
        ErrorCode.SCHEMA_INVALID,
        'Missing or malformed base_state_hash: must be a valid 64-character SHA-256 hex string',
      ),
    );
  }
  const baseStateHash = normalizeSha256(rawBaseHash);

  // Status
  const rawStatus = (data.status ?? '').trim().toLowerCase();
  let status: CanonicalEnvelopeStatusValue;
  if (
    rawStatus === CanonicalEnvelopeStatus.CONTINUE ||
    rawStatus === CanonicalEnvelopeStatus.AWAIT_USER ||
    rawStatus === CanonicalEnvelopeStatus.COMPLETE ||
    rawStatus === CanonicalEnvelopeStatus.PROPOSED_COMPLETE
  ) {
    status = rawStatus as CanonicalEnvelopeStatusValue;
  } else {
    return err(
      makeMediatorError(
        ErrorCode.STATUS_INVALID as ErrorCodeValue,
        `Invalid status '${data.status}'. Canonical status must be 'continue', 'await_user', or 'complete'`,
      ),
    );
  }

  // Actions
  const rawActions = data.actions ?? [];
  if (!Array.isArray(rawActions)) {
    return err(makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Field actions must be an array'));
  }

  // Check for conflicting completion signals
  for (const action of rawActions) {
    const actType = (action.type ?? '').toLowerCase();
    const actId = (action.id ?? '').toLowerCase();
    if (CONFLICTING_COMPLETION_ACTION_NAMES.has(actType) || CONFLICTING_COMPLETION_ACTION_NAMES.has(actId)) {
      return err(
        makeMediatorError(
          ErrorCode.CONFLICTING_COMPLETION_SIGNAL as ErrorCodeValue,
          `Action '${action.type}' constitutes a conflicting completion signal. Completion is indicated solely via canonical status.`,
        ),
      );
    }

    // Verify action is known in canonical list or standard types
    const isKnownCanonical = (CANONICAL_ACTION_IDS as readonly string[]).includes(action.type);
    if (!isKnownCanonical) {
      return err(
        makeMediatorError(
          ErrorCode.ACTION_DENIED,
          `Unknown action type '${action.type}' in protocol envelope. Only registered actions are accepted.`,
        ),
      );
    }
  }

  const contentBlocks = data.content_blocks ?? data.contentBlocks ?? [];

  const canonical: CanonicalEnvelope = {
    protocolVersion,
    taskId,
    sessionId,
    nonce,
    round,
    sequence,
    actionId: data.action_id ?? data.actionId,
    providerId,
    conversationId,
    messageOrBranchId: messageOrBranchId ? messageOrBranchId.trim() : undefined,
    baseStateHash,
    status,
    actions: rawActions as NormalizedAction[],
    contentBlocks,
    rawBytesLength,
  };

  return ok(canonical);
}
