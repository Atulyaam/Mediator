/**
 * @mediator/context-engine — Deterministic Relevance Ranker (S11)
 *
 * Requirements:
 * - Deterministic context-selection strategy.
 * - Strict ranking order:
 *   1. Task goal and acceptance criteria (rank 100)
 *   2. Relevant project rules and approved decisions (rank 90)
 *   3. Files involved in current task (rank 80)
 *   4. Recent validated changes and diffs (rank 70)
 *   5. Relevant test results and exact error excerpts (rank 60)
 *   6. Related project-map entries (rank 50)
 *   7. Older known issues or background details (rank 40)
 * - Each item includes a clear inclusionReason.
 * - Deduplication via contentHash.
 * - Eliminates unchanged or redundant low-value items.
 */

import * as crypto from 'node:crypto';

export type CandidateCategory =
  | 'task_goal_criteria'
  | 'project_rule'
  | 'architectural_decision'
  | 'task_file'
  | 'validated_diff'
  | 'test_result_error'
  | 'project_map_summary'
  | 'known_issue';

export const PRIORITY_RANKS: Record<CandidateCategory, number> = {
  task_goal_criteria: 100,
  project_rule: 90,
  architectural_decision: 90,
  task_file: 80,
  validated_diff: 70,
  test_result_error: 60,
  project_map_summary: 50,
  known_issue: 40,
};

export interface ContextCandidateItem {
  readonly itemId: string;
  readonly category: CandidateCategory;
  readonly title: string;
  readonly content: string;
  readonly contentHash: string;
  readonly priorityRank: number;
  readonly inclusionReason: string;
  readonly byteSize: number;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface CreateCandidateParams {
  readonly itemId: string;
  readonly category: CandidateCategory;
  readonly title: string;
  readonly content: string;
  readonly inclusionReason: string;
  readonly contentHash?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export function createCandidateItem(params: CreateCandidateParams): ContextCandidateItem {
  const content = params.content;
  const contentHash =
    params.contentHash ||
    crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  const byteSize = Buffer.byteLength(content, 'utf8');

  return {
    itemId: params.itemId,
    category: params.category,
    title: params.title,
    content,
    contentHash,
    priorityRank: PRIORITY_RANKS[params.category],
    inclusionReason: params.inclusionReason,
    byteSize,
    metadata: params.metadata,
  };
}

export interface RankOptions {
  /** Optional set of contentHashes already known to the recipient/session to eliminate unchanged items */
  readonly existingKnownHashes?: ReadonlySet<string> | undefined;
  /** Force retain task goal even if hash matches previous round */
  readonly alwaysIncludeGoal?: boolean | undefined;
}

/**
 * Deterministically rank and deduplicate candidates.
 */
export function rankAndDeduplicateCandidates(
  candidates: readonly ContextCandidateItem[],
  options?: RankOptions,
): ContextCandidateItem[] {
  const seenHashes = new Set<string>();
  const seenItemIds = new Set<string>();
  const filtered: ContextCandidateItem[] = [];

  for (const item of candidates) {
    // Deduplicate by itemId
    if (seenItemIds.has(item.itemId)) {
      continue;
    }

    // Deduplicate identical content by contentHash
    if (seenHashes.has(item.contentHash)) {
      continue;
    }

    // Check if unchanged item is already known by provider conversation
    if (
      options?.existingKnownHashes?.has(item.contentHash) &&
      !(options.alwaysIncludeGoal && item.category === 'task_goal_criteria')
    ) {
      continue;
    }

    seenItemIds.add(item.itemId);
    seenHashes.add(item.contentHash);
    filtered.push(item);
  }

  // Deterministic sort: priorityRank descending, then itemId ascending
  return filtered.sort((a, b) => {
    if (b.priorityRank !== a.priorityRank) {
      return b.priorityRank - a.priorityRank;
    }
    return a.itemId.localeCompare(b.itemId);
  });
}
