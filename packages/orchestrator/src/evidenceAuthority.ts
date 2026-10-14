/**
 * @mediator/orchestrator — Evidence Authority & Provenance Verification (S24)
 *
 * Requirements:
 * - Strict evidence provenance distinctions:
 *   1. executor-verified (runtime_canary / trusted executor) — NEVER granted under NO-GO-AUTOEXEC.
 *   2. ide-diagnostic-observed (ide_api_reported).
 *   3. user-verified (explicit trusted UI human confirmation).
 *   4. agent-reported (agent_reported_claim) — informational only, NEVER satisfies verification gates.
 * - Rejects AI attempting to assign provenance or claim verification.
 * - Produces transparent VerificationSummary distinguishing passed, failed, blocked, and unverified checks.
 */

import {
  type RecipeId,
  type S00ExecutionDecision,
  S00ExecutionDecisionValues,
  type VerificationEvidenceRecord,
  type VerificationSummary,
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
} from '@mediator/shared-contracts';

export class EvidenceAuthorityService {
  private readonly evidenceRecords: Map<string, VerificationEvidenceRecord[]> = new Map();
  private readonly s00Decision: S00ExecutionDecision;

  public constructor(s00Decision?: S00ExecutionDecision | undefined) {
    this.s00Decision = s00Decision ?? S00ExecutionDecisionValues.NO_GO_AUTOEXEC;
  }

  /**
   * Registers evidence from an authoritative or observed source.
   * Enforces that under NO-GO-AUTOEXEC, executor-verified evidence cannot be fabricated.
   */
  public recordEvidence(
    taskId: string,
    record: Omit<VerificationEvidenceRecord, 'evidenceId' | 'observedAt'>,
    actorSource: 'executor' | 'ide-api' | 'user-ui' | 'agent-report',
  ): Result<VerificationEvidenceRecord, MediatorError> {
    // 1. Guard against agent attempting to assign executor or user provenance
    if (actorSource === 'agent-report' && record.provenance !== 'agent_reported_claim') {
      return err(
        makeMediatorError(
          ErrorCode.AGENT_REPORT_UNVERIFIED,
          'Agent cannot assign non-agent provenance to its own report. Provenance downgraded to agent_reported_claim.',
          { taskId },
        ),
      );
    }

    // 2. Under NO-GO-AUTOEXEC, runtime executor verification is strictly prohibited
    if (
      this.s00Decision === S00ExecutionDecisionValues.NO_GO_AUTOEXEC &&
      record.provenance === 'runtime_canary'
    ) {
      return err(
        makeMediatorError(
          ErrorCode.EXECUTION_BLOCKED,
          'Cannot assign runtime_canary evidence under S00 NO-GO-AUTOEXEC decision. Automated command execution is disabled.',
          { taskId },
        ),
      );
    }

    // 3. User verification requires explicit user-ui actor
    if (record.provenance === 'documentation_assertion' && actorSource !== 'user-ui') {
      return err(
        makeMediatorError(
          ErrorCode.EVIDENCE_INSUFFICIENT,
          'User verification provenance can only be asserted through explicit trusted UI interaction.',
          { taskId },
        ),
      );
    }

    const fullRecord: VerificationEvidenceRecord = {
      ...record,
      evidenceId: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      observedAt: Date.now(),
    };

    let list = this.evidenceRecords.get(taskId);
    if (!list) {
      list = [];
      this.evidenceRecords.set(taskId, list);
    }
    list.push(fullRecord);

    return ok(fullRecord);
  }

  /**
   * Record a blocked check explicitly.
   */
  public recordBlockedCheck(
    taskId: string,
    sessionId: string,
    checkName: string,
    recipeId: RecipeId | undefined,
    reason: string,
  ): VerificationEvidenceRecord {
    const record: VerificationEvidenceRecord = {
      evidenceId: `ev-blocked-${Date.now()}`,
      taskId,
      sessionId,
      checkName,
      recipeId,
      provenance: 'unit_contract_test',
      outcome: 'blocked',
      observedAt: Date.now(),
      summary: `Check blocked: ${reason}`,
      limitations: reason,
    };

    let list = this.evidenceRecords.get(taskId);
    if (!list) {
      list = [];
      this.evidenceRecords.set(taskId, list);
    }
    list.push(record);
    return record;
  }

  /**
   * Builds an authoritative, honest verification summary for the given task.
   */
  public buildSummary(taskId: string): VerificationSummary {
    const list = this.evidenceRecords.get(taskId) ?? [];

    const totalChecks = list.length;
    let passedChecks = 0;
    let failedChecks = 0;
    let blockedChecks = 0;

    for (const rec of list) {
      if (rec.outcome === 'passed') {
        passedChecks++;
      } else if (rec.outcome === 'failed') {
        failedChecks++;
      } else if (rec.outcome === 'blocked') {
        blockedChecks++;
      }
    }

    const isNoGo = this.s00Decision === S00ExecutionDecisionValues.NO_GO_AUTOEXEC;

    let overallStatus: 'fully-verified' | 'partially-verified' | 'blocked' | 'unverified' = 'unverified';

    if (totalChecks === 0) {
      overallStatus = 'unverified';
    } else if (blockedChecks > 0 && passedChecks === 0) {
      overallStatus = 'blocked';
    } else if (passedChecks > 0 && (blockedChecks > 0 || failedChecks > 0)) {
      overallStatus = 'partially-verified';
    } else if (passedChecks > 0 && failedChecks === 0 && blockedChecks === 0) {
      // If only agent-reported, it cannot be fully-verified
      const onlyAgent = list.every((r) => r.provenance === 'agent_reported_claim');
      overallStatus = onlyAgent ? 'unverified' : 'fully-verified';
    }

    return {
      taskId,
      totalChecks,
      passedChecks,
      failedChecks,
      blockedChecks,
      evidenceRecords: [...list],
      overallStatus,
      automatedExecutionBlocked: isNoGo,
      s00Decision: this.s00Decision,
    };
  }

  public getRecords(taskId: string): readonly VerificationEvidenceRecord[] {
    return this.evidenceRecords.get(taskId) ?? [];
  }

  public clearTask(taskId: string): void {
    this.evidenceRecords.delete(taskId);
  }
}
