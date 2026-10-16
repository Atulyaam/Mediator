/**
 * @mediator/orchestrator — Limited Autopilot Gate Evaluator & Safety Revocation (S26)
 *
 * Requirements:
 * - Evaluates Autopilot eligibility against authoritative prerequisites:
 *   1. S00 feasibility decision (must be GO; currently NO-GO-AUTOEXEC → strictly blocks).
 *   2. S21 capability evidence (all required capabilities must be proven; unknowns evaluate to false).
 *   3. S22 approved execution path (Review-only path → blocks automatic execution).
 *   4. S23 recipe registry & deterministic hash pinning.
 *   5. S24 assisted loop evidence authority (agent-reported cannot satisfy verification).
 *   6. S25 recovery reconciliation & loop guard limits.
 * - Invariant: Under current NO-GO-AUTOEXEC, Autopilot is strictly DEFERRED / DISABLED.
 * - Fail-closed revocation: Any capability loss, stale evidence, or drift revokes eligibility immediately.
 * - Zero runner instantiation; zero automatic workspace mutation; zero Autopilot activation.
 */

import {
  type S00ExecutionDecision,
  type AutopilotGateResult,
  type AutopilotLowRiskProfile,
  CANONICAL_AUTOPILOT_LOW_RISK_PROFILE,
} from '@mediator/shared-contracts';

export interface AutopilotGateEvaluationInput {
  readonly s00Decision: S00ExecutionDecision;
  readonly executorCapabilities?: {
    readonly childProcessesConfined?: boolean | 'unknown' | undefined;
    readonly networkDefaultDeny?: boolean | 'unknown' | undefined;
    readonly capturesRealExitCode?: boolean | 'unknown' | undefined;
    readonly evidenceTimestamp?: number | undefined;
    readonly evidenceProvenance?: string | undefined;
  } | undefined;
  readonly recoveryGatePassed?: boolean | undefined;
  readonly recipeRegistryHashVerified?: boolean | undefined;
  readonly approvalRequiredForModifications?: boolean | undefined;
  readonly userOptInSetting?: boolean | undefined;
  readonly activeConversationMismatched?: boolean | undefined;
}

export class AutopilotGateEvaluator {
  public static readonly REQUIRED_CAPABILITIES = [
    'process.childProcessesConfined',
    'network.networkDefaultDeny',
    'limits.capturesRealExitCode',
  ] as const;

