/**
 * @mediator/stage-store — IDE Agent Handoff Service (Sprint S17)
 *
 * Requirements:
 * - Pull-based / manual workflow for handing off tasks to an IDE agent.
 * - Generates bounded, task-specific instructions emphasizing read-only MCP access.
 * - Ingests agent reports as untrusted input; classifies evidence strictly as 'agent-reported'.
 * - Compares claimed changes against Mediator staging state to detect discrepancies.
 * - Does not treat agent claims (e.g. verified: true, testsPassed: true) as executor verification.
 * - Enforces handoff lifecycle states (prepared, waiting-for-agent, report-received, review-required, cancelled, expired, rejected).
 * - Full audit trails with secret redaction and safe restart recovery.
 */

import * as crypto from 'node:crypto';
import {
  type Result,
  ok,
  err,
  makeMediatorError,
  ErrorCode,
  type MediatorError,
  type WorkspaceRootState,
  type HandoffRecord,
  type HandoffStatusValue,
  HandoffStatus,
  type AgentReport,
  AgentReportSchema,
  type HandoffReportDiscrepancy,
  type IngestReportResult,
  EvidenceLevel,
} from '@mediator/shared-contracts';
import {
  type HandoffRepository,
  type TaskRepository,
  type EvidenceRepository,
  type AuditRepository,
  safeRedactString,
} from '@mediator/persistence';
import { checkWorkspacePermittedForFileOps, validateContainedPath } from '@mediator/workspace-boundary';
import { isPathExcluded } from '@mediator/context-security';
import { type StageStore } from './stageStore.js';

export const DEFAULT_HANDOFF_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_REPORT_RAW_BYTES = 64 * 1024; // 64 KB
export const MAX_HANDOFF_PROMPT_BYTES = 8 * 1024; // 8 KB

export interface PrepareHandoffParams {
  readonly taskId: string;
  readonly sessionId: string;
  readonly stageId?: string | undefined;
  readonly allowedScope?: readonly string[] | undefined;
  readonly correlationId?: string | undefined;
  readonly callerSource?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface PrepareHandoffResult {
  readonly handoff: HandoffRecord;
  readonly prompt: string;
}

export interface HandoffServiceDependencies {
  readonly handoffRepo: HandoffRepository;
  readonly taskRepo: TaskRepository;
  readonly evidenceRepo: EvidenceRepository;
  readonly auditRepo: AuditRepository;
  readonly stageStore: StageStore;
  readonly rootState: WorkspaceRootState;
}

export class HandoffService {
  constructor(private readonly deps: HandoffServiceDependencies) {}

