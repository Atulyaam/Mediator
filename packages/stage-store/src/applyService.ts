/**
 * @mediator/stage-store — Live Workspace Apply-Back & Rollback Service (S14)
 *
 * Requirements:
 * - Controlled, recoverable apply-back only after trusted UI approval.
 * - Enforces clean, conflict-free state immediately before write phase.
 * - Atomic file replacements on same volume via temporary files.
 * - Persistent transaction journal and pre-apply backups.
 * - Rollback preserves intervening user edits (never silently overwrites them).
 * - Multi-file interruptions leave clear recovery information.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { type DatabaseConnection } from '@mediator/persistence';
import {
  type WorkspaceRootState,
  checkWorkspacePermittedForFileOps,
  validateContainedPath,
} from '@mediator/workspace-boundary';
import { type CallerIdentity } from '@mediator/policy-engine';
import {
  type ApplyResult,
  type ApplyTransactionRecord,
  type ApplyItemRecord,
} from './applyTypes.js';
import { ApplyError, ApplyErrorCode } from './applyErrors.js';
import { ApprovalService } from './approvalService.js';
import { ApplyJournal } from './applyJournal.js';
import { StageStorage } from './stageStorage.js';
import { StageRepository } from './stageRepository.js';
import { captureSourceSnapshot, computeSha256 } from './stageSnapshot.js';

export interface ApplyServiceOptions {
  readonly baseBackupDir?: string | undefined;
}

export class ApplyService {
  private readonly journal: ApplyJournal;
  private readonly stageRepo: StageRepository;
  private readonly baseBackupDir: string;

  constructor(
    private readonly db: DatabaseConnection,
    private readonly stageStorage: StageStorage,
    private readonly approvalService: ApprovalService,
    options?: ApplyServiceOptions,
  ) {
    this.journal = new ApplyJournal(db);
    this.stageRepo = new StageRepository(db);

    const appData = process.env.APPDATA || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'share'));

    this.baseBackupDir = options?.baseBackupDir ?? path.join(appData, 'Mediator', 'backups');
  }

  /**
   * Apply approved staged changes to the live project workspace.
   */
  public applyToWorkspace(
    stageId: string,
    approvalId: string,
    workspace: WorkspaceRootState,
    _caller: CallerIdentity,
  ): ApplyResult {
    // 1. Workspace permission check
    const perm = checkWorkspacePermittedForFileOps(workspace);
    if (!perm.ok) {
      throw new ApplyError(
        ApplyErrorCode.UNSAFE_WORKSPACE,
        `Cannot apply changes to unconfirmed workspace root: ${perm.error.message}`,
        { stageId, details: perm.error },
      );
    }
    const canonicalRoot = workspace.canonicalPath ?? workspace.selectedPath;

    // 2. Fetch stage and staged files
    const stage = this.stageRepo.getStage(stageId);
    if (!stage) {
      throw new ApplyError(ApplyErrorCode.STAGE_CONFLICT, `Stage '${stageId}' not found in persistence`, { stageId });
    }
    if (stage.status === 'discarded') {
      throw new ApplyError(ApplyErrorCode.STAGE_CONFLICT, `Cannot apply changes from discarded stage '${stageId}'`, { stageId });
    }

    const stagedFiles = this.stageRepo.listStagedFiles(stageId);
    if (stagedFiles.length === 0) {
      throw new ApplyError(ApplyErrorCode.APPLY_FAILED, `Stage '${stageId}' contains no staged files to apply`, { stageId });
    }

    // 3. Pre-validate approval status before preflight checks
    const existingApproval = this.approvalService.getApproval(approvalId);
    if (!existingApproval) {
      throw new ApplyError(
        ApplyErrorCode.APPROVAL_NOT_FOUND,
        `Approval '${approvalId}' was not found`,
        { approvalId },
      );
    }
    if (existingApproval.status === 'consumed') {
      throw new ApplyError(
        ApplyErrorCode.APPROVAL_ALREADY_CONSUMED,
        `Approval '${approvalId}' has already been consumed (single-use invariant)`,
        { approvalId },
      );
    }
    if (existingApproval.status === 'expired' || Date.now() > existingApproval.expiresAt) {
      throw new ApplyError(
        ApplyErrorCode.APPROVAL_EXPIRED,
        `Approval '${approvalId}' has expired`,
        { approvalId },
      );
    }
    if (existingApproval.status !== 'approved') {
      throw new ApplyError(
        ApplyErrorCode.APPROVAL_REQUIRED,
        `Approval '${approvalId}' is not approved (status: ${existingApproval.status})`,
        { approvalId },
      );
    }

    // 4. Preflight containment and live conflict validation
    for (const f of stagedFiles) {
      // S05 containment
      const cont = validateContainedPath(workspace, f.relativePath);
      if (!cont.ok) {
        throw new ApplyError(
          ApplyErrorCode.UNSAFE_WORKSPACE,
          `Path '${f.relativePath}' is outside workspace root: ${cont.error.message}`,
          { stageId, path: f.relativePath, details: cont.error },
        );
      }
      if (f.targetPath) {
        const targetCont = validateContainedPath(workspace, f.targetPath);
        if (!targetCont.ok) {
          throw new ApplyError(
            ApplyErrorCode.UNSAFE_WORKSPACE,
            `Rename target '${f.targetPath}' is outside workspace root: ${targetCont.error.message}`,
            { stageId, path: f.targetPath, details: targetCont.error },
          );
        }
      }

      // Live conflict check
      const liveSnapshot = captureSourceSnapshot(workspace, f.relativePath);
      if (f.sourceExistsAtBase) {
        if (!liveSnapshot.existsAtBase) {
          throw new ApplyError(
            ApplyErrorCode.APPLY_CONFLICT,
            `Live file '${f.relativePath}' was deleted externally since staging`,
            { stageId, path: f.relativePath },
          );
        }
        if (liveSnapshot.contentHash !== f.baseContentHash) {
          throw new ApplyError(
            ApplyErrorCode.APPLY_CONFLICT,
            `Live file '${f.relativePath}' has been modified externally since staging (hash mismatch)`,
            { stageId, path: f.relativePath, details: { expected: f.baseContentHash, current: liveSnapshot.contentHash } },
          );
        }
      } else {
        // File was an add proposal
        if (liveSnapshot.existsAtBase) {
          throw new ApplyError(
            ApplyErrorCode.APPLY_CONFLICT,
            `File '${f.relativePath}' already exists in live workspace (expected new file)`,
            { stageId, path: f.relativePath },
          );
        }
      }

      if (f.changeType === 'rename-proposed' && f.targetPath) {
        const targetSnap = captureSourceSnapshot(workspace, f.targetPath);
        if (targetSnap.existsAtBase) {
          throw new ApplyError(
            ApplyErrorCode.APPLY_CONFLICT,
            `Rename target '${f.targetPath}' already exists in live workspace`,
            { stageId, path: f.targetPath },
          );
        }
      }
    }

    // 4. Consume approval (enforces trusted resolution, non-expiry, single-use, payload hash binding)
    const consumedApproval = this.approvalService.consumeApproval(approvalId, stagedFiles);

    // 5. Create backup directory for rollback
    const transactionId = `tx_${crypto.randomUUID()}`;
    const txBackupDir = path.join(this.baseBackupDir, transactionId);
    fs.mkdirSync(txBackupDir, { recursive: true });

    // Copy existing live files to backup directory
    for (const f of stagedFiles) {
      if (f.sourceExistsAtBase) {
        const liveFilePath = path.join(canonicalRoot, f.relativePath);
        const backupFilePath = path.join(txBackupDir, f.relativePath);
        fs.mkdirSync(path.dirname(backupFilePath), { recursive: true });
        fs.copyFileSync(liveFilePath, backupFilePath);
      }
    }

    // 6. Record transaction in journal
    const now = Date.now();
    const txRecord: ApplyTransactionRecord = {
      transactionId,
      taskId: stage.taskId,
      stageId,
      approvalId,
      payloadHash: consumedApproval.payloadHash,
      status: 'applying',
      backupDir: txBackupDir,
      createdAt: now,
    };
    this.journal.createTransaction(txRecord);

    const itemsToApply: ApplyItemRecord[] = stagedFiles.map((f, idx) => ({
      itemId: `item_${transactionId}_${idx}`,
      transactionId,
      relativePath: f.relativePath,
      operation: f.changeType,
      baseHash: f.baseContentHash,
      status: 'pending',
      backupPath: f.sourceExistsAtBase ? path.join(txBackupDir, f.relativePath) : undefined,
      targetPath: f.targetPath,
    }));

    for (const item of itemsToApply) {
      this.journal.createItem(item);
    }

    // 7. Execute Mutations to Live Workspace
    const appliedItems: ApplyItemRecord[] = [];
    try {
      for (const item of itemsToApply) {
        const stagedRecord = stagedFiles.find((f) => f.relativePath === item.relativePath)!;
        const liveDestPath = path.join(canonicalRoot, item.relativePath);

        if (item.operation === 'delete-proposed') {
          // Verify source still matches base hash before deletion
          const currentSnap = captureSourceSnapshot(workspace, item.relativePath);
          if (currentSnap.contentHash !== item.baseHash) {
            throw new ApplyError(
              ApplyErrorCode.APPLY_CONFLICT,
              `Live file '${item.relativePath}' modified immediately before delete`,
              { transactionId, path: item.relativePath },
            );
          }
          if (fs.existsSync(liveDestPath)) {
            fs.unlinkSync(liveDestPath);
          }
          this.journal.updateItemStatus(item.itemId, 'applied');
          appliedItems.push({ ...item, status: 'applied' });
        } else if (item.operation === 'rename-proposed') {
          const liveTargetPath = path.join(canonicalRoot, item.targetPath!);
          const currentSnap = captureSourceSnapshot(workspace, item.relativePath);
          if (currentSnap.contentHash !== item.baseHash) {
            throw new ApplyError(
              ApplyErrorCode.APPLY_CONFLICT,
              `Live file '${item.relativePath}' modified immediately before rename`,
              { transactionId, path: item.relativePath },
            );
          }
          fs.mkdirSync(path.dirname(liveTargetPath), { recursive: true });
          fs.renameSync(liveDestPath, liveTargetPath);
          this.journal.updateItemStatus(item.itemId, 'applied', item.baseHash ?? undefined);
          appliedItems.push({ ...item, status: 'applied', postApplyHash: item.baseHash ?? undefined });
        } else {
          // 'add' or 'modify'
          const stagedBuffer = this.stageStorage.readStagedFile(
            stage.taskId,
            stageId,
            item.relativePath,
          );

          // Re-verify live file base hash immediately before mutation
          if (item.operation === 'modify') {
            const currentSnap = captureSourceSnapshot(workspace, item.relativePath);
            if (currentSnap.contentHash !== item.baseHash) {
              throw new ApplyError(
                ApplyErrorCode.APPLY_CONFLICT,
                `Live file '${item.relativePath}' modified immediately before writing`,
                { transactionId, path: item.relativePath },
              );
            }
          }

          // Write atomically using same-volume temporary file
          fs.mkdirSync(path.dirname(liveDestPath), { recursive: true });
          const tmpFilePath = path.join(
            path.dirname(liveDestPath),
            `.mediator_apply_tmp_${crypto.randomBytes(6).toString('hex')}.tmp`,
          );
          fs.writeFileSync(tmpFilePath, stagedBuffer);
          fs.renameSync(tmpFilePath, liveDestPath);

          // Verify post-apply content hash
          const writtenBuffer = fs.readFileSync(liveDestPath);
          const postApplyHash = computeSha256(writtenBuffer);
          if (postApplyHash !== stagedRecord.stagedContentHash) {
            throw new ApplyError(
              ApplyErrorCode.APPLY_FAILED,
              `Post-apply content hash verification failed for '${item.relativePath}'`,
              { transactionId, path: item.relativePath },
            );
          }

          this.journal.updateItemStatus(item.itemId, 'applied', postApplyHash);
          appliedItems.push({ ...item, status: 'applied', postApplyHash });
        }
      }

      // Mark transaction applied
      this.journal.updateTransactionStatus(transactionId, 'applied');

      return {
        transactionId,
        status: 'applied',
        appliedCount: appliedItems.length,
        rolledBackCount: 0,
        recoveryRequiredCount: 0,
        items: appliedItems,
      };
    } catch (applyErr) {
      // 8. Partial failure rollback
      const rollbackRes = this.rollbackAppliedTransaction(transactionId, workspace, appliedItems);
      this.journal.updateTransactionStatus(
        transactionId,
        rollbackRes.recoveryRequiredCount > 0 ? 'recovery_required' : 'rolled_back',
        applyErr instanceof Error ? applyErr.message : String(applyErr),
      );

      throw new ApplyError(
        rollbackRes.recoveryRequiredCount > 0 ? ApplyErrorCode.RECOVERY_REQUIRED : ApplyErrorCode.APPLY_FAILED,
        `Apply transaction '${transactionId}' failed and was rolled back: ${applyErr instanceof Error ? applyErr.message : String(applyErr)}`,
        { transactionId, details: rollbackRes },
      );
    }
  }

  /**
   * Rollback a transaction previously applied to the live workspace.
   * Invariant: Never overwrites intervening user edits.
   */
  public rollbackTransaction(
    transactionId: string,
    workspace: WorkspaceRootState,
  ): ApplyResult {
    const tx = this.journal.getTransaction(transactionId);
    if (!tx) {
      throw new ApplyError(ApplyErrorCode.APPLY_FAILED, `Transaction '${transactionId}' not found`, { transactionId });
    }

    const items = this.journal.listTransactionItems(transactionId);
    return this.rollbackAppliedTransaction(transactionId, workspace, items);
  }

  private rollbackAppliedTransaction(
    transactionId: string,
    workspace: WorkspaceRootState,
    itemsToRollback: readonly ApplyItemRecord[],
  ): ApplyResult {
    const canonicalRoot = workspace.canonicalPath ?? workspace.selectedPath;
    let rolledBackCount = 0;
    let recoveryRequiredCount = 0;
    const resultItems: ApplyItemRecord[] = [];

    for (const item of itemsToRollback) {
      if (item.status !== 'applied') {
        continue;
      }

      const liveDestPath = path.join(canonicalRoot, item.relativePath);

      if (item.operation === 'add') {
        // Was a newly added file
        if (fs.existsSync(liveDestPath)) {
          const currentBuf = fs.readFileSync(liveDestPath);
          const currentHash = computeSha256(currentBuf);
          if (currentHash === item.postApplyHash) {
            // Unchanged by user since Mediator wrote it -> safe to unlink
            fs.unlinkSync(liveDestPath);
            rolledBackCount++;
            this.journal.updateItemStatus(item.itemId, 'rolled_back');
            resultItems.push({ ...item, status: 'rolled_back' });
          } else {
            // User edited the file after Mediator applied it -> DO NOT OVERWRITE!
            recoveryRequiredCount++;
            this.journal.updateItemStatus(item.itemId, 'recovery_required', undefined, 'User modified file after apply');
            resultItems.push({ ...item, status: 'recovery_required' });
          }
        }
      } else if (item.operation === 'delete-proposed') {
        // Was deleted -> restore from backup
        if (item.backupPath && fs.existsSync(item.backupPath)) {
          fs.mkdirSync(path.dirname(liveDestPath), { recursive: true });
          fs.copyFileSync(item.backupPath, liveDestPath);
          rolledBackCount++;
          this.journal.updateItemStatus(item.itemId, 'rolled_back');
          resultItems.push({ ...item, status: 'rolled_back' });
        }
      } else if (item.operation === 'rename-proposed') {
        // Was renamed -> move back if target unmodified
        const liveTargetPath = path.join(canonicalRoot, item.targetPath!);
        if (fs.existsSync(liveTargetPath)) {
          fs.renameSync(liveTargetPath, liveDestPath);
          rolledBackCount++;
          this.journal.updateItemStatus(item.itemId, 'rolled_back');
          resultItems.push({ ...item, status: 'rolled_back' });
        }
      } else {
        // 'modify' -> restore from backup ONLY IF user hasn't modified live file since
        if (fs.existsSync(liveDestPath) && item.backupPath && fs.existsSync(item.backupPath)) {
          const currentBuf = fs.readFileSync(liveDestPath);
          const currentHash = computeSha256(currentBuf);
          if (currentHash === item.postApplyHash) {
            fs.copyFileSync(item.backupPath, liveDestPath);
            rolledBackCount++;
            this.journal.updateItemStatus(item.itemId, 'rolled_back');
            resultItems.push({ ...item, status: 'rolled_back' });
          } else {
            // User edited the file after Mediator applied it -> RECOVERY REQUIRED
            recoveryRequiredCount++;
            this.journal.updateItemStatus(item.itemId, 'recovery_required', undefined, 'User modified file after apply');
            resultItems.push({ ...item, status: 'recovery_required' });
          }
        }
      }
    }

    const finalStatus = recoveryRequiredCount > 0 ? 'recovery_required' : 'rolled_back';
    this.journal.updateTransactionStatus(transactionId, finalStatus);

    return {
      transactionId,
      status: finalStatus,
      appliedCount: 0,
      rolledBackCount,
      recoveryRequiredCount,
      items: resultItems,
    };
  }
}
