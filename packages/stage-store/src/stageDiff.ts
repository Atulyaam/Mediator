/**
 * @mediator/stage-store — Safe Diff Generation (S12)
 *
 * Requirements:
 * - Generates structured diffs comparing captured source snapshot with staged content.
 * - Operates entirely in memory; never modifies live workspace files to compute diffs.
 * - Bounds diff line counts and serialized byte sizes.
 * - Detects binary files and produces safe metadata-only previews.
 * - Accurately reflects change type: add, modify, delete-proposed, rename-proposed.
 */

import {
  type StagedFileRecord,
  type StageDiffPreview,
  type StageDiffStats,
} from './stageTypes.js';

export const MAX_DIFF_LINES = 500;
export const MAX_DIFF_BYTES = 64 * 1024; // 64 KB

export function isBinaryContent(buffer: Buffer): boolean {
  // Check for null bytes in the first 8000 bytes
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function generateDiffPreview(
  stagedFile: StagedFileRecord,
  baseBuffer: Buffer | null,
  stagedBuffer: Buffer | null,
): StageDiffPreview {
  const {
    relativePath,
    changeType,
    baseContentHash,
    stagedContentHash,
    isProtected,
    policyDecision,
    conflictStatus,
    conflictReason,
    requiresManualReview,
    targetPath,
  } = stagedFile;

  // Check binary status
  const isBaseBinary = baseBuffer ? isBinaryContent(baseBuffer) : false;
  const isStagedBinary = stagedBuffer ? isBinaryContent(stagedBuffer) : false;
  const isBinary = isBaseBinary || isStagedBinary || stagedFile.encoding === 'binary';

  if (isBinary) {
    return {
      relativePath,
      changeType,
      stats: { additions: 0, deletions: 0, modifications: 0 },
      diffText: `[Binary file: diff preview unavailable for '${relativePath}']`,
      baseHash: baseContentHash,
      stagedHash: stagedContentHash,
      isProtected,
      policyDecision,
      conflictStatus,
      conflictReason,
      requiresManualReview,
      isBinary: true,
    };
  }

  const baseText = baseBuffer ? baseBuffer.toString('utf8') : '';
  const stagedText = stagedBuffer ? stagedBuffer.toString('utf8') : '';

  const { diffText, stats } = buildTextDiff(relativePath, changeType, baseText, stagedText, targetPath);

  return {
    relativePath,
    changeType,
    stats,
    diffText,
    baseHash: baseContentHash,
    stagedHash: stagedContentHash,
    isProtected,
    policyDecision,
    conflictStatus,
    conflictReason,
    requiresManualReview,
    isBinary: false,
  };
}

function buildTextDiff(
  filePath: string,
  changeType: string,
  baseText: string,
  stagedText: string,
  targetPath?: string | undefined,
): { diffText: string; stats: StageDiffStats } {
  const cleanBase = baseText.replace(/\r?\n$/, '');
  const cleanStaged = stagedText.replace(/\r?\n$/, '');
  const baseLines = cleanBase.length > 0 ? cleanBase.split(/\r?\n/) : [];
  const stagedLines = cleanStaged.length > 0 ? cleanStaged.split(/\r?\n/) : [];

  let header = `--- a/${filePath}\n+++ b/${filePath}\n`;
  if (changeType === 'rename-proposed' && targetPath) {
    header = `rename from ${filePath}\nrename to ${targetPath}\n--- a/${filePath}\n+++ b/${targetPath}\n`;
  } else if (changeType === 'add') {
    header = `--- /dev/null\n+++ b/${filePath}\n`;
  } else if (changeType === 'delete-proposed') {
    header = `--- a/${filePath}\n+++ /dev/null\n`;
  }

  // Simple line-based unified diff algorithm
  const lines: string[] = [];
  let additions = 0;
  let deletions = 0;

  if (changeType === 'add') {
    for (const l of stagedLines) {
      lines.push(`+${l}`);
      additions++;
    }
  } else if (changeType === 'delete-proposed') {
    for (const l of baseLines) {
      lines.push(`-${l}`);
      deletions++;
    }
  } else {
    // Basic Myers / line diff approximation for unified preview
    let i = 0;
    let j = 0;

    while (i < baseLines.length || j < stagedLines.length) {
      const baseLine = baseLines[i];
      const stagedLine = stagedLines[j];

      if (baseLine !== undefined && stagedLine !== undefined && baseLine === stagedLine) {
        lines.push(` ${baseLine}`);
        i++;
        j++;
      } else if (stagedLine !== undefined && (baseLine === undefined || !baseLines.slice(i).includes(stagedLine))) {
        lines.push(`+${stagedLine}`);
        additions++;
        j++;
      } else if (baseLine !== undefined) {
        lines.push(`-${baseLine}`);
        deletions++;
        i++;
      } else {
        break;
      }
    }
  }

  const modifications = Math.min(additions, deletions);

  // Apply bounds
  let truncated = false;
  let boundedLines = lines;
  if (boundedLines.length > MAX_DIFF_LINES) {
    boundedLines = boundedLines.slice(0, MAX_DIFF_LINES);
    truncated = true;
  }

  let fullDiff = header + boundedLines.join('\n');
  if (Buffer.byteLength(fullDiff, 'utf8') > MAX_DIFF_BYTES) {
    fullDiff = fullDiff.substring(0, MAX_DIFF_BYTES);
    truncated = true;
  }

  if (truncated) {
    fullDiff += '\n[Diff truncated: exceeded maximum preview limit]';
  }

  return {
    diffText: fullDiff,
    stats: { additions, deletions, modifications },
  };
}
