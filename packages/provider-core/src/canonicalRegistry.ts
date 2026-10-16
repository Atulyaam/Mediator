/**
 * @mediator/provider-core — Unified Provider Registry
 *
 * Central authority for managing supported AI providers (OpenAI, Gemini, Claude, DeepSeek)
 * for the authenticated web-AI workflow and manual review.
 *
 * Non-Negotiable Invariants:
 * - Single source of truth for canonical provider IDs.
 * - Switching active provider invalidates or revalidates pending operations and approvals.
 * - Never silently switches providers or falls back across modes.
 * - Disabled or unconfigured modes are never reported as connected.
 * - Unknown provider IDs fail-closed with PROVIDER_UNKNOWN.
 */

import {
  type CanonicalProviderId,
  type ProviderMode,
  type ProviderConnectionId,
  type ProviderConnectionStatus,
  type ProviderMetadata,
  type ProviderModelConfig,
  type Result,
  type MediatorError,
  ErrorCode,
  makeMediatorError,
  ok,
  err,
  isCanonicalProviderId,
  CANONICAL_PROVIDER_IDS,
  PROVIDER_MODES,
} from '@mediator/shared-contracts';
import { AUTHORITATIVE_PROVIDER_METADATA } from './catalogues.js';

export interface ProviderStateSummary {
  readonly providerId: CanonicalProviderId;
  readonly displayName: string;
  readonly activeMode: ProviderMode;
  readonly status: ProviderConnectionStatus;
  readonly hasCredential?: boolean;
  readonly keyLastFour?: string | undefined;
  readonly selectedModelId: string;
  readonly availableModels: readonly ProviderModelConfig[];
  readonly supportedModes: readonly ProviderMode[];
  readonly lastError?: string | undefined;
}

export interface UnifiedRegistryOptions {
  readonly defaultProvider?: CanonicalProviderId;
  readonly defaultMode?: ProviderMode;
}

export class UnifiedProviderRegistry {
  private activeProviderId: CanonicalProviderId;
  private activeMode: ProviderMode;
  private readonly selectedModels = new Map<CanonicalProviderId, string>();
  private readonly providerStatuses = new Map<CanonicalProviderId, ProviderConnectionStatus>();
  private readonly lastErrors = new Map<CanonicalProviderId, string>();

  constructor(options?: UnifiedRegistryOptions) {
    this.activeProviderId = options?.defaultProvider ?? 'gemini';
    this.activeMode = options?.defaultMode ?? 'browser';

    // Initialize default models & initial status
    for (const id of CANONICAL_PROVIDER_IDS) {
      const meta = AUTHORITATIVE_PROVIDER_METADATA[id];
      if (meta?.defaultModelId) {
        this.selectedModels.set(id, meta.defaultModelId);
      }
      this.providerStatuses.set(id, 'not-configured');
    }
  }

  public getActiveProviderId(): CanonicalProviderId {
    return this.activeProviderId;
  }

  public getActiveMode(): ProviderMode {
    return this.activeMode;
  }

  public getActiveConnectionId(): ProviderConnectionId {
    return {
      provider: this.activeProviderId,
      mode: this.activeMode,
    };
  }

  public getMetadata(providerId: CanonicalProviderId): ProviderMetadata {
    if (!isCanonicalProviderId(providerId)) {
      throw new Error(`Unknown provider "${String(providerId)}"`);
    }
    return AUTHORITATIVE_PROVIDER_METADATA[providerId];
  }

  public listAllProviders(): readonly ProviderMetadata[] {
    return CANONICAL_PROVIDER_IDS.map((id) => AUTHORITATIVE_PROVIDER_METADATA[id]);
  }

