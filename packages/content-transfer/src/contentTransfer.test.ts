/**
 * @mediator/content-transfer — Sprint S09 Tests
 * Safe Content-Block Framing and Bounded Transfers
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ErrorCode,
  TaskState,
  type WorkspaceRootState,
  type Result,
  type MediatorError,
} from '@mediator/shared-contracts';
import {
  generateCryptoNonce,
  ReplayGuard,
  ProtocolValidator,
} from '@mediator/protocol';
import { type PolicyEvaluationContext } from '@mediator/policy-engine';
import {
  type ContentBlockManifest,
  type TransferChunk,
  type TransferLimits,
  type ParsedContentBlock,
  TransferState,
  DEFAULT_TRANSFER_LIMITS,
} from './transferTypes.js';
import {
  computeSha256,
  validateBlockIntegrity,
  parseFramedPayload,
} from './contentBlockParser.js';
import { TransferStateMachine } from './transferStateMachine.js';
import { ChunkTransferManager } from './chunkManager.js';
import { validateRequestMoreContext } from './requestMoreContextValidator.js';
import { ContentTransferPipeline } from './contentTransferPipeline.js';

function expectChunkPending(res: Result<ParsedContentBlock | null, MediatorError>): void {
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.value).toBeNull();
  }
}

describe('Sprint S09 — Safe Content-Block Framing and Bounded Transfers', () => {
  const TASK_ID = 'task-alpha-1';
  const SESSION_ID = 'session-beta-1';
  const PROVIDER_ID = 'gemini';
  const CONVERSATION_ID = 'conv-12345';
  const BRANCH_ID = 'branch-main';
  const VALID_BASE_HASH = 'a'.repeat(64);

  const MOCK_WORKSPACE_STATE: WorkspaceRootState = {
    selectedPath: 'C:\\Users\\User\\Project',
    canonicalPath: 'C:\\Users\\User\\Project',
    selectionSource: 'ide',
    confirmationStatus: 'confirmed',
    resolutionStatus: 'resolved',
    cloudStatus: 'not_cloud',
  };

  let authoritativeNonce: string;
  let replayGuard: ReplayGuard;
  let protocolValidator: ProtocolValidator;
  let policyContext: PolicyEvaluationContext;

  beforeEach(() => {
    authoritativeNonce = generateCryptoNonce(32);
    replayGuard = new ReplayGuard();
    replayGuard.attachSession({
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      authoritativeNonce,
      providerId: PROVIDER_ID,
      conversationId: CONVERSATION_ID,
      branchId: BRANCH_ID,
      expectedRound: 1,
      expectedSequence: 0,
      expectedBaseStateHash: VALID_BASE_HASH,
    });
    protocolValidator = new ProtocolValidator(replayGuard);

    policyContext = {
      workspace: MOCK_WORKSPACE_STATE,
      task: {
        id: TASK_ID,
        title: 'Alpha Task',
        description: 'Test task',
        workspaceRoot: MOCK_WORKSPACE_STATE.canonicalPath!,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state: TaskState.VALIDATING,
        maxRounds: 10,
      },
      capabilities: new Map(),
      pendingApprovals: [],
    };
  });

  // ─── A. Content Block Integrity & Delimiter Tests ──────────────────────────

  describe('Content Block Parsing & Cryptographic Integrity', () => {
    it('validates exact UTF-8 byte length and SHA-256 hash without trimming or normalization', () => {
      // Content containing multi-byte UTF-8 (emojis and special characters)
      const rawContent = 'export const greeting = "Hello 🚀 World \r\n";\n';
      const exactByteLength = Buffer.byteLength(rawContent, 'utf8');
      const exactHash = computeSha256(rawContent);

      const manifest: ContentBlockManifest = {
        transferId: 'tr_1',
        blockId: 'file_01',
        actionId: 'act_001',
        path: 'src/greeting.ts',
        encoding: 'utf-8',
        byteLength: exactByteLength,
        sha256: exactHash,
      };

      const result = validateBlockIntegrity(manifest, rawContent);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.byteLength).toBe(exactByteLength);
        expect(result.value.content).toBe(rawContent); // Exact characters preserved
      }
    });

    it('rejects byte length mismatch (truncation or silent whitespace trimming)', () => {
      const rawContent = 'export const test = 123;\n';
      const actualBytes = Buffer.byteLength(rawContent, 'utf8');
      const hash = computeSha256(rawContent);

      const manifest: ContentBlockManifest = {
        transferId: 'tr_1',
        blockId: 'file_01',
        actionId: 'act_001',
        encoding: 'utf-8',
        byteLength: actualBytes + 5, // declared 5 bytes longer
        sha256: hash,
      };

      const result = validateBlockIntegrity(manifest, rawContent);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.TRANSFER_INCOMPLETE);
      }
    });

    it('rejects tampered content (checksum mismatch)', () => {
      const rawContent = 'export const test = 123;\n';
      const actualBytes = Buffer.byteLength(rawContent, 'utf8');
      const bogusHash = 'b'.repeat(64);

      const manifest: ContentBlockManifest = {
        transferId: 'tr_1',
        blockId: 'file_01',
        actionId: 'act_001',
        encoding: 'utf-8',
        byteLength: actualBytes,
        sha256: bogusHash,
      };

      const result = validateBlockIntegrity(manifest, rawContent);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.TRANSFER_HASH_MISMATCH);
      }
    });

    it('rejects unsupported encodings', () => {
      const manifest: ContentBlockManifest = {
        transferId: 'tr_1',
        blockId: 'file_01',
        actionId: 'act_001',
        encoding: 'utf-16' as 'utf-8',
        byteLength: 10,
        sha256: 'a'.repeat(64),
      };

      const result = validateBlockIntegrity(manifest, 'test');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.SCHEMA_INVALID);
      }
    });

    it('rejects blocks exceeding maxBlockBytes cap', () => {
      const largeContent = 'a'.repeat(200);
      const manifest: ContentBlockManifest = {
        transferId: 'tr_1',
        blockId: 'file_01',
        actionId: 'act_001',
        encoding: 'utf-8',
        byteLength: 200,
        sha256: computeSha256(largeContent),
      };

      const strictLimits: TransferLimits = {
        ...DEFAULT_TRANSFER_LIMITS,
        maxBlockBytes: 100, // strict 100 bytes cap
      };

      const result = validateBlockIntegrity(manifest, largeContent, strictLimits);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.OVERSIZED_INPUT);
      }
    });
  });

  // ─── B. Manifest-Plus-Body Framing Tests ───────────────────────────────────

  describe('Manifest-Plus-Body Wire Framing', () => {
    it('parses structured wire format with plan manifest and delimited block bodies', () => {
      const fileContent = 'export const answer = 42;\n';
      const fileBytes = Buffer.byteLength(fileContent, 'utf8');
      const fileHash = computeSha256(fileContent);

      const wirePayload = `<<<MEDIATOR_PLAN>>>
{
  "protocol_version": "1.3",
  "task_id": "${TASK_ID}",
  "session_id": "${SESSION_ID}",
  "nonce": "${authoritativeNonce}",
  "round": 1,
  "sequence": 0,
  "provider_id": "${PROVIDER_ID}",
  "conversation_id": "${CONVERSATION_ID}",
  "base_state_hash": "${VALID_BASE_HASH}",
  "status": "continue",
  "actions": [
    {
      "id": "act_007",
      "type": "propose_patch",
      "path": "src/example.ts",
      "content_block_id": "file_01"
    }
  ]
}
<<<END_MEDIATOR_PLAN>>>
<<<MEDIATOR_FILE id="file_01" bytes="${fileBytes}" sha256="${fileHash}" action_id="act_007">>>
${fileContent}<<<END_MEDIATOR_FILE_file_01>>>`;

      const parsed = parseFramedPayload(wirePayload);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.blocks).toHaveLength(1);
        const b = parsed.value.blocks[0];
        expect(b.blockId).toBe('file_01');
        expect(b.byteLength).toBe(fileBytes);
        expect(b.content).toBe(fileContent);
      }
    });

    it('rejects incomplete framing when opening tag is missing closing delimiter', () => {
      const truncatedWire = `<<<MEDIATOR_PLAN>>>
{ "protocol_version": "1.3" }
<<<MEDIATOR_FILE id="file_01" bytes="10" sha256="${'a'.repeat(64)}">>>
some content without closing delimiter`;

      const parsed = parseFramedPayload(truncatedWire);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe(ErrorCode.TRANSFER_INCOMPLETE);
      }
    });

    it('rejects oversized total payload', () => {
      const huge = 'x'.repeat(1000);
      const strictLimits: TransferLimits = {
        ...DEFAULT_TRANSFER_LIMITS,
        maxTotalTransferBytes: 500,
      };

      const parsed = parseFramedPayload(huge, strictLimits);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe(ErrorCode.OVERSIZED_INPUT);
      }
    });
  });

  // ─── C. Transfer State Machine Tests ───────────────────────────────────────

  describe('Transfer State Machine', () => {
    it('follows explicit lifecycle RECEIVING -> VALIDATING -> COMPLETE', () => {
      const sm = new TransferStateMachine('tr_1', SESSION_ID, TASK_ID);
      expect(sm.getState()).toBe(TransferState.RECEIVING);
      expect(sm.isComplete()).toBe(false);

      expect(sm.transitionToValidating().ok).toBe(true);
      expect(sm.getState()).toBe(TransferState.VALIDATING);

      expect(sm.transitionToComplete().ok).toBe(true);
      expect(sm.getState()).toBe(TransferState.COMPLETE);
      expect(sm.isComplete()).toBe(true);
    });

    it('rejects invalid state transitions (cannot jump RECEIVING to COMPLETE)', () => {
      const sm = new TransferStateMachine('tr_1', SESSION_ID, TASK_ID);
      const res = sm.transitionToComplete();
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.INVALID_STATE_TRANSITION);
      }
    });

    it('automatically transitions to EXPIRED upon timeout', () => {
      // 10ms timeout for test
      const sm = new TransferStateMachine('tr_1', SESSION_ID, TASK_ID, 5);
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(sm.getState()).toBe(TransferState.EXPIRED);
          expect(sm.isTerminal()).toBe(true);
          resolve();
        }, 15);
      });
    });
  });

  // ─── D. Bounded Chunk Transfer Manager Tests ───────────────────────────────

  describe('Bounded Chunk Manager', () => {
    let chunkManager: ChunkTransferManager;

    beforeEach(() => {
      chunkManager = new ChunkTransferManager({
        ...DEFAULT_TRANSFER_LIMITS,
        maxChunkBytes: 50, // Small chunk limit for tests
      });
    });

    it('reassembles chunks delivered in order', () => {
      const part1 = 'Part1: Hello ';
      const part2 = 'Part2: Bounded ';
      const part3 = 'Part3: World!';
      const full = part1 + part2 + part3;

      const manifest: ContentBlockManifest = {
        transferId: 'tr_chunked_1',
        blockId: 'block_c1',
        actionId: 'act_c1',
        encoding: 'utf-8',
        byteLength: Buffer.byteLength(full, 'utf8'),
        sha256: computeSha256(full),
      };

      chunkManager.startTransfer(manifest, SESSION_ID, TASK_ID);

      const chunk0: TransferChunk = {
        transferId: 'tr_chunked_1',
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        blockId: 'block_c1',
        chunkIndex: 0,
        totalChunks: 3,
        byteLength: Buffer.byteLength(part1, 'utf8'),
        sha256: computeSha256(part1),
        data: part1,
      };

      const chunk1: TransferChunk = {
        transferId: 'tr_chunked_1',
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        blockId: 'block_c1',
        chunkIndex: 1,
        totalChunks: 3,
        byteLength: Buffer.byteLength(part2, 'utf8'),
        sha256: computeSha256(part2),
        data: part2,
      };

      const chunk2: TransferChunk = {
        transferId: 'tr_chunked_1',
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        blockId: 'block_c1',
        chunkIndex: 2,
        totalChunks: 3,
        byteLength: Buffer.byteLength(part3, 'utf8'),
        sha256: computeSha256(part3),
        data: part3,
      };

      expectChunkPending(chunkManager.appendChunk(chunk0));
      expectChunkPending(chunkManager.appendChunk(chunk1));
      const finalResult = chunkManager.appendChunk(chunk2);

      expect(finalResult.ok).toBe(true);
      if (finalResult.ok && finalResult.value) {
        expect(finalResult.value.content).toBe(full);
        expect(finalResult.value.byteLength).toBe(Buffer.byteLength(full, 'utf8'));
      }
    });

    it('reassembles chunks delivered OUT OF ORDER (chunk 2, chunk 0, chunk 1)', () => {
      const part0 = 'ChunkZero ';
      const part1 = 'ChunkOne ';
      const part2 = 'ChunkTwo!';
      const full = part0 + part1 + part2;

      const manifest: ContentBlockManifest = {
        transferId: 'tr_reorder_1',
        blockId: 'block_reorder',
        actionId: 'act_ro',
        encoding: 'utf-8',
        byteLength: Buffer.byteLength(full, 'utf8'),
        sha256: computeSha256(full),
      };

      chunkManager.startTransfer(manifest, SESSION_ID, TASK_ID);

      const makeChunk = (idx: number, data: string): TransferChunk => ({
        transferId: 'tr_reorder_1',
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        blockId: 'block_reorder',
        chunkIndex: idx,
        totalChunks: 3,
        byteLength: Buffer.byteLength(data, 'utf8'),
        sha256: computeSha256(data),
        data,
      });

      // Deliver 2, then 0, then 1
      expectChunkPending(chunkManager.appendChunk(makeChunk(2, part2)));
      expectChunkPending(chunkManager.appendChunk(makeChunk(0, part0)));
      const res = chunkManager.appendChunk(makeChunk(1, part1));

      expect(res.ok).toBe(true);
      if (res.ok && res.value) {
        expect(res.value.content).toBe(full); // Reassembled in correct 0,1,2 order!
      }
    });

    it('handles duplicate chunks idempotently without duplicating bytes', () => {
      const part0 = 'Chunk0 ';
      const part1 = 'Chunk1';
      const full = part0 + part1;

      const manifest: ContentBlockManifest = {
        transferId: 'tr_dup',
        blockId: 'block_dup',
        actionId: 'act_dup',
        encoding: 'utf-8',
        byteLength: Buffer.byteLength(full, 'utf8'),
        sha256: computeSha256(full),
      };

      chunkManager.startTransfer(manifest, SESSION_ID, TASK_ID);

      const chunk0: TransferChunk = {
        transferId: 'tr_dup',
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        blockId: 'block_dup',
        chunkIndex: 0,
        totalChunks: 2,
        byteLength: Buffer.byteLength(part0, 'utf8'),
        sha256: computeSha256(part0),
        data: part0,
      };

      // Append chunk 0 twice
      expectChunkPending(chunkManager.appendChunk(chunk0));
      expectChunkPending(chunkManager.appendChunk(chunk0)); // Idempotent ignore

      const chunk1: TransferChunk = {
        transferId: 'tr_dup',
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        blockId: 'block_dup',
        chunkIndex: 1,
        totalChunks: 2,
        byteLength: Buffer.byteLength(part1, 'utf8'),
        sha256: computeSha256(part1),
        data: part1,
      };

      const res = chunkManager.appendChunk(chunk1);
      expect(res.ok).toBe(true);
      if (res.ok && res.value) {
        expect(res.value.content).toBe(full);
      }
    });

    it('rejects conflicting duplicate chunk with different content (TAMPERING_DETECTED)', () => {
      const part0 = 'Chunk0 Original';
      const part0Tampered = 'Chunk0 Tampered';

      const manifest: ContentBlockManifest = {
        transferId: 'tr_conflict',
        blockId: 'block_conflict',
        actionId: 'act_conflict',
        encoding: 'utf-8',
        byteLength: 50,
        sha256: 'a'.repeat(64),
      };

      chunkManager.startTransfer(manifest, SESSION_ID, TASK_ID);

      const chunk0: TransferChunk = {
        transferId: 'tr_conflict',
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        blockId: 'block_conflict',
        chunkIndex: 0,
        totalChunks: 2,
        byteLength: Buffer.byteLength(part0, 'utf8'),
        sha256: computeSha256(part0),
        data: part0,
      };

      expectChunkPending(chunkManager.appendChunk(chunk0));

      // Conflicting chunk 0
      const chunk0Conflict: TransferChunk = {
        transferId: 'tr_conflict',
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        blockId: 'block_conflict',
        chunkIndex: 0,
        totalChunks: 2,
        byteLength: Buffer.byteLength(part0Tampered, 'utf8'),
        sha256: computeSha256(part0Tampered),
        data: part0Tampered,
      };

      const res = chunkManager.appendChunk(chunk0Conflict);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.TAMPERING_DETECTED);
      }
    });

    it('rejects cross-session chunks (SESSION_MISMATCH)', () => {
      const manifest: ContentBlockManifest = {
        transferId: 'tr_sess',
        blockId: 'block_sess',
        actionId: 'act_sess',
        encoding: 'utf-8',
        byteLength: 20,
        sha256: 'a'.repeat(64),
      };

      chunkManager.startTransfer(manifest, SESSION_ID, TASK_ID);

      const attackerChunk: TransferChunk = {
        transferId: 'tr_sess',
        sessionId: 'session-attacker', // Cross session!
        taskId: TASK_ID,
        blockId: 'block_sess',
        chunkIndex: 0,
        totalChunks: 1,
        byteLength: 5,
        sha256: computeSha256('hello'),
        data: 'hello',
      };

      const res = chunkManager.appendChunk(attackerChunk);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.SESSION_MISMATCH);
      }
    });

    it('rejects chunks with corrupted per-chunk hash', () => {
      const manifest: ContentBlockManifest = {
        transferId: 'tr_corrupt',
        blockId: 'block_corrupt',
        actionId: 'act_corrupt',
        encoding: 'utf-8',
        byteLength: 20,
        sha256: 'a'.repeat(64),
      };

      chunkManager.startTransfer(manifest, SESSION_ID, TASK_ID);

      const corruptedChunk: TransferChunk = {
        transferId: 'tr_corrupt',
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        blockId: 'block_corrupt',
        chunkIndex: 0,
        totalChunks: 1,
        byteLength: 5,
        sha256: 'badhash'.repeat(9).slice(0, 64),
        data: 'hello',
      };

      const res = chunkManager.appendChunk(corruptedChunk);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.TRANSFER_HASH_MISMATCH);
      }
    });
  });

  // ─── E. request_more_context Validation Tests ──────────────────────────────

  describe('request_more_context Parameter Validation', () => {
    it('accepts valid request_more_context with relative hints and reasonable budget', () => {
      const params = {
        taskId: TASK_ID,
        reason: 'Need unit test file context to verify imports',
        pathHints: ['src/index.ts', 'src/utils.ts'],
        topicHints: ['imports', 'configuration'],
        byteBudget: 128 * 1024,
        maxExcerpts: 5,
      };

      const res = validateRequestMoreContext(params);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.taskId).toBe(TASK_ID);
        expect(res.value.pathHints).toHaveLength(2);
      }
    });

    it('rejects outside-workspace paths and traversal tokens (../)', () => {
      const params = {
        taskId: TASK_ID,
        reason: 'Inspect parent config',
        pathHints: ['../../sensitive.txt'],
      };

      const res = validateRequestMoreContext(params);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PATH_OUTSIDE_ROOT);
      }

      const paramsAbs = {
        taskId: TASK_ID,
        reason: 'Inspect root',
        pathHints: ['C:\\Windows\\system32\\cmd.exe'],
      };
      const resAbs = validateRequestMoreContext(paramsAbs);
      expect(resAbs.ok).toBe(false);
    });

    it('rejects secret paths matching mandatory exclusions (.env, id_rsa, etc.)', () => {
      const params = {
        taskId: TASK_ID,
        reason: 'Check env configuration',
        pathHints: ['.env'],
      };

      const res = validateRequestMoreContext(params);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PATH_PROTECTED);
      }
    });

    it('rejects excessive byte budgets (> 1 MB)', () => {
      const params = {
        taskId: TASK_ID,
        reason: 'Need whole codebase',
        byteBudget: 5 * 1024 * 1024, // 5 MB
      };

      const res = validateRequestMoreContext(params);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.SCHEMA_INVALID);
      }
    });
  });

  // ─── F. End-to-End Invariant Pipeline Tests ────────────────────────────────

  describe('End-to-End Content Transfer Pipeline', () => {
    it('executes: raw response → envelope validation → bounded transfer → length/hash verification → complete proposal', () => {
      const pipeline = new ContentTransferPipeline(protocolValidator);

      const fileBody = 'export function calculateTotal(a: number, b: number): number {\n  return a + b;\n}\n';
      const fileBytes = Buffer.byteLength(fileBody, 'utf8');
      const fileHash = computeSha256(fileBody);

      const rawResponse = `<<<MEDIATOR_PLAN>>>
{
  "protocol_version": "1.3",
  "task_id": "${TASK_ID}",
  "session_id": "${SESSION_ID}",
  "nonce": "${authoritativeNonce}",
  "round": 1,
  "sequence": 0,
  "provider_id": "${PROVIDER_ID}",
  "conversation_id": "${CONVERSATION_ID}",
  "message_or_branch_id": "${BRANCH_ID}",
  "base_state_hash": "${VALID_BASE_HASH}",
  "status": "continue",
  "actions": [
    {
      "id": "act_patch_1",
      "type": "propose_patch",
      "targetPath": "src/math.ts",
      "patchContent": "...",
      "content_block_id": "math_code_block"
    }
  ]
}
<<<END_MEDIATOR_PLAN>>>
<<<MEDIATOR_FILE id="math_code_block" bytes="${fileBytes}" sha256="${fileHash}" action_id="act_patch_1">>>
${fileBody}<<<END_MEDIATOR_FILE_math_code_block>>>`;

      const result = pipeline.processRawResponse(rawResponse, policyContext);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.readyForStaging).toBe(true);
        expect(result.value.blocks).toHaveLength(1);
        expect(result.value.blocks[0].content).toBe(fileBody);
        expect(result.value.envelope.actions).toHaveLength(1);

        // Sequence must now be advanced in replay guard
        const snapshot = replayGuard.getSessionSnapshot();
        expect(snapshot?.expectedSequence).toBe(1);
      }
    });

    it('fails closed when content block referenced by action is missing from payload', () => {
      const pipeline = new ContentTransferPipeline(protocolValidator);

      // Action references "missing_block", but no <<<MEDIATOR_FILE>>> is provided
      const rawResponse = `<<<MEDIATOR_PLAN>>>
{
  "protocol_version": "1.3",
  "task_id": "${TASK_ID}",
  "session_id": "${SESSION_ID}",
  "nonce": "${authoritativeNonce}",
  "round": 1,
  "sequence": 0,
  "provider_id": "${PROVIDER_ID}",
  "conversation_id": "${CONVERSATION_ID}",
  "base_state_hash": "${VALID_BASE_HASH}",
  "status": "continue",
  "actions": [
    {
      "id": "act_patch_missing",
      "type": "propose_patch",
      "targetPath": "src/math.ts",
      "patchContent": "...",
      "content_block_id": "missing_block"
    }
  ]
}
<<<END_MEDIATOR_PLAN>>>`;

      const result = pipeline.processRawResponse(rawResponse, policyContext);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.CONTENT_BLOCK_MISSING);
      }

      // Replay guard must NOT have advanced sequence!
      expect(replayGuard.getSessionSnapshot()?.expectedSequence).toBe(0);
    });

    it('fails closed when file body hash in framed block does not match declared hash', () => {
      const pipeline = new ContentTransferPipeline(protocolValidator);

      const fileBody = 'export const x = 1;\n';
      const fileBytes = Buffer.byteLength(fileBody, 'utf8');
      const bogusHash = 'c'.repeat(64);

      const rawResponse = `<<<MEDIATOR_PLAN>>>
{
  "protocol_version": "1.3",
  "task_id": "${TASK_ID}",
  "session_id": "${SESSION_ID}",
  "nonce": "${authoritativeNonce}",
  "round": 1,
  "sequence": 0,
  "provider_id": "${PROVIDER_ID}",
  "conversation_id": "${CONVERSATION_ID}",
  "base_state_hash": "${VALID_BASE_HASH}",
  "status": "continue",
  "actions": [
    {
      "id": "act_corrupt",
      "type": "propose_patch",
      "targetPath": "src/math.ts",
      "patchContent": "...",
      "content_block_id": "corrupt_block"
    }
  ]
}
<<<END_MEDIATOR_PLAN>>>
<<<MEDIATOR_FILE id="corrupt_block" bytes="${fileBytes}" sha256="${bogusHash}" action_id="act_corrupt">>>
${fileBody}<<<END_MEDIATOR_FILE_corrupt_block>>>`;

      const result = pipeline.processRawResponse(rawResponse, policyContext);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.TRANSFER_HASH_MISMATCH);
      }

      // Zero side effects on replay state
      expect(replayGuard.getSessionSnapshot()?.expectedSequence).toBe(0);
    });
  });
});
