/**
 * @mediator/provider-core — Unified Provider Registry (Sprint S29)
 *
 * Central authority for managing all four AI providers (OpenAI, Gemini, Claude, DeepSeek)
 * across both connection modes (Mode A: Browser Session Bridge, Mode B: Official API).
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
import {
  type AIProviderApiAdapter,
  type ProviderApiRequest,
  type ProviderApiResponse,
  type ProviderRequestOptions,
} from './apiAdapterContract.js';
import { SecureCredentialStore } from './credentialStore.js';
import { ClaudeApiAdapter } from './claudeApiAdapter.js';
import { DeepSeekApiAdapter } from './deepseekApiAdapter.js';
import { OpenAiApiAdapter } from './openaiApiAdapter.js';
import { GeminiApiAdapter } from './geminiApiAdapter.js';

export interface ProviderStateSummary {
  readonly providerId: CanonicalProviderId;
  readonly displayName: string;
  readonly activeMode: ProviderMode;
  readonly status: ProviderConnectionStatus;
  readonly hasCredential: boolean;
  readonly keyLastFour?: string | undefined;
  readonly selectedModelId: string;
  readonly availableModels: readonly ProviderModelConfig[];
  readonly supportedModes: readonly ProviderMode[];
  readonly lastError?: string | undefined;
}

export interface UnifiedRegistryOptions {
  readonly defaultProvider?: CanonicalProviderId;
  readonly defaultMode?: ProviderMode;
  readonly credentialStore?: SecureCredentialStore;
}

export class UnifiedProviderRegistry {
  private activeProviderId: CanonicalProviderId;
  private activeMode: ProviderMode;
  private readonly credentialStore: SecureCredentialStore;
  private readonly apiAdapters = new Map<CanonicalProviderId, AIProviderApiAdapter>();
  private readonly selectedModels = new Map<CanonicalProviderId, string>();
  private readonly providerStatuses = new Map<CanonicalProviderId, ProviderConnectionStatus>();
  private readonly lastErrors = new Map<CanonicalProviderId, string>();

  constructor(options?: UnifiedRegistryOptions) {
    this.activeProviderId = options?.defaultProvider ?? 'gemini';
    this.activeMode = options?.defaultMode ?? 'browser';
    this.credentialStore = options?.credentialStore ?? new SecureCredentialStore({ inMemory: true });

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

  public getCredentialStore(): SecureCredentialStore {
    return this.credentialStore;
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

  public registerApiAdapter(adapter: AIProviderApiAdapter): void {
    if (!isCanonicalProviderId(adapter.providerId)) {
      throw new Error(`Cannot register adapter for unknown provider ID "${String(adapter.providerId)}".`);
    }
    this.apiAdapters.set(adapter.providerId, adapter);
  }

  public getApiAdapter(providerId: CanonicalProviderId): AIProviderApiAdapter | undefined {
    return this.apiAdapters.get(providerId);
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
    const list: ProviderStateSummary[] = [];

    for (const id of CANONICAL_PROVIDER_IDS) {
      const meta = AUTHORITATIVE_PROVIDER_METADATA[id];
      const hasKey = await this.credentialStore.hasCredential(id);
      const credMeta = hasKey ? await this.credentialStore.getMetadata(id) : null;
      let status = this.providerStatuses.get(id) ?? 'not-configured';

      // Evaluate honest status
      if (this.activeProviderId === id && this.activeMode === 'api') {
        if (!hasKey) {
          status = 'user-action-required';
        }
      } else if (hasKey && status === 'not-configured') {
        status = 'configured';
      }

      list.push({
        providerId: id,
        displayName: meta.displayName,
        activeMode: this.activeProviderId === id ? this.activeMode : meta.supportedModes[0] ?? 'manual',
        status,
        hasCredential: hasKey,
        keyLastFour: credMeta?.lastFour ? `...${credMeta.lastFour}` : undefined,
        selectedModelId: this.getSelectedModel(id),
        availableModels: meta.availableModels,
        supportedModes: meta.supportedModes,
        lastError: this.lastErrors.get(id),
      });
    }

    return list;
  }

  public registerDefaultAdapters(options?: { fetchFn?: typeof fetch }): void {
    this.registerApiAdapter(new OpenAiApiAdapter({ fetchFn: options?.fetchFn }));
    this.registerApiAdapter(new GeminiApiAdapter({ fetchFn: options?.fetchFn }));
    this.registerApiAdapter(new ClaudeApiAdapter({ fetchFn: options?.fetchFn }));
    this.registerApiAdapter(new DeepSeekApiAdapter({ fetchFn: options?.fetchFn }));
  }

  public async executeApiRequest(
    request: ProviderApiRequest,
    options?: ProviderRequestOptions,
  ): Promise<Result<ProviderApiResponse, MediatorError>> {
    if (this.activeMode !== 'api') {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_MODE_UNSUPPORTED,
          `Cannot execute API request: active mode is "${this.activeMode}". Switch mode to "api" explicitly.`,
          { taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    if (request.providerId !== this.activeProviderId) {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_SESSION_MISMATCH,
          `Request targeted provider "${request.providerId}", but active provider is "${this.activeProviderId}". Provider switching must be explicit.`,
          { taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    const adapter = this.apiAdapters.get(request.providerId);
    if (!adapter) {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_API_UNAVAILABLE,
          `No API adapter registered for provider "${request.providerId}".`,
          { taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    let apiKey = options?.apiKey;
    if (!apiKey) {
      const credRes = await this.credentialStore.getDecryptedCredential(request.providerId);
      if (!credRes.ok) {
        this.setConnectionStatus(request.providerId, 'user-action-required', credRes.error.message);
        return err(
          makeMediatorError(
            ErrorCode.PROVIDER_CREDENTIAL_MISSING,
            `No API key configured for provider "${request.providerId}".`,
            { taskId: request.taskId, sessionId: request.sessionId },
          ),
        );
      }
      apiKey = credRes.value;
    }

    const result = await adapter.sendMessage(request, { ...options, apiKey });
    if (result.ok) {
      this.setConnectionStatus(request.providerId, 'connected');
    } else {
      this.setConnectionStatus(request.providerId, 'temporarily-unavailable', result.error.message);
    }
    return result;
  }

  public async executeStreamRequest(
    request: ProviderApiRequest,
    onChunk: (chunk: string) => void,
    options?: ProviderRequestOptions,
  ): Promise<Result<ProviderApiResponse, MediatorError>> {
    if (this.activeMode !== 'api') {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_MODE_UNSUPPORTED,
          `Cannot execute streaming API request: active mode is "${this.activeMode}". Switch mode to "api" explicitly.`,
          { taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    if (request.providerId !== this.activeProviderId) {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_SESSION_MISMATCH,
          `Request targeted provider "${request.providerId}", but active provider is "${this.activeProviderId}". Provider switching must be explicit.`,
          { taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    const adapter = this.apiAdapters.get(request.providerId);
    if (!adapter) {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_API_UNAVAILABLE,
          `No API adapter registered for provider "${request.providerId}".`,
          { taskId: request.taskId, sessionId: request.sessionId },
        ),
      );
    }

    let apiKey = options?.apiKey;
    if (!apiKey) {
      const credRes = await this.credentialStore.getDecryptedCredential(request.providerId);
      if (!credRes.ok) {
        this.setConnectionStatus(request.providerId, 'user-action-required', credRes.error.message);
        return err(
          makeMediatorError(
            ErrorCode.PROVIDER_CREDENTIAL_MISSING,
            `No API key configured for provider "${request.providerId}".`,
            { taskId: request.taskId, sessionId: request.sessionId },
          ),
        );
      }
      apiKey = credRes.value;
    }

    const result = await adapter.streamMessage(request, onChunk, { ...options, apiKey });
    if (result.ok) {
      this.setConnectionStatus(request.providerId, 'connected');
    } else {
      this.setConnectionStatus(request.providerId, 'temporarily-unavailable', result.error.message);
    }
    return result;
  }
}
