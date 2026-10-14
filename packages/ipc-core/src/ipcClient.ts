/**
 * @mediator/ipc-core — Authenticated Named-Pipe IPC Client (S19)
 *
 * Requirements:
 * - Connects to local named pipe IPC server.
 * - Handles offline core honestly (`CORE_NOT_RUNNING`).
 * - Sends length-prefixed frames; parses typed responses.
 * - Authenticates with versioned handshake and pairing challenge/token.
 * - Provides typed methods for all allowed operations.
 */

import * as net from 'node:net';
import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
} from '@mediator/shared-contracts';
import {
  IPC_LIMITS,
  IPC_PROTOCOL_VERSION,
  AllowedIpcOperation,
  type IpcHandshakeRequest,
  type IpcHandshakeResponse,
  type IpcMessage,
  type IpcResponse,
  type IpcStatusResult,
  type IpcPingResult,
  type IpcTransferChunkPayload,
  type IpcTransferChunkResult,
  type IpcSubmitEnvelopePayload,
  type IpcSubmitEnvelopeResult,
  type IpcPendingRoundResult,
} from './ipcTypes.js';

export interface IpcClientOptions {
  readonly pipePath: string;
  readonly extensionId: string;
  readonly pairingToken: string;
  readonly nonce: string;
  readonly sessionId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export class IpcClient {
  private socket: net.Socket | null = null;
  private readonly options: IpcClientOptions;
  private isAuthenticated = false;
  private negotiatedSessionId: string | null = null;
  private incomingBuffer = Buffer.alloc(0);
  private expectedLength: number | null = null;
  private readonly pendingRequests = new Map<
    string,
    {
      resolve: (data: unknown) => void;
      reject: (error: MediatorError) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private handshakePromise: {
    resolve: (data: IpcHandshakeResponse) => void;
    reject: (error: MediatorError) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(options: IpcClientOptions) {
    this.options = options;
  }

  /**
   * Connect to the named pipe and perform the authentication handshake.
   */
  public async connect(): Promise<Result<IpcHandshakeResponse, MediatorError>> {
    if (this.socket && this.isAuthenticated) {
      return ok({
        success: true,
        protocolVersion: IPC_PROTOCOL_VERSION,
        serverVersion: IPC_PROTOCOL_VERSION,
        negotiatedSessionId: this.negotiatedSessionId ?? undefined,
        maxFrameBytes: IPC_LIMITS.maxFrameBytes,
        maxChunkBytes: IPC_LIMITS.maxChunkBytes,
      });
    }

    return new Promise((resolve) => {
      const timeoutMs = this.options.timeoutMs ?? IPC_LIMITS.requestTimeoutMs;
      let connectionError: Error | null = null;

      const socket = net.createConnection(this.options.pipePath);

      const connectTimer = setTimeout(() => {
        socket.destroy();
        resolve(
          err(
            makeMediatorError(
              ErrorCode.CORE_NOT_RUNNING,
              `Connection to local Mediator core timed out at ${this.options.pipePath}`,
            ),
          ),
        );
      }, timeoutMs);

      socket.on('connect', (): void => {
        void (async (): Promise<void> => {
          clearTimeout(connectTimer);
          this.socket = socket;

          // Perform handshake
          const handshakeReq: IpcHandshakeRequest = {
            protocolVersion: IPC_PROTOCOL_VERSION,
            extensionId: this.options.extensionId,
            pairingToken: this.options.pairingToken,
            nonce: this.options.nonce,
            sessionId: this.options.sessionId,
            taskId: this.options.taskId,
            timestamp: Date.now(),
          };

          const handshakeResult = await this.sendHandshake(handshakeReq);
          if (handshakeResult.ok) {
            this.isAuthenticated = true;
            this.negotiatedSessionId = handshakeResult.value.negotiatedSessionId ?? null;
            resolve(ok(handshakeResult.value));
          } else {
            this.disconnect();
            resolve(err(handshakeResult.error));
          }
        })();
      });

      socket.on('data', (chunk: Buffer): void => {
        this.incomingBuffer = Buffer.concat([this.incomingBuffer, chunk]);
        this.processIncoming();
      });

      socket.on('error', (errObj: Error): void => {
        connectionError = errObj;
        clearTimeout(connectTimer);
        this.failAllPending(
          makeMediatorError(
            ErrorCode.CORE_NOT_RUNNING,
            `Local Mediator core is unreachable: ${errObj.message}`,
          ),
        );
      });

      socket.on('close', (): void => {
        clearTimeout(connectTimer);
        this.isAuthenticated = false;
        this.socket = null;
        if (this.handshakePromise) {
          this.failAllPending(
            makeMediatorError(
              ErrorCode.IPC_HANDSHAKE_FAILED,
              connectionError
                ? `Connection closed during handshake: ${connectionError.message}`
                : 'Connection closed by server during handshake',
            ),
          );
        }
        if (connectionError) {
          resolve(
            err(
              makeMediatorError(
                ErrorCode.CORE_NOT_RUNNING,
                `Local Mediator core named pipe unavailable (${connectionError.message})`,
              ),
            ),
          );
        }
      });
    });
  }

  public disconnect(): void {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.isAuthenticated = false;
    this.failAllPending(
      makeMediatorError(ErrorCode.IPC_CONNECTION_CLOSED, 'IPC connection closed'),
    );
  }

  public isConnected(): boolean {
    return this.isAuthenticated && this.socket !== null && !this.socket.destroyed;
  }

  public getSessionId(): string | null {
    return this.negotiatedSessionId;
  }

  /**
   * Ping the core.
   */
  public async ping(): Promise<Result<IpcPingResult, MediatorError>> {
    return this.sendRequest<IpcPingResult>(AllowedIpcOperation.PING, {
      timestamp: Date.now(),
    });
  }

  /**
   * Query core status.
   */
  public async getStatus(): Promise<Result<IpcStatusResult, MediatorError>> {
    return this.sendRequest<IpcStatusResult>(AllowedIpcOperation.GET_STATUS, {});
  }

  /**
   * Transfer a chunk to core.
   */
  public async transferChunk(
    payload: IpcTransferChunkPayload,
  ): Promise<Result<IpcTransferChunkResult, MediatorError>> {
    return this.sendRequest<IpcTransferChunkResult>(
      AllowedIpcOperation.TRANSFER_CHUNK,
      payload,
    );
  }

  /**
   * Submit an AI response protocol envelope to core.
   */
  public async submitEnvelope(
    payload: IpcSubmitEnvelopePayload,
  ): Promise<Result<IpcSubmitEnvelopeResult, MediatorError>> {
    return this.sendRequest<IpcSubmitEnvelopeResult>(
      AllowedIpcOperation.SUBMIT_ENVELOPE,
      payload,
    );
  }

  /**
   * Get pending round information from core.
   */
  public async getPendingRound(): Promise<
    Result<IpcPendingRoundResult, MediatorError>
  > {
    return this.sendRequest<IpcPendingRoundResult>(
      AllowedIpcOperation.GET_PENDING_ROUND,
      {},
    );
  }

  private sendHandshake(
    req: IpcHandshakeRequest,
  ): Promise<Result<IpcHandshakeResponse, MediatorError>> {
    return new Promise<Result<IpcHandshakeResponse, MediatorError>>((resolve): void => {
      const timer = setTimeout(() => {
        this.handshakePromise = null;
        resolve(
          err(
            makeMediatorError(
              ErrorCode.IPC_DEADLINE_EXCEEDED,
              'Handshake request timed out',
            ),
          ),
        );
      }, IPC_LIMITS.handshakeTimeoutMs);

      this.handshakePromise = {
        resolve: (data: IpcHandshakeResponse): void => {
          clearTimeout(timer);
          this.handshakePromise = null;
          resolve(ok(data));
        },
        reject: (error: MediatorError): void => {
          clearTimeout(timer);
          this.handshakePromise = null;
          resolve(err(error));
        },
        timer,
      };

      this.writeFrame(req);
    });
  }

  private sendRequest<T>(
    type: string,
    payload: unknown,
  ): Promise<Result<T, MediatorError>> {
    if (!this.isConnected()) {
      return Promise.resolve(
        err(
          makeMediatorError(
            ErrorCode.CORE_NOT_RUNNING,
            'Cannot send IPC request: not connected to local Mediator core',
          ),
        ),
      );
    }

    const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const correlationId = id;

    const message: IpcMessage = {
      id,
      correlationId,
      type,
      payload,
      timestamp: Date.now(),
      sessionId: this.negotiatedSessionId ?? undefined,
      taskId: this.options.taskId,
    };

    return new Promise<Result<T, MediatorError>>((resolve): void => {
      const timeoutMs = this.options.timeoutMs ?? IPC_LIMITS.requestTimeoutMs;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        resolve(
          err(
            makeMediatorError(
              ErrorCode.IPC_DEADLINE_EXCEEDED,
              `IPC request '${type}' timed out after ${timeoutMs}ms`,
            ),
          ),
        );
      }, timeoutMs);

      this.pendingRequests.set(correlationId, {
        resolve: (data: unknown): void => {
          clearTimeout(timer);
          this.pendingRequests.delete(correlationId);
          resolve(ok(data as T));
        },
        reject: (error: MediatorError): void => {
          clearTimeout(timer);
          this.pendingRequests.delete(correlationId);
          resolve(err(error));
        },
        timer,
      });

      this.writeFrame(message);
    });
  }

  private processIncoming(): void {
    while (this.incomingBuffer.length >= 4) {
      if (this.expectedLength === null) {
        this.expectedLength = this.incomingBuffer.readUInt32LE(0);
        if (this.expectedLength > IPC_LIMITS.maxFrameBytes) {
          this.failAllPending(
            makeMediatorError(
              ErrorCode.NATIVE_FRAME_OVERSIZED,
              `Server response exceeded max frame bytes (${this.expectedLength})`,
            ),
          );
          this.disconnect();
          return;
        }
      }

      const totalBytes = 4 + this.expectedLength;
      if (this.incomingBuffer.length < totalBytes) {
        break; // Partial frame
      }

      const payloadBuf = this.incomingBuffer.subarray(4, totalBytes);
      this.incomingBuffer = this.incomingBuffer.subarray(totalBytes);
      this.expectedLength = null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(payloadBuf.toString('utf8'));
      } catch {
        continue;
      }

      if (this.handshakePromise) {
        const hsResp = parsed as IpcHandshakeResponse;
        if (hsResp.success) {
          this.handshakePromise.resolve(hsResp);
        } else {
          this.handshakePromise.reject(
            makeMediatorError(
              hsResp.errorCode ?? ErrorCode.IPC_HANDSHAKE_FAILED,
              hsResp.error ?? 'Handshake failed',
            ),
          );
        }
        continue;
      }

      const resp = parsed as IpcResponse;
      const pending = this.pendingRequests.get(resp.correlationId);
      if (pending) {
        if (resp.success) {
          pending.resolve(resp.data);
        } else {
          pending.reject(
            makeMediatorError(
              resp.errorCode ?? ErrorCode.INTERNAL_ERROR,
              resp.error ?? 'IPC request failed',
            ),
          );
        }
      }
    }
  }

  private failAllPending(error: MediatorError): void {
    if (this.handshakePromise) {
      this.handshakePromise.reject(error);
      this.handshakePromise = null;
    }
    for (const [, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(error);
    }
    this.pendingRequests.clear();
  }

  private writeFrame(data: unknown): void {
    if (!this.socket || this.socket.destroyed) return;
    const jsonStr = JSON.stringify(data);
    const payloadBuf = Buffer.from(jsonStr, 'utf8');
    const headerBuf = Buffer.alloc(4);
    headerBuf.writeUInt32LE(payloadBuf.length, 0);

    this.socket.write(headerBuf);
    this.socket.write(payloadBuf);
  }
}
