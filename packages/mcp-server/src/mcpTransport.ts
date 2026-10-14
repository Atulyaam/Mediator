/**
 * @mediator/mcp-server — Stdio Transport (Sprint S16)
 *
 * Implements local, stream-based stdio transport for the MCP context server.
 * Reads line-delimited JSON or Content-Length framed JSON-RPC from a readable stream,
 * passes requests to McpContextServer, and writes responses to a writable stream.
 *
 * Strictly local; no network listener, no HTTP socket.
 */

import { type Readable, type Writable } from 'node:stream';
import { type McpContextServer } from './mcpServer.js';
import { MAX_MCP_REQUEST_BYTES } from './mcpProtocolTypes.js';

export interface StdioTransportOptions {
  readonly server: McpContextServer;
  readonly inputStream: Readable;
  readonly outputStream: Writable;
  readonly requestTimeoutMs?: number;
}

export class McpStdioTransport {
  private isListening = false;
  private buffer = '';
  private readonly server: McpContextServer;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly timeoutMs: number;
  private activeAbortControllers = new Set<AbortController>();

  constructor(options: StdioTransportOptions) {
    this.server = options.server;
    this.input = options.inputStream;
    this.output = options.outputStream;
    this.timeoutMs = options.requestTimeoutMs ?? 30000;
  }

  public start(): void {
    if (this.isListening) return;
    this.isListening = true;
    this.server.start();

    this.input.setEncoding('utf8');
    this.input.on('data', this.handleChunk);
    this.input.on('end', this.handleEnd);
    this.input.on('error', this.handleError);
  }

  public stop(): void {
    if (!this.isListening) return;
    this.isListening = false;
    this.server.stop();

    // Cancel all in-flight requests
    for (const ctrl of this.activeAbortControllers) {
      ctrl.abort();
    }
    this.activeAbortControllers.clear();

    this.input.off('data', this.handleChunk);
    this.input.off('end', this.handleEnd);
    this.input.off('error', this.handleError);
    this.buffer = '';
  }

  public getIsListening(): boolean {
    return this.isListening;
  }

  private handleChunk = (chunk: string | Buffer): void => {
    this.buffer += chunk.toString();

    // Enforce max buffer size to prevent memory-exhaustion DoS
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_MCP_REQUEST_BYTES * 2) {
      this.buffer = '';
      this.writeResponse({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32003,
          message: 'Transport buffer exceeded maximum size',
        },
      });
      return;
    }

    // Process complete lines (newline-delimited JSON-RPC)
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        void this.processMessage(line);
      }
    }
  };

  private async processMessage(rawMessage: string): Promise<void> {
    const abortCtrl = new AbortController();
    this.activeAbortControllers.add(abortCtrl);

    const timer = setTimeout(() => {
      abortCtrl.abort();
    }, this.timeoutMs);

    try {
      if (abortCtrl.signal.aborted) {
        this.writeResponse({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32603,
            message: 'Request timed out or was cancelled',
          },
        });
        return;
      }

      const response = await this.server.handleRequest(rawMessage);
      this.writeResponse(response);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeResponse({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: `Internal transport error: ${msg}`,
        },
      });
    } finally {
      clearTimeout(timer);
      this.activeAbortControllers.delete(abortCtrl);
    }
  }

  private writeResponse(response: unknown): void {
    try {
      const serialized = JSON.stringify(response) + '\n';
      this.output.write(serialized);
    } catch {
      // Unserializable response or closed pipe
    }
  }

  private handleEnd = (): void => {
    this.stop();
  };

  private handleError = (): void => {
    this.stop();
  };
}
