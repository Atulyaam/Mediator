/**
 * Mediator IDE Extension — Local State
 *
 * Manages local app state only. Does NOT run shell commands.
 * The only mutations here are to in-memory state and VS Code UI.
 */

import {
  TaskState,
  type TaskStateValue,
  type TaskSession,
  createTaskSession,
  applyTransition,
} from '@mediator/task-domain';
import {
  type ExecutorCapability,
  type CapabilityStatus,
  type CanonicalProviderId,
  type ProviderMode,
  type ProviderConnectionStatus,
} from '@mediator/shared-contracts';
import {
  type WorkspaceRootState,
  inspectWorkspaceRoot,
} from '@mediator/workspace-boundary';
import { type ReviewPanelState } from './diffPanelController.js';
import { type HandoffPanelState } from './handoffPanelController.js';

// ─── Multi-Provider State (S29) ───────────────────────────────────────────

export interface ProviderItemState {
  readonly id: CanonicalProviderId;
  readonly name: string;
  readonly supportedModes: readonly ProviderMode[];
  readonly status: ProviderConnectionStatus;
  readonly hasCredential: boolean;
  readonly keyLastFour?: string | undefined;
  readonly selectedModelId: string;
  readonly availableModels: readonly string[];
  readonly lastError?: string | undefined;
}

export interface ProviderSelectionState {
  readonly activeProviderId: CanonicalProviderId;
  readonly activeMode: ProviderMode;
  readonly activeModelId: string;
  readonly providers: readonly ProviderItemState[];
}

// ─── Mediator run state ────────────────────────────────────────────────────

export type MediatorRunState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface MediatorLocalState {
  readonly runState: MediatorRunState;
  readonly workspace: WorkspaceRootState | null;
  readonly workspaceRoot: string | null;
  readonly workspaceConfirmed: boolean;
  readonly taskSession: TaskSession | null;
  readonly capabilities: DetectedCapabilities;
  readonly reviewState: ReviewPanelState | null;
  readonly handoffState: HandoffPanelState | null;
  readonly providerState: ProviderSelectionState;
  readonly errorMessage: string | null;
  readonly version: string;
}

export interface DetectedCapabilities {
  readonly ideAdapter: CapabilityStatus;
  readonly executor: CapabilityStatus;
  readonly browserExtension: CapabilityStatus;
  readonly nativeHost: CapabilityStatus;
  readonly mcpServer: CapabilityStatus;
  readonly executorDetail: ExecutorCapability | null;
}

export { type CapabilityStatus };

// ─── Initial state ─────────────────────────────────────────────────────────

export function createInitialState(
  workspaceInput: string | WorkspaceRootState | null,
): MediatorLocalState {
  let wsState: WorkspaceRootState | null = null;
  if (typeof workspaceInput === 'string') {
    wsState = inspectWorkspaceRoot(workspaceInput, 'ide');
  } else if (workspaceInput) {
    wsState = workspaceInput;
  }

  return {
    runState: 'stopped',
    workspace: wsState,
    workspaceRoot: wsState?.canonicalPath ?? wsState?.selectedPath ?? null,
    workspaceConfirmed: wsState?.confirmationStatus === 'confirmed',
    taskSession: null,
    capabilities: createInitialCapabilities(),
    reviewState: null,
    handoffState: null,
    providerState: createInitialProviderState(),
    errorMessage: null,
    version: '0.0.1',
  };
}

export function createInitialProviderState(): ProviderSelectionState {
  return {
    activeProviderId: 'gemini',
    activeMode: 'browser',
    activeModelId: 'gemini-1.5-pro',
    providers: [
      {
        id: 'openai',
        name: 'OpenAI ChatGPT',
        supportedModes: ['browser', 'api', 'manual'],
        status: 'not-configured',
        hasCredential: false,
        selectedModelId: 'gpt-4o',
        availableModels: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],
      },
      {
        id: 'gemini',
        name: 'Google Gemini',
        supportedModes: ['browser', 'api', 'manual'],
        status: 'not-configured',
        hasCredential: false,
        selectedModelId: 'gemini-1.5-pro',
        availableModels: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash'],
      },
      {
        id: 'claude',
        name: 'Anthropic Claude',
        supportedModes: ['api', 'manual', 'browser'],
        status: 'not-configured',
        hasCredential: false,
        selectedModelId: 'claude-3-5-sonnet-20241022',
        availableModels: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
      },
      {
        id: 'deepseek',
        name: 'DeepSeek',
        supportedModes: ['api', 'manual', 'browser'],
        status: 'not-configured',
        hasCredential: false,
        selectedModelId: 'deepseek-chat',
        availableModels: ['deepseek-chat', 'deepseek-reasoner'],
      },
    ],
  };
}

function createInitialCapabilities(): DetectedCapabilities {
  return {
    // IDE adapter is always available when extension is running
    ideAdapter: 'available',
    // Executor is disabled in Review-only V1 (ADR-002)
    executor: 'disabled',
    // Browser extension and native host not yet installed
    browserExtension: 'unknown',
    nativeHost: 'unknown',
    // MCP server not yet started
    mcpServer: 'unavailable',
    executorDetail: null,
  };
}

// ─── State transitions (local only, no side effects) ──────────────────────

export function withRunState(
  state: MediatorLocalState,
  runState: MediatorRunState,
  errorMessage?: string,
): MediatorLocalState {
  return {
    ...state,
    runState,
    errorMessage: errorMessage ?? null,
  };
}