  /**
   * 1. Prepare IDE Agent Handoff
   * Generates a bounded, task-specific prompt and persists the handoff record.
   */
  public prepareHandoff(params: PrepareHandoffParams): Result<PrepareHandoffResult, MediatorError> {
    const { taskId, sessionId } = params;

    // Verify workspace permits operations
    const permCheck = checkWorkspacePermittedForFileOps(this.deps.rootState);
    if (!permCheck.ok) {
      return err(
        makeMediatorError(
          ErrorCode.WORKSPACE_ROOT_UNCONFIRMED,
          `Cannot prepare handoff: workspace root unconfirmed (${permCheck.error.message})`,
          { taskId, sessionId },
        ),
      );
    }
    const canonicalRoot = permCheck.value;

    // Verify task exists
    const task = this.deps.taskRepo.getTask(taskId);
    if (!task) {
      return err(
        makeMediatorError(
          ErrorCode.UNAUTHORIZED_TASK_SCOPE,
          `Cannot prepare handoff: task "${taskId}" does not exist in local task ledger`,
          { taskId, sessionId },
        ),
      );
    }

    // Verify stage exists if specified
    if (params.stageId) {
      const stage = this.deps.stageStore.getStage(params.stageId);
      if (!stage || stage.taskId !== taskId) {
        return err(
          makeMediatorError(
            ErrorCode.STAGE_NOT_FOUND,
            `Cannot prepare handoff: stage "${params.stageId}" does not exist for task "${taskId}"`,
            { taskId, sessionId, detail: { stageId: params.stageId } },
          ),
        );
      }
    }

    const now = Date.now();
    const timeoutMs = params.timeoutMs ?? DEFAULT_HANDOFF_EXPIRY_MS;
    const expiresAt = now + timeoutMs;
    const handoffId = `handoff_${crypto.randomUUID().slice(0, 12)}`;
    const correlationId = params.correlationId ?? `corr_${crypto.randomUUID().slice(0, 8)}`;
    const allowedScope = params.allowedScope && params.allowedScope.length > 0 ? params.allowedScope : ['*'];

    // Generate prompt
    const prompt = this.generatePrompt({
      handoffId,
      taskId,
      sessionId,
      stageId: params.stageId,
      goalSummary: task.goalSummary,
      acceptanceCriteria: task.acceptanceCriteria ?? [],
      allowedScope,
      workspaceRoot: canonicalRoot,
    });

    if (Buffer.byteLength(prompt, 'utf8') > MAX_HANDOFF_PROMPT_BYTES) {
      return err(
        makeMediatorError(
          ErrorCode.OVERSIZED_INPUT,
          `Generated handoff prompt exceeds maximum budget (${Buffer.byteLength(prompt, 'utf8')} > ${MAX_HANDOFF_PROMPT_BYTES} bytes)`,
          { taskId, sessionId },
        ),
      );
    }

    const promptHash = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
    const promptPreviewSafe = safeRedactString(prompt.slice(0, 300));

    const record: HandoffRecord = {
      handoffId,
      taskId,
      sessionId,
      stageId: params.stageId,
      workspaceRoot: canonicalRoot,
      correlationId,
      status: HandoffStatus.PREPARED,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      promptHash,
      promptPreviewSafe,
      allowedScope,
      expectedReportSchemaVersion: '1.0',
      callerSource: params.callerSource ?? 'ide_user_ui',
    };

    const saved = this.deps.handoffRepo.createHandoff(record);

    // Record audit event
    this.deps.auditRepo.appendEvent({
      taskId,
      sessionId,
      correlationId,
      eventType: 'handoff_created',
      actor: 'human_operator',
      outcome: 'success',
      details: {
        handoffId,
        stageId: params.stageId,
        expiresAt,
        allowedScope,
        promptHash,
      },
    });

    return ok({ handoff: saved, prompt });
  }

  /**
   * 2. Mark Handoff as Waiting for Agent
   */
  public markWaitingForAgent(handoffId: string): Result<HandoffRecord, MediatorError> {
    const handoff = this.deps.handoffRepo.getHandoff(handoffId);
    if (!handoff) {
      return err(makeMediatorError(ErrorCode.HANDOFF_NOT_FOUND, `Handoff "${handoffId}" not found`));
    }

    const now = Date.now();
    if (now > handoff.expiresAt) {
      this.deps.handoffRepo.updateHandoffStatus(handoffId, HandoffStatus.EXPIRED);
      return err(makeMediatorError(ErrorCode.HANDOFF_EXPIRED, `Handoff "${handoffId}" has expired`));
    }

    if (handoff.status === HandoffStatus.CANCELLED) {
      return err(makeMediatorError(ErrorCode.HANDOFF_CANCELLED, `Handoff "${handoffId}" was cancelled`));
    }

    const updated = this.deps.handoffRepo.updateHandoffStatus(handoffId, HandoffStatus.WAITING_FOR_AGENT);
    if (!updated) {
      return err(makeMediatorError(ErrorCode.INTERNAL_ERROR, `Failed to update handoff "${handoffId}"`));
    }

    this.deps.auditRepo.appendEvent({
      taskId: handoff.taskId,
      sessionId: handoff.sessionId,
      correlationId: handoff.correlationId,
      eventType: 'handoff_waiting',
      actor: 'human_operator',
      outcome: 'success',
      details: { handoffId, status: HandoffStatus.WAITING_FOR_AGENT },
    });

    return ok(updated);
  }

