import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  withRunState,
  withWorkspace,
  withNewTaskSession,
  withTaskTransition,
  getStatusBarText,
  getStatusBarTooltip,
  formatCapabilityStatus,
  TaskState,
} from './mediatorState.js';

describe('createInitialState', () => {
  it('starts in stopped state with no task session', () => {
    const s = createInitialState('C:\\Users\\test\\project');
    expect(s.runState).toBe('stopped');
    expect(s.taskSession).toBeNull();
    expect(s.workspaceConfirmed).toBe(false);
    expect(s.errorMessage).toBeNull();
  });

  it('executor capability is disabled (Review-only V1)', () => {
    const s = createInitialState(null);
    expect(s.capabilities.executor).toBe('disabled');
  });

  it('IDE adapter is available when extension is loaded', () => {
    const s = createInitialState(null);
    expect(s.capabilities.ideAdapter).toBe('available');
  });

  it('accepts null workspace root', () => {
    const s = createInitialState(null);
    expect(s.workspaceRoot).toBeNull();
  });
});

describe('withRunState', () => {
  it('transitions stopped → running', () => {
    const s = createInitialState('/workspace');
    const next = withRunState(s, 'running');
    expect(next.runState).toBe('running');
    expect(s.runState).toBe('stopped'); // original immutable
  });

  it('captures error message', () => {
    const s = createInitialState('/workspace');
    const next = withRunState(s, 'error', 'core not found');
    expect(next.runState).toBe('error');
    expect(next.errorMessage).toBe('core not found');
  });

  it('clears error when transitioning away from error', () => {
    const s = withRunState(createInitialState('/workspace'), 'error', 'oops');
    const next = withRunState(s, 'stopped');
    expect(next.errorMessage).toBeNull();
  });
});

describe('withWorkspace', () => {
  it('sets workspace root and confirmed flag', () => {
    const s = createInitialState(null);
    const next = withWorkspace(s, 'C:\\project', true);
    expect(next.workspaceRoot).toBe('C:\\project');
    expect(next.workspaceConfirmed).toBe(true);
  });

  it('does not mutate original', () => {
    const s = createInitialState(null);
    withWorkspace(s, 'C:\\project', true);
    expect(s.workspaceRoot).toBeNull();
  });
});

describe('withNewTaskSession', () => {
  it('creates a task session in IDLE state', () => {
    const s = createInitialState('/workspace');
    const next = withNewTaskSession(s, 'task-1', 'session-1', 'corr-1');
    expect(next.taskSession).not.toBeNull();
    expect(next.taskSession?.state).toBe(TaskState.IDLE);
    expect(next.taskSession?.taskId).toBe('task-1');
    expect(next.taskSession?.roundCount).toBe(0);
  });
});

describe('withTaskTransition', () => {
  it('transitions task session state', () => {
    let s = createInitialState('/workspace');
    s = withNewTaskSession(s, 'task-1', 'session-1', 'corr-1');
    const next = withTaskTransition(s, TaskState.ATTACHED, 'corr-2');
    expect(next.taskSession?.state).toBe(TaskState.ATTACHED);
  });

  it('records error message on invalid transition', () => {
    let s = createInitialState('/workspace');
    s = withNewTaskSession(s, 'task-1', 'session-1', 'corr-1');
    // IDLE → EXECUTING is not allowed
    const next = withTaskTransition(s, TaskState.EXECUTING, 'corr-bad');
    expect(next.errorMessage).not.toBeNull();
    expect(next.taskSession?.state).toBe(TaskState.IDLE); // unchanged
  });

  it('is a no-op when there is no active session', () => {
    const s = createInitialState('/workspace');
    expect(s.taskSession).toBeNull();
    const next = withTaskTransition(s, TaskState.ATTACHED, 'corr-1');
    expect(next.taskSession).toBeNull();
  });
});

describe('getStatusBarText', () => {
  it('shows stopped icon when stopped', () => {
    const s = createInitialState('/workspace');
    const text = getStatusBarText(s);
    expect(text).toContain('Mediator');
    expect(text).toContain('$(circle-slash)');
  });

  it('shows task state when session active', () => {
    let s = createInitialState('/workspace');
    s = withNewTaskSession(s, 'task-1', 'session-1', 'corr-1');
    s = withTaskTransition(s, TaskState.ATTACHED, 'corr-2');
    const text = getStatusBarText(s);
    expect(text).toContain('attached');
  });
});

describe('getStatusBarTooltip', () => {
  it('includes version and run state', () => {
    const s = createInitialState('/workspace');
    const tip = getStatusBarTooltip(s);
    expect(tip).toContain('stopped');
    expect(tip).toContain('0.0.1');
  });

  it('includes workspace root when set', () => {
    const s = createInitialState('C:\\my\\project');
    const tip = getStatusBarTooltip(s);
    expect(tip).toContain('C:\\my\\project');
  });

  it('shows unconfirmed warning', () => {
    const s = createInitialState('C:\\project');
    expect(s.workspaceConfirmed).toBe(false);
    const tip = getStatusBarTooltip(s);
    expect(tip).toContain('unconfirmed');
  });
});

describe('formatCapabilityStatus', () => {
  it('formats all statuses', () => {
    expect(formatCapabilityStatus('available')).toContain('Available');
    expect(formatCapabilityStatus('unavailable')).toContain('Unavailable');
    expect(formatCapabilityStatus('unknown')).toContain('Unknown');
    expect(formatCapabilityStatus('disabled')).toContain('Disabled');
  });
});
