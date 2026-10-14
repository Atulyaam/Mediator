/**
 * @mediator/executor-contract
 *
 * Authoritative capability schema, runtime canary harness, evaluation engine,
 * and execution authorization path.
 */

export {
  CapabilityEvaluationEngine,
  type CapabilityEvaluationInput,
} from './capabilityEvaluator.js';

export {
  RuntimeCanaryHarness,
  type CanaryHarnessOptions,
  type CanaryHarnessRunResult,
} from './canaryHarness.js';

export {
  ExecutionAuthorizationGate,
  type AuthorizationGateContext,
} from './executionAuthorizationGate.js';

export {
  ApprovedExecutionPathService,
  type ApprovedExecutionPathOptions,
} from './approvedExecutionPath.js';

export {
  DisposableWindowsExecutor,
  type DisposableExecutionRequest,
  type DisposableExecutionResult,
  type DisposableExecutionStatus,
  type TrustedPrototypeRecipe,
} from './disposableWindowsExecutor.js';

export {
  WslSandboxProvisioner,
  type WslDistroInfo,
  type WslHostDiscoveryReport,
  type WslSandboxConfigTemplate,
  CANONICAL_MEDIATOR_SANDBOX_NAME,
  CANONICAL_SANDBOX_USER,
  CANONICAL_SANDBOX_UID,
  CANONICAL_WSL_CONF_TEMPLATE,
  CANONICAL_NETWORK_DEFAULT_DENY_SCRIPT,
} from './wslSandboxProvisioner.js';

export {
  WslIsolatedExecutor,
  type WslExecutionStatus,
  type WslTrustedRecipeDefinition,
  type WslExecutionRequest,
  type WslExecutionResult,
  DEFAULT_WSL_TIMEOUT_MS,
  DEFAULT_WSL_MAX_OUTPUT_BYTES,
} from './wslIsolatedExecutor.js';
