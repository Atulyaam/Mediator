/**
 * @mediator/ipc-core — Authenticated Named-Pipe IPC Server (S19)
 *
 * Requirements:
 * - Local-only named pipe server (Windows named pipe or POSIX domain socket for testability).
 * - Enforces current-user security and rejects remote clients.
 * - Requires versioned, authenticated handshake as the first frame.
 * - Bounded message framing with 4-byte LE length prefix; rejects oversized frames (> 512 KiB).
 * - Restricts dispatched operations to narrow allowlist; blocks shell, commands, policy changes.
 * - Manages concurrent connections, timeouts, and safe shutdown.
 */

import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  ErrorCode,
  type ErrorCodeValue,
  PROTOCOL_VERSION,
} from '@mediator/shared-contracts';
import {
  IPC_LIMITS,
  IPC_PROTOCOL_VERSION,
  DEFAULT_NAMED_PIPE_PREFIX,
  ALLOWED_IPC_OPERATIONS_SET,
  PROHIBITED_OPERATION_KEYWORDS,
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
import { PairingManager } from './pairingManager.js';

export interface IpcServerHandlers {
  getStatus?: () => Promise<IpcStatusResult> | IpcStatusResult;
  onTransferChunk?: (
    payload: IpcTransferChunkPayload,
    session: ClientSession,
  ) => Promise<IpcTransferChunkResult> | IpcTransferChunkResult;
  onSubmitEnvelope?: (
    payload: IpcSubmitEnvelopePayload,
    session: ClientSession,
  ) => Promise<IpcSubmitEnvelopeResult> | IpcSubmitEnvelopeResult;
  getPendingRound?: (
    session: ClientSession,
  ) => Promise<IpcPendingRoundResult> | IpcPendingRoundResult;
}

export interface ClientSession {
  readonly id: string;
  readonly extensionId: string;
  readonly authenticatedAt: number;
  readonly taskId?: string | undefined;
  readonly sessionId?: string | undefined;
}

interface SocketState {
  authenticated: boolean;
  session?: ClientSession | undefined;
  buffer: Buffer;
  expectedLength: number | null;
}

export class IpcServer {
  private server: net.Server | null = null;
  private pipePath: string | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly pairingManager: PairingManager;
  private readonly handlers: IpcServerHandlers;
  private isListening = false;

  constructor(
    pairingManager: PairingManager,
    handlers: IpcServerHandlers = {},
  ) {
    this.pairingManager = pairingManager;
    this.handlers = handlers;
  }

  /**
   * Start the named pipe IPC server.
   * On Windows, binds to \\.\pipe\mediator-ipc-<pipeId>.
   * On POSIX systems (e.g. Linux/macOS tests), binds to a temporary Unix socket.
   */
  public async start(customPipeName?: string): Promise<string> {
    if (this.isListening) {
      throw new Error('IPC Server is already running');
    }

    const pipeId = customPipeName ?? `core-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const isWindows = os.platform() === 'win32';

    if (isWindows) {
      this.pipePath = customPipeName?.startsWith('\\\\.\\pipe\\')
        ? customPipeName
        : `${DEFAULT_NAMED_PIPE_PREFIX}${pipeId}`;
    } else {
      // Unix domain socket fallback for cross-platform test environments
      this.pipePath = path.join(os.tmpdir(), `mediator-ipc-${pipeId}.sock`);
      try {
        if (fs.existsSync(this.pipePath)) {
          fs.unlinkSync(this.pipePath);
        }
      } catch {
        // ignore
      }
    }

    return new Promise<string>((resolve, reject) => {
      const server = net.createServer({ pauseOnConnect: false }, (socket) => {
        this.handleConnection(socket);
      });

      server.maxConnections = IPC_LIMITS.maxConcurrentClients;

      server.on('error', (error) => {
        if (!this.isListening) {
          reject(error);
        }
      });

      server.listen(this.pipePath, () => {
        this.isListening = true;
        this.server = server;
        resolve(this.pipePath!);
      });
    });
  }

  /**
   * Stop the server and disconnect all active sockets cleanly.
   */
  public async stop(): Promise<void> {
    this.isListening = false;

    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    if (this.pipePath && os.platform() !== 'win32') {
      try {
        if (fs.existsSync(this.pipePath)) {
          fs.unlinkSync(this.pipePath);
        }
      } catch {
        // ignore
      }
    }
    this.pipePath = null;
  }

  public getPipePath(): string | null {
    return this.pipePath;
  }

  public getActiveClientCount(): number {
    return this.sockets.size;
  }

  public isRunning(): boolean {
    return this.isListening;
  }

  private handleConnection(socket: net.Socket): void {
    this.sockets.add(socket);

    const state: SocketState = {
      authenticated: false,
      buffer: Buffer.alloc(0),
      expectedLength: null,
    };

    // Set handshake deadline
    const handshakeTimer = setTimeout(() => {
      if (!state.authenticated) {
        this.sendErrorAndClose(
          socket,
          'HANDSHAKE_TIMEOUT',
          ErrorCode.IPC_DEADLINE_EXCEEDED,
          'Handshake deadline exceeded before authenticating',
        );
      }
    }, IPC_LIMITS.handshakeTimeoutMs);

    socket.on('data', (chunk: Buffer): void => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      void this.processBuffer(socket, state, handshakeTimer);
    });

    socket.on('close', (): void => {
      clearTimeout(handshakeTimer);
      this.sockets.delete(socket);
    });

    socket.on('error', (): void => {
      clearTimeout(handshakeTimer);
      this.sockets.delete(socket);
    });
  }

  private async processBuffer(
    socket: net.Socket,
    state: SocketState,
    handshakeTimer: ReturnType<typeof setTimeout>,
  ): Promise<void> {
    while (state.buffer.length >= 4) {
      if (state.expectedLength === null) {
        state.expectedLength = state.buffer.readUInt32LE(0);

        if (state.expectedLength > IPC_LIMITS.maxFrameBytes) {
          this.sendErrorAndClose(
            socket,
            'FRAME_TOO_LARGE',
            ErrorCode.NATIVE_FRAME_OVERSIZED,
            `Frame length ${state.expectedLength} exceeds maximum allowed ${IPC_LIMITS.maxFrameBytes} bytes`,
          );
          return;
        }

        if (state.expectedLength < 2) {
          this.sendErrorAndClose(
            socket,
            'FRAME_TOO_SMALL',
            ErrorCode.NATIVE_FRAME_MALFORMED,
            'Frame length too small for valid JSON',
          );
          return;
        }
      }

      // Check if full frame has arrived
      const totalFrameBytes = 4 + state.expectedLength;
      if (state.buffer.length < totalFrameBytes) {
        // Need more data from stream
        break;
      }

      const framePayload = state.buffer.subarray(4, totalFrameBytes);
      state.buffer = state.buffer.subarray(totalFrameBytes);
      state.expectedLength = null;

      // Parse JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(framePayload.toString('utf8'));
      } catch {
        this.sendErrorAndClose(
          socket,
          'JSON_PARSE_ERROR',
          ErrorCode.NATIVE_FRAME_MALFORMED,
          'Failed to parse frame payload as valid JSON',
        );
        return;
      }

      if (!state.authenticated) {
        clearTimeout(handshakeTimer);
        const handshakeSuccess = this.handleHandshake(socket, state, parsed);
        if (!handshakeSuccess) {
          return;
        }
      } else {
        await this.handleMessage(socket, state, parsed);
      }
    }
  }

  private handleHandshake(
    socket: net.Socket,
    state: SocketState,
    data: unknown,
  ): boolean {
    if (!data || typeof data !== 'object') {
      this.sendErrorAndClose(
        socket,
        'INVALID_HANDSHAKE',
        ErrorCode.IPC_HANDSHAKE_FAILED,
        'Handshake payload must be an object',
      );
      return false;
    }

    const req = data as Partial<IpcHandshakeRequest>;

    // Protocol version check
    if (req.protocolVersion !== IPC_PROTOCOL_VERSION) {
      const resp: IpcHandshakeResponse = {
        success: false,
        protocolVersion: IPC_PROTOCOL_VERSION,
        serverVersion: PROTOCOL_VERSION,
        maxFrameBytes: IPC_LIMITS.maxFrameBytes,
        maxChunkBytes: IPC_LIMITS.maxChunkBytes,
        error: `Unsupported protocol version '${req.protocolVersion}'. Server supports '${IPC_PROTOCOL_VERSION}'`,
        errorCode: ErrorCode.PROTOCOL_VERSION_UNSUPPORTED,
      };
      this.writeFrame(socket, resp);
      socket.destroy();
      return false;
    }

    if (!req.extensionId || !req.pairingToken) {
      this.sendErrorAndClose(
        socket,
        'MISSING_CREDENTIALS',
        ErrorCode.IPC_HANDSHAKE_FAILED,
        'Extension ID and pairing token are required',
      );
      return false;
    }

    // Validate pairing token
    const tokenValidation = this.pairingManager.validateToken(
      req.pairingToken,
      req.extensionId,
    );

    if (!tokenValidation.ok) {
      const resp: IpcHandshakeResponse = {
        success: false,
        protocolVersion: IPC_PROTOCOL_VERSION,
        serverVersion: PROTOCOL_VERSION,
        maxFrameBytes: IPC_LIMITS.maxFrameBytes,
        maxChunkBytes: IPC_LIMITS.maxChunkBytes,
        error: tokenValidation.error.message,
        errorCode: tokenValidation.error.code,
      };
      this.writeFrame(socket, resp, () => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      });
      return false;
    }

    const session: ClientSession = {
      id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      extensionId: req.extensionId,
      authenticatedAt: Date.now(),
      taskId: req.taskId,
      sessionId: req.sessionId,
    };

    state.authenticated = true;
    state.session = session;

    const resp: IpcHandshakeResponse = {
      success: true,
      protocolVersion: IPC_PROTOCOL_VERSION,
      serverVersion: PROTOCOL_VERSION,
      negotiatedSessionId: session.id,
      maxFrameBytes: IPC_LIMITS.maxFrameBytes,
      maxChunkBytes: IPC_LIMITS.maxChunkBytes,
    };

    this.writeFrame(socket, resp);
    return true;
  }

  private async handleMessage(
    socket: net.Socket,
    state: SocketState,
    data: unknown,
  ): Promise<void> {
    const msg = data as Partial<IpcMessage>;
    const correlationId = msg.correlationId ?? msg.id ?? 'unknown';

    if (!msg.type || typeof msg.type !== 'string') {
      this.sendResponse(socket, correlationId, false, undefined, 'Message type is missing', ErrorCode.SCHEMA_INVALID);
      return;
    }

    // Security check: prohibit command execution or policy mutation keywords
    const lowerType = msg.type.toLowerCase();
    for (const keyword of PROHIBITED_OPERATION_KEYWORDS) {
      if (lowerType.includes(keyword)) {
        this.sendResponse(
          socket,
          correlationId,
          false,
          undefined,
          `Operation '${msg.type}' is strictly prohibited over local IPC`,
          ErrorCode.IPC_OPERATION_PROHIBITED,
        );
        return;
      }
    }

    if (!ALLOWED_IPC_OPERATIONS_SET.has(msg.type)) {
      this.sendResponse(
        socket,
        correlationId,
        false,
        undefined,
        `Unrecognized or unsupported operation '${msg.type}'`,
        ErrorCode.IPC_OPERATION_PROHIBITED,
      );
      return;
    }

    try {
      switch (msg.type) {
        case AllowedIpcOperation.PING: {
          const clientTimestamp = (msg.payload as { timestamp?: number })?.timestamp ?? Date.now();
          const result: IpcPingResult = {
            pong: true,
            clientTimestamp,
            serverTimestamp: Date.now(),
          };
          this.sendResponse(socket, correlationId, true, result);
          break;
        }

        case AllowedIpcOperation.GET_STATUS: {
          if (this.handlers.getStatus) {
            const status = await this.handlers.getStatus();
            this.sendResponse(socket, correlationId, true, status);
          } else {
            const defaultStatus: IpcStatusResult = {
              coreRunning: true,
              serverVersion: PROTOCOL_VERSION,
              protocolVersion: IPC_PROTOCOL_VERSION,
              activeTaskId: state.session?.taskId ?? null,
              activeSessionId: state.session?.sessionId ?? null,
              stagingReady: true,
            };
            this.sendResponse(socket, correlationId, true, defaultStatus);
          }
          break;
        }

        case AllowedIpcOperation.TRANSFER_CHUNK: {
          if (!this.handlers.onTransferChunk) {
            this.sendResponse(socket, correlationId, false, undefined, 'Transfer chunk handler not configured', ErrorCode.CAPABILITY_UNAVAILABLE);
            return;
          }
          const payload = msg.payload as IpcTransferChunkPayload;
          const result = await this.handlers.onTransferChunk(payload, state.session!);
          this.sendResponse(socket, correlationId, true, result);
          break;
        }

        case AllowedIpcOperation.SUBMIT_ENVELOPE: {
          if (!this.handlers.onSubmitEnvelope) {
            this.sendResponse(socket, correlationId, false, undefined, 'Submit envelope handler not configured', ErrorCode.CAPABILITY_UNAVAILABLE);
            return;
          }
          const payload = msg.payload as IpcSubmitEnvelopePayload;
          const result = await this.handlers.onSubmitEnvelope(payload, state.session!);
          this.sendResponse(socket, correlationId, true, result);
          break;
        }

        case AllowedIpcOperation.GET_PENDING_ROUND: {
          if (!this.handlers.getPendingRound) {
            const emptyResult: IpcPendingRoundResult = { hasPendingRound: false };
            this.sendResponse(socket, correlationId, true, emptyResult);
          } else {
            const result = await this.handlers.getPendingRound(state.session!);
            this.sendResponse(socket, correlationId, true, result);
          }
          break;
        }

        default:
          this.sendResponse(
            socket,
            correlationId,
            false,
            undefined,
            `Unhandled operation '${msg.type}'`,
            ErrorCode.IPC_OPERATION_PROHIBITED,
          );
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.sendResponse(socket, correlationId, false, undefined, errMsg, ErrorCode.INTERNAL_ERROR);
    }
  }

  private sendResponse(
    socket: net.Socket,
    correlationId: string,
    success: boolean,
    data?: unknown,
    error?: string,
    errorCode?: ErrorCodeValue,
  ): void {
    const resp: IpcResponse = {
      id: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      correlationId,
      success,
      data,
      error,
      errorCode,
    };
    this.writeFrame(socket, resp);
  }

  private sendErrorAndClose(
    socket: net.Socket,
    correlationId: string,
    errorCode: ErrorCodeValue,
    errorMessage: string,
  ): void {
    const resp: IpcResponse = {
      id: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      correlationId,
      success: false,
      error: errorMessage,
      errorCode,
    };
    this.writeFrame(socket, resp, (): void => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    });
  }

  private writeFrame(socket: net.Socket, data: unknown, onFlushed?: () => void): void {
    if (socket.destroyed) return;
    const jsonStr = JSON.stringify(data);
    const payloadBuf = Buffer.from(jsonStr, 'utf8');
    const headerBuf = Buffer.alloc(4);
    headerBuf.writeUInt32LE(payloadBuf.length, 0);

    const frameBuf = Buffer.concat([headerBuf, payloadBuf]);
    socket.write(frameBuf, () => {
      if (onFlushed) onFlushed();
    });
  }
}
