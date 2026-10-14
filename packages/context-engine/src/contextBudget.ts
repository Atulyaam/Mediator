/**
 * @mediator/context-engine — Context Budget & Token Estimation (S11)
 *
 * Requirements:
 * - Enforce byte limits using actual serialized UTF-8 byte length (Buffer.byteLength).
 * - Clearly labelled approximate token estimates (no claim of exact token counts).
 * - Configurable budgets for individual files, excerpts, and total context size.
 * - Records omission markers with clear reasons when items cannot fit.
 * - Returns typed error BUDGET_EXCEEDED instead of silently truncating structural data.
 */

import { ContextEngineError, ContextEngineErrorCode } from './errors.js';
import { type ContextCandidateItem } from './contextRanker.js';

export interface ContextBudgetConfig {
  readonly maxTotalBytes: number;
  readonly maxFileBytes?: number | undefined;
  readonly maxExcerptBytes?: number | undefined;
  readonly profileName?: string | undefined;
}

export const DEFAULT_BUDGET_CONFIG: ContextBudgetConfig = {
  maxTotalBytes: 32 * 1024, // 32 KB default conservative packet
  maxFileBytes: 8 * 1024, // 8 KB per file
  maxExcerptBytes: 2 * 1024, // 2 KB per excerpt
  profileName: 'default-conservative',
};

export const PROVIDER_BUDGET_PROFILES: Record<string, ContextBudgetConfig> = {
  'gemini-flash': {
    maxTotalBytes: 64 * 1024,
    maxFileBytes: 16 * 1024,
    maxExcerptBytes: 4 * 1024,
    profileName: 'gemini-flash',
  },
  'gemini-pro': {
    maxTotalBytes: 128 * 1024,
    maxFileBytes: 32 * 1024,
    maxExcerptBytes: 8 * 1024,
    profileName: 'gemini-pro',
  },
  claude: {
    maxTotalBytes: 64 * 1024,
    maxFileBytes: 16 * 1024,
    maxExcerptBytes: 4 * 1024,
    profileName: 'claude',
  },
};

export interface OmissionMarker {
  readonly itemId: string;
  readonly category: string;
  readonly title: string;
  readonly byteSize: number;
  readonly reason: string;
}

export interface BudgetEnforcementResult {
  readonly selectedItems: readonly ContextCandidateItem[];
  readonly omissionMarkers: readonly OmissionMarker[];
  readonly totalBytes: number;
  readonly approximateTokens: number;
  readonly tokenEstimateLabel: string;
}

export const TOKEN_ESTIMATE_METHOD_LABEL =
  'heuristic_approximate_chars_per_token (not exact tokenizer)';

/**
 * Computes approximate token count from UTF-8 byte length with clear labelling.
 */
export function estimateApproximateTokens(utf8ByteLength: number): {
  approximateTokens: number;
  methodLabel: string;
} {
  // Conservative estimate: ~4 bytes per token for standard English / code
  const tokens = Math.max(1, Math.ceil(utf8ByteLength / 4));
  return {
    approximateTokens: tokens,
    methodLabel: TOKEN_ESTIMATE_METHOD_LABEL,
  };
}

/**
 * Enforce budget limits across ranked candidates.
 */
export function enforceContextBudget(
  rankedCandidates: readonly ContextCandidateItem[],
  budget: ContextBudgetConfig = DEFAULT_BUDGET_CONFIG,
): BudgetEnforcementResult {
  if (budget.maxTotalBytes <= 0) {
    throw new ContextEngineError(
      ContextEngineErrorCode.BUDGET_EXCEEDED,
      'Configured total byte budget must be greater than zero',
      { detail: { budget } },
    );
  }

  const selected: ContextCandidateItem[] = [];
  const omissions: OmissionMarker[] = [];
  let accumulatedBytes = 0;

  const maxFileBytes = budget.maxFileBytes ?? DEFAULT_BUDGET_CONFIG.maxFileBytes!;
  const maxExcerptBytes =
    budget.maxExcerptBytes ?? DEFAULT_BUDGET_CONFIG.maxExcerptBytes!;

  for (const item of rankedCandidates) {
    // Check item-level budgets
    if (item.category === 'task_file' && item.byteSize > maxFileBytes) {
      omissions.push({
        itemId: item.itemId,
        category: item.category,
        title: item.title,
        byteSize: item.byteSize,
        reason: `Exceeded per-file byte limit (${item.byteSize} > ${maxFileBytes} bytes)`,
      });
      continue;
    }

    if (
      (item.category === 'validated_diff' || item.category === 'test_result_error') &&
      item.byteSize > maxExcerptBytes
    ) {
      omissions.push({
        itemId: item.itemId,
        category: item.category,
        title: item.title,
        byteSize: item.byteSize,
        reason: `Exceeded per-excerpt byte limit (${item.byteSize} > ${maxExcerptBytes} bytes)`,
      });
      continue;
    }

    // Check total budget
    if (accumulatedBytes + item.byteSize > budget.maxTotalBytes) {
      // If the very highest priority item (task_goal_criteria) cannot fit in total budget, fail closed!
      if (item.category === 'task_goal_criteria' && selected.length === 0) {
        throw new ContextEngineError(
          ContextEngineErrorCode.BUDGET_EXCEEDED,
          `Cannot fit essential task goal within configured total byte budget (${item.byteSize} > ${budget.maxTotalBytes} bytes)`,
          {
            detail: {
              requiredBytes: item.byteSize,
              maxTotalBytes: budget.maxTotalBytes,
              itemTitle: item.title,
            },
          },
        );
      }

      omissions.push({
        itemId: item.itemId,
        category: item.category,
        title: item.title,
        byteSize: item.byteSize,
        reason: `Exceeded remaining total context budget (${accumulatedBytes + item.byteSize} > ${budget.maxTotalBytes} bytes)`,
      });
      continue;
    }

    selected.push(item);
    accumulatedBytes += item.byteSize;
  }

  const { approximateTokens, methodLabel } =
    estimateApproximateTokens(accumulatedBytes);

  return {
    selectedItems: selected,
    omissionMarkers: omissions,
    totalBytes: accumulatedBytes,
    approximateTokens,
    tokenEstimateLabel: methodLabel,
  };
}
