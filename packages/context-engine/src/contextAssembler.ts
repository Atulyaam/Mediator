/**
 * @mediator/context-engine — Context Packet Assembler (S11)
 *
 * Requirements:
 * - One authoritative API: assembleContextPacket()
 * - Strictly coordinates:
 *   1. Task summary & state
 *   2. Project map entries & approved rules/decisions
 *   3. Bounded file excerpts with containment (S05) & secret filters (S06)
 *   4. Deterministic relevance ranking
 *   5. Deduplication of unchanged low-value items
 *   6. Secret scanning and overlap-safe redaction
 *   7. UTF-8 byte budget and token estimation with omission markers
 *   8. Evidence provenance preservation (agent-reported never elevated)
 *   9. request_more_context path & budget validation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  type WorkspaceRootState,
} from '@mediator/shared-contracts';
import { validateContainedPath } from '@mediator/workspace-boundary';
import {
  checkPathExclusion,
  MANDATORY_EXCLUSIONS,
  scanContent,
  shouldBlockContent,
} from '@mediator/context-security';
import { safeRedactString } from '@mediator/persistence';
import { type ValidatedRequestMoreContext } from '@mediator/content-transfer';
import { ContextEngineError, ContextEngineErrorCode } from './errors.js';
import { type TaskSummary } from './taskSummary.js';
import { type ProjectMap } from './projectMap.js';
import { type ProjectRule } from './projectRules.js';
import { type ArchitecturalDecision } from './decisionMemory.js';
import { type KnownIssue } from './knownIssues.js';
import {
  type ContextCandidateItem,
  createCandidateItem,
  rankAndDeduplicateCandidates,
} from './contextRanker.js';
import {
  type ContextBudgetConfig,
  type OmissionMarker,
  DEFAULT_BUDGET_CONFIG,
  enforceContextBudget,
} from './contextBudget.js';

export interface FileDiffItem {
  readonly filePath: string;
  readonly diffText: string;
}

export interface TestExcerptItem {
  readonly command: string;
  readonly exitCode: number;
  readonly excerpt: string;
}

export interface AssembleContextParams {
  readonly taskId: string;
  readonly rootState: WorkspaceRootState;
  readonly summary: TaskSummary;
  readonly projectMap?: ProjectMap | undefined;
  readonly approvedRules?: readonly ProjectRule[] | undefined;
  readonly approvedDecisions?: readonly ArchitecturalDecision[] | undefined;
  readonly knownIssues?: readonly KnownIssue[] | undefined;
  readonly requestedFilePaths?: readonly string[] | undefined;
  readonly recentDiffs?: readonly FileDiffItem[] | undefined;
  readonly testExcerpts?: readonly TestExcerptItem[] | undefined;
  readonly budget?: ContextBudgetConfig | undefined;
  readonly requestMoreContext?: ValidatedRequestMoreContext | undefined;
  readonly existingKnownHashes?: ReadonlySet<string> | undefined;
}

export interface AssembledContextPacket {
  readonly taskId: string;
  readonly round: number;
  readonly baseStateHash: string;
  readonly originalUserGoal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly taskState: string;
  readonly nextExpectedAction?: string | undefined;
  readonly items: readonly ContextCandidateItem[];
  readonly omissionMarkers: readonly OmissionMarker[];
  readonly totalBytes: number;
  readonly approximateTokens: number;
  readonly tokenEstimateLabel: string;
  readonly evidenceProvenance: {
    readonly agentReportedCount: number;
    readonly mediatorObservedCount: number;
    readonly executorVerifiedCount: number;
  };
  readonly generatedAt: number;
  readonly serializedPacket: string;
}

/**
 * Authoritative pipeline to build a compact, budget-enforced, secret-free context packet.
 */