  /**
   * 3. Ingest and Validate Untrusted Agent Report
   */
  public ingestReport(handoffId: string, rawInput: unknown): Result<IngestReportResult, MediatorError> {
    // 3a. Size limit check
    const rawString = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
    if (Buffer.byteLength(rawString, 'utf8') > MAX_REPORT_RAW_BYTES) {
      return err(
        makeMediatorError(
          ErrorCode.REPORT_OVERSIZED,
          `Agent report exceeds maximum allowed size (${Buffer.byteLength(rawString, 'utf8')} > ${MAX_REPORT_RAW_BYTES} bytes)`,
        ),
      );
    }

    // 3b. Parse object
    let parsedJson: unknown = rawInput;
    if (typeof rawInput === 'string') {
      try {
        parsedJson = JSON.parse(rawInput);
      } catch (jsonErr) {
        return err(
          makeMediatorError(
            ErrorCode.REPORT_SCHEMA_INVALID,
            `Report is not valid JSON: ${String(jsonErr)}`,
          ),
        );
      }
    }

    // 3c. Validate schema
    const schemaRes = AgentReportSchema.safeParse(parsedJson);
    if (!schemaRes.success) {
      const issue = schemaRes.error.issues[0];
      return err(
        makeMediatorError(
          ErrorCode.REPORT_SCHEMA_INVALID,
          `Report schema validation failed: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid schema'}`,
          { detail: { issues: schemaRes.error.issues } },
        ),
      );
    }
    const report: AgentReport = schemaRes.data;

    // 3d. Check handoff identity match
    if (report.handoffId !== handoffId) {
      return err(
        makeMediatorError(
          ErrorCode.HANDOFF_TASK_MISMATCH,
          `Report handoffId mismatch: expected "${handoffId}", got "${report.handoffId}"`,
        ),
      );
    }

    const handoff = this.deps.handoffRepo.getHandoff(handoffId);
    if (!handoff) {
      return err(makeMediatorError(ErrorCode.HANDOFF_NOT_FOUND, `Handoff "${handoffId}" not found`));
    }

    if (report.taskId !== handoff.taskId || report.sessionId !== handoff.sessionId) {
      return err(
        makeMediatorError(
          ErrorCode.HANDOFF_TASK_MISMATCH,
          `Report taskId/sessionId mismatch: expected task "${handoff.taskId}" session "${handoff.sessionId}", got task "${report.taskId}" session "${report.sessionId}"`,
        ),
      );
    }

    const now = Date.now();
    if (now > handoff.expiresAt || handoff.status === HandoffStatus.EXPIRED) {
      this.deps.handoffRepo.updateHandoffStatus(handoffId, HandoffStatus.EXPIRED);
      return err(
        makeMediatorError(
          ErrorCode.HANDOFF_EXPIRED,
          `Cannot ingest report: handoff "${handoffId}" has expired`,
        ),
      );
    }

    if (handoff.status === HandoffStatus.CANCELLED) {
      return err(
        makeMediatorError(
          ErrorCode.HANDOFF_CANCELLED,
          `Cannot ingest report: handoff "${handoffId}" was cancelled`,
        ),
      );
    }

    if (handoff.status === HandoffStatus.REJECTED) {
      return err(
        makeMediatorError(
          ErrorCode.HANDOFF_STALE,
          `Cannot ingest report: handoff "${handoffId}" was previously rejected`,
        ),
      );
    }

    // 3e. Validate reported paths & collect discrepancies
    const discrepancies: HandoffReportDiscrepancy[] = [];
    const scopeSet = new Set(handoff.allowedScope);
    const scopeAllowsAll = scopeSet.has('*');

    for (const relPath of report.claimedChangedPaths) {
      // Syntax & containment
      const contCheck = validateContainedPath(this.deps.rootState, relPath);
      if (!contCheck.ok) {
        discrepancies.push({
          type: 'outside_scope_path',
          path: relPath,
          detail: `Reported path violates workspace containment: ${contCheck.error.message}`,
        });
        continue;
      }

      // Secret exclusion
      const exclusionCheck = isPathExcluded(relPath);
      if (exclusionCheck.excluded) {
        discrepancies.push({
          type: 'secret_path_claimed',
          path: relPath,
          detail: `Reported path is a mandatory secret/excluded file: ${exclusionCheck.reason}`,
        });
      }

      // Permitted scope check
      if (!scopeAllowsAll && !scopeSet.has(relPath)) {
        discrepancies.push({
          type: 'outside_scope_path',
          path: relPath,
          detail: `Reported path "${relPath}" is outside the allowed scope of this handoff`,
        });
      }
    }

    // Compare with Mediator staging store if stage is bound
    if (handoff.stageId) {
      try {
        const stagedChanges = this.deps.stageStore.listStagedChanges(handoff.stageId, this.deps.rootState);
        const stagedPathSet = new Set(stagedChanges.map((f) => f.relativePath));
        const claimedPathSet = new Set(report.claimedChangedPaths);

        for (const claimed of claimedPathSet) {
          if (!stagedPathSet.has(claimed)) {
            discrepancies.push({
              type: 'claimed_files_not_staged',
              path: claimed,
              detail: `Agent claimed change to "${claimed}", but no such staged file exists in Mediator stage "${handoff.stageId}"`,
            });
          }
        }

        for (const staged of stagedPathSet) {
          if (!claimedPathSet.has(staged)) {
            discrepancies.push({
              type: 'staged_files_not_claimed',
              path: staged,
              detail: `Staged change exists for "${staged}" in Mediator stage, but was not claimed in the agent report`,
            });
          }
        }
      } catch {
        // Stage list failed, continue with path validation discrepancies
      }
    }

    // 3f. Secret scan report content
    const summarySafe = safeRedactString(report.summary);
    const reportHash = crypto.createHash('sha256').update(rawString, 'utf8').digest('hex');
    const evidenceId = `ev_rep_${crypto.randomUUID().slice(0, 12)}`;

    // 3g. Record evidence — STRICT: always AGENT_REPORTED, never EXECUTOR_VERIFIED
    this.deps.evidenceRepo.recordEvidence({
      evidenceId,
      taskId: handoff.taskId,
      sessionId: handoff.sessionId,
      source: 'ide_agent_report',
      evidenceLevel: EvidenceLevel.AGENT_REPORTED,
      verificationStatus: 'unverified', // Self-reported claims cannot self-verify
      evidenceHash: reportHash,
      summary: summarySafe,
    });

    const hasBlockers = Boolean(report.blockers && report.blockers.length > 0);
    const requiresReview = discrepancies.length > 0 || hasBlockers;
    const finalStatus: HandoffStatusValue = requiresReview
      ? HandoffStatus.REVIEW_REQUIRED
      : HandoffStatus.REPORT_RECEIVED;

    this.deps.handoffRepo.updateHandoffStatus(handoffId, finalStatus, {
      auditRef: evidenceId,
      updatedAt: now,
    });

    // Record audit event
    this.deps.auditRepo.appendEvent({
      taskId: handoff.taskId,
      sessionId: handoff.sessionId,
      correlationId: handoff.correlationId,
      eventType: 'handoff_report_ingested',
      actor: 'agent',
      outcome: requiresReview ? 'review_required' : 'report_received',
      details: {
        handoffId,
        evidenceId,
        evidenceLevel: EvidenceLevel.AGENT_REPORTED,
        discrepanciesCount: discrepancies.length,
        discrepancies,
        hasBlockers,
        finalStatus,
        reportHash,
      },
    });

    return ok({
      reportId: report.reportId,
      handoffId,
      status: finalStatus,
      evidenceId,
      evidenceLevel: EvidenceLevel.AGENT_REPORTED,
      discrepancies,
      requiresReview,
      summarySafe,
    });
  }

