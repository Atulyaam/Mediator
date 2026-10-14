/**
 * @mediator/persistence
 *
 * Sprint S10 — SQLite Task/Action Ledger & Audit Events
 *
 * Provides a local SQLite persistence layer that records Mediator task progress,
 * accepted actions, approvals, evidence, and tamper-evident audit events.
 *
 * Core invariant:
 * After a restart, Mediator must not assume that an action with an uncertain
 * outcome completed successfully, and it must never blindly replay that action.
 */

export * from './errors.js';
export * from './database.js';
export * from './migrations.js';
export * from './auditEvent.js';
export * from './auditRepository.js';
export * from './recovery.js';
export * from './dataRetention.js';
export * from './repositories/index.js';
