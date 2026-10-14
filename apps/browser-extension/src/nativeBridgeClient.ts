/**
 * @mediator/browser-extension — Native Bridge Client (S19)
 *
 * Requirements:
 * - Communicates with com.mediator.native_host via chrome.runtime.connectNative.
 * - Supports test port seam for unit/integration testing without headless Chrome.
 * - Enforces versioned handshake and pairing authentication before sending application traffic.
 * - Handles offline core gracefully (reports CORE_NOT_RUNNING / core-unavailable).
 * - Forwards bounded chunk transfers and protocol envelopes.
 */

import {
  ErrorCode,
  type ErrorCodeValue,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
  PROTOCOL_VERSION,
} from '@mediator/shared-contracts';
import { type ChromePort } from './chromeTypes.js';

declare const chrome: {
  readonly runtime?: {
    connectNative?(application: string): ChromePort;
  };
} | undefined;

export const NATIVE_HOST_NAME = 'com.mediator.native_host';

export type NativeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'pairing-required'
  | 'core-unavailable'
  | 'not-installed'
  | 'blocked';

export interface NativeBridgeClientOptions {
  readonly hostName?: string | undefined;
  readonly portSeam?: ChromePort | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface NativeBridgeStatus {
  readonly state: NativeConnectionState;
  readonly isConnected: boolean;
  readonly hostRunning: boolean;
  readonly coreRunning: boolean;
  readonly serverVersion?: string | undefined;
  readonly statusMessage: string;
}

export class NativeBridgeClient {
  private port: ChromePort | null = null;
  private connectionState: NativeConnectionState = 'disconnected';
  private readonly hostName: string;
  private readonly defaultTimeoutMs: number;
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: MediatorError) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private hostRunning = false;
  private coreRunning = false;
  private serverVersion: string | undefined = undefined;

  constructor(options: NativeBridgeClientOptions = {}) {
    this.hostName = options.hostName ?? NATIVE_HOST_NAME;
    this.defaultTimeoutMs = options.timeoutMs ?? 10_000;
    if (options.portSeam) {
      this.attachPort(options.portSeam);
    }
  }

  public getConnectionState(): NativeConnectionState {
    return this.connectionState;
  }

  public isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  public getStatus(): NativeBridgeStatus {
    return {
      state: this.connectionState,
      isConnected: this.isConnected(),
      hostRunning: this.hostRunning,
      coreRunning: this.coreRunning,
      serverVersion: this.serverVersion,
      statusMessage: this.getStatusMessage(),
    };
  }

  /**
   * Connect to native host and authenticate with local Mediator core.
   */
  public async connect(credentials?: {
    pairingToken?: string;
    extensionId?: string;
    nonce?: string;
    taskId?: string;
  }): Promise<Result<NativeBridgeStatus, MediatorError>> {
    if (!this.port) {
      if (typeof chrome !== 'undefined' && chrome.runtime?.connectNative) {
        try {
          const chromePort = chrome.runtime.connectNative(this.hostName);
          this.attachPort(chromePort);
        } catch (e: unknown) {
          this.connectionState = 'not-installed';
          return err(
            makeMediatorError(
              ErrorCode.NATIVE_HOST_NOT_INSTALLED,
              `Native host '${this.hostName}' is not installed or registered: ${String(e)}`,
            ),
          );
        }
      } else {
        this.connectionState = 'not-installed';
        return err(
          makeMediatorError(
            ErrorCode.NATIVE_HOST_NOT_INSTALLED,
            'chrome.runtime.connectNative is not available in the current environment',
          ),
        );
      }
    }

    this.connectionState = 'connecting';

    // 1. Initial Ping to check host responsiveness
    const pingRes = await this.ping();
    if (!pingRes.ok) {
      this.connectionState = 'core-unavailable';
      return err(pingRes.error);
    }

    this.hostRunning = true;

    // 2. Handshake with pairing token
    const token = credentials?.pairingToken;
    if (!token) {
      this.connectionState = 'pairing-required';
      return ok(this.getStatus());
    }

    const handshakeRes = await this.sendNativeRequest<{
      success: boolean;
      data?: { negotiatedSessionId?: string; serverVersion?: string };
    }>('handshake', {
      pairingToken: token,
      extensionId: credentials?.extensionId,
      nonce: credentials?.nonce ?? `nonce_${Date.now()}`,
      taskId: credentials?.taskId,
    });

    if (!handshakeRes.ok) {
      if (handshakeRes.error.code === ErrorCode.CORE_NOT_RUNNING) {
        this.connectionState = 'core-unavailable';
      } else if (
        handshakeRes.error.code === ErrorCode.IPC_TOKEN_INVALID ||
        handshakeRes.error.code === ErrorCode.IPC_PAIRING_EXPIRED
      ) {
        this.connectionState = 'pairing-required';
      } else {
        this.connectionState = 'blocked';
      }
      return err(handshakeRes.error);
    }

    this.connectionState = 'connected';
    this.coreRunning = true;
    this.serverVersion = PROTOCOL_VERSION;

    return ok(this.getStatus());
  }