  /**
   * Switches the active provider and/or mode.
   * INVARIANT: Rejects transition if active operations or approvals are pending.
   */
  public selectProvider(
    providerId: string,
    mode: string,
    hasPendingApprovalsOrActions = false,
  ): Result<ProviderConnectionId, MediatorError> {
    if (!isCanonicalProviderId(providerId as CanonicalProviderId)) {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_UNKNOWN,
          `Unknown provider "${providerId}". Valid providers are: ${CANONICAL_PROVIDER_IDS.join(', ')}.`,
          { detail: { providerId, allowed: CANONICAL_PROVIDER_IDS } },
        ),
      );
    }

    if (!PROVIDER_MODES.includes(mode as ProviderMode)) {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_MODE_UNSUPPORTED,
          `Unsupported provider mode "${mode}". Valid modes are: ${PROVIDER_MODES.join(', ')}.`,
          { detail: { mode, allowed: PROVIDER_MODES } },
        ),
      );
    }

    const canonicalId = providerId as CanonicalProviderId;
    const targetMode = mode as ProviderMode;
    const meta = AUTHORITATIVE_PROVIDER_METADATA[canonicalId];

    // Verify mode is supported by provider
    if (!meta.supportedModes.includes(targetMode)) {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_MODE_UNSUPPORTED,
          `Provider "${meta.displayName}" does not support mode "${targetMode}". Supported modes: ${meta.supportedModes.join(', ')}.`,
          { detail: { providerId: canonicalId, targetMode, supportedModes: meta.supportedModes } },
        ),
      );
    }

    // Security Gate: Switching active provider cannot inherit pending operations
    if (this.activeProviderId !== canonicalId || this.activeMode !== targetMode) {
      if (hasPendingApprovalsOrActions) {
        return err(
          makeMediatorError(
            ErrorCode.PROVIDER_SWITCH_NOT_ALLOWED,
            `Cannot switch provider from "${this.activeProviderId}" to "${canonicalId}" while active operations or approvals are pending. Invalidate or resolve pending operations first.`,
            { detail: { currentProvider: this.activeProviderId, targetProvider: canonicalId } },
          ),
        );
      }
    }

    this.activeProviderId = canonicalId;
    this.activeMode = targetMode;

    return ok({
      provider: canonicalId,
      mode: targetMode,
    });
  }

  /**
   * Sets the selected model for a provider after validating it against the catalogue.
   */
  public selectModel(
    providerId: CanonicalProviderId,
    modelId: string,
  ): Result<void, MediatorError> {
    if (!isCanonicalProviderId(providerId)) {
      return err(
        makeMediatorError(ErrorCode.PROVIDER_UNKNOWN, `Unknown provider "${String(providerId)}".`),
      );
    }

    const meta = AUTHORITATIVE_PROVIDER_METADATA[providerId];
    const exists = meta.availableModels.some((m) => m.id === modelId);
    if (!exists) {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_MODEL_UNSUPPORTED,
          `Model "${modelId}" is not a recognized model for "${meta.displayName}". Available models: ${meta.availableModels.map((m) => m.id).join(', ')}.`,
          { detail: { providerId, modelId, available: meta.availableModels.map((m) => m.id) } },
        ),
      );
    }

    this.selectedModels.set(providerId, modelId);
    return ok(undefined);
  }

  public getSelectedModel(providerId: CanonicalProviderId): string {
    const defaultModel = AUTHORITATIVE_PROVIDER_METADATA[providerId]?.defaultModelId ?? '';
    return this.selectedModels.get(providerId) ?? defaultModel;
  }

  /**
   * Updates connection status and optional last error.
   */
  public setConnectionStatus(
    providerId: CanonicalProviderId,
    status: ProviderConnectionStatus,
    errorMessage?: string,
  ): void {
    if (!isCanonicalProviderId(providerId)) return;
    this.providerStatuses.set(providerId, status);
    if (errorMessage) {
      this.lastErrors.set(providerId, errorMessage);
    } else if (status === 'connected') {
      this.lastErrors.delete(providerId);
    }
  }

  /**
   * Returns honest, real-time status summary for all four providers.
   */
  public async getProviderStatusSummary(): Promise<readonly ProviderStateSummary[]> {
    await Promise.resolve();
    const list: ProviderStateSummary[] = [];

    for (const id of CANONICAL_PROVIDER_IDS) {
      const meta = AUTHORITATIVE_PROVIDER_METADATA[id];
      const status = this.providerStatuses.get(id) ?? 'not-configured';

      list.push({
        providerId: id,
        displayName: meta.displayName,
        activeMode: this.activeProviderId === id ? this.activeMode : meta.supportedModes[0] ?? 'browser',
        status,
        hasCredential: false,
        selectedModelId: this.getSelectedModel(id),
        availableModels: meta.availableModels,
        supportedModes: meta.supportedModes,
        lastError: this.lastErrors.get(id),
      });
    }

    return list;
  }
}
