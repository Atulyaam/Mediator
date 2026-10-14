/**
 * @mediator/stage-store — Public Staging Service (S12)
 *
 * Requirements:
 * - Coordinates shadow staging storage, SQLite persistence, source snapshots,
 *   diff previews, conflict detection, and rollback checkpoints.
 * - Invariant: Zero modification of the live workspace during any staging operation.
 * - Rechecks workspace confirmation and containment before accessing source files.
 * - Fails closed on any security or integrity violation.
 */

import * as crypto from 'node:crypto';
import { type DatabaseConnection } from '@mediator/persistence';
import {
  type WorkspaceRootState,
  checkWorkspacePermittedForFileOps,
} from '@mediator/workspace-boundary';
import {
  type StageRecord,
  type StagedFileRecord,
  type StageFileProposal,
  type StageDiffPreview,
  type StageCheckpointRecord,
  type StagingCapabilities,
  type StageStoreOptions,
  type CreateStageParams,
  type DiscardStageConfirmation,
} from './stageTypes.js';
import { StageError, StageErrorCode } from './stageErrors.js';
import { StageStorage } from './stageStorage.js';
import { StageRepository } from './stageRepository.js';
import { captureSourceSnapshot, computeSha256 } from './stageSnapshot.js';
import { validateProposal } from './stageChanges.js';
import { detectLiveConflict } from './stageConflicts.js';
import { generateDiffPreview } from './stageDiff.js';
import { createCheckpoint, restoreCheckpoint } from './stageCheckpoint.js';
import { PatchEngine } from './patchEngine.js';
import { type PatchProposal, type PatchResult } from './patchTypes.js';
import { PatchError, PatchErrorCode } from './patchErrors.js';

export class StageStore {
  private readonly storage: StageStorage;
  private readonly repo: StageRepository;
  private readonly patchEngine: PatchEngine;

  constructor(
    private readonly db: DatabaseConnection,
    options?: StageStoreOptions,
  ) {
    this.storage = new StageStorage(options?.baseStagingDir);
    this.repo = new StageRepository(db);
    this.patchEngine = new PatchEngine(this.storage, this.repo);
  }

  public getStagingCapabilities(): StagingCapabilities {
    return {
      stagingRoot: this.storage.getStagingRoot(),
      isolationMethod: 'app_data_shadow',
      liveWorkspaceMutationEnabled: false,
      sandboxAccessibility: 'unknown',
    };
  }

  public createStage(params: CreateStageParams): StageRecord {
    const { taskId, workspace, metadata } = params;

    // 1. Validate confirmed workspace
    const perm = checkWorkspacePermittedForFileOps(workspace);
    if (!perm.ok) {
      throw new StageError(
        StageErrorCode.UNSAFE_WORKSPACE_ROOT,
        `Cannot create stage on unconfirmed workspace root: ${perm.error.message}`,
        { taskId, details: perm.error },
      );
    }

    const stageId = params.stageId ?? `stage_${crypto.randomBytes(6).toString('hex')}`;

    // 2. Prevent duplicate stage ID
    const existing = this.repo.getStage(stageId);
    if (existing) {
      throw new StageError(
        StageErrorCode.STAGE_ALREADY_EXISTS,
        `Stage with id '${stageId}' already exists`,
        { stageId, taskId },
      );
    }

    // 3. Initialize storage directory
    this.storage.initStageStorage(taskId, stageId);

    // 4. Create database record
    const now = Date.now();
    const canonicalPath = workspace.canonicalPath ?? workspace.selectedPath;
    const stage: StageRecord = {
      stageId,
      taskId,
      workspaceIdentity: canonicalPath,
      canonicalWorkspacePath: canonicalPath,
      status: 'active',
      checkpointId: null,
      stageVersion: 1,
      parentCheckpointId: null,
      createdAt: now,
      updatedAt: now,
      metadata,
    };

    this.repo.createStage(stage);
    return stage;
  }

  public getStage(stageId: string): StageRecord | null {
    return this.repo.getStage(stageId);
  }

  public getStagesForTask(taskId: string): StageRecord[] {
    return this.repo.getStagesForTask(taskId);
  }