  public disconnect(): void {
    if (this.port) {
      try {
        this.port.disconnect();
      } catch {
        // ignore
      }
      this.port = null;
    }
    this.connectionState = 'disconnected';
    this.hostRunning = false;
    this.coreRunning = false;
    this.failAllPending(
      makeMediatorError(ErrorCode.IPC_CONNECTION_CLOSED, 'Native host bridge disconnected'),
    );
  }

  public async ping(): Promise<Result<{ pong: boolean }, MediatorError>> {
    return this.sendNativeRequest<{ pong: boolean }>('ping');
  }

  public async transferChunk(
    chunk: unknown,
  ): Promise<Result<{ accepted: boolean }, MediatorError>> {
    return this.sendNativeRequest<{ accepted: boolean }>('transfer_chunk', {
      chunk,
    });
  }

  public async submitEnvelope(
    envelope: unknown,
  ): Promise<Result<{ accepted: boolean }, MediatorError>> {
    return this.sendNativeRequest<{ accepted: boolean }>('submit_envelope', {
      envelope,
    });
  }

  public async getPendingRound(): Promise<Result<unknown, MediatorError>> {
    return this.sendNativeRequest('get_pending_round');
  }

  public attachPort(port: ChromePort): void {
    this.port = port;

    port.onMessage.addListener((message: unknown): void => {
      this.handlePortMessage(message);
    });

    port.onDisconnect.addListener((): void => {
      this.connectionState = 'disconnected';
      this.port = null;
      this.hostRunning = false;
      this.coreRunning = false;
      this.failAllPending(
        makeMediatorError(ErrorCode.IPC_CONNECTION_CLOSED, 'Native host process disconnected'),
      );
    });
  }

  private sendNativeRequest<T>(
    type: string,
    payload?: unknown,
  ): Promise<Result<T, MediatorError>> {
    if (!this.port) {
      return Promise.resolve(
        err(
          makeMediatorError(
            ErrorCode.NATIVE_HOST_NOT_INSTALLED,
            'Native host port is not connected',
          ),
        ),
      );
    }

    const id = `nr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const correlationId = id;

    const message = {
      id,
      correlationId,
      type,
      payload,
    };

    return new Promise<Result<T, MediatorError>>((resolve): void => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        resolve(
          err(
            makeMediatorError(
              ErrorCode.IPC_DEADLINE_EXCEEDED,
              `Native message request '${type}' timed out`,
            ),
          ),
        );
      }, this.defaultTimeoutMs);

      this.pendingRequests.set(correlationId, {
        resolve: (val: unknown): void => {
          clearTimeout(timer);
          this.pendingRequests.delete(correlationId);
          resolve(ok(val as T));
        },
        reject: (error: MediatorError): void => {
          clearTimeout(timer);
          this.pendingRequests.delete(correlationId);
          resolve(err(error));
        },
        timer,
      });

      try {
        this.port!.postMessage(message);
      } catch (errObj: unknown) {
        clearTimeout(timer);
        this.pendingRequests.delete(correlationId);
        resolve(
          err(
            makeMediatorError(
              ErrorCode.IPC_CONNECTION_CLOSED,
              `Failed to send message to native host: ${String(errObj)}`,
            ),
          ),
        );
      }
    });
  }

  private handlePortMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const resp = message as {
      correlationId?: string;
      success?: boolean;
      data?: unknown;
      error?: string;
      errorCode?: ErrorCodeValue;
    };

    const correlationId = resp.correlationId;
    if (!correlationId) return;

    const pending = this.pendingRequests.get(correlationId);
    if (pending) {
      if (resp.success) {
        pending.resolve(resp.data);
      } else {
        pending.reject(
          makeMediatorError(
            resp.errorCode ?? ErrorCode.INTERNAL_ERROR,
            resp.error ?? 'Native message request failed',
          ),
        );
      }
    }
  }

  private failAllPending(error: MediatorError): void {
    for (const [, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(error);
    }
    this.pendingRequests.clear();
  }

  private getStatusMessage(): string {
    switch (this.connectionState) {
      case 'connected':
        return 'Connected to local Mediator core via authenticated native host';
      case 'core-unavailable':
        return 'Native host is running, but local Mediator core named pipe is unavailable (CORE_NOT_RUNNING)';
      case 'pairing-required':
        return 'Pairing token required to authenticate with local Mediator core';
      case 'not-installed':
        return 'Native messaging host is not installed or registered in HKCU';
      case 'blocked':
        return 'Native messaging connection blocked by security policy';
      case 'connecting':
        return 'Connecting to native host...';
      case 'disconnected':
      default:
        return 'Disconnected from local Mediator core';
    }
  }
}