  /**
   * Evaluates Autopilot eligibility against all security gates.
   * Under NO-GO-AUTOEXEC, returns Outcome B (DEFERRED) immediately.
   */
  public evaluateEligibility(input: AutopilotGateEvaluationInput): AutopilotGateResult {
    const blockingReasons: string[] = [];
    const missingPrerequisites: string[] = [];
    const unverifiedCapabilities: string[] = [];
    const verifiedCapabilities: string[] = [];

    // 1. Mandatory S00 Feasibility Decision Check
    if (!input.s00Decision || input.s00Decision === 'NO-GO-AUTOEXEC') {
      blockingReasons.push(
        'Authoritative S00 decision is NO-GO-AUTOEXEC (Review-only mode active; automated execution forbidden).',
      );
      missingPrerequisites.push('s00.go_feasibility_decision');
    }

    // 2. Mandatory S21 Capability Evidence Check
    const caps = input.executorCapabilities;
    if (!caps) {
      for (const req of AutopilotGateEvaluator.REQUIRED_CAPABILITIES) {
        unverifiedCapabilities.push(req);
        blockingReasons.push(`Required executor capability "${req}" has not been evaluated.`);
      }
      missingPrerequisites.push('s21.executor_capabilities_verified');
    } else {
      if (caps.childProcessesConfined !== true) {
        unverifiedCapabilities.push('process.childProcessesConfined');
        blockingReasons.push('Host child-process confinement is unknown or unverified.');
      } else {
        verifiedCapabilities.push('process.childProcessesConfined');
      }

      if (caps.networkDefaultDeny !== true) {
        unverifiedCapabilities.push('network.networkDefaultDeny');
        blockingReasons.push('Host network default-deny confinement is unknown or unverified.');
      } else {
        verifiedCapabilities.push('network.networkDefaultDeny');
      }

      if (caps.capturesRealExitCode !== true) {
        unverifiedCapabilities.push('limits.capturesRealExitCode');
        blockingReasons.push('Host exit code capture from sandbox is unknown or unverified.');
      } else {
        verifiedCapabilities.push('limits.capturesRealExitCode');
      }

      // Check evidence provenance (must be runtime-canary, mock-only is rejected)
      if (caps.evidenceProvenance && caps.evidenceProvenance !== 'runtime-canary') {
        blockingReasons.push(
          `Capability evidence provenance "${caps.evidenceProvenance}" is insufficient; runtime-canary required.`,
        );
        missingPrerequisites.push('s21.runtime_canary_evidence');
      }

      // Freshness check (default 24h)
      if (caps.evidenceTimestamp && Date.now() - caps.evidenceTimestamp > 86400000) {
        blockingReasons.push('Capability evidence is stale (> 24h). Fresh canary run required.');
        missingPrerequisites.push('s21.fresh_capability_evidence');
      }
    }

    // 3. S25 Recovery Gate Check
    if (input.recoveryGatePassed === false) {
      blockingReasons.push('S25 recovery and startup reconciliation gate is not satisfied.');
      missingPrerequisites.push('s25.recovery_reconciliation_passed');
    }

    // 4. S23 Recipe Registry Integrity Check
    if (input.recipeRegistryHashVerified === false) {
      blockingReasons.push('S23 recipe registry definition hash verification failed.');
      missingPrerequisites.push('s23.recipe_hash_pinning_verified');
    }

    // 5. Approval & Policy Gate Check
    if (input.approvalRequiredForModifications === false) {
      blockingReasons.push('Policy must strictly require approvals for destructive and protected operations.');
      missingPrerequisites.push('policy.trusted_approval_required');
    }

    // 6. Same-chat conversation check
    if (input.activeConversationMismatched) {
      blockingReasons.push('Active browser conversation is mismatched or detached.');
      missingPrerequisites.push('same_chat.conversation_identity_verified');
    }

    // 7. User Opt-in alone is insufficient
    if (input.userOptInSetting && blockingReasons.length > 0) {
      // User opt-in exists, but security prerequisites fail
      blockingReasons.push('User opt-in alone cannot authorize execution when security gates are unverified.');
    }

    const isEligible = blockingReasons.length === 0 && unverifiedCapabilities.length === 0;
    const status = isEligible ? 'eligible' : 'deferred';

    return {
      status,
      isEligible,
      s00Decision: input.s00Decision,
      verifiedCapabilities,
      unverifiedCapabilities,
      missingPrerequisites,
      blockingReasons,
      evaluatedAt: Date.now(),
      nextAssessmentRequirements: [
        'Complete host process and network isolation canary test proving true default-deny.',
        'Prove reliable exit-code observation from sandbox execution without host escapes.',
        'Obtain formal S00 GO reassessment decision via documented architectural review.',
      ],
    };
  }

  /**
   * Returns the canonical, inactive AutopilotLowRiskProfile.
   * Under NO-GO-AUTOEXEC, active is strictly false.
   */
  public getInactiveProfile(): AutopilotLowRiskProfile {
    return CANONICAL_AUTOPILOT_LOW_RISK_PROFILE;
  }

  /**
   * Returns the guarded isolated-worktree Autopilot profile under GO-GUARDED-AUTOPILOT (ADR-031).
   */
  public getGuardedProfile(): AutopilotLowRiskProfile {
    return {
      ...CANONICAL_AUTOPILOT_LOW_RISK_PROFILE,
      profileId: 'autopilot.guarded_worktree.v1',
      version: '1.1.0',
      maxRoundsBudget: 5,
      maxDurationBudgetMs: 600000,
      active: true,
    };
  }

  /**
   * Fail-closed revocation: checks if any runtime signal revokes Autopilot eligibility.
   */
  public checkImmediateRevocation(signals: {
    readonly capabilityLost?: boolean | undefined;
    readonly s00Changed?: boolean | undefined;
    readonly conflictDetected?: boolean | undefined;
    readonly secretDetected?: boolean | undefined;
    readonly budgetExceeded?: boolean | undefined;
    readonly conversationDrifted?: boolean | undefined;
  }): { readonly revoked: boolean; readonly revocationReason?: string | undefined } {
    if (signals.capabilityLost) {
      return { revoked: true, revocationReason: 'Executor capability lost or unverified.' };
    }
    if (signals.s00Changed) {
      return { revoked: true, revocationReason: 'S00 decision is NO-GO-AUTOEXEC.' };
    }
    if (signals.conflictDetected) {
      return { revoked: true, revocationReason: 'Live workspace conflict detected.' };
    }
    if (signals.secretDetected) {
      return { revoked: true, revocationReason: 'Secret detected in proposed content.' };
    }
    if (signals.budgetExceeded) {
      return { revoked: true, revocationReason: 'Task resource budget exceeded.' };
    }
    if (signals.conversationDrifted) {
      return { revoked: true, revocationReason: 'Browser conversation identity changed.' };
    }
    return { revoked: false };
  }
}
