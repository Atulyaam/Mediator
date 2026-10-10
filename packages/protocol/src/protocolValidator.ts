/**
 * @mediator/protocol — Authoritative Protocol Validator (S08)
 *
 * Core Responsibility:
 * Accept only structurally valid proposals bound to the currently attached task,
 * session, provider conversation, and expected sequence.
 *
 * Critical Invariants:
 * - AI output remains untrusted even when it contains a valid nonce.
 * - A nonce is not authorization to execute an action; every proposed action must still pass S07 policy.
 * - The protocol validator may reject an action but must NEVER grant permissions.
 * - Validation failures do not mutate state in a way that allows replays to bypass checks.
 * - Review-only mode continues to deny automatic execution.
 * - Missing sandbox capability continues to block run_recipe.
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
  evaluateAction,
  type PolicyDecision,
  type PolicyEvaluationContext,
  type PolicyConfig,
  type ActionRequest,
  type CanonicalActionIdValue,
} from '@mediator/policy-engine';
import {
  parseAndValidateEnvelope,
  type CanonicalEnvelope,
} from './envelopeTypes.js';
import { ReplayGuard } from './replayGuard.js';

export interface EnvelopeValidationResult {
  readonly envelope: CanonicalEnvelope;
  readonly policyDecisions: readonly PolicyDecision[];
  readonly allActionsAllowed: boolean;
  readonly requiresApproval: boolean;
  readonly hasDenials: boolean;
}

export interface ProtocolValidationOptions {
  readonly replayGuard: ReplayGuard;
  readonly policyContext: PolicyEvaluationContext;
  readonly policyConfig?: Partial<PolicyConfig>;
  readonly consumeOnSuccess?: boolean;
}

export class ProtocolValidator {
  private readonly replayGuard: ReplayGuard;

  constructor(replayGuard: ReplayGuard) {
    this.replayGuard = replayGuard;
  }

  public getReplayGuard(): ReplayGuard {
    return this.replayGuard;
  }

  /**
   * Validate a raw wire payload against protocol schema, replay guard, and policy evaluator.
   */
  public validate(
    rawPayload: unknown,
    policyContext: PolicyEvaluationContext,
    options?: {
      policyConfig?: Partial<PolicyConfig>;
      consumeOnSuccess?: boolean;
    },
  ): Result<EnvelopeValidationResult, MediatorError> {
    // 1. Parse JSON string if needed
    let parsedInput: unknown = rawPayload;
    if (typeof rawPayload === 'string') {
      try {
        parsedInput = JSON.parse(rawPayload);
      } catch (jsonErr) {
        return err(
          makeMediatorError(
            ErrorCode.SCHEMA_INVALID,
            'Protocol payload is not valid JSON',
            { detail: { error: String(jsonErr) } },
          ),
        );
      }
    }

    // 2. Validate wire envelope structure & canonical fields
    const envelopeResult = parseAndValidateEnvelope(parsedInput);
    if (!envelopeResult.ok) {
      return err(envelopeResult.error);
    }
    const envelope = envelopeResult.value;

    // 3. Replay protection, session binding, sequence & nonce validation
    const replayResult = this.replayGuard.validateEnvelope(envelope);
    if (!replayResult.ok) {
      return err(replayResult.error);
    }

    // 4. Policy Engine Action Authorization
    // Evaluate each proposed action through authoritative pure evaluateAction()
    const policyDecisions: PolicyDecision[] = [];
    let allActionsAllowed = true;
    let requiresApproval = false;
    let hasDenials = false;

    for (const action of envelope.actions) {
      const flatParams: Record<string, unknown> = { ...action };
      delete flatParams.id;
      delete flatParams.type;
      delete flatParams.parameters;

      const nested = (typeof action.parameters === 'object' && action.parameters !== null)
        ? action.parameters
        : {};

      const mergedParams: Record<string, unknown> = {
        taskId: envelope.taskId,
        ...flatParams,
        ...nested,
      };

      const actionRequest: ActionRequest<Record<string, unknown>> = {
        actionId: action.type as CanonicalActionIdValue,
        correlationId: `${envelope.taskId}:${envelope.round}:${action.id}`,
        caller: {
          type: 'agent',
          id: envelope.providerId,
          isTrustedUI: false,
        },
        parameters: mergedParams,
      };

      const decision = evaluateAction(
        actionRequest,
        policyContext,
        options?.policyConfig,
      );

      policyDecisions.push(decision);

      if (decision.decision === 'DENY' || decision.decision === 'UNSUPPORTED') {
        allActionsAllowed = false;
        hasDenials = true;
      } else if (decision.decision === 'REQUIRE_APPROVAL') {
        allActionsAllowed = false;
        requiresApproval = true;
      }
    }

    // 5. Consume envelope state if requested (only upon full validation success)
    if (options?.consumeOnSuccess !== false) {
      this.replayGuard.consumeEnvelope(envelope);
    }

    return ok({
      envelope,
      policyDecisions,
      allActionsAllowed,
      requiresApproval,
      hasDenials,
    });
  }
}
