/**
 * @mediator/stage-store
 *
 * Sprint S12 — Shadow Staging Store & Isolated Change Preview
 *
 * Provides a task-scoped shadow staging store holding proposed file changes
 * separately from the live project.
 *
 * Core invariant:
 * No AI-proposed file content may modify the original workspace during S12.
 */

export * from './stageTypes.js';
export * from './stageErrors.js';
export * from './stageStorage.js';
export * from './stageSnapshot.js';
export * from './stageConflicts.js';
export * from './stageDiff.js';
export * from './stageChanges.js';
export * from './stageCheckpoint.js';
export * from './stageRepository.js';
export * from './stageStore.js';
export * from './patchTypes.js';
export * from './patchErrors.js';
export * from './patchValidator.js';
export * from './patchConflictService.js';
export * from './patchEngine.js';
export * from './applyTypes.js';
export * from './applyErrors.js';
export * from './approvalService.js';
export * from './applyJournal.js';
export * from './applyService.js';
export * from './handoffService.js';
export * from './reviewIntakeService.js';
