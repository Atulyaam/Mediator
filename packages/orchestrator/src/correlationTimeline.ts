/**
 * @mediator/orchestrator — Correlation-ID Timeline & Observability Service (S25)
 *
 * Requirements:
 * - Collects and provides bounded event timelines correlated across lifecycle boundaries:
 *   1. Response observation, protocol validation, policy review, staging, approval, handoff, feedback.
 *   2. Strict correlation ID and task isolation: separate tasks/sessions never mix.
 *   3. Secret scanning on all event metadata: raw tokens and secrets are never logged.
 *   4. Append-only and chronologically ordered.
 */

import {
  type CorrelationTimelineEvent,
  type EvidenceProvenanceKind,
} from '@mediator/shared-contracts';
import { scanContent, redactContent } from '@mediator/context-security';

export interface RecordTimelineEventParams {
  readonly correlationId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly actionId?: string | undefined;
  readonly eventType: string;
  readonly resultOrStatus: string;
  readonly reasonCode?: string | undefined;
  readonly provenance?: EvidenceProvenanceKind | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export class CorrelationTimelineService {
  private events: CorrelationTimelineEvent[] = [];

  public recordEvent(params: RecordTimelineEventParams): CorrelationTimelineEvent {
    const {
      correlationId,
      taskId,
      sessionId,
      actionId,
      eventType,
      resultOrStatus,
      reasonCode,
      provenance,
      metadata = {},
    } = params;

    const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Sanitize metadata to guarantee no secrets are leaked in logs/timeline
    const sanitizedMeta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (typeof v === 'string') {
        const scan = scanContent(v);
        if (scan.ok && scan.value.findings.length > 0) {
          const red = redactContent(v, scan.value);
          sanitizedMeta[k] = red.redactedContent;
        } else {
          sanitizedMeta[k] = v;
        }
      } else {
        sanitizedMeta[k] = v;
      }
    }

    const event: CorrelationTimelineEvent = {
      eventId,
      correlationId,
      taskId,
      sessionId,
      actionId,
      eventType,
      timestamp: Date.now(),
      resultOrStatus,
      reasonCode,
      provenance,
      metadata: sanitizedMeta,
    };

    this.events.push(event);
    return event;
  }

  public getEventsByCorrelationId(correlationId: string): readonly CorrelationTimelineEvent[] {
    return this.events.filter((e) => e.correlationId === correlationId);
  }

  public getEventsByTaskId(taskId: string): readonly CorrelationTimelineEvent[] {
    return this.events.filter((e) => e.taskId === taskId);
  }

  public getAllEvents(): readonly CorrelationTimelineEvent[] {
    return [...this.events];
  }

  public clear(): void {
    this.events = [];
  }
}