export function withWorkspace(
  state: MediatorLocalState,
  workspaceRoot: string | null,
  confirmed: boolean,
): MediatorLocalState {
  if (!workspaceRoot) {
    return {
      ...state,
      workspace: null,
      workspaceRoot: null,
      workspaceConfirmed: false,
    };
  }

  let ws: WorkspaceRootState;
  if (state.workspace && state.workspace.selectedPath === workspaceRoot) {
    ws = { ...state.workspace };
  } else {
    ws = inspectWorkspaceRoot(workspaceRoot, 'ide');
  }

  if (confirmed) {
    ws = {
      ...ws,
      confirmationStatus: 'confirmed',
      confirmationTimestamp: ws.confirmationTimestamp ?? Date.now(),
    };
  } else {
    ws = {
      ...ws,
      confirmationStatus: 'pending',
      confirmationTimestamp: undefined,
    };
  }

  return {
    ...state,
    workspace: ws,
    workspaceRoot: ws.canonicalPath ?? ws.selectedPath,
    workspaceConfirmed: confirmed,
  };
}

export function withWorkspaceState(
  state: MediatorLocalState,
  workspace: WorkspaceRootState | null,
): MediatorLocalState {
  return {
    ...state,
    workspace,
    workspaceRoot: workspace?.canonicalPath ?? workspace?.selectedPath ?? null,
    workspaceConfirmed: workspace?.confirmationStatus === 'confirmed',
  };
}

export function withReviewState(
  state: MediatorLocalState,
  reviewState: ReviewPanelState | null,
): MediatorLocalState {
  return {
    ...state,
    reviewState,
  };
}

export function withNewTaskSession(
  state: MediatorLocalState,
  taskId: string,
  sessionId: string,
  correlationId: string,
): MediatorLocalState {
  const session = createTaskSession(taskId, sessionId, correlationId);
  return { ...state, taskSession: session };
}

export function withTaskTransition(
  state: MediatorLocalState,
  to: TaskStateValue,
  correlationId: string,
  reason?: string,
): MediatorLocalState {
  if (!state.taskSession) return state;
  const result = applyTransition(state.taskSession, {
    from: state.taskSession.state,
    to,
    correlationId,
    reason,
    actor: 'orchestrator',
  });
  if (!result.ok) {
    return { ...state, errorMessage: result.error.message };
  }
  return { ...state, taskSession: result.value };
}

export function withHandoffState(
  state: MediatorLocalState,
  handoffState: HandoffPanelState | null,
): MediatorLocalState {
  return {
    ...state,
    handoffState,
  };
}

// ─── Display helpers ───────────────────────────────────────────────────────

export function getStatusBarText(state: MediatorLocalState): string {
  const icon = getRunStateIcon(state.runState);
  const taskInfo = state.taskSession
    ? ` · ${formatTaskState(state.taskSession.state)}`
    : '';
  return `${icon} Mediator${taskInfo}`;
}

export function getStatusBarTooltip(state: MediatorLocalState): string {
  const lines: string[] = [`Mediator v${state.version}`, `Status: ${state.runState}`];

  if (state.workspace && state.workspace.selectedPath) {
    const ws = state.workspace;
    const confirmed = state.workspaceConfirmed ? '✓' : '⚠ unconfirmed';
    const cloud = ws.cloudStatus === 'onedrive_redirected' ? ' [OneDrive]' : '';
    lines.push(`Workspace: ${ws.selectedPath} (${confirmed})${cloud}`);
    if (ws.canonicalPath && ws.canonicalPath.toLowerCase() !== ws.selectedPath.toLowerCase()) {
      lines.push(`Canonical: ${ws.canonicalPath}`);
    }
  } else if (state.workspaceRoot) {
    const confirmed = state.workspaceConfirmed ? '✓' : '⚠ unconfirmed';
    lines.push(`Workspace: ${state.workspaceRoot} (${confirmed})`);
  } else {
    lines.push('Workspace: not selected');
  }

  if (state.taskSession) {
    lines.push(`Task: ${state.taskSession.taskId}`);
    lines.push(`State: ${state.taskSession.state}`);
    lines.push(`Round: ${state.taskSession.roundCount}/${state.taskSession.maxRounds}`);
  }

  if (state.errorMessage) {
    lines.push(`Error: ${state.errorMessage}`);
  }

  return lines.join('\n');
}

function getRunStateIcon(runState: MediatorRunState): string {
  switch (runState) {
    case 'stopped': return '$(circle-slash)';
    case 'starting': return '$(sync~spin)';
    case 'running': return '$(circle-filled)';
    case 'stopping': return '$(sync~spin)';
    case 'error': return '$(error)';
  }
}

function formatTaskState(state: TaskStateValue): string {
  return state.toLowerCase().replace(/_/g, ' ');
}

export function formatCapabilityStatus(status: CapabilityStatus): string {
  switch (status) {
    case 'available':
    case 'supported':
      return '✓ Available';
    case 'unavailable':
      return '✗ Unavailable';
    case 'permission_denied':
      return '⚠ Permission Denied';
    case 'not_yet_verified':
      return '? Not Yet Verified';
    case 'unknown':
      return '? Unknown';
    case 'disabled':
      return '— Disabled (Review-only mode)';
    default:
      return '? Unknown';
  }
}

export { TaskState };
