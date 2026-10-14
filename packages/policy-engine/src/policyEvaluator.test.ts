/**
 * @mediator/policy-engine — Authoritative Test Suite (S07)
 *
 * Comprehensive table-driven tests for Sprint S07:
 * 1.  All 16 actions registered exactly once.
 * 2.  Unknown actions and malformed parameters are denied.
 * 3.  Review-only mode blocks execution and live-workspace mutations.
 * 4.  An unconfirmed workspace denies file operations.
 * 5.  Outside-root paths are denied.
 * 6.  Secret exclusions block context collection before reading.
 * 7.  Protected-path changes cannot auto-apply.
 * 8.  Arbitrary command strings are rejected.
 * 9.  Missing sandbox capability blocks run_recipe.
 * 10. MCP/agent approval requests cannot approve themselves.
 * 11. Only the trusted approval UI flow can resolve pending approvals.
 * 12. Expired, duplicate, and mismatched approvals fail safely.
 * 13. Agent-reported evidence cannot become executor-verified evidence.
 * 14. Policy configuration cannot be overridden by AI-provided inputs.
 * 15. Identical inputs yield identical policy decisions (pure function).
 * 16. Existing S01–S06 test suites continue passing (verified by npm test).
 * 17. Serialization of denials and errors never exposes secrets.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateAction,
  ACTION_REGISTRY,
  CANONICAL_ACTION_IDS,
  CanonicalActionId,
  isProtectedPath,
  ApprovalStore,
  classifyEvidence,
  policyDecisionToError,
  PolicyReasons,
  type ActionRequest,
  type PolicyEvaluationContext,
  type PolicyConfig,
} from './index.js';
import { type WorkspaceRootState } from '@mediator/workspace-boundary';
import { TaskState, type Task, EvidenceLevel } from '@mediator/shared-contracts';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const CONFIRMED_WORKSPACE: WorkspaceRootState = {
  selectedPath: 'C:\\Users\\test\\project',
  canonicalPath: 'C:\\Users\\test\\project',
  selectionSource: 'cli',
  confirmationStatus: 'confirmed',
  confirmationTimestamp: Date.now(),
  resolutionStatus: 'resolved',
  cloudStatus: 'not_cloud',
};

const UNCONFIRMED_WORKSPACE: WorkspaceRootState = {
  ...CONFIRMED_WORKSPACE,
  confirmationStatus: 'pending',
};

const UNRESOLVED_WORKSPACE: WorkspaceRootState = {
  ...CONFIRMED_WORKSPACE,
  resolutionStatus: 'unresolved',
  canonicalPath: null,
};

const ACTIVE_TASK: Task = {
  id: 'task-100',
  title: 'Test Task',
  description: 'A test task for policy verification',
  workspaceRoot: 'C:\\Users\\test\\project',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  state: TaskState.VALIDATING,
  maxRounds: 5,
};

const STOPPED_TASK: Task = {
  ...ACTIVE_TASK,
  state: TaskState.STOPPED,
};

const DEFAULT_CONTEXT: PolicyEvaluationContext = {
  workspace: CONFIRMED_WORKSPACE,
  task: ACTIVE_TASK,
  capabilities: new Map([['canary.verified', false]]),
};

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('S07 — Canonical Action Registry', () => {
  it('1. registers exactly 16 canonical actions', () => {
    expect(CANONICAL_ACTION_IDS).toHaveLength(16);
    expect(ACTION_REGISTRY.size).toBe(16);

    const expectedActions = [
      'get_task_brief',
      'get_relevant_context',
      'list_staged_changes',
      'get_diff',
      'read_file',
      'search_text',
      'propose_patch',
      'request_more_context',
      'request_approval',
      'submit_agent_report',
      'pause_task',
      'get_capabilities',
      'apply_patch_to_stage',
      'run_recipe',
      'apply_staged_changes',
      'rollback_checkpoint',
    ];

    for (const expectedId of expectedActions) {
      expect(ACTION_REGISTRY.has(expectedId)).toBe(true);
      const def = ACTION_REGISTRY.get(expectedId)!;
      expect(def.actionId).toBe(expectedId);
      expect(def.version).toBe('1.0');
      expect(typeof def.description).toBe('string');
      expect(typeof def.effect.readsData).toBe('boolean');
      expect(typeof def.effect.changesStaging).toBe('boolean');
      expect(typeof def.effect.affectsLiveWorkspace).toBe('boolean');
      expect(typeof def.effect.requestsExecution).toBe('boolean');
    }
  });

  it('2. unknown actions and malformed parameters are denied', () => {
    // Unknown action
    const unknownReq: ActionRequest = {
      actionId: 'non_existent_action',
      correlationId: 'c-1',
      caller: { type: 'browser' },
      parameters: {},
    };
    const unknownRes = evaluateAction(unknownReq, DEFAULT_CONTEXT);
    expect(unknownRes.decision).toBe('DENY');
    expect(unknownRes.reasonCode).toBe(PolicyReasons.UNKNOWN_ACTION);

    // Missing required parameters (e.g. read_file requires path)
    const malformedReq: ActionRequest = {
      actionId: CanonicalActionId.READ_FILE,
      correlationId: 'c-2',
      caller: { type: 'agent' },
      parameters: {}, // missing 'path'
    };
    const malformedRes = evaluateAction(malformedReq, DEFAULT_CONTEXT);
    expect(malformedRes.decision).toBe('DENY');
    expect(malformedRes.reasonCode).toBe(PolicyReasons.SCHEMA_INVALID);
  });
});

describe('S07 — Review-Only Mode & Mutation Controls', () => {
  it('3. Review-only mode blocks execution and live-workspace mutations', () => {
    // run_recipe in Review-only mode
    const runReq: ActionRequest = {
      actionId: CanonicalActionId.RUN_RECIPE,
      correlationId: 'c-3',
      caller: { type: 'cli' },
      parameters: { recipeId: 'project.test', taskId: 'task-100' },
    };
    const runRes = evaluateAction(runReq, DEFAULT_CONTEXT, { executionMode: 'review_only' });
    expect(runRes.decision).toBe('DENY');
    expect(runRes.reasonCode).toBe(PolicyReasons.REVIEW_ONLY_MODE_BLOCKS_EXECUTION);

    // apply_staged_changes without prior user approval
    const applyReq: ActionRequest = {
      actionId: CanonicalActionId.APPLY_STAGED_CHANGES,
      correlationId: 'c-4',
      caller: { type: 'agent' },
      parameters: { taskId: 'task-100' },
    };
    const applyRes = evaluateAction(applyReq, DEFAULT_CONTEXT, { executionMode: 'review_only' });
    expect(applyRes.decision).toBe('REQUIRE_APPROVAL');
    expect(applyRes.reasonCode).toBe(PolicyReasons.REVIEW_ONLY_MODE_BLOCKS_MUTATION);
  });
});

describe('S07 — Workspace Boundary & Containment', () => {
  it('4. an unconfirmed workspace denies file operations', () => {
    const context: PolicyEvaluationContext = {
      ...DEFAULT_CONTEXT,
      workspace: UNCONFIRMED_WORKSPACE,
    };
    const req: ActionRequest = {
      actionId: CanonicalActionId.READ_FILE,
      correlationId: 'c-5',
      caller: { type: 'ide' },
      parameters: { path: 'src/index.ts' },
    };
    const res = evaluateAction(req, context);
    expect(res.decision).toBe('DENY');
    expect(res.reasonCode).toBe(PolicyReasons.WORKSPACE_UNCONFIRMED);
  });

  it('4b. an unresolved workspace denies file operations', () => {
    const context: PolicyEvaluationContext = {
      ...DEFAULT_CONTEXT,
      workspace: UNRESOLVED_WORKSPACE,
    };
    const req: ActionRequest = {
      actionId: CanonicalActionId.READ_FILE,
      correlationId: 'c-6',
      caller: { type: 'cli' },
      parameters: { path: 'src/index.ts' },
    };
    const res = evaluateAction(req, context);
    expect(res.decision).toBe('DENY');
    expect(res.reasonCode).toBe(PolicyReasons.WORKSPACE_UNRESOLVED);
  });

  it('5. outside-root paths and parent traversal (../) are denied', () => {
    const traversalReq: ActionRequest = {
      actionId: CanonicalActionId.READ_FILE,
      correlationId: 'c-7',
      caller: { type: 'agent' },
      parameters: { path: '../outside.txt' },
    };
    const res = evaluateAction(traversalReq, DEFAULT_CONTEXT);
    expect(res.decision).toBe('DENY');
    expect(res.reasonCode).toBe(PolicyReasons.PATH_OUTSIDE_WORKSPACE);

    // Backslash traversal
    const backslashReq: ActionRequest = {
      actionId: CanonicalActionId.PROPOSE_PATCH,
      correlationId: 'c-8',
      caller: { type: 'browser' },
      parameters: {
        taskId: 'task-100',
        targetPath: '..\\..\\Windows\\System32\\calc.exe',
        patchContent: 'dummy',
      },
    };
    const backslashRes = evaluateAction(backslashReq, DEFAULT_CONTEXT);
    expect(backslashRes.decision).toBe('DENY');
    expect(backslashRes.reasonCode).toBe(PolicyReasons.PATH_OUTSIDE_WORKSPACE);
  });
});

describe('S07 — Secret Exclusions & Context Collection', () => {
  it('6. secret exclusions block context collection before reading', () => {
    // Attempting to read .env
    const envReq: ActionRequest = {
      actionId: CanonicalActionId.READ_FILE,
      correlationId: 'c-9',
      caller: { type: 'agent' },
      parameters: { path: '.env' },
    };
    const envRes = evaluateAction(envReq, DEFAULT_CONTEXT);
    expect(envRes.decision).toBe('DENY');
    expect(envRes.reasonCode).toBe(PolicyReasons.PATH_EXCLUDED_SECRET);

    // Attempting to request id_rsa
    const rsaReq: ActionRequest = {
      actionId: CanonicalActionId.GET_RELEVANT_CONTEXT,
      correlationId: 'c-10',
      caller: { type: 'agent' },
      parameters: { taskId: 'task-100', filePaths: ['src/app.ts', '.ssh/id_rsa'] },
    };
    const rsaRes = evaluateAction(rsaReq, DEFAULT_CONTEXT);
    expect(rsaRes.decision).toBe('DENY');
    expect(rsaRes.reasonCode).toBe(PolicyReasons.PATH_EXCLUDED_SECRET);
  });
});

describe('S07 — Protected Path Classification', () => {
  it('7. protected-path changes cannot auto-apply', () => {
    // package.json is protected
    expect(isProtectedPath('package.json').isProtected).toBe(true);
    expect(isProtectedPath('src/package.json').isProtected).toBe(true);
    expect(isProtectedPath('.github/workflows/ci.yml').isProtected).toBe(true);
    expect(isProtectedPath('.git/hooks/pre-commit').isProtected).toBe(true);
    expect(isProtectedPath('.vscode/tasks.json').isProtected).toBe(true);
    expect(isProtectedPath('scripts/deploy.sh').isProtected).toBe(true);
    expect(isProtectedPath('scripts/deploy.ps1').isProtected).toBe(true);
    expect(isProtectedPath('Makefile').isProtected).toBe(true);
    expect(isProtectedPath('.mediator/policy.json').isProtected).toBe(true);

    // Non-protected file
    expect(isProtectedPath('src/utils/math.ts').isProtected).toBe(false);
    expect(isProtectedPath('docs/guide.md').isProtected).toBe(false);

    // Proposing patch to protected path is allowed to stage, but flags review requirement
    const patchReq: ActionRequest = {
      actionId: CanonicalActionId.PROPOSE_PATCH,
      correlationId: 'c-11',
      caller: { type: 'agent' },
      parameters: {
        taskId: 'task-100',
        targetPath: 'package.json',
        patchContent: 'diff',
      },
    };
    const patchRes = evaluateAction(patchReq, DEFAULT_CONTEXT);
    expect(patchRes.decision).toBe('ALLOW');
    expect(patchRes.details?.isProtected).toBe(true);
  });
});

describe('S07 — Command Execution & Arbitrary Input Defense', () => {
  it('8. arbitrary command strings and injected shell operators are rejected', () => {
    const injectReq: ActionRequest = {
      actionId: CanonicalActionId.RUN_RECIPE,
      correlationId: 'c-12',
      caller: { type: 'agent' },
      parameters: {
        recipeId: 'rm -rf /; echo evil',
        taskId: 'task-100',
      },
    };
    const res = evaluateAction(injectReq, DEFAULT_CONTEXT);
    expect(res.decision).toBe('DENY');
    expect(res.reasonCode).toBe(PolicyReasons.SCHEMA_INVALID);
  });

  it('9. missing sandbox capability blocks run_recipe', () => {
    const recipeReq: ActionRequest = {
      actionId: CanonicalActionId.RUN_RECIPE,
      correlationId: 'c-13',
      caller: { type: 'ide' },
      parameters: { recipeId: 'project.test', taskId: 'task-100' },
    };
    // Even if executionMode is assisted, missing canary verification returns UNSUPPORTED
    const res = evaluateAction(recipeReq, DEFAULT_CONTEXT, {
      executionMode: 'assisted',
      allowRecipeExecution: true,
    });
    expect(res.decision).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(PolicyReasons.CAPABILITY_MISSING);
  });
});

describe('S07 — Approval Management & Actor Separation', () => {
  let store: ApprovalStore;

  beforeEach(() => {
    store = new ApprovalStore();
  });

  it('10. MCP and agent approval requests cannot approve themselves', () => {
    const request = store.createRequest({
      taskId: 'task-100',
      actionId: 'apply_staged_changes',
      targetPaths: ['src/index.ts'],
      changeHash: 'hash-abc',
      decision: 'REQUIRE_APPROVAL',
      reason: 'Live mutation requires approval',
    });

    // Attempting resolution by agent caller
    const agentRes = store.resolve({
      approvalId: request.approvalId,
      resolution: 'approved',
      caller: { type: 'agent', isTrustedUI: false },
    });
    expect(agentRes.success).toBe(false);
    if (!agentRes.success) {
      expect(agentRes.reasonCode).toBe('CALLER_UNAUTHORIZED_FOR_APPROVAL');
    }

    // Attempting resolution by MCP caller
    const mcpRes = store.resolve({
      approvalId: request.approvalId,
      resolution: 'approved',
      caller: { type: 'mcp', isTrustedUI: false },
    });
    expect(mcpRes.success).toBe(false);
    if (!mcpRes.success) {
      expect(mcpRes.reasonCode).toBe('CALLER_UNAUTHORIZED_FOR_APPROVAL');
    }
  });

  it('11. only trusted approval UI flow can resolve pending approvals', () => {
    const request = store.createRequest({
      taskId: 'task-100',
      actionId: 'apply_staged_changes',
      targetPaths: ['src/index.ts'],
      changeHash: 'hash-abc',
      decision: 'REQUIRE_APPROVAL',
      reason: 'Live mutation requires approval',
    });

    const trustedRes = store.resolve({
      approvalId: request.approvalId,
      resolution: 'approved',
      caller: { type: 'ide', isTrustedUI: true, id: 'ide_user' },
    });
    expect(trustedRes.success).toBe(true);
    expect(request.status).toBe('approved');
  });

  it('12. expired, duplicate, and mismatched approvals fail safely', () => {
    // Expired approval
    const expiredReq = store.createRequest({
      taskId: 'task-100',
      actionId: 'apply_staged_changes',
      targetPaths: ['src/index.ts'],
      changeHash: 'hash-abc',
      decision: 'REQUIRE_APPROVAL',
      reason: 'Live mutation',
      timeoutMs: -100, // already expired
    });

    const resolveExpired = store.resolve({
      approvalId: expiredReq.approvalId,
      resolution: 'approved',
      caller: { type: 'ide', isTrustedUI: true },
    });
    expect(resolveExpired.success).toBe(false);
    if (!resolveExpired.success) {
      expect(resolveExpired.reasonCode).toBe('APPROVAL_EXPIRED');
    }

    // Single-use: once consumed, duplicate use fails
    const validReq = store.createRequest({
      taskId: 'task-100',
      actionId: 'apply_staged_changes',
      targetPaths: ['src/index.ts'],
      changeHash: 'hash-abc',
      decision: 'REQUIRE_APPROVAL',
      reason: 'Live mutation',
    });
    store.resolve({
      approvalId: validReq.approvalId,
      resolution: 'approved',
      caller: { type: 'ide', isTrustedUI: true },
    });

    const firstConsume = store.consume(validReq.approvalId, 'task-100', 'apply_staged_changes', 'hash-abc');
    expect(firstConsume.success).toBe(true);

    const secondConsume = store.consume(validReq.approvalId, 'task-100', 'apply_staged_changes', 'hash-abc');
    expect(secondConsume.success).toBe(false);
    if (!secondConsume.success) {
      expect(secondConsume.reasonCode).toBe('APPROVAL_ALREADY_RESOLVED');
    }

    // Mismatched task ID
    const mismatchedReq = store.createRequest({
      taskId: 'task-100',
      actionId: 'apply_staged_changes',
      targetPaths: ['src/index.ts'],
      changeHash: 'hash-abc',
      decision: 'REQUIRE_APPROVAL',
      reason: 'Live mutation',
    });
    store.resolve({
      approvalId: mismatchedReq.approvalId,
      resolution: 'approved',
      caller: { type: 'ide', isTrustedUI: true },
    });
    const mismatchConsume = store.consume(mismatchedReq.approvalId, 'task-WRONG', 'apply_staged_changes', 'hash-abc');
    expect(mismatchConsume.success).toBe(false);
    if (!mismatchConsume.success) {
      expect(mismatchConsume.reasonCode).toBe('APPROVAL_PAYLOAD_MISMATCH');
    }
  });
});

describe('S07 — Evidence Classification', () => {
  it('13. agent-reported evidence cannot become executor-verified evidence', () => {
    // Agent attempts to self-certify as executor-verified
    const agentClaim = classifyEvidence(
      'agent',
      EvidenceLevel.MEDIATOR_EXECUTOR_VERIFIED,
      'I ran the test suite and all 50 tests passed!',
    );

    expect(agentClaim.level).toBe(EvidenceLevel.AGENT_REPORTED);
    expect(agentClaim.canSatisfyGate).toBe(false);
    expect(agentClaim.untrustedClaimStripped).toBe(true);
    expect(agentClaim.safeSummary).toContain('[Agent Claim - Unverified]');

    // Browser caller attempts to claim executor-verified
    const browserClaim = classifyEvidence(
      'browser',
      EvidenceLevel.MEDIATOR_EXECUTOR_VERIFIED,
      'Web AI verified everything',
    );
    expect(browserClaim.level).toBe(EvidenceLevel.AGENT_REPORTED);
    expect(browserClaim.canSatisfyGate).toBe(false);
  });
});

describe('S07 — Anti-Tampering & Pure Function Invariants', () => {
  it('14. policy configuration cannot be overridden by AI-provided inputs', () => {
    const tamperReq: ActionRequest = {
      actionId: CanonicalActionId.READ_FILE,
      correlationId: 'c-14',
      caller: { type: 'agent' },
      parameters: {
        path: 'src/app.ts',
        policyOverride: true,
        bypass: 'all',
      },
    };
    const res = evaluateAction(tamperReq, DEFAULT_CONTEXT);
    expect(res.decision).toBe('DENY');
    expect(res.reasonCode).toBe(PolicyReasons.POLICY_TAMPERING_ATTEMPT);
  });

  it('15. identical inputs yield identical policy decisions (pure function)', () => {
    const req: ActionRequest = {
      actionId: CanonicalActionId.READ_FILE,
      correlationId: 'c-15',
      caller: { type: 'ide' },
      parameters: { path: 'src/main.ts' },
    };

    const decision1 = evaluateAction(req, DEFAULT_CONTEXT);
    const decision2 = evaluateAction(req, DEFAULT_CONTEXT);
    const decision3 = evaluateAction(req, DEFAULT_CONTEXT);

    expect(decision1).toEqual(decision2);
    expect(decision2).toEqual(decision3);
  });

  it('17. serialization of denials and errors never exposes secrets', () => {
    const fakeSecret = 'ghp_fakeSuperSecretToken1234567890ABCDEF';
    const req: ActionRequest = {
      actionId: CanonicalActionId.READ_FILE,
      correlationId: 'c-16',
      caller: { type: 'agent' },
      parameters: { path: `.env.${fakeSecret}` },
    };

    const decision = evaluateAction(req, DEFAULT_CONTEXT);
    expect(decision.decision).toBe('DENY');

    const serializedDecision = JSON.stringify(decision);
    const errorObj = policyDecisionToError(decision);
    const serializedError = JSON.stringify(errorObj);

    // Verify secret is not echoed in explanation or detail
    expect(decision.explanation).not.toContain(fakeSecret);
    expect(serializedDecision).not.toContain(fakeSecret);
    expect(serializedError).not.toContain(fakeSecret);
  });
});