  public stageFileProposal(
    stageId: string,
    proposal: StageFileProposal,
    workspace: WorkspaceRootState,
  ): StagedFileRecord {
    // 1. Load active stage
    const stage = this.getRequiredStage(stageId);
    if (stage.status === 'discarded') {
      throw new StageError(
        StageErrorCode.STAGE_STATUS_INVALID,
        `Cannot stage changes to discarded stage '${stageId}'`,
        { stageId, taskId: stage.taskId },
      );
    }

    // 2. Validate proposal parameters, containment, secrets, protected-paths
    const validated = validateProposal(workspace, proposal);

    // 3. Capture current live source snapshot
    const snapshot = captureSourceSnapshot(workspace, validated.relativePath);

    // 4. Validate base hash requirement
    if (proposal.expectedBaseHash !== undefined) {
      if (snapshot.contentHash !== proposal.expectedBaseHash) {
        throw new StageError(
          StageErrorCode.STAGE_BASE_HASH_STALE,
          `Expected base hash '${proposal.expectedBaseHash.substring(0, 8)}...' does not match current source hash '${snapshot.contentHash?.substring(0, 8) ?? 'none'}...'`,
          { stageId, taskId: stage.taskId, path: validated.relativePath },
        );
      }
    }

    // 5. Change type validation against base presence
    if (proposal.changeType === 'modify' && !snapshot.existsAtBase) {
      throw new StageError(
        StageErrorCode.STAGE_NOT_FOUND,
        `Cannot propose modify for '${validated.relativePath}': source file does not exist at base`,
        { stageId, taskId: stage.taskId, path: validated.relativePath },
      );
    }

    if (proposal.changeType === 'add' && snapshot.existsAtBase) {
      throw new StageError(
        StageErrorCode.STAGE_CONFLICT,
        `Cannot propose add for '${validated.relativePath}': source file already exists at base`,
        { stageId, taskId: stage.taskId, path: validated.relativePath },
      );
    }

    if (proposal.changeType === 'delete-proposed' && !snapshot.existsAtBase) {
      throw new StageError(
        StageErrorCode.STAGE_NOT_FOUND,
        `Cannot propose delete for '${validated.relativePath}': source file does not exist at base`,
        { stageId, taskId: stage.taskId, path: validated.relativePath },
      );
    }

    // 6. Write to shadow staging storage (for add, modify, rename-proposed)
    let stagedStoragePath = '';
    let stagedContentHash = '';
    let byteLength = 0;

    if (proposal.changeType === 'delete-proposed') {
      // Deletion is represented purely in metadata; original live file is NOT deleted
      stagedStoragePath = '';
      stagedContentHash = crypto.createHash('sha256').update('').digest('hex');
      byteLength = 0;
      this.storage.deleteStagedFile(stage.taskId, stageId, validated.relativePath);
    } else {
      const bufferToWrite = validated.buffer ?? Buffer.alloc(0);
      const writeRes = this.storage.writeStagedFile(
        stage.taskId,
        stageId,
        validated.relativePath,
        bufferToWrite,
      );
      stagedStoragePath = writeRes.stagedStoragePath;
      stagedContentHash = writeRes.hash;
      byteLength = writeRes.byteLength;
    }

    // 7. Persist staged file record
    const now = Date.now();
    const record: StagedFileRecord = {
      stageId,
      relativePath: validated.relativePath,
      sourceExistsAtBase: snapshot.existsAtBase,
      baseContentHash: snapshot.contentHash,
      baseMtimeMs: snapshot.mtimeMs,
      baseSizeBytes: snapshot.sizeBytes,
      stagedContentHash,
      byteLength,
      encoding: validated.encoding,
      changeType: proposal.changeType,
      isProtected: validated.isProtected,
      policyDecision: validated.policyDecision,
      requiresManualReview: validated.requiresManualReview,
      targetPath: validated.targetPath,
      conflictStatus: 'clean',
      stagedStoragePath,
      createdAt: now,
      updatedAt: now,
    };

    this.repo.saveStagedFile(record);
    return record;
  }

