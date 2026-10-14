/**
 * @mediator/native-host — Native Host Controller (S19)
 *
 * Requirements:
 * - Coordinates NativeMessageReader (stdin), NativeMessageWriter (stdout), and IpcClient.
 * - Enforces extension origin allowlist and protocol constraints.
 * - Handles offline local core gracefully without crashing (`CORE_NOT_RUNNING`).
 * - Bridges chunked transfers and protocol envelopes between browser extension and local core.
 * - Sanitized diagnostics routed exclusively to stderr.
 */

import {
  ErrorCode,
  type ErrorCodeValue,
  type MediatorError,
  PROTOCOL_VERSION,
} from '@mediator/shared-contracts';
import {
  IpcClient,
  IPC_PROTOCOL_VERSION,
  type IpcHandshakeResponse,
  type IpcTransferChunkPayload,
  type IpcSubmitEnvelopePayload,
} from '@mediator/ipc-core';
import { NativeMessageReader, NativeMessageWriter, logSanitizedStderr } from './framing.js';
import { OriginValidator } from './originValidator.js';

export interface NativeHostConfig {
  readonly allowedExtensionIds: readonly string[];
  readonly pipePath: string;
  readonly defaultPairingToken?: string | undefined;
}

export interface IncomingNativeRequest {
  readonly id?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly type: string;
  readonly payload?: unknown;
  readonly extensionId?: string | undefined;
  readonly pairingToken?: string | undefined;
  readonly nonce?: string | undefined;
  readonly taskId?: string | undefined;
  readonly sessionId?: string | undefined;
}

export class NativeHostController {
  private readonly originValidator: OriginValidator;
  private readonly config: NativeHostConfig;
  private readonly reader: NativeMessageReader;
  private readonly writer: NativeMessageWriter;
  private ipcClient: IpcClient | null = null;
  private validatedExtensionId: string | null = null;

  constructor(
    config: NativeHostConfig,
    reader: NativeMessageReader = new NativeMessageReader(),
    writer: NativeMessageWriter = new NativeMessageWriter(),
  ) {
    this.config = config;
    this.originValidator = new OriginValidator(config.allowedExtensionIds);
    this.reader = reader;
    this.writer = writer;

    this.reader.setMessageListener((msg) => {
      void this.handleIncomingMessage(msg);
    });
    this.reader.setErrorListener((err) => this.handleFramingError(err));
  }

  /**
   * Initialize native host with the command-line origin argument (argv[1]).
   */
  public initializeOrigin(originArg: string | undefined): boolean {
    const originRes = this.originValidator.validateOrigin(originArg);
    if (originRes.ok) {
      this.validatedExtensionId = originRes.value;
      logSanitizedStderr(`Initialized with validated origin: ${this.validatedExtensionId}`);
      return true;
    } else {
      logSanitizedStderr(`Origin validation failed: ${originRes.error.message}`);
      return false;
    }
  }

  public getReader(): NativeMessageReader {
    return this.reader;
  }

  public getWriter(): NativeMessageWriter {
    return this.writer;
  }

  public getValidatedExtensionId(): string | null {
    return this.validatedExtensionId;
  }

  /**
   * Set or mock the active IpcClient (useful for integration testing).
   */
  public setIpcClient(client: IpcClient | null): void {
    this.ipcClient = client;
  }

  /**
   * Process incoming native message.
   */
  public async handleIncomingMessage(rawMessage: unknown): Promise<void> {
    if (!rawMessage || typeof rawMessage !== 'object') {
      this.sendErrorResponse('unknown', ErrorCode.SCHEMA_INVALID, 'Incoming message must be a JSON object');
      return;
    }

    const req = rawMessage as IncomingNativeRequest;
    const correlationId = req.correlationId ?? req.id ?? 'msg_unknown';

    // 1. Origin verification
    const extId = req.extensionId ?? this.validatedExtensionId;
    if (!extId || !this.originValidator.isExtensionIdAllowed(extId)) {
      this.sendErrorResponse(
        correlationId,
        ErrorCode.IPC_ORIGIN_REJECTED,
        `Unauthorized extension origin: '${extId}'`,
      );
      return;
    }

    // 2. Route message type
    switch (req.type) {
      case 'handshake':
      case 'connect': {
        await this.handleHandshake(req, correlationId, extId);
        break;
      }

      case 'ping': {
        await this.handlePing(correlationId);
        break;
      }

      case 'get_status': {
        await this.handleGetStatus(correlationId);
        break;
      }

      case 'transfer_chunk': {
        await this.handleTransferChunk(req, correlationId);
        break;
      }

      case 'submit_envelope': {
        await this.handleSubmitEnvelope(req, correlationId);
        break;
      }

      case 'get_pending_round': {
        await this.handleGetPendingRound(correlationId);
        break;
      }

      default:
        this.sendErrorResponse(
          correlationId,
          ErrorCode.IPC_OPERATION_PROHIBITED,
          `Unsupported native host operation: '${req.type}'`,
        );
    }
  }

  private async ensureIpcConnected(
    extId: string,
    pairingToken: string,
    nonce: string,
    taskId?: string,
  ): Promise<boolean> {
    if (this.ipcClient && this.ipcClient.isConnected()) {
      return true;
    }

    this.ipcClient = new IpcClient({
      pipePath: this.config.pipePath,
      extensionId: extId,
      pairingToken,
      nonce,
      taskId,
    });

    const connectRes = await this.ipcClient.connect();
    return connectRes.ok;
  }

