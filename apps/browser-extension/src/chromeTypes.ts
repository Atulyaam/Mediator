/**
 * @mediator/browser-extension — Type definitions for Chrome Extension APIs
 *
 * Provides strict TypeScript types for MV3 APIs used in the extension
 * without requiring the full @types/chrome package dependency or any-casts.
 */

import {
  type AttachState,
  type ExtractionLimits,
  type PreparedDraft,
  type ExtractionResult,
  type DraftPreparationResult,
  type PageClassificationResult,
} from './providerTypes.js';
import { type PrepareDraftInput } from './draftManager.js';

export interface ChromeTab {
  readonly id?: number;
  readonly url?: string;
  readonly active?: boolean;
}

export type ContentScriptMessage =
  | { readonly type: 'CLASSIFY_PAGE' }
  | { readonly type: 'EXTRACT_RESPONSE'; readonly limits?: ExtractionLimits }
  | { readonly type: 'PREPARE_DRAFT'; readonly draft: PreparedDraft };

export type ContentScriptResponse =
  | { readonly ok: true; readonly classification: PageClassificationResult }
  | ExtractionResult
  | DraftPreparationResult
  | { readonly ok: false; readonly error: string };

export type BackgroundMessage =
  | { readonly type: 'GET_STATUS' }
  | { readonly type: 'ATTACH_TAB'; readonly tabId: number; readonly url: string }
  | { readonly type: 'DETACH_TAB' }
  | { readonly type: 'PREPARE_DRAFT'; readonly input: PrepareDraftInput };

export type BackgroundResponse =
  | { readonly ok: true; readonly state: AttachState }
  | { readonly ok: false; readonly error: string }
  | DraftPreparationResult;

export interface ChromeTabsApi {
  query(
    queryInfo: { active?: boolean; currentWindow?: boolean },
    callback: (tabs: ChromeTab[]) => void,
  ): void;
  sendMessage(
    tabId: number,
    message: ContentScriptMessage,
    callback?: (response: ContentScriptResponse) => void,
  ): void;
  readonly onUpdated?: {
    addListener(
      callback: (
        tabId: number,
        changeInfo: { status?: string; url?: string },
        tab: ChromeTab,
      ) => void,
    ): void;
  };
}

export interface ChromeRuntimeApi {
  readonly lastError?: { readonly message?: string };
  sendMessage(
    message: BackgroundMessage,
    callback?: (response: BackgroundResponse) => void,
  ): void;
  readonly onMessage?: {
    addListener(
      callback: (
        message: unknown,
        sender: unknown,
        sendResponse: (response: unknown) => void,
      ) => boolean | void,
    ): void;
  };
  connectNative?(application: string): ChromePort;
  sendNativeMessage?(
    application: string,
    message: unknown,
    callback?: (response: unknown) => void,
  ): void;
}

export interface ChromePort {
  readonly name?: string;
  readonly onMessage: {
    addListener(callback: (message: unknown) => void): void;
    removeListener?(callback: (message: unknown) => void): void;
  };
  readonly onDisconnect: {
    addListener(callback: (port: ChromePort) => void): void;
    removeListener?(callback: (port: ChromePort) => void): void;
  };
  postMessage(message: unknown): void;
  disconnect(): void;
}

export interface ChromeApi {
  readonly runtime?: ChromeRuntimeApi;
  readonly tabs?: ChromeTabsApi;
}

