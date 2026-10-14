/**
 * @mediator/browser-extension — Manual Prepared Draft Manager (Sprint S18)
 *
 * Requirements:
 * - Accepts bounded, locally prepared message drafts (max 8 KB).
 * - Validates schema, active attached tab/conversation identity, and size.
 * - Shows exact draft to user before any insertion or copy.
 * - Provides copy/manual-paste fallback if composer detection fails.
 * - Requires explicit user action to submit/send. Never automatically sends.
 * - Pauses on tab switch, conversation navigation, or uncertain composer.
 */

import {
  type PreparedDraft,
  type DraftPreparationResult,
  type MinimalDocument,
  MAX_PREPARED_DRAFT_BYTES,
} from './providerTypes.js';
import { type ProviderAdapter } from './providerAdapter.js';
import { type AttachManager } from './attachManager.js';

export interface PrepareDraftInput {
  readonly text: string;
  readonly targetConversationId?: string | undefined;
}

export class DraftManager {
  private activeDraft: PreparedDraft | null = null;

  constructor(
    private readonly providerAdapter: ProviderAdapter,
    private readonly attachManager: AttachManager,
  ) {}

  public getActiveDraft(): PreparedDraft | null {
    return this.activeDraft;
  }

  /**
   * Step 1: Prepare draft message with size validation and conversational binding
   */
  public prepareDraft(input: PrepareDraftInput): DraftPreparationResult {
    const attachState = this.attachManager.getState();

    // 1. Check attach state
    if (attachState.status !== 'attached') {
      return {
        ok: false,
        status: 'rejected-uncertain-state',
        reason: 'Cannot prepare draft: extension is not attached to an active provider tab.',
      };
    }

    // 2. Validate byte size
    const byteLength = new TextEncoder().encode(input.text).length;
    if (byteLength > MAX_PREPARED_DRAFT_BYTES) {
      return {
        ok: false,
        status: 'rejected-oversized',
        reason: `Draft exceeds maximum allowed size (${byteLength} > ${MAX_PREPARED_DRAFT_BYTES} bytes).`,
      };
    }

    if (input.text.trim().length === 0) {
      return {
        ok: false,
        status: 'rejected-uncertain-state',
        reason: 'Draft text cannot be empty.',
      };
    }

    // 3. Conversation binding check
    if (
      input.targetConversationId &&
      attachState.conversationId &&
      input.targetConversationId !== attachState.conversationId
    ) {
      return {
        ok: false,
        status: 'rejected-uncertain-state',
        reason: `Draft target conversation "${input.targetConversationId}" does not match active conversation "${attachState.conversationId}".`,
      };
    }

    const draftId = `draft_${Math.random().toString(36).slice(2, 10)}`;
    const draft: PreparedDraft = {
      draftId,
      text: input.text,
      targetConversationId: attachState.conversationId ?? undefined,
      createdAt: Date.now(),
      byteLength,
    };

    this.activeDraft = draft;

    return {
      ok: true,
      status: 'ready-for-review',
      draft,
      fallbackCopyText: draft.text,
    };
  }

  /**
   * Step 2: Attempt composer insertion or fallback to manual copy
   */
  public insertIntoComposer(doc: MinimalDocument): DraftPreparationResult {
    if (!this.activeDraft) {
      return {
        ok: false,
        status: 'rejected-uncertain-state',
        reason: 'No prepared draft available to insert.',
      };
    }

    return this.providerAdapter.prepareDraftInComposer(doc, this.activeDraft);
  }

  /**
   * Clear active draft
   */
  public clearDraft(): void {
    this.activeDraft = null;
  }
}