  public applyPatch(
    stageId: string,
    proposal: PatchProposal,
    workspace: WorkspaceRootState,
  ): PatchResult {
    this.getRequiredStage(stageId);
    if (proposal.stageId !== stageId) {
      throw new PatchError(
        PatchErrorCode.INVALID_OPERATION,
        `Proposal stageId '${proposal.stageId}' does not match target stageId '${stageId}'`,
        { patchId: proposal.patchId, stageId },
      );
    }
    return this.patchEngine.applyPatch(workspace, proposal);
  }

  public applyPatchBatch(
    stageId: string,
    proposals: readonly PatchProposal[],
    workspace: WorkspaceRootState,
  ): PatchResult[] {
    this.getRequiredStage(stageId);
    for (const p of proposals) {
      if (p.stageId !== stageId) {
        throw new PatchError(
          PatchErrorCode.INVALID_OPERATION,
          `Batch proposal stageId '${p.stageId}' does not match target stageId '${stageId}'`,
          { patchId: p.patchId, stageId },
        );
      }
    }
    return this.patchEngine.applyPatchBatch(workspace, proposals);
  }

  public getStagedFile(
    stageId: string,
    relativePath: string,
  ): { record: StagedFileRecord; content: Buffer } {
    const stage = this.getRequiredStage(stageId);
    const record = this.repo.getStagedFile(stageId, relativePath);
    if (!record) {
      throw new StageError(
        StageErrorCode.STAGE_NOT_FOUND,
        `No staged file record found for '${relativePath}' in stage '${stageId}'`,
        { stageId, taskId: stage.taskId, path: relativePath },
      );
    }

    if (record.changeType === 'delete-proposed') {
      return { record, content: Buffer.alloc(0) };
    }

    const content = this.storage.readStagedFile(stage.taskId, stageId, relativePath);
    return { record, content };
  }

  public listStagedChanges(
    stageId: string,
    workspace?: WorkspaceRootState,
  ): StagedFileRecord[] {
    this.getRequiredStage(stageId);
    const files = this.repo.listStagedFiles(stageId);

    if (!workspace) {
      return files;
    }

    // If workspace provided, re-evaluate live conflicts
    const updated: StagedFileRecord[] = [];
    for (const f of files) {
      const conflictRes = detectLiveConflict(workspace, f);
      if (conflictRes.conflictStatus !== f.conflictStatus || conflictRes.conflictReason !== f.conflictReason) {
        const refreshed: StagedFileRecord = {
          ...f,
          conflictStatus: conflictRes.conflictStatus,
          conflictReason: conflictRes.conflictReason,
          updatedAt: Date.now(),
        };
        this.repo.saveStagedFile(refreshed);
        updated.push(refreshed);
      } else {
        updated.push(f);
      }
    }

    return updated;
  }

  public getStageStatus(
    stageId: string,
    workspace?: WorkspaceRootState,
  ): StageRecord & { conflictsCount: number; filesCount: number } {
    const stage = this.getRequiredStage(stageId);
    const files = this.listStagedChanges(stageId, workspace);
    const conflictsCount = files.filter((f) => f.conflictStatus !== 'clean').length;

    return {
      ...stage,
      conflictsCount,
      filesCount: files.length,
    };
  }

  public getStageDiff(
    stageId: string,
    workspace: WorkspaceRootState,
    relativePath?: string,
  ): StageDiffPreview[] {
    const stage = this.getRequiredStage(stageId);
    const files = this.listStagedChanges(stageId, workspace);
    const targets = relativePath ? files.filter((f) => f.relativePath === relativePath) : files;

    if (relativePath && targets.length === 0) {
      throw new StageError(
        StageErrorCode.STAGE_NOT_FOUND,
        `No staged file record found for '${relativePath}' in stage '${stageId}'`,
        { stageId, taskId: stage.taskId, path: relativePath },
      );
    }

    const previews: StageDiffPreview[] = [];

    for (const file of targets) {
      // 1. Live base snapshot
      let baseBuffer: Buffer | null = null;
      if (file.sourceExistsAtBase) {
        try {
          const snapshot = captureSourceSnapshot(workspace, file.relativePath);
          baseBuffer = snapshot.contentBuffer;
        } catch {
          baseBuffer = null;
        }
      }

      // 2. Staged buffer
      let stagedBuffer: Buffer | null = null;
      if (file.changeType !== 'delete-proposed') {
        try {
          stagedBuffer = this.storage.readStagedFile(stage.taskId, stageId, file.relativePath);
        } catch {
          stagedBuffer = null;
        }
      }

      const preview = generateDiffPreview(file, baseBuffer, stagedBuffer);
      previews.push(preview);
    }

    return previews;
  }

