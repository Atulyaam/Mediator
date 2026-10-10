/**
 * @mediator/policy-engine — Evidence Classifier (S07)
 *
 * Enforces separation between unverified agent claims and verified execution evidence.
 *
 * Security invariant:
 * - An agent, provider adapter, or MCP tool calling `submit_agent_report` CANNOT
 *   generate `executor-verified` evidence, even if it explicitly claims "tests passed"
 *   or sets a claim type of "executor-verified".
 * - Only verified execution adapters (canary-proven) can yield `executor-verified` evidence.
 * - In Review-only V1 mode, automated execution is disabled, so executor verification is unavailable.
 */

import {
  EvidenceLevel,
  type EvidenceLevelValue,
  canSatisfyVerificationGate,
} from '@mediator/shared-contracts';
import { type CallerType } from './policyTypes.js';

export interface ClassifiedEvidence {
  readonly level: EvidenceLevelValue;
  readonly canSatisfyGate: boolean;
  readonly safeSummary: string;
  readonly untrustedClaimStripped: boolean;
}

/**
 * Classifies reported evidence based strictly on the authoritative caller identity,
 * discarding any untrusted self-assigned claims from agents.
 */
export function classifyEvidence(
  callerType: CallerType,
  claimedLevel: string | undefined,
  claimedSummary: string,
): ClassifiedEvidence {
  // If caller is agent, browser, or MCP, it is STRICTLY agent-reported
  if (callerType === 'agent' || callerType === 'browser' || callerType === 'mcp') {
    const untrustedClaimStripped =
      claimedLevel === EvidenceLevel.MEDIATOR_EXECUTOR_VERIFIED ||
      claimedLevel === EvidenceLevel.TRUSTED_IDE_API_VERIFIED;

    return {
      level: EvidenceLevel.AGENT_REPORTED,
      canSatisfyGate: false,
      safeSummary: `[Agent Claim - Unverified] ${claimedSummary}`,
      untrustedClaimStripped,
    };
  }

  // If caller is core or ide: check if genuine executor verification
  if (callerType === 'core' && claimedLevel === EvidenceLevel.MEDIATOR_EXECUTOR_VERIFIED) {
    return {
      level: EvidenceLevel.MEDIATOR_EXECUTOR_VERIFIED,
      canSatisfyGate: canSatisfyVerificationGate(EvidenceLevel.MEDIATOR_EXECUTOR_VERIFIED),
      safeSummary: claimedSummary,
      untrustedClaimStripped: false,
    };
  }

  if (callerType === 'ide' && claimedLevel === EvidenceLevel.IDE_DIAGNOSTIC_OBSERVED) {
    return {
      level: EvidenceLevel.IDE_DIAGNOSTIC_OBSERVED,
      canSatisfyGate: canSatisfyVerificationGate(EvidenceLevel.IDE_DIAGNOSTIC_OBSERVED),
      safeSummary: claimedSummary,
      untrustedClaimStripped: false,
    };
  }

  // Default fallback for any other source: mediator-observed (cannot satisfy automated verification gate)
  return {
    level: EvidenceLevel.MANUAL_RESULT_REPORTED,
    canSatisfyGate: false,
    safeSummary: claimedSummary,
    untrustedClaimStripped: false,
  };
}
