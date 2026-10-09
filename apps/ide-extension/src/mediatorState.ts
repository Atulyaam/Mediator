/**
 * Mediator IDE Extension — Local State
 *
 * Manages local app state only. Does NOT run shell commands.
 * The only mutations here are to in-memory state and VS Code UI.
 */

import { TaskState, type TaskStateValue, createTaskSession, applyTransition } from '@mediator/task-domain';
import { type TaskSession } from '@mediator/task-domain';
import { type ExecutorCapability } from '@mediator/shared-contracts';

// ─── Mediator run state ────────────────────────────────────────────────────

export type MediatorRunState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface MediatorLocalState {
  readonly runState: MediatorRunState;
  readonly workspaceRoot: string | null;
  readonly workspaceConfirmed: boolean;
  readonly taskSession: TaskSession | null;
  readonly capabilities: DetectedCapabilities;
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

export type CapabilityStatus = 'available' | 'unavailable' | 'unknown' | 'disabled';

// ─── Initial state ─────────────────────────────────────────────────────────

export function createInitialState(workspaceRoot: string | null): MediatorLocalState {
  return {
    runState: 'stopped',
    workspaceRoot,
    workspaceConfirmed: false,
    taskSession: null,
    capabilities: createInitialCapabilities(),
    errorMessage: null,
    version: '0.0.1',
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
  return { ...state, workspaceRoot, workspaceConfirmed: confirmed };
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

  if (state.workspaceRoot) {
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
    case 'available': return '✓ Available';
    case 'unavailable': return '✗ Unavailable';
    case 'unknown': return '? Unknown';
    case 'disabled': return '— Disabled (Review-only mode)';
  }
}

export { TaskState };
