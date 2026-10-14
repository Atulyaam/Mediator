/**
 * @mediator/orchestrator — Standalone Host Broker Process Server (Sprint S49)
 *
 * Implements the separate Windows process worker for TrustedHostBroker:
 * - Runs in a dedicated operating-system process isolated from ContainedOrchestrator.
 * - Communicates via newline-delimited JSON over stdio / stream transport.
 * - Inherits zero host secrets (scrubbed environment block).
 * - Routes all diagnostic logs strictly to stderr; reserves stdout for protocol envelopes.
 * - Handles process termination and cleanup cleanly.
 */

import { type Readable, type Writable } from 'node:stream';
import {
  type BrokerRequest,
  type BrokerResponse,
  HOST_BROKER_LIMITS,
} from './hostBrokerTypes.js';
import { TrustedHostBroker, type TrustedHostBrokerOptions } from './trustedHostBroker.js';

export interface BrokerServerHandle {
  readonly close: () => void;
}

/**
 * Runs the Broker protocol server on the given readable and writable streams.
 */
export function runBrokerServer(
  broker: TrustedHostBroker,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): BrokerServerHandle {
  let buffer = '';
  let closed = false;

  const onData = (chunk: Buffer | string): void => {
    if (closed) return;
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    // Protect against unbounded message buffer flood
    if (buffer.length > HOST_BROKER_LIMITS.maxPayloadBytes * 2) {
      process.stderr.write(
        `[BrokerProcessHost] Buffer limit exceeded (${buffer.length} bytes). Dropping excess.\n`,
      );
      buffer = '';
      return;
    }

    const lines = buffer.split('\n');
    // Keep the last incomplete fragment in the buffer
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      void processLine(trimmed);
    }
  };

  const processLine = async (line: string): Promise<void> => {
    let request: BrokerRequest;
    try {
      request = JSON.parse(line) as BrokerRequest;
    } catch (parseErr) {
      const errorResponse: BrokerResponse = {
        ok: false,
        requestId: 'unknown',
        correlationId: 'unknown',
        operation: 'unknown',
        error: {
          code: 'MALFORMED_REQUEST_BODY',
          message: `Broker request is not valid JSON: ${String(parseErr)}`,
        },
      };
      output.write(JSON.stringify(errorResponse) + '\n');
      return;
    }

    try {
      const response = await broker.handleRequest(request);
      output.write(JSON.stringify(response) + '\n');
    } catch (execErr) {
      const errorResponse: BrokerResponse = {
        ok: false,
        requestId: request.header?.requestId ?? 'unknown',
        correlationId: request.header?.correlationId ?? 'unknown',
        operation: request.operation ?? 'unknown',
        error: {
          code: 'BROKER_INTERNAL_ERROR',
          message: `Unhandled broker error: ${String(execErr)}`,
        },
      };
      output.write(JSON.stringify(errorResponse) + '\n');
    }
  };

  input.on('data', onData);

  const onClose = (): void => {
    closed = true;
    input.removeListener('data', onData);
  };

  input.on('end', onClose);
  input.on('close', onClose);

  return {
    close: onClose,
  };
}

/**
 * Entrypoint when executed directly as a child process worker.
 */
export function initializeBrokerProcessFromEnv(): BrokerServerHandle | null {
  const initConfigRaw = process.env.MEDIATOR_BROKER_CONFIG;
  if (!initConfigRaw) {
    return null;
  }

  try {
    const options = JSON.parse(initConfigRaw) as TrustedHostBrokerOptions;
    const broker = new TrustedHostBroker(options);
    return runBrokerServer(broker, process.stdin, process.stdout);
  } catch (err) {
    process.stderr.write(
      `[BrokerProcessHost] Failed to initialize from MEDIATOR_BROKER_CONFIG: ${String(err)}\n`,
    );
    process.exit(1);
  }
}

// Auto-initialize if launched directly with configuration env var
if (process.env.MEDIATOR_BROKER_CONFIG) {
  initializeBrokerProcessFromEnv();
}
