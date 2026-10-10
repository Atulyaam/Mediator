/**
 * @mediator/content-transfer — Content Transfer Pipeline (S09)
 *
 * Enforces the end-to-end invariant:
 *   raw response → envelope validation → bounded transfer → length/hash verification → complete proposal
 *
 * Invariant: No proposal reaches the staging layer before every required validation succeeds.
 */

import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
} from '@mediator/shared-contracts';
import {
  type ProtocolValidator,
  type CanonicalEnvelope,
} from '@mediator/protocol';
import { type PolicyEvaluationContext, type PolicyDecision } from '@mediator/policy-engine';
import {
  type ParsedContentBlock,
  type TransferLimits,
  DEFAULT_TRANSFER_LIMITS,
} from './transferTypes.js';
import { parseFramedPayload } from './contentBlockParser.js';

export interface ValidatedProposal {
  readonly envelope: CanonicalEnvelope;
  readonly blocks: readonly ParsedContentBlock[];
  readonly policyDecisions: readonly PolicyDecision[];
  readonly readyForStaging: boolean;
}

export class ContentTransferPipeline {
  private readonly protocolValidator: ProtocolValidator;
  private readonly limits: TransferLimits;

  constructor(
    protocolValidator: ProtocolValidator,
    limits: TransferLimits = DEFAULT_TRANSFER_LIMITS,
  ) {
    this.protocolValidator = protocolValidator;
    this.limits = limits;
  }

  /**
   * Processes a raw provider response through the complete pipeline:
   * 1. Extracts manifest and framed body blocks.
   * 2. Validates protocol envelope schema, replay guard, and S08 session binding.
   * 3. Validates exact byte length and SHA-256 checksums of each framed block.
   * 4. Evaluates actions through S07 policy engine.
   * 5. Returns completed proposal only if all stages succeed.
   */
  public processRawResponse(
    rawResponse: string,
    policyContext: PolicyEvaluationContext,
  ): Result<ValidatedProposal, MediatorError> {
    // Stage 1: Frame parsing & integrity extraction
    const frameResult = parseFramedPayload(rawResponse, this.limits);
    if (!frameResult.ok) {
      return err(frameResult.error);
    }

    const { manifestJson, blocks } = frameResult.value;

    // Stage 2: Protocol envelope & replay protection (S08)
    const envelopeResult = this.protocolValidator.validate(manifestJson, policyContext, {
      consumeOnSuccess: false, // commit only after content blocks also pass!
    });
    if (!envelopeResult.ok) {
      return err(envelopeResult.error);
    }

    const { envelope, policyDecisions } = envelopeResult.value;

    // Stage 3: Content-block cross-verification against envelope manifest
    // Map extracted blocks by block ID
    const extractedBlocksMap = new Map<string, ParsedContentBlock>();
    for (const b of blocks) {
      extractedBlocksMap.set(b.blockId, b);
    }

    // Check all actions proposing patches or carrying content blocks
    for (const action of envelope.actions) {
      const blockId = (action.contentBlockId ?? action.content_block_id ?? action.blockId ?? action.block_id) as string | undefined;
      if (blockId) {
        if (!extractedBlocksMap.has(blockId)) {
          return err(
            makeMediatorError(
              ErrorCode.CONTENT_BLOCK_MISSING,
              `Action '${action.id}' references content block '${blockId}', but no framed block body was found in the payload.`,
              { actionId: action.id },
            ),
          );
        }
      }
    }

    // Stage 4: Commit envelope state in replay guard now that both envelope and bodies are verified
    this.protocolValidator.getReplayGuard().consumeEnvelope(envelope);

    return ok({
      envelope,
      blocks,
      policyDecisions,
      readyForStaging: true,
    });
  }
}
