import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  ErrorCode,
  type ProtocolEnvelope,
  type ConversationIdentity,
  S00ExecutionDecisionValues,
} from '@mediator/shared-contracts';
import { WorkflowOrchestrator } from './workflowOrchestrator.js';

describe('Sprint S24 — Assisted End-to-End Loop with Evidence Authority', () => {
  let tempWorkspace: string;
  let orchestrator: WorkflowOrchestrator;
  const sampleConversation: ConversationIdentity = {
    provider: 'google-gemini',
    conversationId: 'chat-round-1',
  };

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s24-test-'));
    orchestrator = new WorkflowOrchestrator({
      workspaceRoot: tempWorkspace,
      s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
    });
  });

  describe('Assisted Loop Mechanics & Safety Invariants', () => {
    it('executes a clean review-only round without running any processes', async () => {
      const envelope: ProtocolEnvelope = {
        protocolVersion: '1.3',
        taskId: 'task-clean',
        sessionId: 'session-clean',
        nonce: 'nonce-12345678',
        round: 1,
        sequence: 1,
        conversation: sampleConversation,
        baseStateHash: 'a'.repeat(64),
        status: 'continue',
        actions: [
          {
            id: 'act-1',
            type: 'propose_patch',
            path: 'src/app.ts',
            expectedBaseHash: 'a'.repeat(64),
            contentBlockId: 'block-1',
          },
        ],
        contentBlocks: [
          {
            id: 'block-1',
            delimiter: 'EOF',
            encoding: 'utf-8',
            byteLength: 20,
            sha256: 'b'.repeat(64),
          },
        ],
      };

      const res = await orchestrator.executeRound(envelope, {
        taskId: 'task-clean',
        sessionId: 'session-clean',
        correlationId: 'corr-clean',
        conversation: sampleConversation,
        userApproved: true,
        sameChatConfirmed: true,
      });

      expect(res.state).toBe('completed');
      expect(res.stagedPatchCount).toBe(1);
      expect(res.executionBlocked).toBe(true);
      expect(res.feedbackSent).toBe(true);
      expect(res.feedbackDraft).toContain('BLOCKED under NO-GO-AUTOEXEC');
    });

    it('enforces budget guard: trips after exceeding maximum transitions', () => {
      const budgetGuard = orchestrator.getBudgetGuard();
      const taskId = 'task-overflow';

      for (let i = 0; i < 50; i++) {
        const t = budgetGuard.recordTransition(taskId, 'staging');
        expect(t.ok).toBe(true);
      }

      // 51st transition trips the budget
      const overflow = budgetGuard.recordTransition(taskId, 'staging');
      expect(overflow.ok).toBe(false);
      if (!overflow.ok) {
        expect(overflow.error.code).toBe(ErrorCode.WORKFLOW_BUDGET_EXCEEDED);
      }
    });

    it('enforces loop guard: trips on identical repeated payload hashes', () => {
      const budgetGuard = orchestrator.getBudgetGuard();
      const taskId = 'task-loop';
      const repeatedHash = 'repeat_payload_hash';

      budgetGuard.recordTransition(taskId, 'staging', repeatedHash);
      budgetGuard.recordTransition(taskId, 'staging', repeatedHash);
      const trip = budgetGuard.recordTransition(taskId, 'staging', repeatedHash);

      expect(trip.ok).toBe(false);
      if (!trip.ok) {
        expect(trip.error.code).toBe(ErrorCode.WORKFLOW_LOOP_DETECTED);
      }
    });

    it('evidence authority: rejects agent claim being upgraded to executor-verified', () => {
      const evidenceAuth = orchestrator.getEvidenceAuthority();
      const res = evidenceAuth.recordEvidence(
        'task-agent',
        {
          taskId: 'task-agent',
          sessionId: 'session-1',
          checkName: 'Fake Executor Claim',
          provenance: 'runtime_canary', // agent claims it ran tests!
          outcome: 'passed',
          summary: 'Claimed runtime canary',
        },
        'agent-report',
      );

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.AGENT_REPORT_UNVERIFIED);
      }
    });

    it('evidence authority: under NO-GO-AUTOEXEC, runtime_canary cannot be recorded', () => {
      const evidenceAuth = orchestrator.getEvidenceAuthority();
      const res = evidenceAuth.recordEvidence(
        'task-nogo',
        {
          taskId: 'task-nogo',
          sessionId: 'session-1',
          checkName: 'Attempted Auto Exec Check',
          provenance: 'runtime_canary',
          outcome: 'passed',
          summary: 'Trying to record canary',
        },
        'executor',
      );

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ErrorCode.EXECUTION_BLOCKED);
      }
    });
  });

  describe('Ten Controlled Test-Repo Tasks (Exit Gate)', () => {
    it('Task 1: Simple valid patch proposal with clean staging and trusted review', async () => {
      const outcome = await orchestrator.runControlledTask(1);
      expect(outcome.passed).toBe(true);
      expect(outcome.finalState).toBe('completed');
      expect(outcome.approvalRequired).toBe(true);
    });

    it('Task 2: Invalid or malformed protocol envelope', async () => {
      const outcome = await orchestrator.runControlledTask(2);
      expect(outcome.passed).toBe(true);
      expect(outcome.finalState).toBe('failed');
    });

    it('Task 3: Stale base hash or changed source fixture', async () => {
      const outcome = await orchestrator.runControlledTask(3);
      expect(outcome.passed).toBe(true);
      expect(outcome.finalState).toBe('conflicted');
    });

    it('Task 4: Secret-bearing proposed content', async () => {
      const outcome = await orchestrator.runControlledTask(4);
      expect(outcome.passed).toBe(true);
      expect(outcome.finalState).toBe('failed');
    });

    it('Task 5: Protected-path proposal requiring manual review', async () => {
      const outcome = await orchestrator.runControlledTask(5);
      expect(outcome.passed).toBe(true);
      expect(outcome.finalState).toBe('awaiting-approval');
      expect(outcome.userActionRequired).toBe(true);
    });

    it('Task 6: Unknown action or unregistered recipe', async () => {
      const outcome = await orchestrator.runControlledTask(6);
      expect(outcome.passed).toBe(true);
      expect(outcome.finalState).toBe('failed');
    });

    it('Task 7: Expired approval or changed payload hash', async () => {
      const outcome = await orchestrator.runControlledTask(7);
      expect(outcome.passed).toBe(true);
      expect(outcome.finalState).toBe('approval-expired');
    });

    it('Task 8: Missing executor capability leading to manual handoff under NO-GO', async () => {
      const outcome = await orchestrator.runControlledTask(8);
      expect(outcome.passed).toBe(true);
      expect(outcome.finalState).toBe('completed');
    });

    it('Task 9: Agent-reported success that remains unverified', async () => {
      const outcome = await orchestrator.runControlledTask(9);
      expect(outcome.passed).toBe(true);
      expect(outcome.evidenceProvenance).toBe('agent_reported_claim');
    });

    it('Task 10: Same-chat identity change or uncertain submission that pauses feedback', async () => {
      const outcome = await orchestrator.runControlledTask(10);
      expect(outcome.passed).toBe(true);
      expect(outcome.finalState).toBe('paused');
    });
  });
});