export function assembleContextPacket(
  params: AssembleContextParams,
): AssembledContextPacket {
  const budget = params.budget ?? DEFAULT_BUDGET_CONFIG;
  const rootState = params.rootState;
  const canonicalRoot = rootState.canonicalPath;

  if (!canonicalRoot || !fs.existsSync(canonicalRoot)) {
    throw new ContextEngineError(
      ContextEngineErrorCode.UNSAFE_WORKSPACE_ROOT,
      `Cannot assemble context: canonical workspace root unavailable (${canonicalRoot})`,
    );
  }

  const rawCandidates: ContextCandidateItem[] = [];
  const earlyOmissions: OmissionMarker[] = [];

  // 1. Task Goal and Acceptance Criteria (Top priority: rank 100)
  const goalContent = [
    `Goal: ${params.summary.originalUserGoal}`,
    params.summary.acceptanceCriteria.length > 0
      ? `Acceptance Criteria:\n${params.summary.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`
      : '',
    params.summary.approvedPlan ? `Approved Plan: ${params.summary.approvedPlan}` : '',
    params.summary.nextExpectedAction
      ? `Next Expected Action: ${params.summary.nextExpectedAction}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  rawCandidates.push(
    createCandidateItem({
      itemId: `goal-${params.taskId}`,
      category: 'task_goal_criteria',
      title: 'Current Task Goal and Acceptance Criteria',
      content: goalContent,
      inclusionReason: 'Primary active task objective and criteria',
    }),
  );

  // 2. Approved Project Rules and Decisions (Rank 90)
  if (params.approvedRules) {
    for (const rule of params.approvedRules) {
      if (rule.status === 'approved') {
        rawCandidates.push(
          createCandidateItem({
            itemId: `rule-${rule.ruleId}`,
            category: 'project_rule',
            title: `Project Rule: ${rule.title}`,
            content: rule.content,
            inclusionReason: 'Approved project convention',
            metadata: { authorType: rule.authorType },
          }),
        );
      }
    }
  }

  if (params.approvedDecisions) {
    for (const dec of params.approvedDecisions) {
      if (dec.status === 'approved') {
        rawCandidates.push(
          createCandidateItem({
            itemId: `dec-${dec.decisionId}`,
            category: 'architectural_decision',
            title: `Decision: ${dec.title}`,
            content: `Rationale: ${dec.rationale}`,
            inclusionReason: 'Approved architectural decision',
            metadata: { decisionId: dec.decisionId },
          }),
        );
      }
    }
  }

  // 3. Files involved in task (Rank 80)
  const filesToRead = new Set<string>([
    ...(params.requestedFilePaths ?? []),
    ...(params.summary.filesExamined ?? []),
    ...(params.requestMoreContext?.pathHints ?? []),
  ]);

  for (const relPath of filesToRead) {
    const normRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normRel) continue;

    // S06 Secret Exclusion check
    const exclusion = checkPathExclusion(normRel, MANDATORY_EXCLUSIONS);
    if (exclusion.excluded) {
      earlyOmissions.push({
        itemId: `file-${normRel}`,
        category: 'task_file',
        title: normRel,
        byteSize: 0,
        reason: `Excluded sensitive path: ${exclusion.reason ?? 'secret pattern'}`,
      });
      continue;
    }

    // S05 Path Containment check
    const fullPath = path.resolve(canonicalRoot, normRel);
    const containment = validateContainedPath(rootState, fullPath, {
      operation: 'read',
      mustExist: true,
    });
    if (!containment.ok) {
      earlyOmissions.push({
        itemId: `file-${normRel}`,
        category: 'task_file',
        title: normRel,
        byteSize: 0,
        reason: `Path failed containment: ${containment.error.message}`,
      });
      continue;
    }

    // Read bounded file content
    try {
      const stat = fs.statSync(fullPath);
      const maxFileBytes = budget.maxFileBytes ?? DEFAULT_BUDGET_CONFIG.maxFileBytes!;
      if (stat.size > maxFileBytes) {
        earlyOmissions.push({
          itemId: `file-${normRel}`,
          category: 'task_file',
          title: normRel,
          byteSize: stat.size,
          reason: `File size exceeds individual file budget (${stat.size} > ${maxFileBytes} bytes)`,
        });
        continue;
      }

      let content = fs.readFileSync(fullPath, 'utf8');

      // Secret scanning & redaction
      const scan = scanContent(content);
      if (!scan.ok || shouldBlockContent(scan.value)) {
        earlyOmissions.push({
          itemId: `file-${normRel}`,
          category: 'task_file',
          title: normRel,
          byteSize: stat.size,
          reason: 'File contains recognizable secrets that cannot be safely sent',
        });
        continue;
      }

      content = safeRedactString(content);

      rawCandidates.push(
        createCandidateItem({
          itemId: `file-${normRel}`,
          category: 'task_file',
          title: normRel,
          content: `// File: ${normRel}\n${content}`,
          inclusionReason: 'File referenced in current task state or request',
          metadata: { relativePath: normRel, byteSize: stat.size },
        }),
      );
    } catch (readErr: unknown) {
      earlyOmissions.push({
        itemId: `file-${normRel}`,
        category: 'task_file',
        title: normRel,
        byteSize: 0,
        reason: `File read failed: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
      });
    }
  }

  // 4. Validated Diffs (Rank 70)
  if (params.recentDiffs) {
    for (const diff of params.recentDiffs) {
      const redactedDiff = safeRedactString(diff.diffText);
      rawCandidates.push(
        createCandidateItem({
          itemId: `diff-${diff.filePath}`,
          category: 'validated_diff',
          title: `Diff: ${diff.filePath}`,
          content: redactedDiff,
          inclusionReason: 'Recent validated diff in active task',
        }),
      );
    }
  }

  // 5. Test results and error excerpts (Rank 60)
  if (params.testExcerpts) {
    for (const t of params.testExcerpts) {
      const safeExcerpt = safeRedactString(t.excerpt);
      rawCandidates.push(
        createCandidateItem({
          itemId: `test-${t.command}-${t.exitCode}`,
          category: 'test_result_error',
          title: `Test Error: ${t.command} (exit ${t.exitCode})`,
          content: safeExcerpt,
          inclusionReason: 'Relevant test execution failure excerpt',
        }),
      );
    }
  }

  // 6. Project map summary (Rank 50)
  if (params.projectMap) {
    const summaryLines = [
      `Project: ${params.projectMap.projectName}`,
      `Languages: ${params.projectMap.detectedLanguages.join(', ') || 'None'}`,
      `Frameworks: ${params.projectMap.detectedFrameworks.join(', ') || 'None'}`,
      `Entry Points: ${params.projectMap.entryPoints.slice(0, 5).join(', ') || 'None'}`,
      `Key Configs: ${params.projectMap.configFiles.slice(0, 5).join(', ') || 'None'}`,
      `Test Commands: ${params.projectMap.testCommands.join(', ') || 'None'}`,
    ];
    rawCandidates.push(
      createCandidateItem({
        itemId: `map-summary-${params.projectMap.workspaceId}`,
        category: 'project_map_summary',
        title: 'Project Map Overview',
        content: summaryLines.join('\n'),
        inclusionReason: 'Project overview and detected architecture',
      }),
    );
  }

  // 7. Known Issues & Failed attempts (Rank 40)
  if (params.knownIssues) {
    for (const issue of params.knownIssues) {
      if (issue.status === 'unresolved' || issue.status === 'blocked') {
        const text = [
          `Issue: ${issue.title}`,
          issue.description,
          issue.attemptedFixes.length > 0
            ? `Previously Failed Attempts:\n${issue.attemptedFixes.map((f) => `- ${f}`).join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');

        rawCandidates.push(
          createCandidateItem({
            itemId: `issue-${issue.issueId}`,
            category: 'known_issue',
            title: `Known Issue: ${issue.title}`,
            content: text,
            inclusionReason: 'Unresolved issue to prevent redundant attempts',
          }),
        );
      }
    }
  }

  // 8. Rank and deduplicate
  const ranked = rankAndDeduplicateCandidates(rawCandidates, {
    existingKnownHashes: params.existingKnownHashes,
    alwaysIncludeGoal: true,
  });

  // 9. Enforce budgets and gather omission markers
  const budgetResult = enforceContextBudget(ranked, budget);
  const allOmissions = [...earlyOmissions, ...budgetResult.omissionMarkers];

  // 10. Compute base state hash
  const baseStateHash = crypto
    .createHash('sha256')
    .update(
      budgetResult.selectedItems.map((i) => `${i.itemId}:${i.contentHash}`).join('|'),
      'utf8',
    )
    .digest('hex');

  // 11. Format final serialized packet
  const packetStructure = {
    taskId: params.taskId,
    round: params.summary.latestAcceptedRound,
    baseStateHash,
    taskState: params.summary.taskState,
    originalUserGoal: params.summary.originalUserGoal,
    acceptanceCriteria: params.summary.acceptanceCriteria,
    nextExpectedAction: params.summary.nextExpectedAction,
    contextItems: budgetResult.selectedItems.map((i) => ({
      itemId: i.itemId,
      category: i.category,
      title: i.title,
      content: i.content,
      inclusionReason: i.inclusionReason,
      contentHash: i.contentHash,
    })),
    omissions: allOmissions.map((o) => ({
      item: o.title,
      reason: o.reason,
    })),
    budgetMetrics: {
      totalBytes: budgetResult.totalBytes,
      approximateTokens: budgetResult.approximateTokens,
      tokenEstimateLabel: budgetResult.tokenEstimateLabel,
    },
    evidenceProvenance: {
      agentReportedCount: params.summary.evidence.agentReported.length,
      mediatorObservedCount: params.summary.evidence.mediatorObserved.length,
      executorVerifiedCount: params.summary.evidence.executorVerified.length,
    },
  };

  const serializedPacket = JSON.stringify(packetStructure, null, 2);

  return {
    taskId: params.taskId,
    round: params.summary.latestAcceptedRound,
    baseStateHash,
    originalUserGoal: params.summary.originalUserGoal,
    acceptanceCriteria: params.summary.acceptanceCriteria,
    taskState: params.summary.taskState,
    nextExpectedAction: params.summary.nextExpectedAction,
    items: budgetResult.selectedItems,
    omissionMarkers: allOmissions,
    totalBytes: budgetResult.totalBytes,
    approximateTokens: budgetResult.approximateTokens,
    tokenEstimateLabel: budgetResult.tokenEstimateLabel,
    evidenceProvenance: packetStructure.evidenceProvenance,
    generatedAt: Date.now(),
    serializedPacket,
  };
}
