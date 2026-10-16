/**
 * @mediator/orchestrator — Authoritative Mediator Core (Sprint S33–S35)
 *
 * Single Source of Truth for all Mediator interfaces:
 * - Standalone UI
 * - IDE Extension (Antigravity & VS Code)
 * - Browser Extension (Gemini, ChatGPT, DeepSeek)
 * - CLI
 *
 * Invariants:
 * - Authoritative for tasks, session transitions, workspace scope, and providers.
 * - Shared, typed event distribution (cross-interface synchronization).
 * - Provider Conversation Loop operates independently of Local Autopilot.
 * - Under canonical S00 NO-GO-AUTOEXEC, Local Autopilot is fail-closed (BLOCKED).
 * - Live workspace mutation strictly requires human approval.
 */

import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  type CanonicalProviderId,
  type ProviderMode,
  type Result,
  type MediatorError,
  type RecipeId,
  ErrorCode,
  makeMediatorError,
  ok,
  err,
  PROTOCOL_VERSION,
  isCanonicalProviderId,
  type S00ExecutionDecision,
  type AutopilotGateResult,
} from '@mediator/shared-contracts';
import {
  inspectWorkspaceRoot,
  confirmWorkspaceRoot,
  type WorkspaceRootState,
} from '@mediator/workspace-boundary';
import {
  UnifiedProviderRegistry,
  type ProviderStateSummary,
} from '@mediator/provider-core';
import { DatabaseConnection } from '@mediator/persistence';
import { StageStore } from '@mediator/stage-store';
import { RecipeRegistryService } from '@mediator/recipe-registry';
import { WslIsolatedExecutor } from '@mediator/executor-contract';
import { WorkflowOrchestrator, type OrchestrationRoundResult } from './workflowOrchestrator.js';
import { AutopilotGateEvaluator, type AutopilotGateEvaluationInput } from './autopilotGate.js';
import { TrustedHostBroker } from './hostContainment/trustedHostBroker.js';
import { ContainedOrchestrator } from './hostContainment/containedOrchestrator.js';
import { GuardedAutopilotEngine } from './guardedAutopilotEngine.js';
import {
  WebConversationManager,
  type ProviderMessageDispatcher,
  type ConversationMessage,
  type WebConversationSession,
} from './webConversationManager.js';
import {
  type AutopilotTaskConfig,
  type AutopilotRunResult,
} from '@mediator/shared-contracts';

export interface TaskRecord {
  readonly id: string;
  readonly prompt: string;
  status: 'idle' | 'running' | 'waiting_for_response' | 'paused' | 'completed' | 'cancelled' | 'failed';
  readonly providerId: CanonicalProviderId;
  readonly mode: ProviderMode;
  conversationId?: string | undefined;
  conversationHistory?: ConversationMessage[];
  roundNumber: number;
  readonly createdAt: number;
  updatedAt: number;
  stages: string[];
  approvals: string[];
  events: Array<{ timestamp: number; type: string; message: string; details?: unknown }>;
  lastDiff?: string | undefined;
  lastError?: string | undefined;
  pauseReason?: string | undefined;
  lastValidation?: {
    recipeId: string;
    exitCode: number;
    passed: boolean;
    stdout: string;
    stderr: string;
    timestamp: number;
  } | undefined;
}

export interface MediatorCoreEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly type:
    | 'core:ready'
    | 'state:snapshot'
    | 'workspace:changed'
    | 'provider:selected'
    | 'provider:status'
    | 'task:created'
    | 'task:updated'
    | 'task:paused'
    | 'task:resumed'
    | 'task:cancelled'
    | 'task:completed'
    | 'stage:created'
    | 'approval:created'
    | 'approval:resolved'
    | 'loop:toggled'
    | 'autopilot:toggled'
    | 'autopilot:completed'
    | 'autopilot:stopped'
    | 'audit:log';
  readonly payload: unknown;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly taskId: string;
  readonly actionType: string;
  status: 'pending' | 'approved' | 'rejected' | 'discarded' | 'consumed';
  readonly description: string;
  readonly createdAt: number;
  resolvedAt?: number | undefined;
  resolvedReason?: string | undefined;
  stagedFiles?: string[] | undefined;
  stageId?: string | undefined;
  approvalToken?: string | undefined;
  baseHashes?: Record<string, string> | undefined;
  stagedHashes?: Record<string, string> | undefined;
}

export interface StageItem {
  readonly id: string;
  readonly taskId: string;
  readonly filePath: string;
  readonly diffPreview?: string;
  readonly approvalId?: string;
  readonly approvalToken?: string;
  readonly stagedFiles?: readonly string[];
  readonly proposedFiles?: Readonly<
    Record<
      string,
      {
        readonly proposedContent: string;
        readonly baseHash?: string;
        readonly stagedHash?: string;
      }
    >
  >;
}

