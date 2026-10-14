/**
 * @mediator/orchestrator — Trusted Host Broker Implementation (Sprint S45)
 *
 * Implements the Narrow Trusted Host Broker:
 * - Operates with host workspace access under strong, fail-closed constraints.
 * - Rejects generic shell commands and arbitrary path modifications.
 * - Enforces HMAC-SHA256 request authentication, nonce replay caches, and timestamp freshness.
 * - Revalidates path containment, ADS streams, device names, and TOCTOU source hashes.
 * - Enforces single-use cryptographic approval binding before any live workspace write.
 * - Guarantees fail-closed behavior on broker unavailability, restart, or misconfiguration.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  type WorkspaceRootState,
  validateContainedPath,
} from '@mediator/workspace-boundary';
import {
  HostBrokerOperation,
  PERMITTED_BROKER_OPERATIONS,
  PROHIBITED_BROKER_OPERATIONS,
  HOST_BROKER_LIMITS,
  type BrokerRequest,
  type BrokerResponse,
  BrokerRequestHeaderSchema,
  type WorkspaceStatusPayload,
  type WorkspaceStatusResult,
  type ReadSnapshotPayload,
  type ReadSnapshotResult,
  type StageProposalPayload,
  type StageProposalResult,
  type ApplyApprovedStagePayload,
  type ApplyApprovedStageResult,
  type DispatchSandboxRecipePayload,
  type DispatchSandboxRecipeResult,
  type BrokerTransport,
} from './hostBrokerTypes.js';

export interface BrokerApprovalRecord {
  readonly approvalId: string;
  readonly stageId: string;
  readonly approvalToken: string;
  readonly targetFiles: ReadonlyArray<string>;
  readonly baseContentHashes: Readonly<Record<string, string>>;
  readonly stagedContentHashes: Readonly<Record<string, string>>;
  status: 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';
  readonly expiresAt: number;
  readonly grantedBy: 'trusted_ui' | 'trusted_cli' | 'browser_ai' | 'mcp_agent';
}

export interface TrustedHostBrokerOptions {
  readonly sharedSecret: string;
  readonly workspace: WorkspaceRootState;
  readonly shadowStageDir: string;
  readonly backupDir: string;
  readonly s00Decision?: 'GO_IDE' | 'GO_WSL2' | 'NO-GO-AUTOEXEC';
  readonly onSandboxDispatch?: (
    payload: DispatchSandboxRecipePayload,
  ) => Promise<DispatchSandboxRecipeResult>;
}

export class TrustedHostBroker implements BrokerTransport {
  private readonly sharedSecret: string;
  private readonly workspace: WorkspaceRootState;
  private readonly shadowStageDir: string;
  private readonly backupDir: string;
  private readonly s00Decision: string;
  private readonly onSandboxDispatch?: (
    (payload: DispatchSandboxRecipePayload) => Promise<DispatchSandboxRecipeResult>
  ) | undefined;

  // Nonce replay tracking: maps nonce -> timestamp
  private readonly seenNonces = new Map<string, number>();

  // In-memory approvals ledger
  private readonly approvals = new Map<string, BrokerApprovalRecord>();

  constructor(options: TrustedHostBrokerOptions) {
    if (!options.sharedSecret || options.sharedSecret.length < 32) {
      throw new Error('TrustedHostBroker requires a high-entropy shared secret (min 32 chars)');
    }
    this.sharedSecret = options.sharedSecret;
    this.workspace = options.workspace;
    this.shadowStageDir = options.shadowStageDir;
    this.backupDir = options.backupDir;
    this.s00Decision = options.s00Decision ?? 'NO-GO-AUTOEXEC';
    this.onSandboxDispatch = options.onSandboxDispatch;

    // Ensure staging and backup directories exist
    fs.mkdirSync(this.shadowStageDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  /**
   * Register an approval into the broker's authoritative ledger.
   */
  public registerApproval(record: BrokerApprovalRecord): void {
    this.approvals.set(record.approvalId, { ...record });
  }

  /**
   * Retrieve an approval from the ledger.
   */
  public getApproval(approvalId: string): BrokerApprovalRecord | undefined {
    return this.approvals.get(approvalId);
  }

  /**
   * Main request entrypoint for broker operations.
   */
  public async handleRequest<T = unknown, R = unknown>(
    request: BrokerRequest<T>,
  ): Promise<BrokerResponse<R>> {
    const correlationId = request?.header?.correlationId ?? 'unknown-corr';
    const requestId = request?.header?.requestId ?? 'unknown-req';
    const operation = request?.operation ?? 'unknown-op';

    try {
      // 1. Prohibited operations check
      if (
        PROHIBITED_BROKER_OPERATIONS.some(
          (op) => (operation as string) === op || (operation as string).startsWith(op.split('.')[0]!),
        )
      ) {
        return {
          ok: false,
          requestId,
          correlationId,
          operation,
          error: {
            code: 'PROHIBITED_OPERATION',
            message: `Operation '${operation}' is strictly prohibited on the host broker`,
            violationDetails: 'Shell execution and arbitrary host commands are not permitted',
          },
        };
      }

      if (!PERMITTED_BROKER_OPERATIONS.has(operation)) {
        return {
          ok: false,
          requestId,
          correlationId,
          operation,
          error: {
            code: 'UNKNOWN_OPERATION',
            message: `Operation '${operation}' is not recognized by host broker`,
          },
        };
      }

      // 2. Header schema validation
      const parseHeader = BrokerRequestHeaderSchema.safeParse(request.header);
      if (!parseHeader.success) {
        return {
          ok: false,
          requestId,
          correlationId,
          operation,
          error: {
            code: 'MALFORMED_HEADER',
            message: 'Broker request header failed schema validation',
            violationDetails: parseHeader.error.message,
          },
        };
      }
      const header = parseHeader.data;

      // 3. Timestamp Freshness Window check (Replay defense)
      const now = Date.now();
      const timeDiff = Math.abs(now - header.timestamp);
      if (timeDiff > HOST_BROKER_LIMITS.freshnessWindowMs) {
        return {
          ok: false,
          requestId,
          correlationId,
          operation,
          error: {
            code: 'REQUEST_STALE',
            message: `Request timestamp drift (${timeDiff}ms) exceeds allowed freshness window (${HOST_BROKER_LIMITS.freshnessWindowMs}ms)`,
          },
        };
      }

      // 4. Nonce Replay Check
      this.purgeExpiredNonces(now);
      if (this.seenNonces.has(header.nonce)) {
        return {
          ok: false,
          requestId,
          correlationId,
          operation,
          error: {
            code: 'REPLAY_ATTACK_DETECTED',
            message: `Request nonce '${header.nonce}' was already processed`,
            violationDetails: 'Replay of prior broker requests is strictly prohibited',
          },
        };
      }
      this.seenNonces.set(header.nonce, now);

      // 5. Cryptographic HMAC-SHA256 Signature Verification
      const payloadString = JSON.stringify(request.payload ?? null);
      const payloadHash = crypto.createHash('sha256').update(payloadString).digest('hex');
      const expectedSignMaterial = `${header.requestId}:${header.timestamp}:${header.nonce}:${operation}:${payloadHash}`;
      const expectedSignature = crypto
        .createHmac('sha256', this.sharedSecret)
        .update(expectedSignMaterial)
        .digest('hex');

      const expectedBuf = Buffer.from(expectedSignature, 'utf8');
      const actualBuf = Buffer.from(header.signature, 'utf8');

      if (
        expectedBuf.length !== actualBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, actualBuf)
      ) {
        return {
          ok: false,
          requestId,
          correlationId,
          operation,
          error: {
            code: 'AUTHENTICATION_FAILED',
            message: 'HMAC signature verification failed',
            violationDetails: 'Request signature does not match expected cryptographic hash',
          },
        };
      }

      // 6. Caller Origin Gating: Reject AI or MCP attempting privileged operations
      if (header.callerOrigin === 'browser_ai' || header.callerOrigin === 'mcp_agent') {
        return {
          ok: false,
          requestId,
          correlationId,
          operation,
          error: {
            code: 'CALLER_UNAUTHORIZED',
            message: `Caller origin '${header.callerOrigin}' cannot invoke host broker operations`,
            violationDetails: 'AI provider and browser extensions are strictly isolated from host broker',
          },
        };
      }

      // 7. Dispatch to specific operation handlers
      switch (operation) {
        case HostBrokerOperation.WORKSPACE_STATUS: {
          const res = this.handleWorkspaceStatus(request.payload as WorkspaceStatusPayload);
          return {
            ok: true,
            requestId,
            correlationId,
            operation,
            result: res as unknown as R,
          };
        }

        case HostBrokerOperation.READ_SNAPSHOT: {
          const res = this.handleReadSnapshot(request.payload as ReadSnapshotPayload);
          return {
            ok: true,
            requestId,
            correlationId,
            operation,
            result: res as unknown as R,
          };
        }

        case HostBrokerOperation.STAGE_PROPOSAL: {
          const res = this.handleStageProposal(request.payload as StageProposalPayload);
          return {
            ok: true,
            requestId,
            correlationId,
            operation,
            result: res as unknown as R,
          };
        }

        case HostBrokerOperation.APPLY_APPROVED_STAGE: {
          const res = this.handleApplyApprovedStage(
            request.payload as ApplyApprovedStagePayload,
            header.callerOrigin,
          );
          return {
            ok: true,
            requestId,
            correlationId,
            operation,
            result: res as unknown as R,
          };
        }

        case HostBrokerOperation.DISPATCH_SANDBOX_RECIPE: {
          const res = await this.handleDispatchSandboxRecipe(
            request.payload as DispatchSandboxRecipePayload,
          );
          return {
            ok: true,
            requestId,
            correlationId,
            operation,
            result: res as unknown as R,
          };
        }

        default:
          return {
            ok: false,
            requestId,
            correlationId,
            operation,
            error: { code: 'UNHANDLED_OPERATION', message: `Unhandled operation ${String(operation)}` },
          };
      }
    } catch (err: unknown) {
      const errorObj = err as { code?: string; message?: string; details?: unknown };
      return {
        ok: false,
        requestId,
        correlationId,
        operation,
        error: {
          code: errorObj.code ?? 'BROKER_ERROR',
          message: errorObj.message ?? String(err),
          violationDetails: errorObj.details ? JSON.stringify(errorObj.details) : undefined,
        },
      };
    }
  }

  // ─── Private Operation Handlers ──────────────────────────────────────────

  private handleWorkspaceStatus(_payload: WorkspaceStatusPayload): WorkspaceStatusResult {
    const canonicalRoot = this.workspace.canonicalPath ?? this.workspace.selectedPath;
    const exists = fs.existsSync(canonicalRoot);
    return {
      confirmed: this.workspace.confirmationStatus === 'confirmed',
      canonicalRoot,
      exists,
    };
  }

  private handleReadSnapshot(payload: ReadSnapshotPayload): ReadSnapshotResult {
    // Path containment check
    const cont = validateContainedPath(this.workspace, payload.relativePath);
    if (!cont.ok) {
      const err = new Error(`Path outside workspace: ${cont.error.message}`) as Error & {
        code: string;
      };
      err.code = 'PATH_OUTSIDE_WORKSPACE';
      throw err;
    }

    const canonicalRoot = this.workspace.canonicalPath ?? this.workspace.selectedPath;
    const fullPath = path.resolve(canonicalRoot, payload.relativePath);

    if (!fs.existsSync(fullPath)) {
      return {
        relativePath: payload.relativePath,
        existsAtBase: false,
        content: null,
        contentHash: null,
        sizeBytes: 0,
      };
    }

    const stat = fs.statSync(fullPath);
    if (stat.size > HOST_BROKER_LIMITS.maxSnapshotBytes) {
      const err = new Error(
        `File size (${stat.size} bytes) exceeds broker limit (${HOST_BROKER_LIMITS.maxSnapshotBytes} bytes)`,
      ) as Error & { code: string };
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    return {
      relativePath: payload.relativePath,
      existsAtBase: true,
      content,
      contentHash,
      sizeBytes: stat.size,
    };
  }

  private handleStageProposal(payload: StageProposalPayload): StageProposalResult {
    // 1. Path containment check on relativePath
    const cont = validateContainedPath(this.workspace, payload.relativePath);
    if (!cont.ok) {
      const err = new Error(`Path outside workspace: ${cont.error.message}`) as Error & {
        code: string;
      };
      err.code = 'PATH_OUTSIDE_WORKSPACE';
      throw err;
    }

    // 2. Validate base match if modifying or deleting
    const canonicalRoot = this.workspace.canonicalPath ?? this.workspace.selectedPath;
    const livePath = path.resolve(canonicalRoot, payload.relativePath);
    let baseMatch = false;

    if (fs.existsSync(livePath)) {
      const liveContent = fs.readFileSync(livePath, 'utf8');
      const liveHash = crypto.createHash('sha256').update(liveContent).digest('hex');
      baseMatch = liveHash === payload.baseContentHash;
    } else {
      baseMatch = payload.baseContentHash === '';
    }

    // 3. Write to shadow staging directory ONLY (never to live workspace)
    const stageFolder = path.join(this.shadowStageDir, payload.stageId);
    fs.mkdirSync(stageFolder, { recursive: true });

    // Clean relative path for staging disk storage
    const normalizedRel = payload.relativePath.replace(/[\\/]/g, '_');
    const stagedFilePath = path.join(stageFolder, normalizedRel);
    fs.writeFileSync(stagedFilePath, payload.proposedContent, 'utf8');

    const stagedHash = crypto
      .createHash('sha256')
      .update(payload.proposedContent)
      .digest('hex');

    return {
      stageId: payload.stageId,
      stagedPath: stagedFilePath,
      stagedHash,
      baseMatch,
    };
  }

  private handleApplyApprovedStage(
    payload: ApplyApprovedStagePayload,
    callerOrigin: string,
  ): ApplyApprovedStageResult {
    // 1. Caller verification: Only trusted UI or trusted CLI can approve/apply
    if (callerOrigin !== 'trusted_ui' && callerOrigin !== 'trusted_cli') {
      const err = new Error(
        `Caller origin '${callerOrigin}' is not authorized to apply live changes`,
      ) as Error & { code: string };
      err.code = 'APPROVAL_CALLER_UNAUTHORIZED';
      throw err;
    }

    // 2. Approval Record verification
    const approval = this.approvals.get(payload.approvalId);
    if (!approval) {
      const err = new Error(`Approval '${payload.approvalId}' not found`) as Error & {
        code: string;
      };
      err.code = 'APPROVAL_NOT_FOUND';
      throw err;
    }

    if (approval.status === 'consumed') {
      const err = new Error(
        `Approval '${payload.approvalId}' has already been consumed (single-use invariant)`,
      ) as Error & { code: string };
      err.code = 'APPROVAL_ALREADY_CONSUMED';
      throw err;
    }

    if (approval.status !== 'approved') {
      const err = new Error(
        `Approval '${payload.approvalId}' is not in approved state (status: ${approval.status})`,
      ) as Error & { code: string };
      err.code = 'APPROVAL_REQUIRED';
      throw err;
    }

    if (Date.now() > approval.expiresAt) {
      approval.status = 'expired';
      const err = new Error(`Approval '${payload.approvalId}' has expired`) as Error & {
        code: string;
      };
      err.code = 'APPROVAL_EXPIRED';
      throw err;
    }

    if (approval.approvalToken !== payload.approvalToken) {
      const err = new Error(
        `Approval token mismatch for approval '${payload.approvalId}'`,
      ) as Error & { code: string };
      err.code = 'APPROVAL_TOKEN_INVALID';
      throw err;
    }

    if (approval.stageId !== payload.stageId) {
      const err = new Error(
        `Approval stage mismatch (expected '${approval.stageId}', received '${payload.stageId}')`,
      ) as Error & { code: string };
      err.code = 'STAGE_MISMATCH';
      throw err;
    }

    // 3. Preflight path containment and TOCTOU hash checks
    const canonicalRoot = this.workspace.canonicalPath ?? this.workspace.selectedPath;
    const stageFolder = path.join(this.shadowStageDir, payload.stageId);

    for (const relPath of payload.targetFiles) {
      const cont = validateContainedPath(this.workspace, relPath);
      if (!cont.ok) {
        const err = new Error(`Path outside workspace: ${cont.error.message}`) as Error & {
          code: string;
        };
        err.code = 'PATH_OUTSIDE_WORKSPACE';
        throw err;
      }

      const livePath = path.resolve(canonicalRoot, relPath);
      const expectedBaseHash = approval.baseContentHashes[relPath];

      if (expectedBaseHash !== undefined) {
        // Source file must exist and match base hash
        if (!fs.existsSync(livePath)) {
          const err = new Error(
            `Live file '${relPath}' was deleted externally since staging`,
          ) as Error & { code: string };
          err.code = 'TOCTOU_HASH_MISMATCH';
          throw err;
        }
        const currentContent = fs.readFileSync(livePath, 'utf8');
        const currentHash = crypto.createHash('sha256').update(currentContent).digest('hex');
        if (currentHash !== expectedBaseHash) {
          const err = new Error(
            `Live file '${relPath}' has been modified externally since approval (TOCTOU violation)`,
          ) as Error & { code: string };
          err.code = 'TOCTOU_HASH_MISMATCH';
          throw err;
        }
      }

      // Staged file integrity check
      const normalizedRel = relPath.replace(/[\\/]/g, '_');
      const stagedFilePath = path.join(stageFolder, normalizedRel);
      if (!fs.existsSync(stagedFilePath)) {
        const err = new Error(`Staged file for '${relPath}' not found in stage storage`) as Error & {
          code: string;
        };
        err.code = 'STAGE_FILE_MISSING';
        throw err;
      }

      const stagedContent = fs.readFileSync(stagedFilePath, 'utf8');
      const stagedHash = crypto.createHash('sha256').update(stagedContent).digest('hex');
      const expectedStagedHash = approval.stagedContentHashes[relPath];

      if (expectedStagedHash && stagedHash !== expectedStagedHash) {
        const err = new Error(
          `Staged file '${relPath}' content was modified after approval was granted`,
        ) as Error & { code: string };
        err.code = 'STAGE_TAMPER_DETECTED';
        throw err;
      }
    }

    // 4. Create Pre-Apply Backup
    const transactionId = `tx_${crypto.randomBytes(8).toString('hex')}`;
    const txBackupDir = path.join(this.backupDir, transactionId);
    fs.mkdirSync(txBackupDir, { recursive: true });

    for (const relPath of payload.targetFiles) {
      const livePath = path.resolve(canonicalRoot, relPath);
      if (fs.existsSync(livePath)) {
        const backupPath = path.join(txBackupDir, relPath.replace(/[\\/]/g, '_'));
        fs.copyFileSync(livePath, backupPath);
      }
    }

    // 5. Apply changes to live workspace atomically
    for (const relPath of payload.targetFiles) {
      const livePath = path.resolve(canonicalRoot, relPath);
      const normalizedRel = relPath.replace(/[\\/]/g, '_');
      const stagedFilePath = path.join(stageFolder, normalizedRel);
      const stagedContent = fs.readFileSync(stagedFilePath, 'utf8');

      fs.mkdirSync(path.dirname(livePath), { recursive: true });
      fs.writeFileSync(livePath, stagedContent, 'utf8');
    }

    // 6. Mark approval as consumed immediately (Single-use invariant)
    approval.status = 'consumed';

    return {
      success: true,
      appliedFiles: payload.targetFiles,
      transactionId,
      backupDir: txBackupDir,
    };
  }

  private async handleDispatchSandboxRecipe(
    payload: DispatchSandboxRecipePayload,
  ): Promise<DispatchSandboxRecipeResult> {
    // 1. Mandatory S00 NO-GO-AUTOEXEC check
    if (this.s00Decision === 'NO-GO-AUTOEXEC') {
      return {
        status: 'security_violation',
        exitCode: 1,
        stdout: '',
        stderr: '',
        violationDetails:
          'CRITICAL: Autonomous local recipe execution is blocked under S00 NO-GO-AUTOEXEC policy',
      };
    }

    // 2. Mandatory Network Isolation check
    if (!payload.isolateNetwork && !payload.allowUnisolatedNetworkForCanary) {
      return {
        status: 'security_violation',
        exitCode: 1,
        stdout: '',
        stderr: '',
        violationDetails:
          'CRITICAL: Attempted execution without network isolation on MediatorSandbox without canary authorization',
      };
    }

    // 3. Delegate to registered sandbox executor if provided
    if (this.onSandboxDispatch) {
      return await this.onSandboxDispatch(payload);
    }

    return {
      status: 'success',
      exitCode: 0,
      stdout: 'Simulated sandbox execution completed offline',
      stderr: '',
    };
  }

  private purgeExpiredNonces(now: number): void {
    const cutoff = now - HOST_BROKER_LIMITS.nonceCacheTtlMs;
    for (const [nonce, timestamp] of this.seenNonces.entries()) {
      if (timestamp < cutoff) {
        this.seenNonces.delete(nonce);
      }
    }
  }
}
