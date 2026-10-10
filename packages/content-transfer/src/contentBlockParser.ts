/**
 * @mediator/content-transfer — Content Block Parser (S09)
 *
 * Requirements:
 * - Parses manifest-plus-body framing format.
 * - Exact UTF-8 byte length verification.
 * - Exact SHA-256 cryptographic checksum verification.
 * - Never trims, normalizes, or alters source content before validation.
 * - Rejects truncated, oversized, missing, or delimiter-colliding blocks.
 * - Returns bounded, sanitized error diagnostics without echoing source code or secrets.
 */

import { createHash } from 'crypto';
import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
} from '@mediator/shared-contracts';
import {
  type ContentBlockManifest,
  type ParsedContentBlock,
  type TransferLimits,
  DEFAULT_TRANSFER_LIMITS,
} from './transferTypes.js';

export function normalizeSha256(hash: string): string {
  const clean = hash.trim().toLowerCase();
  return clean.startsWith('sha256:') ? clean.slice(7) : clean;
}

export function computeSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Validates a raw content block's byte length and cryptographic checksum against its manifest.
 * Guarantees zero normalization or silent trimming.
 */
export function validateBlockIntegrity(
  manifest: ContentBlockManifest,
  rawContent: string,
  limits: TransferLimits = DEFAULT_TRANSFER_LIMITS,
): Result<ParsedContentBlock, MediatorError> {
  // 1. Strict encoding check
  const encodingStr = String(manifest.encoding);
  if (encodingStr !== 'utf-8') {
    return err(
      makeMediatorError(
        ErrorCode.SCHEMA_INVALID,
        `Unsupported encoding '${encodingStr}'. Only 'utf-8' is supported.`,
        { actionId: manifest.actionId },
      ),
    );
  }

  // 2. Exact byte length verification (never string.length which counts UTF-16 code units)
  const actualBytes = Buffer.byteLength(rawContent, 'utf8');

  // Enforce size limits
  if (actualBytes > limits.maxBlockBytes) {
    return err(
      makeMediatorError(
        ErrorCode.OVERSIZED_INPUT,
        `Block '${manifest.blockId}' exceeds maximum allowed size of ${limits.maxBlockBytes} bytes (actual: ${actualBytes} bytes).`,
        {
          actionId: manifest.actionId,
          detail: { blockId: manifest.blockId, actualBytes, maxAllowed: limits.maxBlockBytes },
        },
      ),
    );
  }

  if (actualBytes !== manifest.byteLength) {
    return err(
      makeMediatorError(
        ErrorCode.TRANSFER_INCOMPLETE,
        `Block '${manifest.blockId}' byte length mismatch: declared ${manifest.byteLength} bytes, actual ${actualBytes} bytes.`,
        {
          actionId: manifest.actionId,
          detail: { blockId: manifest.blockId, declaredBytes: manifest.byteLength, actualBytes },
        },
      ),
    );
  }

  // 3. Cryptographic hash verification (SHA-256)
  const actualHash = computeSha256(rawContent);
  const expectedHash = normalizeSha256(manifest.sha256);

  if (actualHash !== expectedHash) {
    return err(
      makeMediatorError(
        ErrorCode.TRANSFER_HASH_MISMATCH,
        `Block '${manifest.blockId}' checksum mismatch. Cryptographic verification failed.`,
        {
          actionId: manifest.actionId,
          detail: {
            blockId: manifest.blockId,
            declaredHash: expectedHash.slice(0, 16) + '...',
            actualHash: actualHash.slice(0, 16) + '...',
          },
        },
      ),
    );
  }

  return ok({
    transferId: manifest.transferId,
    blockId: manifest.blockId,
    actionId: manifest.actionId,
    path: manifest.path,
    encoding: 'utf-8',
    byteLength: actualBytes,
    sha256: actualHash,
    content: rawContent,
  });
}

