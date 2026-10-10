/**
 * @mediator/protocol — Sprint S08 Tests
 * Nonce-Bound Protocol Envelope and Replay Protection
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ErrorCode,
  TaskState,
  type WorkspaceRootState,
  EvidenceLevel,
} from '@mediator/shared-contracts';
import {
  generateCryptoNonce,
  timingSafeEqualNonce,
  maskNonce,
  createSessionNonceBinding,
  rotateSessionNonce,
} from './cryptoNonce.js';
import {
  parseAndValidateEnvelope,
  type CanonicalEnvelope,
} from './envelopeTypes.js';
import {
  ReplayGuard,
  type ActiveSessionContext,
} from './replayGuard.js';
import { ProtocolValidator } from './protocolValidator.js';
import { type PolicyEvaluationContext } from '@mediator/policy-engine';

describe('Sprint S08 — Nonce-Bound Protocol Envelope & Replay Protection', () => {
  const MOCK_WORKSPACE_STATE: WorkspaceRootState = {
    selectedPath: 'C:\\Users\\User\\Project',
    canonicalPath: 'C:\\Users\\User\\Project',
    selectionSource: 'ide',
    confirmationStatus: 'confirmed',
    resolutionStatus: 'resolved',
    cloudStatus: 'not_cloud',
  };

  const VALID_BASE_HASH = 'a'.repeat(64);
  const TASK_ID = 'task-alpha-1';
  const SESSION_ID = 'session-beta-1';
  const PROVIDER_ID = 'gemini';
  const CONVERSATION_ID = 'conv-12345';
  const BRANCH_ID = 'branch-main';

  let authoritativeNonce: string;
  let activeContext: ActiveSessionContext;
  let replayGuard: ReplayGuard;
  let protocolValidator: ProtocolValidator;
  let policyContext: PolicyEvaluationContext;

  beforeEach(() => {
    authoritativeNonce = generateCryptoNonce(32);
    activeContext = {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      authoritativeNonce,
      providerId: PROVIDER_ID,
      conversationId: CONVERSATION_ID,
      branchId: BRANCH_ID,
      expectedRound: 1,
      expectedSequence: 0,
      expectedBaseStateHash: VALID_BASE_HASH,
    };
    replayGuard = new ReplayGuard();
    replayGuard.attachSession(activeContext);
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

  // ─── A. Cryptographic Nonce Tests ──────────────────────────────────────────

  describe('Cryptographic Session Nonce', () => {
    it('generates unique, cryptographically random nonces (CSPRNG)', () => {
      const nonce1 = generateCryptoNonce(32);
      const nonce2 = generateCryptoNonce(32);
      expect(nonce1).toHaveLength(64); // 32 bytes hex
      expect(nonce2).toHaveLength(64);
      expect(nonce1).not.toBe(nonce2);
    });

    it('timingSafeEqualNonce compares nonces in constant time and rejects inequality', () => {
      const nonceA = generateCryptoNonce(32);
      const nonceB = generateCryptoNonce(32);
      expect(timingSafeEqualNonce(nonceA, nonceA)).toBe(true);
      expect(timingSafeEqualNonce(nonceA, nonceB)).toBe(false);
      expect(timingSafeEqualNonce(nonceA, '')).toBe(false);
      expect(timingSafeEqualNonce('', nonceB)).toBe(false);
    });

    it('masks nonces safely to prevent leakage in ordinary logs and error messages', () => {
      const nonce = generateCryptoNonce(32);
      const masked = maskNonce(nonce);
      expect(masked).not.toBe(nonce);
      expect(masked).toContain('...');
      expect(masked.length).toBeLessThan(nonce.length);
      expect(maskNonce('')).toBe('[NONCE_INVALID]');
    });

    it('rotates session nonce when session is invalidated or rebound', () => {
      const binding = createSessionNonceBinding(TASK_ID, SESSION_ID, CONVERSATION_ID);
      const rotated = rotateSessionNonce(binding, 'conv-67890');
      expect(rotated.nonce).not.toBe(binding.nonce);
      expect(rotated.conversationId).toBe('conv-67890');
      expect(rotated.rotatedAt).toBeDefined();
    });
  });

  // ─── B. Protocol Envelope Parsing & Validation ─────────────────────────────

  describe('Protocol Envelope Validation', () => {
    function makeWireEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        protocol_version: '1.3',
        task_id: TASK_ID,
        session_id: SESSION_ID,
        nonce: authoritativeNonce,
        round: 1,
        sequence: 0,
        provider_id: PROVIDER_ID,
        conversation_id: CONVERSATION_ID,
        message_or_branch_id: BRANCH_ID,
        base_state_hash: VALID_BASE_HASH,
        status: 'continue',
        actions: [
          {
            id: 'act-1',
            type: 'read_file',
            path: 'src/index.ts',
          },
        ],
        ...overrides,
      };
    }

    it('accepts a structurally valid envelope (both snake_case and camelCase)', () => {
      const wire = makeWireEnvelope();
      const res = parseAndValidateEnvelope(wire);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.protocolVersion).toBe('1.3');
        expect(res.value.taskId).toBe(TASK_ID);
        expect(res.value.status).toBe('continue');
        expect(res.value.actions).toHaveLength(1);
      }

      // Also accepts camelCase
      const camelWire = {
        protocolVersion: '1.3',
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        nonce: authoritativeNonce,
        round: 1,
        sequence: 0,
        conversation: {
          provider: PROVIDER_ID,
          conversationId: CONVERSATION_ID,
          branchId: BRANCH_ID,
        },
        baseStateHash: VALID_BASE_HASH,
        status: 'complete',
        actions: [
          {
            id: 'act-1',
            type: 'read_file',
            path: 'src/index.ts',
          },
        ],
      };
      const camelRes = parseAndValidateEnvelope(camelWire);
      expect(camelRes.ok).toBe(true);
      if (camelRes.ok) {
        expect(camelRes.value.status).toBe('complete');
      }
    });

    it('rejects unsupported protocol version', () => {
      const wire = makeWireEnvelope({ protocol_version: '2.0' });
      const res = parseAndValidateEnvelope(wire);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.PROTOCOL_VERSION_UNSUPPORTED);
      }
    });

    it('rejects missing required fields (task_id, session_id, round, sequence, nonce, status)', () => {
      const wireMissingTask = makeWireEnvelope();
      delete wireMissingTask.task_id;
      const res = parseAndValidateEnvelope(wireMissingTask);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.SCHEMA_INVALID);
      }

      const wireMissingNonce = makeWireEnvelope({ nonce: '' });
      const resNonce = parseAndValidateEnvelope(wireMissingNonce);
      expect(resNonce.ok).toBe(false);
    });

    it('rejects malformed or invalid status values', () => {
      const wire = makeWireEnvelope({ status: 'done_and_finished' });
      const res = parseAndValidateEnvelope(wire);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.STATUS_INVALID);
      }
    });

    it('rejects conflicting completion signals (e.g. action named complete)', () => {
      const wire = makeWireEnvelope({
        actions: [
          {
            id: 'act-complete',
            type: 'complete',
          },
        ],
      });
      const res = parseAndValidateEnvelope(wire);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.CONFLICTING_COMPLETION_SIGNAL);
      }
    });

    it('rejects unknown action types', () => {
      const wire = makeWireEnvelope({
        actions: [
          {
            id: 'act-unknown',
            type: 'execute_arbitrary_shell_command',
          },
        ],
      });
      const res = parseAndValidateEnvelope(wire);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.ACTION_DENIED);
      }
    });

    it('rejects malformed base_state_hash', () => {
      const wire = makeWireEnvelope({ base_state_hash: 'not-a-sha256' });
      const res = parseAndValidateEnvelope(wire);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.SCHEMA_INVALID);
      }
    });

    it('rejects oversized inputs (> 1 MB)', () => {
      const largeString = 'x'.repeat(1024 * 1024 + 10);
      const wire = makeWireEnvelope({
        actions: [
          {
            id: 'act-large',
            type: 'read_file',
            path: largeString,
          },
        ],
      });
      const res = parseAndValidateEnvelope(wire);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.OVERSIZED_INPUT);
      }
    });
  });

  // ─── C. Replay Protection & Sequence Guard Tests ───────────────────────────

  describe('Replay Guard & Session Binding', () => {
    function makeCanonicalEnvelope(overrides: Partial<CanonicalEnvelope> = {}): CanonicalEnvelope {
      return {
        protocolVersion: '1.3',
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        nonce: authoritativeNonce,
        round: 1,
        sequence: 0,
        providerId: PROVIDER_ID,
        conversationId: CONVERSATION_ID,
        messageOrBranchId: BRANCH_ID,
        baseStateHash: VALID_BASE_HASH,
        status: 'continue',
        actions: [
          {
            id: 'act-1',
            type: 'read_file',
            path: 'src/index.ts',
          },
        ],
        contentBlocks: [],
        rawBytesLength: 200,
        ...overrides,
      };
    }

    it('accepts and consumes a valid first envelope and advances sequence', () => {
      const env = makeCanonicalEnvelope();
      const res = replayGuard.validateAndConsume(env);
      expect(res.ok).toBe(true);

      const snapshot = replayGuard.getSessionSnapshot();
      expect(snapshot?.expectedSequence).toBe(1);
    });

    it('rejects wrong nonce (NONCE_MISMATCH) and does NOT leak authoritative nonce', () => {
      const fakeNonce = generateCryptoNonce(32);
      const env = makeCanonicalEnvelope({ nonce: fakeNonce });
      const res = replayGuard.validateEnvelope(env);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.NONCE_MISMATCH);
        expect(res.error.message).not.toContain(authoritativeNonce);
      }
    });

    it('rejects wrong session ID (SESSION_MISMATCH)', () => {
      const env = makeCanonicalEnvelope({ sessionId: 'session-attacker' });
      const res = replayGuard.validateEnvelope(env);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.SESSION_MISMATCH);
      }
    });

    it('rejects wrong task ID (TASK_MISMATCH)', () => {
      const env = makeCanonicalEnvelope({ taskId: 'task-other' });
      const res = replayGuard.validateEnvelope(env);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.TASK_MISMATCH);
      }
    });

    it('rejects wrong provider or conversation ID (CONVERSATION_MISMATCH)', () => {
      const envConv = makeCanonicalEnvelope({ conversationId: 'conv-other' });
      const resConv = replayGuard.validateEnvelope(envConv);
      expect(resConv.ok).toBe(false);
      if (!resConv.ok) {
        expect(resConv.error.code).toBe(ErrorCode.CONVERSATION_MISMATCH);
      }

      const envProv = makeCanonicalEnvelope({ providerId: 'claude' });
      const resProv = replayGuard.validateEnvelope(envProv);
      expect(resProv.ok).toBe(false);
      if (!resProv.ok) {
        expect(resProv.error.code).toBe(ErrorCode.CONVERSATION_MISMATCH);
      }
    });

    it('rejects wrong branch identity (BRANCH_MISMATCH)', () => {
      const env = makeCanonicalEnvelope({ messageOrBranchId: 'branch-dev' });
      const res = replayGuard.validateEnvelope(env);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.BRANCH_MISMATCH);
      }
    });

    it('rejects stale round (ROUND_STALE)', () => {
      replayGuard.advanceExpectedRound(3);
      const env = makeCanonicalEnvelope({ round: 2 });
      const res = replayGuard.validateEnvelope(env);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.ROUND_STALE);
      }
    });

    it('rejects duplicate sequence (SEQUENCE_DUPLICATE)', () => {
      const env0 = makeCanonicalEnvelope({ sequence: 0 });
      expect(replayGuard.validateAndConsume(env0).ok).toBe(true);

      // Replaying sequence 0 must fail
      const env0Dup = makeCanonicalEnvelope({ sequence: 0 });
      const res = replayGuard.validateEnvelope(env0Dup);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.SEQUENCE_DUPLICATE);
      }
    });

    it('rejects out-of-order sequence (SEQUENCE_OUT_OF_ORDER)', () => {
      // Expected sequence is 0, receiving sequence 2 must fail
      const env = makeCanonicalEnvelope({ sequence: 2 });
      const res = replayGuard.validateEnvelope(env);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.SEQUENCE_OUT_OF_ORDER);
      }
    });

    it('rejects replayed packet (PACKET_ALREADY_CONSUMED)', () => {
      const env0 = makeCanonicalEnvelope({ sequence: 0 });
      expect(replayGuard.validateAndConsume(env0).ok).toBe(true);

      // Same packet tried again
      const res = replayGuard.validateEnvelope(env0);
      expect(res.ok).toBe(false);
    });

    it('rejects reused action IDs across envelopes (ACTION_ID_DUPLICATE)', () => {
      const env0 = makeCanonicalEnvelope({
        sequence: 0,
        actions: [{ id: 'action-unique-1', type: 'read_file', path: 'file1.ts' }],
      });
      expect(replayGuard.validateAndConsume(env0).ok).toBe(true);

      // Second envelope with sequence 1 tries to reuse action-unique-1
      const env1 = makeCanonicalEnvelope({
        sequence: 1,
        actions: [{ id: 'action-unique-1', type: 'read_file', path: 'file2.ts' }],
      });
      const res = replayGuard.validateEnvelope(env1);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.ACTION_ID_DUPLICATE);
      }
    });

    it('rejects duplicate action IDs within the same envelope', () => {
      const env = makeCanonicalEnvelope({
        sequence: 0,
        actions: [
          { id: 'action-same-id', type: 'read_file', path: 'file1.ts' },
          { id: 'action-same-id', type: 'read_file', path: 'file2.ts' },
        ],
      });
      const res = replayGuard.validateEnvelope(env);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.ACTION_ID_DUPLICATE);
      }
    });

    it('rejects stale base_state_hash (BASE_STATE_HASH_MISMATCH)', () => {
      const staleHash = 'b'.repeat(64);
      const env = makeCanonicalEnvelope({ baseStateHash: staleHash });
      const res = replayGuard.validateEnvelope(env);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.BASE_STATE_HASH_MISMATCH);
      }
    });

    it('validation failure has NO side effects and does NOT advance sequence or consume action IDs', () => {
      const initialSnapshot = replayGuard.getSessionSnapshot();
      expect(initialSnapshot?.expectedSequence).toBe(0);

      // Attack with wrong nonce
      const maliciousEnv = makeCanonicalEnvelope({
        sequence: 0,
        nonce: 'invalid-nonce-attacker',
        actions: [{ id: 'action-safe-1', type: 'read_file', path: 'file.ts' }],
      });
      const failRes = replayGuard.validateAndConsume(maliciousEnv);
      expect(failRes.ok).toBe(false);

      // Snapshot sequence must still be 0!
      const afterSnapshot = replayGuard.getSessionSnapshot();
      expect(afterSnapshot?.expectedSequence).toBe(0);

      // A legitimate envelope with sequence 0 and valid nonce must succeed and consume action-safe-1
      const legitEnv = makeCanonicalEnvelope({
        sequence: 0,
        nonce: authoritativeNonce,
        actions: [{ id: 'action-safe-1', type: 'read_file', path: 'file.ts' }],
      });
      const legitRes = replayGuard.validateAndConsume(legitEnv);
      expect(legitRes.ok).toBe(true);
      expect(replayGuard.getSessionSnapshot()?.expectedSequence).toBe(1);
    });
  });

  // ─── D. Browser Edits & Uncertain Identity Tests ───────────────────────────

  describe('Browser Edits and Identity Reconciliation', () => {
    function makeCanonicalEnvelope(): CanonicalEnvelope {
      return {
        protocolVersion: '1.3',
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        nonce: authoritativeNonce,
        round: 1,
        sequence: 0,
        providerId: PROVIDER_ID,
        conversationId: CONVERSATION_ID,
        messageOrBranchId: BRANCH_ID,
        baseStateHash: VALID_BASE_HASH,
        status: 'continue',
        actions: [{ id: 'act-1', type: 'read_file', path: 'src/index.ts' }],
        contentBlocks: [],
        rawBytesLength: 200,
      };
    }

    it('pauses and rejects envelopes when user edits prompt in browser (IDENTITY_UNCERTAIN)', () => {
      replayGuard.recordUserPromptEdit('User edited prompt');
      expect(replayGuard.isSessionIdentityUncertain()).toBe(true);
      expect(replayGuard.isSessionPaused()).toBe(true);

      const env = makeCanonicalEnvelope();
      const res = replayGuard.validateEnvelope(env);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.IDENTITY_UNCERTAIN);
      }
    });

    it('pauses and rejects envelopes when user switches conversation or branch', () => {
      replayGuard.recordConversationSwitch('conv-new-999');
      const env = makeCanonicalEnvelope();
      const res = replayGuard.validateEnvelope(env);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.IDENTITY_UNCERTAIN);
      }
    });

    it('pauses and rejects envelopes when AI response is regenerated', () => {
      replayGuard.recordRegenerate('User clicked regenerate');
      const env = makeCanonicalEnvelope();
      const res = replayGuard.validateEnvelope(env);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.IDENTITY_UNCERTAIN);
      }
    });

    it('reconciles identity safely with new nonce upon explicit user reattachment', () => {
      replayGuard.recordUserPromptEdit();
      expect(replayGuard.isSessionIdentityUncertain()).toBe(true);

      const newNonce = generateCryptoNonce(32);
      replayGuard.reconcileIdentity({
        ...activeContext,
        authoritativeNonce: newNonce,
        expectedSequence: 0,
      });

      expect(replayGuard.isSessionIdentityUncertain()).toBe(false);
      expect(replayGuard.isSessionPaused()).toBe(false);

      const env = makeCanonicalEnvelope();
      const newEnv = { ...env, nonce: newNonce };
      const res = replayGuard.validateAndConsume(newEnv);
      expect(res.ok).toBe(true);
    });
  });

  // ─── E. Policy Engine Integration Tests ────────────────────────────────────

  describe('Policy Engine Integration & Security Invariants', () => {
    it('passes valid envelopes through policy engine: review-only blocks execution', () => {
      const wire = {
        protocol_version: '1.3',
        task_id: TASK_ID,
        session_id: SESSION_ID,
        nonce: authoritativeNonce,
        round: 1,
        sequence: 0,
        provider_id: PROVIDER_ID,
        conversation_id: CONVERSATION_ID,
        message_or_branch_id: BRANCH_ID,
        base_state_hash: VALID_BASE_HASH,
        status: 'continue',
        actions: [
          {
            id: 'act-recipe',
            type: 'run_recipe',
            recipeId: 'test_canary',
            parameters: {},
          },
        ],
      };

      const result = protocolValidator.validate(wire, policyContext);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.policyDecisions).toHaveLength(1);
        const decision = result.value.policyDecisions[0];
        // In review-only mode, run_recipe is DENIED
        expect(decision.decision).toBe('DENY');
        expect(result.value.hasDenials).toBe(true);
        expect(result.value.allActionsAllowed).toBe(false);
      }
    });

    it('a valid nonce does not grant execution permissions or bypass missing sandbox capability', () => {
      const wire = {
        protocol_version: '1.3',
        task_id: TASK_ID,
        session_id: SESSION_ID,
        nonce: authoritativeNonce,
        round: 1,
        sequence: 0,
        provider_id: PROVIDER_ID,
        conversation_id: CONVERSATION_ID,
        base_state_hash: VALID_BASE_HASH,
        status: 'continue',
        actions: [
          {
            id: 'act-recipe',
            type: 'run_recipe',
            recipeId: 'build_canary',
            parameters: {},
          },
        ],
      };

      // Even if reviewOnlyMode was disabled (assisted mode), missing sandbox capabilities blocks execution
      const result = protocolValidator.validate(wire, policyContext, {
        policyConfig: { executionMode: 'assisted', allowRecipeExecution: true },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const dec = result.value.policyDecisions[0];
        expect(dec.decision).toBe('UNSUPPORTED');
      }
    });

    it('classified evidence from submit_agent_report remains strictly agent-reported', () => {
      const wire = {
        protocol_version: '1.3',
        task_id: TASK_ID,
        session_id: SESSION_ID,
        nonce: authoritativeNonce,
        round: 1,
        sequence: 0,
        provider_id: PROVIDER_ID,
        conversation_id: CONVERSATION_ID,
        base_state_hash: VALID_BASE_HASH,
        status: 'continue',
        actions: [
          {
            id: 'act-report',
            type: 'submit_agent_report',
            summary: 'Claiming all tests passed',
            claimType: 'verification',
            claimedResult: 'passed',
            details: {
              level: EvidenceLevel.MEDIATOR_EXECUTOR_VERIFIED, // untrusted claim
            },
          },
        ],
      };

      const result = protocolValidator.validate(wire, policyContext);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const dec = result.value.policyDecisions[0];
        expect(dec.decision).toBe('ALLOW');
        // AI submission can never claim executor-verified
        expect(dec.details?.evidenceLevel).toBe(EvidenceLevel.AGENT_REPORTED);
        expect(dec.details?.canSatisfyVerificationGate).toBe(false);
      }
    });
  });
});