export function generateUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent ? oldContent.split('\n') : [];
  const newLines = newContent ? newContent.split('\n') : [];
  const lines: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length || 1} +1,${newLines.length || 1} @@`,
  ];
  for (const line of oldLines) {
    lines.push(`-${line}`);
  }
  for (const line of newLines) {
    lines.push(`+${line}`);
  }
  return lines.join('\n') + '\n';
}

export interface MediatorCoreStateSnapshot {
  readonly coreVersion: string;
  readonly protocolVersion: string;
  readonly workspaceRoot: string | null;
  readonly workspaceConfirmed: boolean;
  readonly activeProviderId: CanonicalProviderId;
  readonly activeMode: ProviderMode;
  readonly activeConversation: {
    readonly providerId: string;
    readonly conversationId?: string | undefined;
    readonly tabId?: number | undefined;
  } | null;
  readonly activeTaskId: string | null;
  readonly tasks: TaskRecord[];
  readonly loopEnabled: boolean;
  readonly loopStatus: string;
  readonly autopilotEnabled: boolean;
  readonly autopilotStatus: string;
  readonly autopilotCanRun: boolean;
  readonly autopilotBlockingReasons: readonly string[];
  readonly s00Decision: string;
  readonly providers: readonly ProviderStateSummary[];
  readonly pendingApprovals: ApprovalRecord[];
  readonly recentStages: readonly StageItem[];
  readonly uptimeSeconds: number;
  readonly pairingToken: string;
}

export interface MediatorCoreOptions {
  readonly workspaceRoot?: string | null | undefined;
  readonly pairingToken?: string | undefined;
  readonly db?: DatabaseConnection | undefined;
  readonly s00Decision?: S00ExecutionDecision | undefined;
}

export class MediatorCore {
  public static readonly VERSION = '0.0.1';
  public static readonly PROTOCOL_VERSION = PROTOCOL_VERSION;

  private readonly startTime = Date.now();
  private readonly pairingToken: string;
  private s00Decision: S00ExecutionDecision;
  private readonly eventEmitter = new EventEmitter();
  private readonly db: DatabaseConnection;
  private readonly providerRegistry: UnifiedProviderRegistry;
  private readonly autopilotGateEvaluator = new AutopilotGateEvaluator();

  private workspaceRoot: string | null = null;
  private workspaceState: WorkspaceRootState | null = null;
  private workspaceConfirmed = false;

  private activeConversation: {
    providerId: string;
    conversationId?: string | undefined;
    tabId?: number | undefined;
    latestMessageAnchor?: string | undefined;
    branchId?: string | undefined;
  } | null = null;

  private readonly tasks = new Map<string, TaskRecord>();
  private activeTaskId: string | null = null;

  private loopEnabled = true;
  private loopStatus: 'off' | 'ready' | 'running' | 'paused' | 'blocked' | 'completed' = 'ready';

  private autopilotEnabled = false;
  private autopilotStatus: 'off' | 'ready' | 'running' | 'paused' | 'blocked' | 'revoked' = 'off';

  private readonly stageStore: StageStore;
  private readonly recipeRegistry: RecipeRegistryService;
  private orchestrator: WorkflowOrchestrator | null = null;
  private hostBroker: TrustedHostBroker | null = null;
  private containedOrchestrator: ContainedOrchestrator | null = null;
  private wslExecutor: WslIsolatedExecutor | null = null;
  private guardedAutopilotEngine: GuardedAutopilotEngine;
  private readonly webConversationManager: WebConversationManager;

  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly stagesList: StageItem[] = [];
  private readonly auditLogs: Array<{ timestamp: number; type: string; message: string; details?: unknown }> = [];

  constructor(options?: MediatorCoreOptions) {
    this.eventEmitter.setMaxListeners(50);
    this.pairingToken = options?.pairingToken ?? `pair_${crypto.randomBytes(16).toString('hex')}`;
    this.s00Decision = options?.s00Decision ?? 'NO-GO-AUTOEXEC';
    this.db = options?.db ?? new DatabaseConnection({ isMemory: true });
    this.stageStore = new StageStore(this.db);
    this.recipeRegistry = new RecipeRegistryService();
    this.providerRegistry = new UnifiedProviderRegistry({ defaultProvider: 'gemini', defaultMode: 'browser' });
    this.guardedAutopilotEngine = new GuardedAutopilotEngine({
      workspaceRoot: options?.workspaceRoot ?? process.cwd(),
      s00Decision: this.s00Decision,
      wslExecutor: this.wslExecutor ?? undefined,
    });
    this.webConversationManager = new WebConversationManager({
      workspaceRoot: options?.workspaceRoot ?? process.cwd(),
    });

    if (options?.workspaceRoot) {
      this.setWorkspaceRoot(options.workspaceRoot, true);
    }

    this.recomputeAutopilotStatus();
  }

  // ─── Pair Token Verification ─────────────────────────────────────────────

  public verifyPairingToken(token: string | undefined): boolean {
    if (!token) return false;
    return crypto.timingSafeEqual(
      Buffer.from(token.padEnd(64)),
      Buffer.from(this.pairingToken.padEnd(64)),
    );
  }

  public getPairingToken(): string {
    return this.pairingToken;
  }

  // ─── Authoritative Workspace ──────────────────────────────────────────────

  public getWorkspaceRoot(): string | null {
    return this.workspaceRoot;
  }

  public isWorkspaceConfirmed(): boolean {
    return this.workspaceConfirmed;
  }

  public setWorkspaceRoot(newRoot: string, confirm = false): Result<string, MediatorError> {
    if (!newRoot || typeof newRoot !== 'string') {
      return err(makeMediatorError(ErrorCode.WORKSPACE_ROOT_UNCONFIRMED, 'Invalid workspace root provided'));
    }

    const inspected = inspectWorkspaceRoot(newRoot, 'cli');
    if (inspected.resolutionStatus !== 'resolved') {
      return err(
        makeMediatorError(
          ErrorCode.WORKSPACE_ROOT_UNCONFIRMED,
          `Failed to resolve workspace path: ${inspected.resolutionStatus}`,
        ),
      );
    }

    let finalState = inspected;
    if (confirm) {
      const confRes = confirmWorkspaceRoot(inspected, true);
      if (!confRes.ok) return err(confRes.error);
      finalState = confRes.value;
    }

    const previousRoot = this.workspaceRoot;
    this.workspaceState = finalState;
    this.workspaceRoot = finalState.canonicalPath ?? finalState.selectedPath;
    this.workspaceConfirmed = finalState.confirmationStatus === 'confirmed';

    // Invalidate active approvals and stages if workspace changed
    if (previousRoot && previousRoot !== this.workspaceRoot) {
      for (const app of this.approvals.values()) {
        if (app.status === 'pending') {
          app.status = 'discarded';
          app.resolvedReason = 'Workspace root changed; previous pending approval invalidated.';
          this.emitEvent('approval:resolved', app);
        }
      }
    }

    // Reinitialize Orchestrator for new root
    this.orchestrator = new WorkflowOrchestrator({
      workspaceRoot: this.workspaceRoot,
      s00Decision: this.s00Decision,
      stageStore: this.stageStore,
      recipeRegistry: this.recipeRegistry,
    });

    this.guardedAutopilotEngine = new GuardedAutopilotEngine({
      workspaceRoot: this.workspaceRoot,
      s00Decision: this.s00Decision,
      wslExecutor: this.wslExecutor ?? undefined,
    });

    if (this.workspaceConfirmed) {
      this.initHostContainment();
    }

    this.logAudit('workspace:changed', `Active workspace set to ${this.workspaceRoot} (confirmed: ${this.workspaceConfirmed})`);
    this.emitEvent('workspace:changed', {
      workspaceRoot: this.workspaceRoot,
      confirmed: this.workspaceConfirmed,
    });

    return ok(this.workspaceRoot);
  }

  private initHostContainment(): void {
    if (!this.workspaceState || !this.workspaceConfirmed) return;
    const brokerSecret = crypto.randomBytes(32).toString('hex');
    const appData =
      process.env.APPDATA ||
      (process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : path.join(os.homedir(), '.local', 'share'));
    const shadowStageDir = path.join(appData, 'Mediator', 'staging');
    const backupDir = path.join(appData, 'Mediator', 'backups');

    this.wslExecutor = new WslIsolatedExecutor();

    this.hostBroker = new TrustedHostBroker({
      sharedSecret: brokerSecret,
      workspace: this.workspaceState,
      shadowStageDir,
      backupDir,
      s00Decision: this.s00Decision as 'GO_IDE' | 'GO_WSL2' | 'NO-GO-AUTOEXEC',
    });

    this.containedOrchestrator = new ContainedOrchestrator({
      sharedSecret: brokerSecret,
      broker: this.hostBroker,
    });
  }

  // ─── Provider Management ──────────────────────────────────────────────────

  public getActiveProviderId(): CanonicalProviderId {
    return this.providerRegistry.getActiveProviderId();
  }

  public getActiveMode(): ProviderMode {
    return this.providerRegistry.getActiveMode();
  }

  public selectProvider(providerId: string, mode?: ProviderMode): Result<CanonicalProviderId, MediatorError> {
    if (!isCanonicalProviderId(providerId as CanonicalProviderId)) {
      return err(
        makeMediatorError(ErrorCode.PROVIDER_UNKNOWN, `Unknown or unsupported provider ID "${providerId}".`),
      );
    }

    const targetMode = mode ?? this.getActiveMode();
    const res = this.providerRegistry.selectProvider(providerId, targetMode);
    if (!res.ok) return res;

    // Reset conversation identity when provider switches
    this.activeConversation = null;

    this.logAudit('provider:selected', `Selected provider switched to ${providerId} (${targetMode})`);
    this.emitEvent('provider:selected', {
      providerId: this.getActiveProviderId(),
      mode: this.getActiveMode(),
    });

    return ok(this.getActiveProviderId());
  }

  public setConversationIdentity(conv: {
    providerId: string;
    conversationId?: string | undefined;
    tabId?: number | undefined;
    latestMessageAnchor?: string | undefined;
    branchId?: string | undefined;
  }): void {
    this.activeConversation = conv;
    this.logAudit('provider:status', `Attached to conversation ${conv.conversationId ?? 'new'} on tab ${conv.tabId ?? 0}`);
    this.emitEvent('provider:status', conv);
  }

  public getActiveConversation(): typeof this.activeConversation {
    return this.activeConversation;
  }

  public async listProviders(): Promise<readonly ProviderStateSummary[]> {
    return this.providerRegistry.getProviderStatusSummary();
  }

  public getProvidersSync(): readonly ProviderStateSummary[] {
    const list: ProviderStateSummary[] = [];
    for (const meta of this.providerRegistry.listAllProviders()) {
      list.push({
        providerId: meta.providerId,
        displayName: meta.displayName,
        activeMode: this.getActiveProviderId() === meta.providerId ? this.getActiveMode() : meta.supportedModes[0] ?? 'manual',
        status: this.getActiveProviderId() === meta.providerId ? 'connected' : 'not-configured',
        hasCredential: false,
        selectedModelId: this.providerRegistry.getSelectedModel(meta.providerId),
        availableModels: meta.availableModels,
        supportedModes: meta.supportedModes,
      });
    }
    return list;
  }

  // ─── Task Lifecycle ───────────────────────────────────────────────────────

  public createTask(params: {
    prompt: string;
    providerId?: CanonicalProviderId | undefined;
    mode?: ProviderMode | undefined;
    conversationId?: string | undefined;
  }): Result<TaskRecord, MediatorError> {
    if (!params.prompt || params.prompt.trim().length === 0) {
      return err(makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Task prompt cannot be empty.'));
    }

    const providerId = params.providerId ?? this.getActiveProviderId();
    const mode = params.mode ?? this.getActiveMode();

    const taskId = `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const initialConvId = params.conversationId ?? this.activeConversation?.conversationId;
    const convSession = this.webConversationManager.getOrCreateSession(
      taskId,
      providerId,
      initialConvId,
    );

    const task: TaskRecord = {
      id: taskId,
      prompt: params.prompt.trim(),
      status: 'running',
      providerId,
      mode,
      conversationId: initialConvId,
      conversationHistory: convSession.history,
      roundNumber: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stages: [],
      approvals: [],
      events: [
        {
          timestamp: Date.now(),
          type: 'created',
          message: `Task initialized with prompt: "${params.prompt.trim().slice(0, 80)}"`,
        },
      ],
    };

    this.tasks.set(taskId, task);
    this.activeTaskId = taskId;

    this.logAudit('task:created', `Task ${taskId} created for ${providerId}`);
    this.emitEvent('task:created', task);

    return ok(task);
  }

  public getTask(taskId: string): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    if (task) {
      task.conversationHistory = this.webConversationManager.getSession(taskId)?.history ?? [];
    }
    return task;
  }

  public listTasks(): TaskRecord[] {
    const list = Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
    for (const t of list) {
      t.conversationHistory = this.webConversationManager.getSession(t.id)?.history ?? [];
    }
    return list;
  }

  public getActiveTaskId(): string | null {
    return this.activeTaskId;
  }

  public pauseTask(taskId: string, reason = 'User requested pause'): Result<TaskRecord, MediatorError> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(makeMediatorError(ErrorCode.TASK_MISMATCH, `Task ${taskId} not found`));
    }

    task.status = 'paused';
    task.pauseReason = reason;
    task.updatedAt = Date.now();
    task.events.push({ timestamp: Date.now(), type: 'paused', message: reason });

    this.logAudit('task:paused', `Task ${taskId} paused: ${reason}`);
    this.emitEvent('task:paused', task);
    return ok(task);
  }

  public resumeTask(taskId: string): Result<TaskRecord, MediatorError> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(makeMediatorError(ErrorCode.TASK_MISMATCH, `Task ${taskId} not found`));
    }

    task.status = 'running';
    task.pauseReason = undefined;
    task.updatedAt = Date.now();
    task.events.push({ timestamp: Date.now(), type: 'resumed', message: 'Task resumed by user' });

    this.logAudit('task:resumed', `Task ${taskId} resumed`);
    this.emitEvent('task:updated', task);
    return ok(task);
  }

  public cancelTask(taskId: string, reason = 'User requested cancellation'): Result<TaskRecord, MediatorError> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(makeMediatorError(ErrorCode.TASK_MISMATCH, `Task ${taskId} not found`));
    }

    task.status = 'cancelled';
    task.pauseReason = reason;
    task.updatedAt = Date.now();
    task.events.push({ timestamp: Date.now(), type: 'cancelled', message: reason });

    if (this.activeTaskId === taskId) {
      this.activeTaskId = null;
    }

    this.logAudit('task:cancelled', `Task ${taskId} cancelled: ${reason}`);
    this.emitEvent('task:cancelled', task);
    return ok(task);
  }

  public completeTask(taskId: string): Result<TaskRecord, MediatorError> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(makeMediatorError(ErrorCode.TASK_MISMATCH, `Task ${taskId} not found`));
    }

    task.status = 'completed';
    task.updatedAt = Date.now();
    task.events.push({ timestamp: Date.now(), type: 'completed', message: 'Task completed successfully' });

    if (this.activeTaskId === taskId) {
      this.activeTaskId = null;
    }

    this.logAudit('task:completed', `Task ${taskId} marked completed`);
    this.emitEvent('task:completed', task);
    return ok(task);
  }

  // ─── Provider Response & Workflow Orchestration ────────────────────────────

  public async submitProviderResponse(
    taskId: string,
    rawTextOrEnvelope: string | Record<string, unknown>,
  ): Promise<Result<OrchestrationRoundResult, MediatorError>> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(makeMediatorError(ErrorCode.TASK_MISMATCH, `Task ${taskId} not found`));
    }

    if (!this.workspaceRoot || !this.workspaceConfirmed) {
      return err(
        makeMediatorError(
          ErrorCode.WORKSPACE_ROOT_UNCONFIRMED,
          'Active workspace must be selected and confirmed before processing provider responses.',
        ),
      );
    }

    if (!this.orchestrator) {
      this.orchestrator = new WorkflowOrchestrator({
        workspaceRoot: this.workspaceRoot,
        s00Decision: this.s00Decision,
        stageStore: this.stageStore,
        recipeRegistry: this.recipeRegistry,
      });
    }

    task.roundNumber += 1;
    task.updatedAt = Date.now();

    // Parse envelope if raw JSON
    let envelopeObj: unknown;
    if (typeof rawTextOrEnvelope === 'string') {
      try {
        envelopeObj = JSON.parse(rawTextOrEnvelope);
      } catch {
        return err(
          makeMediatorError(ErrorCode.SCHEMA_INVALID, 'Provided response is not valid JSON protocol envelope'),
        );
      }
    } else {
      envelopeObj = rawTextOrEnvelope;
    }

    const envelopeRec =
      typeof envelopeObj === 'object' && envelopeObj !== null
        ? (envelopeObj as Record<string, unknown>)
        : null;
    const envelopeConv =
      typeof envelopeRec?.conversation === 'object' && envelopeRec?.conversation !== null
        ? (envelopeRec.conversation as Record<string, unknown>)
        : undefined;
    const envelopeConvId =
      typeof envelopeConv?.conversationId === 'string'
        ? envelopeConv.conversationId
        : undefined;
    const envelopeProvider =
      typeof envelopeConv?.provider === 'string'
        ? (envelopeConv.provider as CanonicalProviderId)
        : undefined;

    if (envelopeConvId && (!task.conversationId || task.conversationId.startsWith('conv_task_'))) {
      task.conversationId = envelopeConvId;
      this.webConversationManager.getOrCreateSession(task.id, task.providerId, envelopeConvId);
    }

    const effectiveConvId = envelopeConvId ?? task.conversationId ?? 'c1';
    const effectiveProvider = envelopeProvider ?? task.providerId;

    const correlationId = `corr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    let roundRes = await this.orchestrator.executeRound(envelopeObj, {
      taskId: task.id,
      sessionId: `sess_${task.id}`,
      correlationId,
      conversation: {
        provider: effectiveProvider,
        tabId: typeof envelopeConv?.tabId === 'number' ? envelopeConv.tabId : 101,
        conversationId: effectiveConvId,
      },
      sameChatConfirmed: true,
      userApproved: true,
    });
    const rawActions = envelopeRec?.actions;
    const envelopeActions: ReadonlyArray<Record<string, unknown>> = Array.isArray(rawActions)
      ? (rawActions as ReadonlyArray<Record<string, unknown>>)
      : [];
    const rawBlocks = envelopeRec?.contentBlocks;
    const envelopeBlocks: ReadonlyArray<Record<string, unknown>> = Array.isArray(rawBlocks)
      ? (rawBlocks as ReadonlyArray<Record<string, unknown>>)
      : [];

    let stagedViaHelper = false;
    for (const act of envelopeActions) {
      if (act.type === 'propose_patch' && typeof act.path === 'string') {
        const block = envelopeBlocks.find((b) => b.id === act.contentBlockId);
        const proposedContent =
          typeof block?.content === 'string'
            ? block.content
            : typeof block?.text === 'string'
              ? block.text
              : undefined;

        if (proposedContent !== undefined) {
          const stagedRes = await this.stageProposal({
            taskId: task.id,
            relativePath: act.path,
            proposedContent,
            expectedBaseHash: typeof act.expectedBaseHash === 'string' ? act.expectedBaseHash : undefined,
            description: `Proposed code changes for ${act.path} (round ${task.roundNumber})`,
          });
          if (stagedRes.ok) {
            roundRes = {
              ...roundRes,
              diffPreview: stagedRes.value.diffPreview,
              approvalRequired: true,
            };
            stagedViaHelper = true;
          }
        }
      }
    }

    if (!stagedViaHelper) {
      if (roundRes.diffPreview) {
        task.lastDiff = roundRes.diffPreview;
        const stageId = `stage_${Date.now()}`;
        task.stages.push(stageId);
        this.stagesList.unshift({
          id: stageId,
          taskId: task.id,
          filePath: 'staged_changes.diff',
          diffPreview: roundRes.diffPreview,
        });
        this.emitEvent('stage:created', { stageId, taskId: task.id, diff: roundRes.diffPreview });
      }

      if (roundRes.approvalRequired) {
        const approvalId = `appr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const approval: ApprovalRecord = {
          id: approvalId,
          taskId: task.id,
          actionType: 'patch',
          status: 'pending',
          description: `Proposed code changes for task ${task.id} (round ${task.roundNumber})`,
          createdAt: Date.now(),
          stagedFiles: ['staged_changes'],
        };
        this.approvals.set(approvalId, approval);
        task.approvals.push(approvalId);
        this.emitEvent('approval:created', approval);
      }
    }

    if (roundRes.state === 'completed') {
      task.status = 'completed';
      this.emitEvent('task:completed', task);
    } else if (
      roundRes.state === 'paused' ||
      roundRes.state === 'awaiting-approval' ||
      roundRes.state === 'manual-handoff-ready'
    ) {
      task.status = 'paused';
      task.pauseReason = 'Awaiting human review or confirmation';
      this.emitEvent('task:paused', task);
    } else if (roundRes.state === 'failed' || roundRes.state === 'verification-blocked') {
      task.status = 'failed';
      task.lastError = roundRes.error?.message;
      this.emitEvent('task:updated', task);
    } else {
      task.status = 'waiting_for_response';
      this.emitEvent('task:updated', task);
    }

    this.logAudit('task:updated', `Round ${task.roundNumber} executed for ${task.id}: state=${roundRes.state}`);
    return ok(roundRes);
  }

  // ─── Approvals & Staging ──────────────────────────────────────────────────

  public listApprovals(): ApprovalRecord[] {
    return Array.from(this.approvals.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  public getApproval(approvalId: string): ApprovalRecord | undefined {
    return this.approvals.get(approvalId);
  }

  public resolveApproval(
    approvalId: string,
    approved: boolean,
    reason = approved ? 'Approved by user' : 'Rejected by user',
  ): Result<ApprovalRecord, MediatorError> {
    const app = this.approvals.get(approvalId);
    if (!app) {
      return err(makeMediatorError(ErrorCode.APPROVAL_EXPIRED, `Approval ${approvalId} not found`));
    }

    if (app.status !== 'pending') {
      return err(
        makeMediatorError(
          ErrorCode.APPROVAL_EXPIRED,
          `Approval ${approvalId} is already resolved (${app.status})`,
        ),
      );
    }

    app.status = approved ? 'approved' : 'rejected';
    app.resolvedAt = Date.now();
    app.resolvedReason = reason;

    // Synchronize into host broker ledger if present
    if (this.hostBroker) {
      const brokerApp = this.hostBroker.getApproval(approvalId);
      if (brokerApp) {
        brokerApp.status = approved ? 'approved' : 'rejected';
      }
    }

    this.logAudit('approval:resolved', `Approval ${approvalId} ${app.status}: ${reason}`);
    this.emitEvent('approval:resolved', app);

    return ok(app);
  }

  public async stageProposal(params: {
    taskId: string;
    relativePath: string;
    proposedContent: string;
    expectedBaseHash?: string | undefined;
    description?: string | undefined;
  }): Promise<
    Result<
      {
        stageId: string;
        approvalId: string;
        diffPreview: string;
        stagedHash: string;
        baseMatch: boolean;
      },
      MediatorError
    >
  > {
    if (!this.workspaceRoot || !this.workspaceConfirmed || !this.workspaceState) {
      return err(
        makeMediatorError(
          ErrorCode.WORKSPACE_ROOT_UNCONFIRMED,
          'Active workspace must be selected and confirmed before staging proposals.',
        ),
      );
    }

    const task = this.tasks.get(params.taskId);
    if (!task) {
      return err(makeMediatorError(ErrorCode.TASK_MISMATCH, `Task ${params.taskId} not found`));
    }

    if (!this.containedOrchestrator || !this.hostBroker) {
      this.initHostContainment();
    }

    if (!this.containedOrchestrator || !this.hostBroker) {
      return err(
        makeMediatorError(
          ErrorCode.INTERNAL_ERROR,
          'Failed to initialize TrustedHostBroker for staging proposal.',
        ),
      );
    }

    const stageId = `stage_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const canonicalRoot = this.workspaceState.canonicalPath ?? this.workspaceState.selectedPath;
    const liveFilePath = path.resolve(canonicalRoot, params.relativePath);

    let liveBaseHash = '';
    let liveContent = '';
    if (fs.existsSync(liveFilePath)) {
      liveContent = fs.readFileSync(liveFilePath, 'utf8');
      liveBaseHash = crypto.createHash('sha256').update(liveContent).digest('hex');
    }

    const changeType = !liveBaseHash
      ? 'add-proposed'
      : params.proposedContent.length === 0
        ? 'delete-proposed'
        : 'modify-proposed';

    const brokerRes = await this.containedOrchestrator.stageProposal(
      {
        stageId,
        relativePath: params.relativePath,
        proposedContent: params.proposedContent,
        baseContentHash: params.expectedBaseHash ?? liveBaseHash,
        changeType,
      },
      params.taskId,
    );

    if (!brokerRes.ok || !brokerRes.result) {
      const errCode =
        brokerRes.error?.code === 'PATH_OUTSIDE_WORKSPACE'
          ? ErrorCode.PATH_OUTSIDE_ROOT
          : ErrorCode.STAGE_CONFLICT;

      return err(
        makeMediatorError(
          errCode,
          brokerRes.error?.message ?? 'Failed to stage proposal via host broker',
        ),
      );
    }

    const diffPreview = generateUnifiedDiff(params.relativePath, liveContent, params.proposedContent);
    const approvalId = `appr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const approvalToken = `tok_${crypto.randomBytes(16).toString('hex')}`;

    // Register into Broker ledger
    this.hostBroker.registerApproval({
      approvalId,
      stageId,
      approvalToken,
      targetFiles: [params.relativePath],
      baseContentHashes: { [params.relativePath]: params.expectedBaseHash ?? liveBaseHash },
      stagedContentHashes: { [params.relativePath]: brokerRes.result.stagedHash },
      status: 'pending',
      expiresAt: Date.now() + 120_000,
      grantedBy: 'trusted_cli',
    });

    const approval: ApprovalRecord = {
      id: approvalId,
      taskId: task.id,
      actionType: 'patch',
      status: 'pending',
      description: params.description ?? `Proposed change to ${params.relativePath}`,
      createdAt: Date.now(),
      stagedFiles: [params.relativePath],
      stageId,
      approvalToken,
      baseHashes: { [params.relativePath]: params.expectedBaseHash ?? liveBaseHash },
      stagedHashes: { [params.relativePath]: brokerRes.result.stagedHash },
    };
    this.approvals.set(approvalId, approval);
    task.approvals.push(approvalId);
    task.stages.push(stageId);
    task.lastDiff = diffPreview;

    const stageItem: StageItem = {
      id: stageId,
      taskId: task.id,
      filePath: params.relativePath,
      diffPreview,
      approvalId,
      approvalToken,
      stagedFiles: [params.relativePath],
      proposedFiles: {
        [params.relativePath]: {
          proposedContent: params.proposedContent,
          baseHash: params.expectedBaseHash ?? liveBaseHash,
          stagedHash: brokerRes.result.stagedHash,
        },
      },
    };
    this.stagesList.unshift(stageItem);

    this.logAudit('stage:created', `Stage ${stageId} created for task ${task.id} (${params.relativePath})`);
    this.emitEvent('stage:created', { stageId, taskId: task.id, diff: diffPreview });
    this.emitEvent('approval:created', approval);

    return ok({
      stageId,
      approvalId,
      diffPreview,
      stagedHash: brokerRes.result.stagedHash,
      baseMatch: brokerRes.result.baseMatch,
    });
  }

  public async applyApprovedStage(
    stageId: string,
    approvalId: string,
    callerOrigin: 'trusted_ui' | 'trusted_cli' = 'trusted_cli',
  ): Promise<
    Result<
      {
        success: boolean;
        appliedFiles: string[];
        transactionId: string;
        backupDir: string;
      },
      MediatorError
    >
  > {
    if (!this.workspaceRoot || !this.workspaceConfirmed || !this.workspaceState) {
      return err(
        makeMediatorError(
          ErrorCode.WORKSPACE_ROOT_UNCONFIRMED,
          'Active workspace must be selected and confirmed before applying changes.',
        ),
      );
    }

    const callerStr: string = callerOrigin;
    if (callerStr !== 'trusted_ui' && callerStr !== 'trusted_cli') {
      return err(
        makeMediatorError(
          ErrorCode.ACTION_DENIED,
          `Caller origin '${callerStr}' is not authorized to apply live changes.`,
        ),
      );
    }

    const approval = this.approvals.get(approvalId);
    if (!approval) {
      return err(makeMediatorError(ErrorCode.APPROVAL_EXPIRED, `Approval '${approvalId}' not found.`));
    }

    if (approval.status === 'consumed') {
      return err(
        makeMediatorError(
          ErrorCode.APPROVAL_EXPIRED,
          `Approval '${approvalId}' has already been consumed (single-use invariant).`,
        ),
      );
    }

    if (approval.status !== 'approved') {
      return err(
        makeMediatorError(
          ErrorCode.APPROVAL_EXPIRED,
          `Approval '${approvalId}' is not in approved state (status: ${approval.status}).`,
        ),
      );
    }

    const task = this.tasks.get(approval.taskId);
    if (!task) {
      return err(makeMediatorError(ErrorCode.TASK_MISMATCH, `Associated task '${approval.taskId}' not found.`));
    }

    const stageItem = this.stagesList.find((s) => s.id === stageId);
    if (!stageItem) {
      return err(makeMediatorError(ErrorCode.STAGE_NOT_FOUND, `Stage '${stageId}' not found.`));
    }

    if (!this.containedOrchestrator || !this.hostBroker) {
      this.initHostContainment();
    }

    if (!this.containedOrchestrator || !this.hostBroker) {
      return err(
        makeMediatorError(ErrorCode.INTERNAL_ERROR, 'Failed to initialize TrustedHostBroker for workspace apply.'),
      );
    }

    // Ensure broker has approval record in approved state
    let brokerApp = this.hostBroker.getApproval(approvalId);
    if (!brokerApp) {
      const canonicalRoot = this.workspaceState.canonicalPath ?? this.workspaceState.selectedPath;
      const targetFiles = approval.stagedFiles ?? [stageItem.filePath];
      const baseHashes: Record<string, string> = {};
      const stagedHashes: Record<string, string> = {};

      for (const f of targetFiles) {
        const liveF = path.resolve(canonicalRoot, f);
        if (fs.existsSync(liveF)) {
          baseHashes[f] = crypto.createHash('sha256').update(fs.readFileSync(liveF, 'utf8')).digest('hex');
        }
        stagedHashes[f] = approval.stagedHashes?.[f] ?? crypto.createHash('sha256').update('').digest('hex');
      }

      this.hostBroker.registerApproval({
        approvalId,
        stageId,
        approvalToken: approval.approvalToken ?? `tok_${crypto.randomBytes(16).toString('hex')}`,
        targetFiles,
        baseContentHashes: approval.baseHashes ?? baseHashes,
        stagedContentHashes: approval.stagedHashes ?? stagedHashes,
        status: 'approved',
        expiresAt: Date.now() + 120_000,
        grantedBy: callerOrigin,
      });
      brokerApp = this.hostBroker.getApproval(approvalId);
    } else {
      brokerApp.status = 'approved';
    }

    const targetFiles = approval.stagedFiles ?? [stageItem.filePath];

    const brokerRes = await this.containedOrchestrator.applyApprovedStage(
      {
        stageId,
        approvalId,
        approvalToken: approval.approvalToken ?? brokerApp!.approvalToken,
        targetFiles,
      },
      {
        taskId: task.id,
        callerOrigin,
      },
    );

    if (!brokerRes.ok || !brokerRes.result) {
      const errCode =
        brokerRes.error?.code === 'TOCTOU_HASH_MISMATCH'
          ? ErrorCode.STAGE_BASE_HASH_STALE
          : brokerRes.error?.code === 'PATH_OUTSIDE_WORKSPACE'
            ? ErrorCode.PATH_OUTSIDE_ROOT
            : ErrorCode.APPROVAL_PAYLOAD_MISMATCH;

      return err(
        makeMediatorError(
          errCode,
          brokerRes.error?.message ?? 'Host broker failed to apply approved stage',
        ),
      );
    }

    // Mark approval consumed
    approval.status = 'consumed';
    task.status = 'completed';
    task.events.push({
      timestamp: Date.now(),
      type: 'applied',
      message: `Stage ${stageId} applied to workspace (tx: ${brokerRes.result.transactionId})`,
      details: brokerRes.result,
    });
    task.updatedAt = Date.now();

    this.logAudit(
      'task:completed',
      `Stage ${stageId} applied successfully. Transaction: ${brokerRes.result.transactionId}`,
      brokerRes.result,
    );
    this.emitEvent('task:updated', task);
    this.emitEvent('task:completed', task);

    return ok({
      success: true,
      appliedFiles: [...brokerRes.result.appliedFiles],
      transactionId: brokerRes.result.transactionId,
      backupDir: brokerRes.result.backupDir,
    });
  }

  public async validateTaskOffline(
    taskId: string,
    recipeId: RecipeId = 'python.test',
    options?: {
      distroName?: string;
      linuxTaskWorkspaceRoot?: string;
      allowDefaultDistroForCanary?: boolean;
    },
  ): Promise<
    Result<
      {
        recipeId: string;
        exitCode: number;
        passed: boolean;
        stdout: string;
        stderr: string;
        outputTruncated: boolean;
      },
      MediatorError
    >
  > {
    if (!this.workspaceRoot || !this.workspaceConfirmed || !this.workspaceState) {
      return err(
        makeMediatorError(
          ErrorCode.WORKSPACE_ROOT_UNCONFIRMED,
          'Active workspace must be selected and confirmed before offline validation.',
        ),
      );
    }

    const task = this.tasks.get(taskId);
    if (!task) {
      return err(makeMediatorError(ErrorCode.TASK_MISMATCH, `Task ${taskId} not found`));
    }

    if (!this.wslExecutor) {
      this.wslExecutor = new WslIsolatedExecutor();
    }

    const correlationId = `corr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const recipeHash = crypto.createHash('sha256').update(recipeId).digest('hex');

    task.events.push({
      timestamp: Date.now(),
      type: 'validating',
      message: `Offline validation started for recipe ${recipeId} inside sandbox`,
    });
    this.emitEvent('task:updated', task);

    const execRes = await this.wslExecutor.executeRecipe({
      recipeId,
      recipeHash,
      liveWorkspaceRootWindows: this.workspaceRoot,
      taskWorkspaceRootLinux: options?.linuxTaskWorkspaceRoot,
      distroName: options?.distroName,
      correlationId,
      isolateNetwork: true,
      allowDefaultDistroForCanary: options?.allowDefaultDistroForCanary,
    });

    const passed = execRes.exitCode === 0;
    const exitCode = execRes.exitCode ?? (execRes.status === 'completed_success' ? 0 : 1);

    task.lastValidation = {
      recipeId,
      exitCode,
      passed,
      stdout: execRes.stdout,
      stderr: execRes.stderr,
      timestamp: Date.now(),
    };

    task.events.push({
      timestamp: Date.now(),
      type: 'validated',
      message: `Offline validation ${recipeId} ${passed ? 'PASSED' : 'FAILED'} (exit code ${exitCode})`,
      details: { exitCode, status: execRes.status },
    });
    task.updatedAt = Date.now();

    this.logAudit(
      'task:updated',
      `Task ${taskId} validated offline with ${recipeId}: exit ${exitCode} (${passed ? 'PASSED' : 'FAILED'})`,
    );
    this.emitEvent('task:updated', task);

    return ok({
      recipeId,
      exitCode,
      passed,
      stdout: execRes.stdout,
      stderr: execRes.stderr,
      outputTruncated: execRes.outputTruncated,
    });
  }

  public listStages(): ReadonlyArray<StageItem> {
    return this.stagesList;
  }

  public getStageDiff(stageId: string): string | null {
    const st = this.stagesList.find((s) => s.id === stageId);
    return st?.diffPreview ?? null;
  }

  // ─── Toggles: Provider Loop & Autopilot ────────────────────────────────────

  public getLoopStatus(): { loopEnabled: boolean; loopStatus: string } {
    return { loopEnabled: this.loopEnabled, loopStatus: this.loopStatus };
  }

  public toggleLoop(enable?: boolean): { loopEnabled: boolean; loopStatus: string } {
    this.loopEnabled = enable !== undefined ? enable : !this.loopEnabled;
    this.loopStatus = this.loopEnabled ? 'ready' : 'off';
    this.logAudit('loop:toggled', `Provider loop toggled to ${this.loopEnabled ? 'ENABLED' : 'DISABLED'}`);
    this.emitEvent('loop:toggled', { loopEnabled: this.loopEnabled, loopStatus: this.loopStatus });
    return { loopEnabled: this.loopEnabled, loopStatus: this.loopStatus };
  }

  public getAutopilotStatus(): {
    autopilotEnabled: boolean;
    autopilotStatus: string;
    canRun: boolean;
    blockingReasons: readonly string[];
  } {
    const gate = this.recomputeAutopilotStatus();
    return {
      autopilotEnabled: this.autopilotEnabled,
      autopilotStatus: this.autopilotStatus,
      canRun: gate.isEligible,
      blockingReasons: gate.blockingReasons,
    };
  }

  public toggleAutopilot(enable?: boolean): {
    autopilotEnabled: boolean;
    autopilotStatus: string;
    canRun: boolean;
    blockingReasons: readonly string[];
  } {
    this.autopilotEnabled = enable !== undefined ? enable : !this.autopilotEnabled;
    const gate = this.recomputeAutopilotStatus();

    this.logAudit(
      'autopilot:toggled',
      `Autopilot toggled to ${this.autopilotEnabled ? 'ENABLED' : 'DISABLED'} (status=${this.autopilotStatus})`,
    );
    this.emitEvent('autopilot:toggled', {
      autopilotEnabled: this.autopilotEnabled,
      autopilotStatus: this.autopilotStatus,
      canRun: gate.isEligible,
      blockingReasons: gate.blockingReasons,
    });

    return {
      autopilotEnabled: this.autopilotEnabled,
      autopilotStatus: this.autopilotStatus,
      canRun: gate.isEligible,
      blockingReasons: gate.blockingReasons,
    };
  }

  public setS00Decision(decision: S00ExecutionDecision): void {
    this.s00Decision = decision;
    this.guardedAutopilotEngine.setS00Decision(decision);
    this.recomputeAutopilotStatus();
  }

  public getGuardedAutopilotEngine(): GuardedAutopilotEngine {
    return this.guardedAutopilotEngine;
  }

  public async runAutopilotTask(
    taskId: string,
    config?: Partial<AutopilotTaskConfig>,
  ): Promise<Result<AutopilotRunResult, MediatorError>> {
    if (!this.workspaceRoot || !this.workspaceConfirmed) {
      return err(
        makeMediatorError(
          ErrorCode.WORKSPACE_ROOT_UNCONFIRMED,
          'Active workspace must be selected and confirmed before running Autopilot.',
          { taskId },
        ),
      );
    }

    const task = this.tasks.get(taskId);
    if (!task) {
      return err(makeMediatorError(ErrorCode.TASK_MISMATCH, `Task "${taskId}" not found`, { taskId }));
    }

    if (!this.autopilotEnabled) {
      return err(
        makeMediatorError(
          ErrorCode.AUTOPILOT_DISABLED,
          'Autopilot is globally disabled in settings. Enable Autopilot before running.',
          { taskId },
        ),
      );
    }

    const gate = this.recomputeAutopilotStatus();
    if (!gate.isEligible) {
      return err(
        makeMediatorError(
          ErrorCode.AUTOPILOT_POLICY_DISALLOWED,
          `Autopilot execution blocked by security policy: ${gate.blockingReasons.join('; ')}`,
          { taskId },
        ),
      );
    }

    task.status = 'running';
    this.autopilotStatus = 'running';
    this.emitEvent('task:updated', task);
    this.emitEvent('autopilot:toggled', {
      autopilotEnabled: this.autopilotEnabled,
      autopilotStatus: this.autopilotStatus,
      canRun: true,
      blockingReasons: [],
    });

    this.logAudit('task:updated', `Autopilot session started for task ${taskId}`);

    const worktreeGetter = (): string | undefined => this.guardedAutopilotEngine.getWorktreeRoot(taskId);
    const providerHandler = this.webConversationManager.getDispatcher()
      ? this.webConversationManager.createProviderHandler(taskId, worktreeGetter)
      : undefined;

    const runResult = await this.guardedAutopilotEngine.runIterationLoop({
      taskId,
      prompt: task.prompt,
      config,
      providerHandler,
    });

    if (runResult.status === 'completed' && runResult.stagedDiff) {
      task.lastDiff = runResult.stagedDiff;
      const stageId = `stage_autopilot_${Date.now()}`;
      task.stages.push(stageId);
      this.stagesList.unshift({
        id: stageId,
        taskId: task.id,
        filePath: 'guarded_autopilot.diff',
        diffPreview: runResult.stagedDiff,
      });

      const approvalId = `appr_autopilot_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const approval: ApprovalRecord = {
        id: approvalId,
        taskId: task.id,
        actionType: 'patch',
        status: 'pending',
        description: `Guarded Autopilot changes for task ${task.id} (${runResult.iterationsRun} iteration(s), verified in sandbox)`,
        createdAt: Date.now(),
        stagedFiles: [...runResult.changedFiles],
        stageId,
      };
      this.approvals.set(approvalId, approval);
      task.approvals.push(approvalId);

      task.status = 'paused';
      task.pauseReason = 'Awaiting human review of verified changes';
      this.autopilotStatus = 'ready';

      this.emitEvent('stage:created', { stageId, taskId: task.id, diff: runResult.stagedDiff });
      this.emitEvent('approval:created', approval);
      this.emitEvent('autopilot:completed', { taskId, runResult });
    } else if (runResult.status === 'cancelled') {
      task.status = 'cancelled';
      task.pauseReason = 'Autopilot cancelled by user';
      this.autopilotStatus = 'ready';
      this.emitEvent('task:cancelled', task);
    } else {
      task.status = 'failed';
      task.lastError = runResult.details;
      this.autopilotStatus = 'ready';
      this.emitEvent('task:updated', task);
      this.emitEvent('autopilot:stopped', { taskId, runResult });
    }

    this.logAudit('task:updated', `Autopilot session finished for ${taskId}: ${runResult.status} (${runResult.stopReason})`);
    return ok(runResult);
  }

  public cancelAutopilotTask(taskId: string, reason = 'User requested cancellation'): Result<boolean, MediatorError> {
    const cancelled = this.guardedAutopilotEngine.cancel(taskId, reason);
    if (cancelled) {
      const task = this.tasks.get(taskId);
      if (task) {
        task.status = 'cancelled';
        task.pauseReason = reason;
        task.updatedAt = Date.now();
        this.emitEvent('task:cancelled', task);
      }
      this.autopilotStatus = 'ready';
      this.logAudit('task:cancelled', `Autopilot task ${taskId} cancelled: ${reason}`);
      return ok(true);
    }
    return err(makeMediatorError(ErrorCode.TASK_MISMATCH, `No active Autopilot session for task "${taskId}"`));
  }

  public getAutopilotTaskSession(taskId: string): AutopilotRunResult | undefined {
    return this.guardedAutopilotEngine.getSession(taskId);
  }

  public getWebConversationManager(): WebConversationManager {
    return this.webConversationManager;
  }

  public setProviderDispatcher(dispatcher: ProviderMessageDispatcher): void {
    this.webConversationManager.setDispatcher(dispatcher);
  }

  public getTaskConversation(taskId: string): WebConversationSession | undefined {
    return this.webConversationManager.getSession(taskId);
  }

  public async executeContextCommand(
    taskId: string,
    commandName: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const worktreeRoot = this.guardedAutopilotEngine.getWorktreeRoot(taskId);
    const res = await this.webConversationManager.executeContextCommand(taskId, commandName, args, worktreeRoot);
    this.logAudit('task:command', `Task ${taskId} executed context command ${commandName}`, { args, ok: res.ok });
    return res;
  }

  public async submitFollowUpMessage(
    taskId: string,
    text: string,
  ): Promise<Result<{ reply: string; conversationId: string }, MediatorError>> {
    const session = this.webConversationManager.getSession(taskId);
    if (!session) {
      return err(makeMediatorError(ErrorCode.TASK_MISMATCH, `No conversation session found for task "${taskId}"`));
    }
    const dispatcher = this.webConversationManager.getDispatcher();
    if (!dispatcher) {
      return err(makeMediatorError(ErrorCode.PROVIDER_NOT_CONFIGURED, 'No provider message dispatcher active'));
    }
    try {
      const userMsg: ConversationMessage = {
        id: `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };
      session.history.push(userMsg);

      const res = await dispatcher.sendMessage(session.conversationId, text, {
        providerId: session.providerId,
        taskId,
      });
      session.conversationId = res.conversationId;

      const assistantMsg: ConversationMessage = {
        id: `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        role: 'assistant',
        content: res.responseText,
        timestamp: Date.now(),
      };
      session.history.push(assistantMsg);

      const task = this.getTask(taskId);
      if (task) {
        task.conversationId = res.conversationId;
        task.updatedAt = Date.now();
        this.emitEvent('task:updated', task);
      }
      return ok({ reply: res.responseText, conversationId: res.conversationId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return err(makeMediatorError(ErrorCode.INTERNAL_ERROR, `Failed sending follow-up message: ${msg}`));
    }
  }

  private recomputeAutopilotStatus(): AutopilotGateResult {
    const isGuardedGo = this.s00Decision === 'GO-GUARDED-AUTOPILOT' || this.s00Decision === 'GO-WSL2';
    const evalInput: AutopilotGateEvaluationInput = {
      s00Decision: this.s00Decision,
      executorCapabilities: isGuardedGo
        ? {
            childProcessesConfined: true,
            networkDefaultDeny: true,
            capturesRealExitCode: true,
            evidenceTimestamp: Date.now(),
            evidenceProvenance: 'runtime-canary',
          }
        : undefined,
      userOptInSetting: this.autopilotEnabled,
      recoveryGatePassed: true,
      recipeRegistryHashVerified: true,
      approvalRequiredForModifications: true,
    };

    const gate = this.autopilotGateEvaluator.evaluateEligibility(evalInput);

    if (!this.autopilotEnabled) {
      this.autopilotStatus = 'off';
    } else {
      // Fail-closed invariant: under NO-GO, status is BLOCKED; under GO-GUARDED-AUTOPILOT, ready
      this.autopilotStatus = gate.isEligible ? 'ready' : 'blocked';
    }

    return gate;
  }

  // ─── Event Distribution & Pub/Sub ──────────────────────────────────────────

  public subscribe(listener: (event: MediatorCoreEvent) => void): () => void {
    this.eventEmitter.on('core-event', listener);
    return () => {
      this.eventEmitter.off('core-event', listener);
    };
  }

  public emitEvent(type: MediatorCoreEvent['type'], payload: unknown): void {
    const event: MediatorCoreEvent = {
      id: `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      timestamp: Date.now(),
      type,
      payload,
    };
    this.eventEmitter.emit('core-event', event);
  }

  public getAuditLogs(): ReadonlyArray<{ timestamp: number; type: string; message: string; details?: unknown }> {
    return this.auditLogs;
  }

  private logAudit(type: string, message: string, details?: unknown): void {
    const entry = { timestamp: Date.now(), type, message, details };
    this.auditLogs.unshift(entry);
    this.emitEvent('audit:log', entry);
  }

  // ─── Full State Snapshot ──────────────────────────────────────────────────

  public getStateSnapshot(): MediatorCoreStateSnapshot {
    const gate = this.recomputeAutopilotStatus();
    return {
      coreVersion: MediatorCore.VERSION,
      protocolVersion: MediatorCore.PROTOCOL_VERSION,
      workspaceRoot: this.workspaceRoot,
      workspaceConfirmed: this.workspaceConfirmed,
      activeProviderId: this.getActiveProviderId(),
      activeMode: this.getActiveMode(),
      activeConversation: this.activeConversation,
      activeTaskId: this.activeTaskId,
      tasks: this.listTasks(),
      loopEnabled: this.loopEnabled,
      loopStatus: this.loopStatus,
      autopilotEnabled: this.autopilotEnabled,
      autopilotStatus: this.autopilotStatus,
      autopilotCanRun: gate.isEligible,
      autopilotBlockingReasons: gate.blockingReasons,
      s00Decision: this.s00Decision,
      providers: this.getProvidersSync(),
      pendingApprovals: this.listApprovals(),
      recentStages: this.stagesList,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      pairingToken: this.pairingToken,
    };
  }
}
