/**
 * @mediator/ide-extension — Handoff Panel Controller (Sprint S17)
 *
 * Coordinates IDE extension UI interactions for:
 * 1. Prepare IDE Agent Handoff (bounded prompt generation)
 * 2. Copy Handoff Prompt (manual transfer to IDE agent)
 * 3. Mark Waiting for IDE Agent (pull-based awaiting report)
 * 4. Ingest / Paste Agent Report (untrusted ingestion & discrepancy check)
 * 5. Cancel Handoff
 * 6. Resolve Pending Review Request (trusted human resolution)
 *
 * Invariants:
 * - Never claims automated external connection or push dispatch.
 * - Waiting state means Mediator is awaiting manual return of agent report.
 * - Only trusted local UI callers can resolve pending reviews.
 */

import {
  type HandoffRecord,
  type IngestReportResult,
  type PendingReviewRequest,
} from '@mediator/shared-contracts';
import { type CallerIdentity } from '@mediator/policy-engine';
import {
  type HandoffService,
  type ReviewIntakeService,
  type PrepareHandoffParams,
} from '@mediator/stage-store';

export interface HandoffPanelState {
  readonly currentHandoff: HandoffRecord | null;
  readonly promptText: string | null;
  readonly lastCopySuccess: boolean | null;
  readonly waitingForAgent: boolean;
  readonly lastIngestResult: IngestReportResult | null;
  readonly lastIngestError: string | null;
  readonly pendingReviewRequests: readonly PendingReviewRequest[];
  readonly errorMessage: string | null;
  readonly statusMessage: string | null;
  readonly isConnectedToExternalAgent: false; // Invariant: ALWAYS false
}

export type ClipboardWriter = (text: string) => Promise<boolean | void>;

export class HandoffPanelController {
  private state: HandoffPanelState;

  constructor(
    private readonly handoffService: HandoffService,
    private readonly reviewIntakeService: ReviewIntakeService | null,
    private readonly clipboardWriter: ClipboardWriter,
    initialHandoff: HandoffRecord | null = null,
  ) {
    this.state = {
      currentHandoff: initialHandoff,
      promptText: null,
      lastCopySuccess: null,
      waitingForAgent: initialHandoff?.status === 'waiting-for-agent',
      lastIngestResult: null,
      lastIngestError: null,
      pendingReviewRequests: [],
      errorMessage: null,
      statusMessage: null,
      isConnectedToExternalAgent: false,
    };
  }

  public getState(): HandoffPanelState {
    return this.state;
  }

