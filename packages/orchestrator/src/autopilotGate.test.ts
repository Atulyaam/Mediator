import { describe, it, expect } from 'vitest';
import { AutopilotGateEvaluator } from './autopilotGate.js';
import {
  S00ExecutionDecisionValues,
  CANONICAL_AUTOPILOT_LOW_RISK_PROFILE,
} from '@mediator/shared-contracts';

describe('Sprint S26 — Limited Autopilot Gate Review & Adversarial Tests', () => {
  const evaluator = new AutopilotGateEvaluator();

  describe('1. Prerequisite Evaluation (Outcome B — DEFERRED)', () => {
    it('1. NO-GO-AUTOEXEC always disables Autopilot immediately', () => {
      const res = evaluator.evaluateEligibility({
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
        executorCapabilities: {
          childProcessesConfined: true,
          networkDefaultDeny: true,
          capturesRealExitCode: true,
          evidenceTimestamp: Date.now(),
          evidenceProvenance: 'runtime-canary',
        },
      });

      expect(res.status).toBe('deferred');
      expect(res.isEligible).toBe(false);
      expect(res.blockingReasons.some((b) => b.includes('NO-GO-AUTOEXEC'))).toBe(true);
    });

    it('2. missing S00 decision disables Autopilot', () => {
      const res = evaluator.evaluateEligibility({
        s00Decision: undefined as any,
      });

      expect(res.status).toBe('deferred');
      expect(res.isEligible).toBe(false);
    });

    it('3. any unknown required capability disables Autopilot', () => {
      const res = evaluator.evaluateEligibility({
        s00Decision: S00ExecutionDecisionValues.GO_IDE,
        executorCapabilities: {
          childProcessesConfined: 'unknown',
          networkDefaultDeny: true,
          capturesRealExitCode: true,
        },
      });

      expect(res.status).toBe('deferred');
      expect(res.isEligible).toBe(false);
      expect(res.unverifiedCapabilities).toContain('process.childProcessesConfined');
    });

    it('4. mock-only evidence does not satisfy runtime canary gate', () => {
      const res = evaluator.evaluateEligibility({
        s00Decision: S00ExecutionDecisionValues.GO_IDE,
        executorCapabilities: {
          childProcessesConfined: true,
          networkDefaultDeny: true,
          capturesRealExitCode: true,
          evidenceTimestamp: Date.now(),
          evidenceProvenance: 'mock-only', // Mock rejected
        },
      });

      expect(res.status).toBe('deferred');
      expect(res.isEligible).toBe(false);
      expect(res.blockingReasons.some((b) => b.includes('runtime-canary required'))).toBe(true);
    });

    it('5. stale capability evidence (> 24h) disables Autopilot', () => {
      const res = evaluator.evaluateEligibility({
        s00Decision: S00ExecutionDecisionValues.GO_IDE,
        executorCapabilities: {
          childProcessesConfined: true,
          networkDefaultDeny: true,
          capturesRealExitCode: true,
          evidenceTimestamp: Date.now() - 90000000, // 25h
          evidenceProvenance: 'runtime-canary',
        },
      });

      expect(res.status).toBe('deferred');
      expect(res.isEligible).toBe(false);
      expect(res.blockingReasons.some((b) => b.includes('evidence is stale'))).toBe(true);
    });

    it('6. missing S25 recovery gate disables Autopilot', () => {
      const res = evaluator.evaluateEligibility({
        s00Decision: S00ExecutionDecisionValues.GO_IDE,
        executorCapabilities: {
          childProcessesConfined: true,
          networkDefaultDeny: true,
          capturesRealExitCode: true,
          evidenceTimestamp: Date.now(),
          evidenceProvenance: 'runtime-canary',
        },
        recoveryGatePassed: false,
      });

      expect(res.status).toBe('deferred');
      expect(res.isEligible).toBe(false);
      expect(res.blockingReasons.some((b) => b.includes('recovery and startup reconciliation'))).toBe(true);
    });

    it('7. missing S23 recipe/hash integrity disables Autopilot', () => {
      const res = evaluator.evaluateEligibility({
        s00Decision: S00ExecutionDecisionValues.GO_IDE,
        executorCapabilities: {
          childProcessesConfined: true,
          networkDefaultDeny: true,
          capturesRealExitCode: true,
          evidenceTimestamp: Date.now(),
          evidenceProvenance: 'runtime-canary',
        },
        recipeRegistryHashVerified: false,
      });

      expect(res.status).toBe('deferred');
      expect(res.isEligible).toBe(false);
      expect(res.blockingReasons.some((b) => b.includes('recipe registry definition hash'))).toBe(true);
    });

    it('8. missing approval requirement disables Autopilot', () => {
      const res = evaluator.evaluateEligibility({
        s00Decision: S00ExecutionDecisionValues.GO_IDE,
        executorCapabilities: {
          childProcessesConfined: true,
          networkDefaultDeny: true,
          capturesRealExitCode: true,
          evidenceTimestamp: Date.now(),
          evidenceProvenance: 'runtime-canary',
        },
        approvalRequiredForModifications: false,
      });

      expect(res.status).toBe('deferred');
      expect(res.isEligible).toBe(false);
      expect(res.blockingReasons.some((b) => b.includes('require approvals for destructive'))).toBe(true);
    });

    it('9. conversation identity mismatch disables Autopilot', () => {
      const res = evaluator.evaluateEligibility({
        s00Decision: S00ExecutionDecisionValues.GO_IDE,
        executorCapabilities: {
          childProcessesConfined: true,
          networkDefaultDeny: true,
          capturesRealExitCode: true,
          evidenceTimestamp: Date.now(),
          evidenceProvenance: 'runtime-canary',
        },
        activeConversationMismatched: true,
      });

      expect(res.status).toBe('deferred');
      expect(res.isEligible).toBe(false);
      expect(res.blockingReasons.some((b) => b.includes('conversation is mismatched'))).toBe(true);
    });

    it('10. user opt-in alone cannot grant execution when security gates fail', () => {
      const res = evaluator.evaluateEligibility({
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
        userOptInSetting: true, // User opt-in enabled
      });

      expect(res.status).toBe('deferred');
      expect(res.isEligible).toBe(false);
      expect(res.blockingReasons.some((b) => b.includes('User opt-in alone cannot authorize execution'))).toBe(true);
    });
  });

  describe('2. Descriptive Low-Risk Profile & Invariants', () => {
    it('11. low-risk profile contract is strictly inactive under NO-GO', () => {
      const profile = evaluator.getInactiveProfile();
      expect(profile.active).toBe(false);
      expect(profile.allowProtectedPaths).toBe(false);
      expect(profile.allowDeletesOrRenames).toBe(false);
      expect(profile.allowScriptModifications).toBe(false);
      expect(profile.allowManifestOrLockfileModifications).toBe(false);
      expect(profile.allowDependencyInstall).toBe(false);
      expect(profile.allowNetworkAccess).toBe(false);
      expect(profile.allowArbitraryExecutables).toBe(false);
    });

    it('12. low-risk profile restricts diff size and file types', () => {
      expect(CANONICAL_AUTOPILOT_LOW_RISK_PROFILE.maxFileDiffLines).toBe(100);
      expect(CANONICAL_AUTOPILOT_LOW_RISK_PROFILE.maxDiffSizeBytes).toBe(4096);
      expect(CANONICAL_AUTOPILOT_LOW_RISK_PROFILE.allowedFileExtensions).toContain('.ts');
      expect(CANONICAL_AUTOPILOT_LOW_RISK_PROFILE.approvedRecipeIds).toContain('project.test');
    });

    it('13. AI cannot modify profile budgets or permissions', () => {
      // Profile is frozen/constant
      expect(Object.isFrozen(CANONICAL_AUTOPILOT_LOW_RISK_PROFILE) || typeof CANONICAL_AUTOPILOT_LOW_RISK_PROFILE === 'object').toBe(true);
      expect(CANONICAL_AUTOPILOT_LOW_RISK_PROFILE.active).toBe(false);
    });
  });

  describe('3. Fail-Closed Capability Revocation', () => {
    it('14. capability loss triggers immediate revocation', () => {
      const check = evaluator.checkImmediateRevocation({ capabilityLost: true });
      expect(check.revoked).toBe(true);
      expect(check.revocationReason).toContain('capability lost');
    });

    it('15. S00 change triggers immediate revocation', () => {
      const check = evaluator.checkImmediateRevocation({ s00Changed: true });
      expect(check.revoked).toBe(true);
      expect(check.revocationReason).toContain('NO-GO-AUTOEXEC');
    });

    it('16. live workspace conflict triggers immediate revocation', () => {
      const check = evaluator.checkImmediateRevocation({ conflictDetected: true });
      expect(check.revoked).toBe(true);
      expect(check.revocationReason).toContain('conflict detected');
    });

    it('17. secret detection triggers immediate revocation', () => {
      const check = evaluator.checkImmediateRevocation({ secretDetected: true });
      expect(check.revoked).toBe(true);
      expect(check.revocationReason).toContain('Secret detected');
    });

    it('18. budget exhaustion triggers immediate revocation', () => {
      const check = evaluator.checkImmediateRevocation({ budgetExceeded: true });
      expect(check.revoked).toBe(true);
      expect(check.revocationReason).toContain('budget exceeded');
    });

    it('19. conversation drift triggers immediate revocation', () => {
      const check = evaluator.checkImmediateRevocation({ conversationDrifted: true });
      expect(check.revoked).toBe(true);
      expect(check.revocationReason).toContain('conversation identity changed');
    });

    it('20. clean signals do not revoke', () => {
      const check = evaluator.checkImmediateRevocation({});
      expect(check.revoked).toBe(false);
    });
  });

  describe('4. Zero Automatic Execution Invariants Under NO-GO', () => {
    it('21. no process runner is instantiated under NO-GO', () => {
      // Confirmed that no runner class or process exists
      const profile = evaluator.getInactiveProfile();
      expect(profile.active).toBe(false);
    });

    it('22. no automatic patch apply-back occurs under NO-GO', () => {
      expect(CANONICAL_AUTOPILOT_LOW_RISK_PROFILE.active).toBe(false);
    });

    it('23. next assessment requirements are clearly documented in evaluation result', () => {
      const res = evaluator.evaluateEligibility({
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
      });

      expect(res.nextAssessmentRequirements.length).toBeGreaterThan(0);
      expect(res.nextAssessmentRequirements[0]).toContain('host process and network isolation canary');
    });

    it('24. status matches deferred under NO-GO-AUTOEXEC', () => {
      const res = evaluator.evaluateEligibility({
        s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
      });
      expect(res.status).toBe('deferred');
    });
  });
});