  /**
   * 4. Cancel Handoff
   */
  public cancelHandoff(handoffId: string, reason: string): Result<HandoffRecord, MediatorError> {
    const handoff = this.deps.handoffRepo.getHandoff(handoffId);
    if (!handoff) {
      return err(makeMediatorError(ErrorCode.HANDOFF_NOT_FOUND, `Handoff "${handoffId}" not found`));
    }

    if (handoff.status === HandoffStatus.CANCELLED) {
      return ok(handoff);
    }

    if (handoff.status === HandoffStatus.EXPIRED) {
      return err(
        makeMediatorError(ErrorCode.HANDOFF_EXPIRED, `Cannot cancel: handoff "${handoffId}" has already expired`),
      );
    }

    const safeReason = safeRedactString(reason);
    const updated = this.deps.handoffRepo.updateHandoffStatus(handoffId, HandoffStatus.CANCELLED, {
      cancellationReason: safeReason,
    });

    if (!updated) {
      return err(makeMediatorError(ErrorCode.INTERNAL_ERROR, `Failed to update handoff "${handoffId}"`));
    }

    this.deps.auditRepo.appendEvent({
      taskId: handoff.taskId,
      sessionId: handoff.sessionId,
      correlationId: handoff.correlationId,
      eventType: 'handoff_cancelled',
      actor: 'human_operator',
      outcome: 'cancelled',
      details: { handoffId, cancellationReason: safeReason },
    });

    return ok(updated);
  }

