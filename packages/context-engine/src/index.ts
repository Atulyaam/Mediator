/**
 * @mediator/context-engine
 *
 * Sprint S11 — Compact Context Engine & Project Memory
 *
 * Build a modular local context engine that selects the smallest useful set
 * of project information for the next AI reasoning step.
 *
 * Core invariants:
 * - Never bypasses workspace containment (S04/S05), secret exclusions (S06),
 *   policy validation (S07), or protocol limits (S08/S09).
 * - Web AI conversation remains the primary reasoning state.
 * - Mediator stores only compact project memory and verified local state.
 * - Strict evidence provenance: agent-reported claims never elevated to verified.
 * - Actual serialized UTF-8 byte budgets with clearly labelled token estimates.
 */

export * from './errors.js';
export * from './projectMap.js';
export * from './projectRules.js';
export * from './decisionMemory.js';
export * from './knownIssues.js';
export * from './taskSummary.js';
export * from './contextRanker.js';
export * from './contextBudget.js';
export * from './contextAssembler.js';
export * from './contextMemoryService.js';
export * from './webResearchService.js';

