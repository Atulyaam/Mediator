/**
 * @mediator/policy-engine — Policy Errors (S07)
 *
 * Provides factory functions for creating typed MediatorError objects
 * from policy evaluation results.
 *
 * Security invariant: Error messages and details NEVER contain raw secrets,
 * command injections, or unfiltered sensitive content.
 */

import {
  type MediatorError,
  ErrorCode,
  type ErrorCodeValue,
  makeMediatorError,
} from '@mediator/shared-contracts';
import { type PolicyDecision, PolicyReasonCode } from './policyTypes.js';

export function mapReasonCodeToErrorCode(reasonCode: PolicyReasonCode): ErrorCodeValue {
  switch (reasonCode) {
    case PolicyReasonCode.WORKSPACE_UNCONFIRMED:
      return ErrorCode.WORKSPACE_CONFIRMATION_REQUIRED;
    case PolicyReasonCode.WORKSPACE_UNRESOLVED:
      return ErrorCode.WORKSPACE_UNRESOLVED;
    case PolicyReasonCode.PATH_OUTSIDE_WORKSPACE:
      return ErrorCode.PATH_OUTSIDE_ROOT;
    case PolicyReasonCode.PATH_EXCLUDED_SECRET:
      return ErrorCode.PATH_DENIED;
    case PolicyReasonCode.CONTENT_SECRET_DETECTED:
      return ErrorCode.SECRET_DETECTED;
    case PolicyReasonCode.CONTENT_SCAN_FAILED:
      return ErrorCode.SCHEMA_INVALID;
    case PolicyReasonCode.PROTECTED_PATH_REQUIRES_APPROVAL:
    case PolicyReasonCode.PROTECTED_PATH_CANNOT_AUTO_APPLY:
      return ErrorCode.PATH_PROTECTED;
    case PolicyReasonCode.REVIEW_ONLY_MODE_BLOCKS_MUTATION:
    case PolicyReasonCode.REVIEW_ONLY_MODE_BLOCKS_EXECUTION:
    case PolicyReasonCode.ARBITRARY_COMMAND_DENIED:
      return ErrorCode.ACTION_DENIED;
    case PolicyReasonCode.EXECUTOR_UNAVAILABLE:
      return ErrorCode.EXECUTOR_NOT_CONFIGURED;
    case PolicyReasonCode.CAPABILITY_MISSING:
      return ErrorCode.CAPABILITY_UNAVAILABLE;
    case PolicyReasonCode.UNKNOWN_ACTION:
    case PolicyReasonCode.SCHEMA_INVALID:
    case PolicyReasonCode.POLICY_TAMPERING_ATTEMPT:
      return ErrorCode.SCHEMA_INVALID;
    case PolicyReasonCode.TASK_STATE_INVALID:
      return ErrorCode.INVALID_STATE_TRANSITION;
    case PolicyReasonCode.CALLER_UNAUTHORIZED_FOR_APPROVAL:
      return ErrorCode.ACTION_DENIED;
    case PolicyReasonCode.APPROVAL_REQUIRED:
      return ErrorCode.APPROVAL_REQUIRED;
    case PolicyReasonCode.APPROVAL_EXPIRED:
      return ErrorCode.APPROVAL_EXPIRED;
    case PolicyReasonCode.APPROVAL_PAYLOAD_MISMATCH:
      return ErrorCode.APPROVAL_PAYLOAD_MISMATCH;
    case PolicyReasonCode.APPROVAL_NOT_FOUND:
    case PolicyReasonCode.APPROVAL_ALREADY_RESOLVED:
      return ErrorCode.ACTION_DENIED;
    case PolicyReasonCode.UNSUPPORTED_ACTION:
      return ErrorCode.PROTOCOL_VERSION_UNSUPPORTED;
    default:
      return ErrorCode.ACTION_DENIED;
  }
}

export function policyDecisionToError(decision: PolicyDecision): MediatorError {
  const code = mapReasonCodeToErrorCode(decision.reasonCode);
  return makeMediatorError(code, decision.explanation, {
    actionId: decision.actionId,
    correlationId: decision.correlationId,
    detail: {
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      applicableRuleIds: decision.applicableRuleIds,
      ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
      ...(decision.details ? decision.details : {}),
    },
  });
}