  private async handleHandshake(
    req: IncomingNativeRequest,
    correlationId: string,
    extId: string,
  ): Promise<void> {
    const token = req.pairingToken ?? this.config.defaultPairingToken;
    if (!token) {
      this.sendErrorResponse(
        correlationId,
        ErrorCode.IPC_TOKEN_INVALID,
        'Pairing token is required to establish core connection',
      );
      return;
    }

    const nonce = req.nonce ?? `nonce_${Date.now()}`;
    const connected = await this.ensureIpcConnected(extId, token, nonce, req.taskId);

    if (!connected) {
      this.sendErrorResponse(
        correlationId,
        ErrorCode.CORE_NOT_RUNNING,
        'Unable to connect to local Mediator core named pipe',
      );
      return;
    }

    const response: IpcHandshakeResponse = {
      success: true,
      protocolVersion: IPC_PROTOCOL_VERSION,
      serverVersion: PROTOCOL_VERSION,
      negotiatedSessionId: this.ipcClient?.getSessionId() ?? undefined,
      maxFrameBytes: 512 * 1024,
      maxChunkBytes: 256 * 1024,
    };

    this.sendSuccessResponse(correlationId, response);
  }

  private async handlePing(correlationId: string): Promise<void> {
    if (!this.ipcClient || !this.ipcClient.isConnected()) {
      // Respond at native-host layer if core is offline
      this.sendSuccessResponse(correlationId, {
        pong: true,
        hostRunning: true,
        coreConnected: false,
        timestamp: Date.now(),
      });
      return;
    }

    const pingRes = await this.ipcClient.ping();
    if (pingRes.ok) {
      this.sendSuccessResponse(correlationId, {
        pong: true,
        hostRunning: true,
        coreConnected: true,
        serverTimestamp: pingRes.value.serverTimestamp,
      });
    } else {
      this.sendErrorResponse(correlationId, pingRes.error.code, pingRes.error.message);
    }
  }

  private async handleGetStatus(correlationId: string): Promise<void> {
    if (!this.ipcClient || !this.ipcClient.isConnected()) {
      this.sendSuccessResponse(correlationId, {
        hostRunning: true,
        coreRunning: false,
        status: 'CORE_NOT_RUNNING',
      });
      return;
    }

    const statusRes = await this.ipcClient.getStatus();
    if (statusRes.ok) {
      this.sendSuccessResponse(correlationId, statusRes.value);
    } else {
      this.sendErrorResponse(correlationId, statusRes.error.code, statusRes.error.message);
    }
  }

  private async handleTransferChunk(
    req: IncomingNativeRequest,
    correlationId: string,
  ): Promise<void> {
    if (!this.ipcClient || !this.ipcClient.isConnected()) {
      this.sendErrorResponse(correlationId, ErrorCode.CORE_NOT_RUNNING, 'Local core is not connected');
      return;
    }

    const payload = req.payload as IpcTransferChunkPayload;
    if (!payload || !payload.chunk) {
      this.sendErrorResponse(correlationId, ErrorCode.SCHEMA_INVALID, 'Missing chunk in transfer payload');
      return;
    }

    const transferRes = await this.ipcClient.transferChunk(payload);
    if (transferRes.ok) {
      this.sendSuccessResponse(correlationId, transferRes.value);
    } else {
      this.sendErrorResponse(correlationId, transferRes.error.code, transferRes.error.message);
    }
  }

  private async handleSubmitEnvelope(
    req: IncomingNativeRequest,
    correlationId: string,
  ): Promise<void> {
    if (!this.ipcClient || !this.ipcClient.isConnected()) {
      this.sendErrorResponse(correlationId, ErrorCode.CORE_NOT_RUNNING, 'Local core is not connected');
      return;
    }

    const payload = req.payload as IpcSubmitEnvelopePayload;
    if (!payload || !payload.envelope) {
      this.sendErrorResponse(correlationId, ErrorCode.SCHEMA_INVALID, 'Missing envelope in submit payload');
      return;
    }

    const submitRes = await this.ipcClient.submitEnvelope(payload);
    if (submitRes.ok) {
      this.sendSuccessResponse(correlationId, submitRes.value);
    } else {
      this.sendErrorResponse(correlationId, submitRes.error.code, submitRes.error.message);
    }
  }

  private async handleGetPendingRound(correlationId: string): Promise<void> {
    if (!this.ipcClient || !this.ipcClient.isConnected()) {
      this.sendSuccessResponse(correlationId, { hasPendingRound: false, coreRunning: false });
      return;
    }

    const roundRes = await this.ipcClient.getPendingRound();
    if (roundRes.ok) {
      this.sendSuccessResponse(correlationId, roundRes.value);
    } else {
      this.sendErrorResponse(correlationId, roundRes.error.code, roundRes.error.message);
    }
  }

  private handleFramingError(error: MediatorError): void {
    logSanitizedStderr(`Framing error: ${error.message} (${error.code})`);
    try {
      this.writer.writeMessage({
        success: false,
        correlationId: 'framing_error',
        errorCode: error.code,
        error: error.message,
      });
    } catch {
      // ignore
    }
  }

  private sendSuccessResponse(correlationId: string, data: unknown): void {
    this.writer.writeMessage({
      success: true,
      correlationId,
      data,
    });
  }

  private sendErrorResponse(
    correlationId: string,
    errorCode: ErrorCodeValue,
    error: string,
  ): void {
    this.writer.writeMessage({
      success: false,
      correlationId,
      errorCode,
      error,
    });
  }
}