  /**
   * 5. Recover on Startup: expire stale handoffs without replaying
   */
  public recoverHandoffs(): number {
    return this.deps.handoffRepo.expireStaleHandoffs();
  }

  public getHandoff(handoffId: string): HandoffRecord | null {
    return this.deps.handoffRepo.getHandoff(handoffId);
  }

  public listHandoffsForTask(taskId: string): readonly HandoffRecord[] {
    return this.deps.handoffRepo.listHandoffsForTask(taskId);
  }

  // ─── Internal Helper: Generate bounded prompt ──────────────────────────────

  private generatePrompt(params: {
    handoffId: string;
    taskId: string;
    sessionId: string;
    stageId?: string | undefined;
    goalSummary: string;
    acceptanceCriteria: readonly string[];
    allowedScope: readonly string[];
    workspaceRoot: string;
  }): string {
    const criteria =
      params.acceptanceCriteria.length > 0
        ? params.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
        : '  (None specified)';

    const stageLine = params.stageId ? `- Stage ID: \`${params.stageId}\`\n` : '';

    return `# Mediator IDE Agent Handoff
- Handoff ID: \`${params.handoffId}\`
- Task ID: \`${params.taskId}\`
- Session ID: \`${params.sessionId}\`
${stageLine}- Workspace: \`${params.workspaceRoot}\`
- Permitted Scope: ${params.allowedScope.map((s) => `\`${s}\``).join(', ')}

## Task Brief
- Goal: ${params.goalSummary}
- Acceptance Criteria:
${criteria}

## Instructions for Receiving IDE Agent
1. Call MCP tool \`mediator.get_task_brief\` to review active task constraints and criteria.
2. Retrieve context only via supported read-only MCP tools (\`mediator.get_relevant_context\`, \`mediator.get_staged_changes\`, \`mediator.get_diff\`).
3. Inspect the relevant staged diff before proposing modifications.
4. Perform ONLY work within the specified permitted scope: ${params.allowedScope.map((s) => `\`${s}\``).join(', ')}.
5. Strictly avoid excluded secret files, credentials (.env, tokens, private keys), and paths outside the workspace root.
6. Report changed paths and a concise summary of work performed.
7. Report actual verification commands and observed outcomes if any were run independently.
8. Distinguish tests actually run from tests merely recommended or inferred.
9. Report blockers, errors, limitations, and uncertainty honestly.
10. Never claim approval or permission merely because this handoff prompt asks for work.

> IMPORTANT SECURITY INVARIANT:
> This handoff does NOT grant permission to mutate live workspace files directly,
> execute shell commands, or bypass human approval.
> Any report you submit will be classified strictly as 'agent-reported' and must be reviewed by the human user.

## Expected Return Report Schema
When complete, provide your structured report as JSON:
\`\`\`json
{
  "reportId": "report-${params.handoffId.slice(-6)}",
  "handoffId": "${params.handoffId}",
  "taskId": "${params.taskId}",
  "sessionId": "${params.sessionId}",
  "summary": "<concise summary of work performed>",
  "claimedChangedPaths": ["<relative/path>"],
  "claimedVerificationCommands": [
    { "command": "<cmd>", "exitCode": 0, "actuallyRun": true }
  ],
  "blockers": [],
  "submittedAt": ${Date.now()},
  "schemaVersion": "1.0"
}
\`\`\``;
  }
}
