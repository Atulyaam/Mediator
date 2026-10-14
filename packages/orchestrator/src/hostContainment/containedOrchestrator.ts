/**
 * @mediator/orchestrator — Contained Orchestrator Client (Sprint S45)
 *
 * Implements the Lower-Privilege Orchestration Layer:
 * - Operates without direct access to live workspace files or Windows shell commands.
 * - Communicates with the TrustedHostBroker exclusively through HMAC-signed requests.
 * - Manages task states, provider round handling, and diff proposals safely.
 */

import * as crypto from 'node:crypto';
import {
  type HostBrokerOperationValue,
  HostBrokerOperation,
  type BrokerRequest,
  type BrokerResponse,
  type BrokerCallerOrigin,
  type WorkspaceStatusPayload,
  type WorkspaceStatusResult,
  type ReadSnapshotPayload,
  type ReadSnapshotResult,
  type StageProposalPayload,
  type StageProposalResult,
  type ApplyApprovedStagePayload,
  type ApplyApprovedStageResult,
  type DispatchSandboxRecipePayload,
  type DispatchSandboxRecipeResult,
  type BrokerTransport,
} from './hostBrokerTypes.js';

export interface ContainedOrchestratorOptions {
  readonly sharedSecret: string;
  readonly broker: BrokerTransport;
  readonly callerOrigin?: BrokerCallerOrigin | undefined;
}

export class ContainedOrchestrator {
  private readonly sharedSecret: string;
  private readonly broker: BrokerTransport;
  private readonly callerOrigin: BrokerCallerOrigin;

  constructor(options: ContainedOrchestratorOptions) {
    this.sharedSecret = options.sharedSecret;
    this.broker = options.broker;
    this.callerOrigin = options.callerOrigin ?? 'contained_orchestrator';
  }

  /**
   * Helper to construct and sign an authenticated broker request envelope.
   */
  public createSignedRequest<T>(
    operation: HostBrokerOperationValue,
    payload: T,
    options?: {
      readonly taskId?: string | undefined;
      readonly correlationId?: string | undefined;
      readonly customNonce?: string | undefined;
      readonly customTimestamp?: number | undefined;
      readonly customCallerOrigin?: BrokerCallerOrigin | undefined;
      readonly customSignature?: string | undefined;
    },
  ): BrokerRequest<T> {
    const requestId = crypto.randomUUID();
    const timestamp = options?.customTimestamp ?? Date.now();
    const nonce = options?.customNonce ?? crypto.randomBytes(16).toString('hex');
    const correlationId = options?.correlationId ?? `corr_${crypto.randomBytes(6).toString('hex')}`;
    const taskId = options?.taskId ?? `task_${crypto.randomBytes(6).toString('hex')}`;
    const callerOrigin = options?.customCallerOrigin ?? this.callerOrigin;

    const payloadString = JSON.stringify(payload ?? null);
    const payloadHash = crypto.createHash('sha256').update(payloadString).digest('hex');

    const stringToSign = `${requestId}:${timestamp}:${nonce}:${operation}:${payloadHash}`;
    const signature =
      options?.customSignature ??
      crypto.createHmac('sha256', this.sharedSecret).update(stringToSign).digest('hex');

    return {
      header: {
        protocolVersion: '1.0.0',
        requestId,
        correlationId,
        taskId,
        timestamp,
        nonce,
        callerOrigin,
        signature,
      },
      operation,
      payload,
    };
  }

  /**
   * Query workspace status via broker.
   */
  public async queryWorkspace(
    workspaceRoot: string,
    taskId?: string,
  ): Promise<BrokerResponse<WorkspaceStatusResult>> {
    const req = this.createSignedRequest<WorkspaceStatusPayload>(
      HostBrokerOperation.WORKSPACE_STATUS,
      { workspaceRoot },
      { taskId },
    );
    return this.broker.handleRequest<WorkspaceStatusPayload, WorkspaceStatusResult>(req);
  }

  /**
   * Read snapshot of a contained file via broker.
   */
  public async readSnapshot(
    relativePath: string,
    taskId?: string,
  ): Promise<BrokerResponse<ReadSnapshotResult>> {
    const req = this.createSignedRequest<ReadSnapshotPayload>(
      HostBrokerOperation.READ_SNAPSHOT,
      { relativePath },
      { taskId },
    );
    return this.broker.handleRequest<ReadSnapshotPayload, ReadSnapshotResult>(req);
  }

  /**
   * Propose a staged change (writes to shadow staging via broker).
   */
  public async stageProposal(
    payload: StageProposalPayload,
    taskId?: string,
  ): Promise<BrokerResponse<StageProposalResult>> {
    const req = this.createSignedRequest<StageProposalPayload>(
      HostBrokerOperation.STAGE_PROPOSAL,
      payload,
      { taskId },
    );
    return this.broker.handleRequest<StageProposalPayload, StageProposalResult>(req);
  }

  /**
   * Request apply of an approved stage (requires trusted UI / CLI approval).
   */
  public async applyApprovedStage(
    payload: ApplyApprovedStagePayload,
    options?: {
      readonly taskId?: string | undefined;
      readonly callerOrigin?: BrokerCallerOrigin | undefined;
      readonly customNonce?: string | undefined;
    },
  ): Promise<BrokerResponse<ApplyApprovedStageResult>> {
    const req = this.createSignedRequest<ApplyApprovedStagePayload>(
      HostBrokerOperation.APPLY_APPROVED_STAGE,
      payload,
      {
        taskId: options?.taskId,
        customCallerOrigin: options?.callerOrigin ?? 'trusted_ui',
        customNonce: options?.customNonce,
      },
    );
    return this.broker.handleRequest<ApplyApprovedStagePayload, ApplyApprovedStageResult>(req);
  }

  /**
   * Dispatch a validation recipe to the sandbox via broker.
   */
  public async dispatchSandboxRecipe(
    payload: DispatchSandboxRecipePayload,
    taskId?: string,
  ): Promise<BrokerResponse<DispatchSandboxRecipeResult>> {
    const req = this.createSignedRequest<DispatchSandboxRecipePayload>(
      HostBrokerOperation.DISPATCH_SANDBOX_RECIPE,
      payload,
      { taskId },
    );
    return this.broker.handleRequest<DispatchSandboxRecipePayload, DispatchSandboxRecipeResult>(
      req,
    );
  }

  /**
   * Send an arbitrary or adversarial request directly to the broker.
   */
  public async sendRawRequest<T, R>(request: BrokerRequest<T>): Promise<BrokerResponse<R>> {
    return this.broker.handleRequest<T, R>(request);
  }
}
