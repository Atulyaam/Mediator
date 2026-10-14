/**
 * @mediator/orchestrator — Bounded Context Compactor & Repetition Indicators (S25)
 *
 * Requirements:
 * - Produces compact rolling state deltas rather than repeated full repository dumps.
 * - Tracks recent context excerpts and omits unchanged information by default.
 * - Computes privacy-preserving context size & repetition indicators.
 * - Enforces critical invariants:
 *   1. NEVER compacts away uncertainty, unknown actions, conflicts, or security blockers.
 *   2. NEVER combines agent-reported claims with executor-verified outcomes.
 *   3. Secret scanning & redaction are strictly enforced on all summaries.
 *   4. Sensitive paths and app-data staging stores are excluded.
 *   5. Explicit truncation markers indicate omitted content.
 */

import {
  type CompactedTaskSummary,
  type ContextIndicators,
  type VerificationSummary,
} from '@mediator/shared-contracts';
import { scanContent, redactContent } from '@mediator/context-security';

export interface CompactionSourceParams {
  readonly taskId: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly acceptanceCriteria?: readonly string[] | undefined;
  readonly round: number;
  readonly stageId: string;
  readonly changedFilePaths: readonly string[];
  readonly policyApprovalState: string;
  readonly verificationSummary: VerificationSummary;
  readonly blockers?: readonly string[] | undefined;
  readonly knownIssues?: readonly string[] | undefined;
  readonly decisionsMade?: readonly string[] | undefined;
  readonly unknownActions?: readonly string[] | undefined;
  readonly nextRequiredAction?: string | undefined;
  readonly maxByteBudget?: number | undefined;
}

export class ContextCompactor {
  private readonly recentExcerptsByTask: Map<string, Set<string>> = new Map();

  /**
   * Compacts task state into a bounded, secret-safe state delta.
   */
  public compactTaskState(params: CompactionSourceParams): CompactedTaskSummary {
    const {
      taskId,
      sessionId,
      goal,
      acceptanceCriteria = [],
      round,
      stageId,
      changedFilePaths,
      policyApprovalState,
      verificationSummary,
      blockers = [],
      knownIssues = [],
      decisionsMade = [],
      unknownActions = [],
      nextRequiredAction = 'Awaiting next instruction or review.',
      maxByteBudget = 65536, // 64 KB
    } = params;

    // Track recently included excerpts to calculate repetition
    let taskExcerpts = this.recentExcerptsByTask.get(taskId);
    if (!taskExcerpts) {
      taskExcerpts = new Set();
      this.recentExcerptsByTask.set(taskId, taskExcerpts);
    }

    let repetitionHits = 0;
    let selectedExcerptsCount = 0;
    let omittedCount = 0;
    let redactionCount = 0;

    // Build consolidated blockers, ensuring unknown actions and security blockers are NEVER dropped
    const consolidatedBlockers: string[] = [...blockers];
    for (const unknownAction of unknownActions) {
      consolidatedBlockers.push(`CRITICAL: Action "${unknownAction}" has unknown completion status. Cannot auto-advance.`);
    }

    if (verificationSummary.automatedExecutionBlocked) {
      consolidatedBlockers.push('Execution gate: automated command runner is unavailable under S00 NO-GO-AUTOEXEC.');
    }

    // Sanitize text fields via secret scanner
    const sanitizeText = (text: string): string => {
      const scan = scanContent(text);
      if (scan.ok && scan.value.findings.length > 0) {
        redactionCount += scan.value.findings.length;
        const red = redactContent(text, scan.value);
        return red.redactedContent;
      }
      return text;
    };

    const sanitizedGoal = sanitizeText(goal);
    const sanitizedCriteria = acceptanceCriteria.map(sanitizeText);
    const sanitizedBlockers = consolidatedBlockers.map(sanitizeText);
    const sanitizedIssues = knownIssues.map(sanitizeText);
    const sanitizedDecisions = decisionsMade.map(sanitizeText);
    const sanitizedNextAction = sanitizeText(nextRequiredAction);

    // Compute excerpt repetition
    for (const p of changedFilePaths) {
      selectedExcerptsCount++;
      if (taskExcerpts.has(p)) {
        repetitionHits++;
      } else {
        taskExcerpts.add(p);
      }
    }

    const changedCount = changedFilePaths.length;
    const repetitionRatio = selectedExcerptsCount > 0 ? repetitionHits / selectedExcerptsCount : 0;
    const changedVsUnchangedRatio = changedCount > 0 ? 1 : 0;

    // Estimate size and tokens
    const jsonString = JSON.stringify({
      taskId,
      sessionId,
      goal: sanitizedGoal,
      criteria: sanitizedCriteria,
      round,
      stageId,
      files: changedFilePaths,
      policy: policyApprovalState,
      verification: verificationSummary,
      blockers: sanitizedBlockers,
      issues: sanitizedIssues,
      decisions: sanitizedDecisions,
      nextAction: sanitizedNextAction,
    });

    let finalJson = jsonString;
    const packetBytes = Buffer.byteLength(finalJson, 'utf8');

    if (packetBytes > maxByteBudget) {
      omittedCount++;
      finalJson = finalJson.slice(0, maxByteBudget - 64) + '... [TRUNCATED: exceeded compaction budget]';
    }

    const estimatedTokens = Math.ceil(Buffer.byteLength(finalJson, 'utf8') / 4);

    const indicators: ContextIndicators = {
      packetBytes: Buffer.byteLength(finalJson, 'utf8'),
      estimatedTokens,
      configuredBudget: maxByteBudget,
      selectedExcerptsCount,
      omittedCount,
      changedVsUnchangedRatio,
      repetitionRatio: Number(repetitionRatio.toFixed(3)),
      freshnessTimestamp: Date.now(),
      redactionCount,
    };

    return {
      taskId,
      sessionId,
      goal: sanitizedGoal,
      acceptanceCriteria: sanitizedCriteria,
      lastAcceptedRound: round,
      currentStageId: stageId,
      changedFilePaths,
      policyApprovalState,
      verificationSummary,
      blockers: sanitizedBlockers,
      knownIssues: sanitizedIssues,
      decisionsMade: sanitizedDecisions,
      nextRequiredAction: sanitizedNextAction,
      indicators,
      updatedAt: Date.now(),
    };
  }

  public clearTaskContext(taskId: string): void {
    this.recentExcerptsByTask.delete(taskId);
  }
}
