/**
 * @mediator/executor-contract — Capability Evaluation Engine (S21)
 *
 * Requirements:
 * - Centralized deterministic capability evaluation engine.
 * - Fails closed when S00 decision is missing, invalid, or NO-GO-AUTOEXEC.
 * - Treats all mandatory unknown capability values as false.
 * - Rejects stale evidence (older than max evidence age).
 * - Rejects mismatched evidence (executor ID, version, stage ID, workspace root).
 * - Rejects documentation-only assertions, mock-only claims, or agent-reported claims for runtime gates.
 * - Refuses eligibility if any mandatory security property is unverified.
 * - Never modifies policy or self-upgrades its own authority.
 * - Records bounded explainable list of passed, failed, and unverified requirements.
 */

import {
  type S00ExecutionDecision,
  S00ExecutionDecisionValues,
  type ExecutorSecurityCapabilities,
  type SecurityCapabilityField,
  type CapabilityEvaluationReport,
  type CapabilityEvaluationResult,
  type CanaryRunRecord,
  ErrorCode,
} from '@mediator/shared-contracts';
import { normalizeWindowsPath } from '@mediator/workspace-boundary';

export interface CapabilityEvaluationInput {
  readonly executorId: string;
  readonly executorVersion: string;
  readonly s00Decision: S00ExecutionDecision;
  readonly capabilities: ExecutorSecurityCapabilities;
  readonly requiredStageId: string;
  readonly requiredWorkspaceRoot: string;
  readonly currentSessionId?: string | undefined;
  readonly evaluationTime?: number | undefined;
  readonly maxEvidenceAgeMs?: number | undefined;
  readonly canaryRecords?: readonly CanaryRunRecord[] | undefined;
  readonly requireNetworkIsolation?: boolean | undefined;
}

export class CapabilityEvaluationEngine {
  private readonly defaultMaxAgeMs: number;

  public constructor(options?: { readonly defaultMaxAgeMs?: number | undefined }) {
    this.defaultMaxAgeMs = options?.defaultMaxAgeMs ?? 3_600_000; // 1 hour default TTL
  }

