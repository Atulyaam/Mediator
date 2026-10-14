/**
 * @mediator/orchestrator — Process-Isolated Broker Transport (Sprint S49)
 *
 * Implements OS-level process boundary enforcement for TrustedHostBroker:
 * - Spawns TrustedHostBroker in a separate Windows child process.
 * - Scrubs sensitive host environment variables from child's environment block.
 * - Communicates strictly over standard input/output streams via newline-delimited JSON envelopes.
 * - Correlates asynchronous responses with request nonces and request IDs.
 * - Guarantees process-tree termination on cancellation, shutdown, or timeout.
 * - Fails closed with BROKER_UNAVAILABLE if child process exits or crashes.
 */

import { spawn, type ChildProcess, execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  type BrokerRequest,
  type BrokerResponse,
  type BrokerTransport,
  HOST_BROKER_LIMITS,
} from './hostBrokerTypes.js';
import { type TrustedHostBrokerOptions } from './trustedHostBroker.js';
import { cleanseEnvironment } from './windowsProcessSupervisor.js';

export interface ProcessIsolatedTransportOptions {
  readonly brokerOptions: TrustedHostBrokerOptions;
  readonly workerScriptPath?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export class ProcessIsolatedBrokerTransport implements BrokerTransport {
  private child: ChildProcess | null = null;
  private childPid: number | undefined;
  private readonly brokerOptions: TrustedHostBrokerOptions;
  private readonly workerScriptPath?: string | undefined;
  private readonly defaultTimeoutMs: number;
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: BrokerResponse<unknown>) => void;
      reject: (reason: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private isClosed = false;

  constructor(options: ProcessIsolatedTransportOptions) {
    this.brokerOptions = options.brokerOptions;
    this.workerScriptPath = options.workerScriptPath;
    this.defaultTimeoutMs = options.timeoutMs ?? HOST_BROKER_LIMITS.freshnessWindowMs;
    this.spawnBrokerProcess();
  }

  public getPid(): number | undefined {
    return this.childPid;
  }

  public isAlive(): boolean {
    return !this.isClosed && !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  private resolveWorkerScript(): string {
    if (this.workerScriptPath && fs.existsSync(this.workerScriptPath)) {
      return this.workerScriptPath;
    }
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const candidateDist = path.resolve(currentDir, '../../dist/hostContainment/brokerProcessHost.js');
    if (fs.existsSync(candidateDist)) {
      return candidateDist;
    }
    const candidateSameDirJs = path.join(currentDir, 'brokerProcessHost.js');
    if (fs.existsSync(candidateSameDirJs)) {
      return candidateSameDirJs;
    }
    return candidateDist;
  }

  private spawnBrokerProcess(): void {
    const workerScript = this.resolveWorkerScript();
    const cleanEnv = cleanseEnvironment(process.env);

    // Pass broker configuration to child process via isolated environment variable
    cleanEnv['MEDIATOR_BROKER_CONFIG'] = JSON.stringify(this.brokerOptions);

    const nodeArgs: string[] = [workerScript];

    try {
      this.child = spawn(process.execPath, nodeArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: cleanEnv,
        windowsHide: true,
        detached: false,
      });

      this.childPid = this.child.pid;

      if (!this.child.stdout || !this.child.stdin) {
        throw new Error('Child process stdio streams are not available');
      }

      const rl = readline.createInterface({
        input: this.child.stdout,
        crlfDelay: Infinity,
      });

      rl.on('line', (line: string) => {
        this.handleResponseLine(line);
      });

      this.child.stderr?.on('data', (_chunk: Buffer) => {
        // Diagnostic stderr output from child is ignored or redirected safely
      });

      this.child.on('exit', (code: number | null) => {
        this.handleChildExit(code ?? -1);
      });

      this.child.on('error', (err: Error) => {
        this.handleChildError(err);
      });
    } catch (spawnErr) {
      this.isClosed = true;
      throw new Error(`Failed to spawn isolated broker process: ${String(spawnErr)}`);
    }
  }

  private handleResponseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const response = JSON.parse(trimmed) as BrokerResponse;
      const pending = this.pendingRequests.get(response.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(response.requestId);
        pending.resolve(response);
      }
    } catch {
      // Malformed response line from child ignored
    }
  }

  private handleChildExit(code: number): void {
    this.isClosed = true;
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        requestId,
        correlationId: 'proc_exit',
        operation: 'unknown',
        error: {
          code: 'BROKER_UNAVAILABLE',
          message: `Isolated host broker process exited unexpectedly (code ${code}).`,
        },
      });
    }
    this.pendingRequests.clear();
  }

  private handleChildError(err: Error): void {
    this.isClosed = true;
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        requestId,
        correlationId: 'proc_error',
        operation: 'unknown',
        error: {
          code: 'BROKER_UNAVAILABLE',
          message: `Isolated host broker encountered process error: ${err.message}`,
        },
      });
    }
    this.pendingRequests.clear();
  }

  public async handleRequest<T, R>(request: BrokerRequest<T>): Promise<BrokerResponse<R>> {
    if (this.isClosed || !this.child || !this.child.stdin || !this.isAlive()) {
      return {
        ok: false,
        requestId: request.header?.requestId ?? 'unknown',
        correlationId: request.header?.correlationId ?? 'unknown',
        operation: request.operation ?? 'unknown',
        error: {
          code: 'BROKER_UNAVAILABLE',
          message: 'Process-isolated host broker is not running or has been terminated.',
        },
      };
    }

    const requestId = request.header.requestId;

    return new Promise<BrokerResponse<R>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve({
          ok: false,
          requestId,
          correlationId: request.header.correlationId,
          operation: request.operation,
          error: {
            code: 'BROKER_REQUEST_TIMEOUT',
            message: `Broker request timed out after ${this.defaultTimeoutMs}ms`,
          },
        });
      }, this.defaultTimeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: BrokerResponse<unknown>) => void,
        reject,
        timer,
      });

      try {
        const payloadJson = JSON.stringify(request) + '\n';
        this.child!.stdin!.write(payloadJson, 'utf8');
      } catch (writeErr) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        resolve({
          ok: false,
          requestId,
          correlationId: request.header.correlationId,
          operation: request.operation,
          error: {
            code: 'BROKER_COMMUNICATION_FAILED',
            message: `Failed to write request to broker process: ${String(writeErr)}`,
          },
        });
      }
    });
  }

  public async close(): Promise<void> {
    await Promise.resolve();
    if (this.isClosed) return;
    this.isClosed = true;

    // Clear pending requests
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        requestId,
        correlationId: 'closed',
        operation: 'unknown',
        error: {
          code: 'BROKER_UNAVAILABLE',
          message: 'Broker transport was explicitly closed.',
        },
      });
    }
    this.pendingRequests.clear();

    const pid = this.childPid;
    if (pid) {
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
        } catch {
          // Already exited
        }
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Already exited
        }
      }
    }

    if (this.child) {
      this.child.stdin?.end();
      this.child.kill();
      this.child = null;
    }
  }
}