  public createCheckpoint(
    stageId: string,
    description?: string,
  ): StageCheckpointRecord {
    const stage = this.getRequiredStage(stageId);
    const files = this.repo.listStagedFiles(stageId);

    const checkpoint = createCheckpoint(
      stageId,
      stage.taskId,
      files,
      this.storage,
      description,
    );

    this.repo.saveCheckpoint(checkpoint);
    this.repo.updateStageStatus(stageId, 'checkpointed', checkpoint.checkpointId);

    return checkpoint;
  }

  public restoreCheckpoint(
    stageId: string,
    checkpointId: string,
  ): readonly StagedFileRecord[] {
    const stage = this.getRequiredStage(stageId);
    const checkpoint = this.repo.getCheckpoint(checkpointId);

    if (!checkpoint) {
      throw new StageError(
        StageErrorCode.CHECKPOINT_NOT_FOUND,
        `Checkpoint '${checkpointId}' not found in persistence`,
        { stageId, taskId: stage.taskId, details: { checkpointId } },
      );
    }

    // Restores files and asserts hashes
    const restoredFiles = restoreCheckpoint(
      checkpoint,
      stageId,
      stage.taskId,
      this.storage,
    );

    // Atomically replace staged files in DB
    this.repo.replaceStagedFiles(stageId, restoredFiles);
    this.repo.updateStageStatus(stageId, 'active', checkpointId);

    return restoredFiles;
  }

  public listCheckpoints(stageId: string): StageCheckpointRecord[] {
    this.getRequiredStage(stageId);
    return this.repo.listCheckpoints(stageId);
  }

  public discardStage(
    stageId: string,
    confirmation: DiscardStageConfirmation,
  ): void {
    const stage = this.getRequiredStage(stageId);

    if (!confirmation.confirmed) {
      throw new StageError(
        StageErrorCode.CONFIRMATION_REQUIRED,
        "Explicit confirmation (confirmed: true) is required to discard a stage",
        { stageId, taskId: stage.taskId },
      );
    }

    // Physical deletion of shadow files
    this.storage.removeStageStorage(stage.taskId, stageId);

    // Update status in SQLite
    this.repo.updateStageStatus(stageId, 'discarded');
  }

  public verifyStageIntegrity(stageId: string): {
    verified: boolean;
    filesCount: number;
    details: string[];
  } {
    const stage = this.getRequiredStage(stageId);
    const files = this.repo.listStagedFiles(stageId);
    const details: string[] = [];
    let allValid = true;

    for (const file of files) {
      if (file.changeType === 'delete-proposed') {
        details.push(`${file.relativePath}: delete-proposed (metadata valid)`);
        continue;
      }

      try {
        const buffer = this.storage.readStagedFile(stage.taskId, stageId, file.relativePath);
        const hash = computeSha256(buffer);
        if (hash !== file.stagedContentHash) {
          allValid = false;
          details.push(`${file.relativePath}: hash mismatch (expected ${file.stagedContentHash.substring(0, 8)}..., got ${hash.substring(0, 8)}...)`);
        } else {
          details.push(`${file.relativePath}: verified ok (${file.byteLength} bytes)`);
        }
      } catch (err) {
        allValid = false;
        details.push(`${file.relativePath}: missing or unreadable (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    return {
      verified: allValid,
      filesCount: files.length,
      details,
    };
  }

  public getStorage(): StageStorage {
    return this.storage;
  }

  public getRepo(): StageRepository {
    return this.repo;
  }

  private getRequiredStage(stageId: string): StageRecord {
    const stage = this.repo.getStage(stageId);
    if (!stage) {
      throw new StageError(
        StageErrorCode.STAGE_NOT_FOUND,
        `Stage with id '${stageId}' does not exist`,
        { stageId },
      );
    }
    return stage;
  }
}
