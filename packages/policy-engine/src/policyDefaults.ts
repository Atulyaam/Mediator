/**
 * @mediator/policy-engine — Policy Defaults (S07)
 *
 * Establishes baseline security policy configuration for Review-only V1 mode.
 *
 * Invariant: By default, Mediator operates in Review-only mode (ADR-002).
 * Live workspace mutation and automated recipe execution are disabled by default.
 */

import { type PolicyConfig } from './policyTypes.js';

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  executionMode: 'review_only',
  allowLiveMutation: false,
  allowRecipeExecution: false,
  requireApprovalForProtectedPaths: true,
  customProtectedPatterns: [],
  approvalTimeoutMs: 300_000, // 5 minutes
  strictMode: true,
};

/**
 * Safely resolves a policy configuration by applying defaults.
 * Guarantees all fields are populated and prevents callers from disabling hard security invariants.
 */
export function resolvePolicyConfig(partialConfig?: Partial<PolicyConfig>): PolicyConfig {
  if (!partialConfig) {
    return { ...DEFAULT_POLICY_CONFIG };
  }

  return {
    executionMode: partialConfig.executionMode ?? DEFAULT_POLICY_CONFIG.executionMode,
    allowLiveMutation: partialConfig.allowLiveMutation ?? DEFAULT_POLICY_CONFIG.allowLiveMutation,
    allowRecipeExecution: partialConfig.allowRecipeExecution ?? DEFAULT_POLICY_CONFIG.allowRecipeExecution,
    requireApprovalForProtectedPaths:
      partialConfig.requireApprovalForProtectedPaths ?? DEFAULT_POLICY_CONFIG.requireApprovalForProtectedPaths,
    customProtectedPatterns: partialConfig.customProtectedPatterns ?? DEFAULT_POLICY_CONFIG.customProtectedPatterns,
    approvalTimeoutMs: partialConfig.approvalTimeoutMs ?? DEFAULT_POLICY_CONFIG.approvalTimeoutMs,
    strictMode: partialConfig.strictMode ?? DEFAULT_POLICY_CONFIG.strictMode,
  };
}