  /**
   * Action 1: Prepare IDE Agent Handoff
   * Validates task/scope, creates bounded prompt, updates controller state.
   */
  public prepareHandoff(input: PrepareHandoffParams): Promise<HandoffPanelState> {
    try {
      const res = this.handoffService.prepareHandoff(input);
      if (!res.ok) {
        this.state = {
          ...this.state,
          errorMessage: `Failed to prepare handoff: [${res.error.code}] ${res.error.message}`,
          statusMessage: 'Error preparing handoff.',
        };
        return Promise.resolve(this.state);
      }

      const { handoff, prompt } = res.value;
      const pendingReviews = this.reviewIntakeService
        ? this.reviewIntakeService.listRequestsForTask(input.taskId)
        : [];

      this.state = {
        ...this.state,
        currentHandoff: handoff,
        promptText: prompt,
        lastCopySuccess: null,
        waitingForAgent: false,
        lastIngestResult: null,
        lastIngestError: null,
        pendingReviewRequests: pendingReviews,
        errorMessage: null,
        statusMessage: `Handoff ${handoff.handoffId} prepared. Copy the prompt to transfer manually to your IDE agent.`,
      };
      return Promise.resolve(this.state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state = {
        ...this.state,
        errorMessage: `Failed to prepare handoff: ${message}`,
        statusMessage: 'Error preparing handoff.',
      };
      return Promise.resolve(this.state);
    }
  }

  /**
   * Action 2: Copy Handoff Prompt
   * Copies prepared bounded prompt to system clipboard.
   * Explicitly reports success or failure; never claims agent was contacted.
   */
  public async copyPromptToClipboard(): Promise<{ success: boolean; error?: string }> {
    if (!this.state.promptText) {
      const err = 'No prompt available to copy. Prepare handoff first.';
      this.state = {
        ...this.state,
        lastCopySuccess: false,
        errorMessage: err,
      };
      return { success: false, error: err };
    }

    try {
      const writeResult = await this.clipboardWriter(this.state.promptText);
      const ok = writeResult !== false;
      this.state = {
        ...this.state,
        lastCopySuccess: ok,
        errorMessage: ok ? null : 'Clipboard write failed.',
        statusMessage: ok
          ? 'Handoff prompt copied to clipboard. Paste into your IDE agent chat manually.'
          : 'Failed to write to clipboard.',
      };
      return ok
        ? { success: true }
        : { success: false, error: 'Clipboard write returned false.' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state = {
        ...this.state,
        lastCopySuccess: false,
        errorMessage: `Clipboard copy error: ${message}`,
      };
      return { success: false, error: message };
    }
  }

  public copyPrompt(): Promise<{ success: boolean; error?: string }> {
    return this.copyPromptToClipboard();
  }

  /**
   * Action 3: Mark Waiting for IDE Agent
   * Enters waiting state, acknowledging prompt was transferred manually.
   */
  public markWaitingForAgent(): Promise<HandoffPanelState> {
    if (!this.state.currentHandoff) {
      this.state = {
        ...this.state,
        errorMessage: 'Cannot wait for agent: no active handoff record.',
      };
      return Promise.resolve(this.state);
    }

    try {
      const res = this.handoffService.markWaitingForAgent(this.state.currentHandoff.handoffId);
      if (!res.ok) {
        this.state = {
          ...this.state,
          errorMessage: `Failed to enter waiting state: [${res.error.code}] ${res.error.message}`,
        };
        return Promise.resolve(this.state);
      }

      this.state = {
        ...this.state,
        currentHandoff: res.value,
        waitingForAgent: true,
        errorMessage: null,
        statusMessage: 'Waiting for manual return of agent report. (No automated connection active)',
      };
      return Promise.resolve(this.state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state = {
        ...this.state,
        errorMessage: `Failed to enter waiting state: ${message}`,
      };
      return Promise.resolve(this.state);
    }
  }

  /**
   * Action 4: Ingest / Paste Agent Report
   * Ingests untrusted report, validates schema and scope, detects discrepancies,
   * assigns agent-reported provenance.
   */
  public ingestReport(rawReport: unknown): Promise<{
    success: boolean;
    result?: IngestReportResult;
    error?: string;
  }> {
    if (!this.state.currentHandoff) {
      const err = 'No active handoff to receive report.';
      this.state = { ...this.state, errorMessage: err };
      return Promise.resolve({ success: false, error: err });
    }

    const handoffId = this.state.currentHandoff.handoffId;
    const ingestRes = this.handoffService.ingestReport(handoffId, rawReport);

    if (!ingestRes.ok) {
      const errMsg = `Report rejected: [${ingestRes.error.code}] ${ingestRes.error.message}`;
      this.state = {
        ...this.state,
        lastIngestResult: null,
        lastIngestError: errMsg,
        errorMessage: errMsg,
        statusMessage: `Report rejected (${ingestRes.error.code}).`,
      };
      return Promise.resolve({ success: false, error: ingestRes.error.message });
    }

    const result = ingestRes.value;

    // Refresh handoff record
    const updatedHandoff = this.handoffService.getHandoff(handoffId);
    const pendingReviews = this.reviewIntakeService && this.state.currentHandoff
      ? this.reviewIntakeService.listRequestsForTask(this.state.currentHandoff.taskId)
      : [];

    this.state = {
      ...this.state,
      currentHandoff: updatedHandoff,
      waitingForAgent: false,
      lastIngestResult: result,
      lastIngestError: null,
      pendingReviewRequests: pendingReviews,
      errorMessage: null,
      statusMessage: `Report ingested successfully (Provenance: agent-reported, Discrepancies: ${result.discrepancies.length}).`,
    };

    return Promise.resolve({ success: true, result });
  }

  /**
   * Action 5: Cancel Handoff
   * Cancels active handoff and stops waiting.
   */
  public cancelHandoff(reason = 'Cancelled by user in IDE UI'): Promise<HandoffPanelState> {
    if (!this.state.currentHandoff) {
      this.state = {
        ...this.state,
        errorMessage: 'No active handoff to cancel.',
      };
      return Promise.resolve(this.state);
    }

    try {
      const res = this.handoffService.cancelHandoff(
        this.state.currentHandoff.handoffId,
        reason,
      );
      if (!res.ok) {
        this.state = {
          ...this.state,
          errorMessage: `Failed to cancel handoff: [${res.error.code}] ${res.error.message}`,
        };
        return Promise.resolve(this.state);
      }

      this.state = {
        ...this.state,
        currentHandoff: res.value,
        waitingForAgent: false,
        errorMessage: null,
        statusMessage: `Handoff ${res.value.handoffId} cancelled.`,
      };
      return Promise.resolve(this.state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state = {
        ...this.state,
        errorMessage: `Failed to cancel handoff: ${message}`,
      };
      return Promise.resolve(this.state);
    }
  }

  /**
   * Action 6: Resolve Pending Review Request
   * Restricted to trusted local UI caller identity only.
   */
  public resolveReviewRequest(
    requestId: string,
    decision: 'approved' | 'rejected',
    caller: CallerIdentity,
    currentPayloadHash?: string,
    notes?: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.reviewIntakeService) {
      return Promise.resolve({ success: false, error: 'Review intake service unavailable.' });
    }

    const res = this.reviewIntakeService.resolveReviewRequest({
      requestId,
      resolution: decision === 'approved' ? 'approved' : 'denied',
      caller,
      currentPayloadHash,
      resolutionReason: notes,
    });

    if (!res.ok) {
      return Promise.resolve({ success: false, error: `[${res.error.code}] ${res.error.message}` });
    }

    // Refresh pending list
    if (this.state.currentHandoff) {
      const pending = this.reviewIntakeService.listRequestsForTask(this.state.currentHandoff.taskId);
      this.state = {
        ...this.state,
        pendingReviewRequests: pending,
        statusMessage: `Review request ${requestId} marked ${decision}.`,
      };
    }

    return Promise.resolve({ success: true });
  }
}