  /**
   * Deterministically evaluate capability evidence against execution criteria.
   */
  public evaluate(input: CapabilityEvaluationInput): CapabilityEvaluationReport {
    const evalTime = input.evaluationTime ?? Date.now();
    const maxAge = input.maxEvidenceAgeMs ?? this.defaultMaxAgeMs;

    const passed: string[] = [];
    const failed: string[] = [];
    const unverified: string[] = [];
    const blockedReasons: string[] = [];

    // 1. Validate S00 Decision (Mandatory Fail-Closed)
    if (!input.s00Decision || !Object.values(S00ExecutionDecisionValues).includes(input.s00Decision)) {
      blockedReasons.push('S00 feasibility decision is missing, invalid, or unrecognized');
      failed.push('s00_decision_valid');
      return {
        result: 'blocked',
        isEligibleForAutoExec: false,
        s00Decision: input.s00Decision ?? S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
        executorId: input.executorId,
        executorVersion: input.executorVersion,
        evaluatedAt: evalTime,
        passedRequirements: passed,
        failedRequirements: failed,
        unverifiedRequirements: unverified,
        blockedReasons,
      };
    }

    if (input.s00Decision === S00ExecutionDecisionValues.NO_GO_AUTOEXEC) {
      blockedReasons.push('S00 feasibility decision is NO-GO-AUTOEXEC: automatic execution is disabled for Review-only V1');
      failed.push('s00_decision_go');
    } else {
      passed.push('s00_decision_go');
    }

    const caps = input.capabilities;

    // 2. Validate Identity & Scope Match
    if (!caps || typeof caps !== 'object') {
      blockedReasons.push('Capability evidence payload is missing or invalid');
      failed.push('capabilities_payload_present');
      return {
        result: 'blocked',
        isEligibleForAutoExec: false,
        s00Decision: input.s00Decision,
        executorId: input.executorId,
        executorVersion: input.executorVersion,
        evaluatedAt: evalTime,
        passedRequirements: passed,
        failedRequirements: failed,
        unverifiedRequirements: unverified,
        blockedReasons,
      };
    }

    if (caps.executorId !== input.executorId) {
      blockedReasons.push(
        `${ErrorCode.CAPABILITY_EVIDENCE_MISMATCH}: evidence executorId '${caps.executorId}' does not match required '${input.executorId}'`,
      );
      failed.push('executor_id_match');
    } else {
      passed.push('executor_id_match');
    }

    if (caps.executorVersion !== input.executorVersion) {
      blockedReasons.push(
        `${ErrorCode.CAPABILITY_EVIDENCE_MISMATCH}: evidence executorVersion '${caps.executorVersion}' does not match required '${input.executorVersion}'`,
      );
      failed.push('executor_version_match');
    } else {
      passed.push('executor_version_match');
    }

    if (caps.stageId !== input.requiredStageId) {
      blockedReasons.push(
        `${ErrorCode.CAPABILITY_EVIDENCE_MISMATCH}: evidence stageId '${caps.stageId}' does not match active stage '${input.requiredStageId}'`,
      );
      failed.push('stage_id_match');
    } else {
      passed.push('stage_id_match');
    }

    const normCapWorkspace = normalizeWindowsPath(caps.workspaceRoot);
    const normReqWorkspace = normalizeWindowsPath(input.requiredWorkspaceRoot);
    if (normCapWorkspace.toLowerCase() !== normReqWorkspace.toLowerCase()) {
      blockedReasons.push(
        `${ErrorCode.CAPABILITY_EVIDENCE_MISMATCH}: evidence workspaceRoot '${caps.workspaceRoot}' does not match active workspace '${input.requiredWorkspaceRoot}'`,
      );
      failed.push('workspace_root_match');
    } else {
      passed.push('workspace_root_match');
    }

    // 3. Validate Staging & Filesystem Guarantees
    this.evaluateField(
      'filesystem.stageRootRead',
      caps.filesystem.stageRootRead,
      evalTime,
      maxAge,
      true, // requireRuntimeCanary
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    this.evaluateField(
      'filesystem.stageRootWrite',
      caps.filesystem.stageRootWrite,
      evalTime,
      maxAge,
      true,
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    this.evaluateField(
      'filesystem.liveWorkspaceWriteDenied',
      caps.filesystem.liveWorkspaceWriteDenied,
      evalTime,
      maxAge,
      true, // Critical: source write denial must be proven by canary
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    this.evaluateField(
      'filesystem.outsideRootDenied',
      caps.filesystem.outsideRootDenied,
      evalTime,
      maxAge,
      true,
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    this.evaluateField(
      'filesystem.secretFilesProtected',
      caps.filesystem.secretFilesProtected,
      evalTime,
      maxAge,
      true,
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    this.evaluateField(
      'filesystem.symlinkEscapeDenied',
      caps.filesystem.symlinkEscapeDenied,
      evalTime,
      maxAge,
      true,
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    // 4. Process and Executable Restrictions
    this.evaluateField(
      'process.executableAllowlistEnforced',
      caps.process.executableAllowlistEnforced,
      evalTime,
      maxAge,
      false,
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    this.evaluateField(
      'process.untrustedScriptsRejected',
      caps.process.untrustedScriptsRejected,
      evalTime,
      maxAge,
      false,
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    this.evaluateField(
      'process.hostShellFallbackDenied',
      caps.process.hostShellFallbackDenied,
      evalTime,
      maxAge,
      false,
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    // 5. Limits & Exit Code Collection
    this.evaluateField(
      'limits.timeoutEnforced',
      caps.limits.timeoutEnforced,
      evalTime,
      maxAge,
      false,
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    this.evaluateField(
      'limits.outputByteLimitsEnforced',
      caps.limits.outputByteLimitsEnforced,
      evalTime,
      maxAge,
      false,
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    this.evaluateField(
      'limits.capturesRealExitCode',
      caps.limits.capturesRealExitCode,
      evalTime,
      maxAge,
      true, // Real exit code capture must be verified
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    this.evaluateField(
      'execution.fixedRecipeOnly',
      caps.execution.fixedRecipeOnly,
      evalTime,
      maxAge,
      false,
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    this.evaluateField(
      'execution.stagedSourceProven',
      caps.execution.stagedSourceProven,
      evalTime,
      maxAge,
      true,
      passed,
      failed,
      unverified,
      blockedReasons,
      input.canaryRecords,
    );

    // 6. Network Isolation (when required)
    if (input.requireNetworkIsolation) {
      this.evaluateField(
        'network.networkRestricted',
        caps.network?.networkRestricted,
        evalTime,
        maxAge,
        true,
        passed,
        failed,
        unverified,
        blockedReasons,
        input.canaryRecords,
      );
    }

    // Determine Final Classification
    let result: CapabilityEvaluationResult;
    const isEligible =
      input.s00Decision !== S00ExecutionDecisionValues.NO_GO_AUTOEXEC &&
      failed.length === 0 &&
      unverified.length === 0;

    if (input.s00Decision === S00ExecutionDecisionValues.NO_GO_AUTOEXEC) {
      result = 'blocked';
    } else if (failed.length > 0) {
      result = 'blocked';
    } else if (unverified.length > 0) {
      result = 'unverified';
    } else {
      result = 'eligible';
    }

    return {
      result,
      isEligibleForAutoExec: isEligible,
      s00Decision: input.s00Decision,
      executorId: input.executorId,
      executorVersion: input.executorVersion,
      evaluatedAt: evalTime,
      passedRequirements: passed,
      failedRequirements: failed,
      unverifiedRequirements: unverified,
      blockedReasons,
    };
  }

  private evaluateField(
    fieldName: string,
    field: SecurityCapabilityField | undefined,
    evalTime: number,
    maxAge: number,
    requireRuntimeCanary: boolean,
    passed: string[],
    failed: string[],
    unverified: string[],
    blockedReasons: string[],
    canaryRecords?: readonly CanaryRunRecord[] | undefined,
  ): void {
    if (!field) {
      unverified.push(fieldName);
      blockedReasons.push(`${fieldName}: capability field is completely missing (treated as unverified)`);
      return;
    }

    // Check unknown enforcer
    if (field.enforcedBy === 'unknown') {
      unverified.push(fieldName);
      blockedReasons.push(`${fieldName}: enforcing layer is 'unknown' (unknown counts as false for security guarantees)`);
      return;
    }

    // Check value
    if (field.value !== true) {
      failed.push(fieldName);
      blockedReasons.push(`${fieldName}: capability value is false (${field.statusOrLimitations ?? 'not supported'})`);
      return;
    }

    // Check for contradictory evidence (claiming true despite status or evidenceRef indicating breach, tamper, or post-hoc restoration)
    const statusLower = (field.statusOrLimitations ?? '').toLowerCase();
    const evidenceRefLower = (field.evidenceRef ?? '').toLowerCase();
    const hasContradictoryText =
      statusLower.includes('tampered') ||
      statusLower.includes('breached') ||
      statusLower.includes('integrity preserved: false') ||
      statusLower.includes('integritypreserved: false') ||
      statusLower.includes('integritypreserved=false') ||
      statusLower.includes('write permitted') ||
      statusLower.includes('restored after write') ||
      statusLower.includes('cleanup after write') ||
      statusLower.includes('detected after write') ||
      statusLower.includes('prevention failed') ||
      statusLower.includes('detection only') ||
      evidenceRefLower.includes('tamper-detected') ||
      evidenceRefLower.includes('write-occurred');

    if (hasContradictoryText) {
      failed.push(fieldName);
      blockedReasons.push(
        `${fieldName}: contradictory evidence rejected — security property was breached (status: "${field.statusOrLimitations}"); post-hoc detection or cleanup does NOT satisfy prevention guarantee`,
      );
      return;
    }

    // Cross-check underlying canary records if provided
    if (canaryRecords && canaryRecords.length > 0) {
      const matchingRecord = canaryRecords.find(
        (r) => r.capability === fieldName || r.capability.toLowerCase() === fieldName.toLowerCase(),
      );
      if (matchingRecord && matchingRecord.classification !== 'pass') {
        failed.push(fieldName);
        blockedReasons.push(
          `${fieldName}: contradictory evidence rejected — underlying canary run "${matchingRecord.runId}" recorded classification "${matchingRecord.classification}" (${matchingRecord.observedResult})`,
        );
        return;
      }
    }

    // Check evidence presence
    if (!field.evidenceRef) {
      unverified.push(fieldName);
      blockedReasons.push(`${fieldName}: evidence reference is missing`);
      return;
    }

    // Check freshness
    if (field.observedAt !== undefined) {
      const age = evalTime - field.observedAt;
      if (age < -60_000) {
        failed.push(fieldName);
        blockedReasons.push(`${fieldName}: evidence timestamp is from the future`);
        return;
      }
      if (age > maxAge) {
        failed.push(fieldName);
        blockedReasons.push(`${fieldName}: evidence is stale (${Math.round(age / 1000)}s old > ${Math.round(maxAge / 1000)}s max age)`);
        return;
      }
    } else {
      unverified.push(fieldName);
      blockedReasons.push(`${fieldName}: evidence timestamp is missing`);
      return;
    }

    // Check provenance
    if (field.provenance === 'documentation_assertion') {
      unverified.push(fieldName);
      blockedReasons.push(`${fieldName}: documentation-only assertion cannot satisfy a runtime capability gate`);
      return;
    }

    if (field.provenance === 'agent_reported_claim') {
      unverified.push(fieldName);
      blockedReasons.push(`${fieldName}: agent-reported claim cannot satisfy a runtime capability gate`);
      return;
    }

    if (field.provenance === 'unknown_unverified') {
      unverified.push(fieldName);
      blockedReasons.push(`${fieldName}: provenance is unknown_unverified`);
      return;
    }

    if (requireRuntimeCanary && field.provenance !== 'runtime_canary') {
      unverified.push(fieldName);
      blockedReasons.push(`${fieldName}: requires runtime_canary evidence, but provenance is '${field.provenance}'`);
      return;
    }

    passed.push(fieldName);
  }
}