/**
 * Parses a combined wire payload containing both manifest and framed content blocks.
 * Wire syntax:
 * <<<MEDIATOR_PLAN>>>
 * { manifest JSON }
 * <<<END_MEDIATOR_PLAN>>>
 * <<<MEDIATOR_FILE id="..." bytes="..." sha256="..." (action_id="..." transfer_id="..." path="...")>>>
 * content
 * <<<END_MEDIATOR_FILE_<id>|END_FILE>>>
 */
export function parseFramedPayload(
  rawPayload: string,
  limits: TransferLimits = DEFAULT_TRANSFER_LIMITS,
): Result<{ manifestJson: string; blocks: ParsedContentBlock[] }, MediatorError> {
  if (typeof rawPayload !== 'string') {
    return err(
      makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Payload must be a string'),
    );
  }

  const totalBytes = Buffer.byteLength(rawPayload, 'utf8');
  if (totalBytes > limits.maxTotalTransferBytes) {
    return err(
      makeMediatorError(
        ErrorCode.OVERSIZED_INPUT,
        `Total payload exceeds maximum size of ${limits.maxTotalTransferBytes} bytes (actual: ${totalBytes} bytes).`,
      ),
    );
  }

  // 1. Extract manifest section
  const planStartTag = '<<<MEDIATOR_PLAN>>>';
  const planEndTag = '<<<END_MEDIATOR_PLAN>>>';

  let manifestJson = '';
  let remainingPayload = rawPayload;

  const planStartIndex = rawPayload.indexOf(planStartTag);
  if (planStartIndex !== -1) {
    const planEndIndex = rawPayload.indexOf(planEndTag, planStartIndex + planStartTag.length);
    if (planEndIndex === -1) {
      return err(
        makeMediatorError(
          ErrorCode.TRANSFER_INCOMPLETE,
          'Framing error: <<<MEDIATOR_PLAN>>> start tag found without corresponding <<<END_MEDIATOR_PLAN>>> closing delimiter.',
        ),
      );
    }

    manifestJson = rawPayload.slice(planStartIndex + planStartTag.length, planEndIndex).trim();
    remainingPayload = rawPayload.slice(planEndIndex + planEndTag.length);
  } else {
    // If not using plan tags, check if the start of the payload is pure JSON
    // up until the first <<<MEDIATOR_FILE or delimiter
    const firstBlockIndex = rawPayload.indexOf('<<<MEDIATOR_FILE');
    if (firstBlockIndex !== -1) {
      manifestJson = rawPayload.slice(0, firstBlockIndex).trim();
      remainingPayload = rawPayload.slice(firstBlockIndex);
    } else {
      manifestJson = rawPayload.trim();
      remainingPayload = '';
    }
  }

  if (Buffer.byteLength(manifestJson, 'utf8') > limits.maxManifestBytes) {
    return err(
      makeMediatorError(
        ErrorCode.OVERSIZED_INPUT,
        `Manifest exceeds maximum allowed size of ${limits.maxManifestBytes} bytes.`,
      ),
    );
  }

  // 2. Extract and validate content blocks
  const blocks: ParsedContentBlock[] = [];
  const fileHeaderRegex = /<<<MEDIATOR_FILE\s+([^>]+)>>>/g;

  let match: RegExpExecArray | null;
  const headerMatches: Array<{ index: number; end: number; attrs: string }> = [];

  while ((match = fileHeaderRegex.exec(remainingPayload)) !== null) {
    headerMatches.push({
      index: match.index,
      end: match.index + match[0].length,
      attrs: match[1] ?? '',
    });
  }

  if (headerMatches.length > limits.maxBlocks) {
    return err(
      makeMediatorError(
        ErrorCode.OVERSIZED_INPUT,
        `Too many content blocks: ${headerMatches.length} exceeds limit of ${limits.maxBlocks}.`,
      ),
    );
  }

  for (let i = 0; i < headerMatches.length; i++) {
    const currentHeader = headerMatches[i];
    if (!currentHeader) continue;

    // Parse attributes: id="..." bytes="..." sha256="..." action_id="..." transfer_id="..."
    const attrRegex = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
    const attrs: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(currentHeader.attrs)) !== null) {
      const key = attrMatch[1];
      const val = attrMatch[2];
      if (key && val !== undefined) {
        attrs[key.toLowerCase()] = val;
      }
    }

    const blockId = attrs.id ?? attrs.block_id ?? attrs.blockid;
    if (!blockId) {
      return err(
        makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Missing required block id attribute in <<<MEDIATOR_FILE>>>'),
      );
    }

    const rawBytes = attrs.bytes ?? attrs.byte_length ?? attrs.bytelength;
    if (!rawBytes || isNaN(Number(rawBytes))) {
      return err(
        makeMediatorError(ErrorCode.SCHEMA_INVALID, `Missing or invalid bytes attribute in block '${blockId}'`),
      );
    }
    const byteLength = Number(rawBytes);

    const sha256 = attrs.sha256 ?? attrs.hash;
    if (!sha256) {
      return err(
        makeMediatorError(ErrorCode.SCHEMA_INVALID, `Missing sha256 attribute in block '${blockId}'`),
      );
    }

    const actionId = attrs.action_id ?? attrs.actionid ?? blockId;
    const transferId = attrs.transfer_id ?? attrs.transferid ?? 'transfer_default';
    const path = attrs.path;
    const customEndDelimiter = attrs.delimiter ?? `END_MEDIATOR_FILE_${blockId}`;

    // Find the end tag: either custom delimiter or standard <<<END_MEDIATOR_FILE...>>>
    const bodyStart = currentHeader.end;
    // Strip leading newline immediately following the header if present, or maintain exact
    let adjustedStart = bodyStart;
    if (remainingPayload[adjustedStart] === '\r' && remainingPayload[adjustedStart + 1] === '\n') {
      adjustedStart += 2;
    } else if (remainingPayload[adjustedStart] === '\n') {
      adjustedStart += 1;
    }

    // Determine end of this block
    const endDelimiters = [
      `<<<${customEndDelimiter}>>>`,
      `<<<END_MEDIATOR_FILE_${blockId}>>>`,
      '<<<END_MEDIATOR_FILE>>>',
    ];

    let bodyEnd = -1;
    for (const del of endDelimiters) {
      const foundIdx = remainingPayload.indexOf(del, adjustedStart);
      if (foundIdx !== -1 && (bodyEnd === -1 || foundIdx < bodyEnd)) {
        bodyEnd = foundIdx;
      }
    }

    if (bodyEnd === -1) {
      return err(
        makeMediatorError(
          ErrorCode.TRANSFER_INCOMPLETE,
          `Framing error: Closing delimiter for block '${blockId}' not found. Truncated transfer.`,
        ),
      );
    }

    // Extract body content between header and closing delimiter
    let rawBlockContent = remainingPayload.slice(adjustedStart, bodyEnd);

    // If the slice does not match declared byteLength, check if an optional trailing framing newline was added before delimiter
    if (Buffer.byteLength(rawBlockContent, 'utf8') !== byteLength) {
      if (rawBlockContent.endsWith('\r\n')) {
        const candidate = rawBlockContent.slice(0, -2);
        if (Buffer.byteLength(candidate, 'utf8') === byteLength) {
          rawBlockContent = candidate;
        }
      } else if (rawBlockContent.endsWith('\n')) {
        const candidate = rawBlockContent.slice(0, -1);
        if (Buffer.byteLength(candidate, 'utf8') === byteLength) {
          rawBlockContent = candidate;
        }
      }
    }

    const manifest: ContentBlockManifest = {
      transferId,
      blockId,
      actionId,
      path,
      encoding: 'utf-8',
      byteLength,
      sha256,
      delimiter: customEndDelimiter,
    };

    // Validate byte length and cryptographic hash
    const blockValidation = validateBlockIntegrity(manifest, rawBlockContent, limits);
    if (!blockValidation.ok) {
      return err(blockValidation.error);
    }

    blocks.push(blockValidation.value);
  }

  return ok({ manifestJson, blocks });
}
