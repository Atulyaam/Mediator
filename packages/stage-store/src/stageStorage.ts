/**
 * @mediator/stage-store — Private App-Data File Storage (S12)
 *
 * Requirements:
 * - Stores shadow files strictly inside Mediator application data.
 * - Staged content is physically separated from the live workspace.
 * - Rejects any attempt to write outside the allocated stage directory.
 * - Performs atomic writes using temporary files and atomic replacement.
 * - Enforces secure filesystem permissions (0o700 dirs, 0o600 files where supported).
 * - Manages checkpoint snapshots and rollback file restorations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { StageError, StageErrorCode } from './stageErrors.js';

export function getDefaultStagingRoot(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Mediator', 'staging');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Mediator', 'staging');
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgData, 'mediator', 'staging');
}

export class StageStorage {
  private readonly stagingRoot: string;

  constructor(baseStagingDir?: string | undefined) {
    this.stagingRoot = path.resolve(baseStagingDir ?? getDefaultStagingRoot());
  }

  public getStagingRoot(): string {
    return this.stagingRoot;
  }

  public getStageDir(taskId: string, stageId: string): string {
    this.validateIdentifier(taskId, 'taskId');
    this.validateIdentifier(stageId, 'stageId');
    return path.join(this.stagingRoot, taskId, stageId);
  }

  public getStageFilesDir(taskId: string, stageId: string): string {
    return path.join(this.getStageDir(taskId, stageId), 'files');
  }

  public getCheckpointsDir(taskId: string, stageId: string): string {
    return path.join(this.getStageDir(taskId, stageId), 'checkpoints');
  }

  public initStageStorage(taskId: string, stageId: string): void {
    const filesDir = this.getStageFilesDir(taskId, stageId);
    const chkDir = this.getCheckpointsDir(taskId, stageId);
    try {
      fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(chkDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new StageError(
        StageErrorCode.STORAGE_ACCESS_DENIED,
        `Failed to initialize stage storage directory: ${err instanceof Error ? err.message : String(err)}`,
        { taskId, stageId },
      );
    }
  }

  public resolveStagedFilePath(taskId: string, stageId: string, relativePath: string): string {
    const filesDir = this.getStageFilesDir(taskId, stageId);
    const normalized = path.normalize(relativePath).replace(/^[\\/]+/, '');
    const resolved = path.resolve(filesDir, normalized);

    // Strict containment inside filesDir
    if (resolved !== filesDir && !resolved.startsWith(filesDir + path.sep)) {
      throw new StageError(
        StageErrorCode.PATH_TRAVERSAL,
        `Staged path '${relativePath}' attempts to escape stage directory`,
        { taskId, stageId, path: relativePath },
      );
    }

    return resolved;
  }

  public writeStagedFile(
    taskId: string,
    stageId: string,
    relativePath: string,
    content: string | Buffer,
  ): { stagedStoragePath: string; byteLength: number; hash: string } {
    const targetFile = this.resolveStagedFilePath(taskId, stageId, relativePath);
    const targetDir = path.dirname(targetFile);

    try {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new StageError(
        StageErrorCode.STORAGE_ACCESS_DENIED,
        `Failed to create directory for staged file: ${err instanceof Error ? err.message : String(err)}`,
        { taskId, stageId, path: relativePath },
      );
    }

    // Atomic write via temporary file
    const tempFile = path.join(
      targetDir,
      `.tmp_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
    );

    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    try {
      fs.writeFileSync(tempFile, buffer, { mode: 0o600 });
      try {
        fs.renameSync(tempFile, targetFile);
      } catch {
        // On Windows, if target exists or is held briefly, remove target and retry or copy
        if (fs.existsSync(targetFile)) {
          try {
            fs.unlinkSync(targetFile);
          } catch {
            // Ignore failure if destination is locked or unlinked concurrently
          }
        }
        try {
          fs.renameSync(tempFile, targetFile);
        } catch {
          fs.copyFileSync(tempFile, targetFile);
          try {
            fs.unlinkSync(tempFile);
          } catch {
            // Ignore temp file cleanup failure
          }
        }
      }
    } catch (err) {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch {
        // Ignore cleanup failure
      }
      throw new StageError(
        StageErrorCode.STORAGE_ACCESS_DENIED,
        `Failed to write staged file atomically: ${err instanceof Error ? err.message : String(err)}`,
        { taskId, stageId, path: relativePath },
      );
    }

    const filesDir = this.getStageFilesDir(taskId, stageId);
    const stagedStoragePath = path.relative(filesDir, targetFile).replace(/\\/g, '/');

    return {
      stagedStoragePath,
      byteLength: buffer.byteLength,
      hash,
    };
  }

  public readStagedFile(
    taskId: string,
    stageId: string,
    relativePath: string,
  ): Buffer {
    const targetFile = this.resolveStagedFilePath(taskId, stageId, relativePath);
    if (!fs.existsSync(targetFile)) {
      throw new StageError(
        StageErrorCode.STAGE_NOT_FOUND,
        `Staged file does not exist at '${relativePath}'`,
        { taskId, stageId, path: relativePath },
      );
    }

    try {
      return fs.readFileSync(targetFile);
    } catch (err) {
      throw new StageError(
        StageErrorCode.STORAGE_ACCESS_DENIED,
        `Failed to read staged file: ${err instanceof Error ? err.message : String(err)}`,
        { taskId, stageId, path: relativePath },
      );
    }
  }

  public deleteStagedFile(
    taskId: string,
    stageId: string,
    relativePath: string,
  ): boolean {
    const targetFile = this.resolveStagedFilePath(taskId, stageId, relativePath);
    if (!fs.existsSync(targetFile)) {
      return false;
    }
    try {
      fs.unlinkSync(targetFile);
      return true;
    } catch (err) {
      throw new StageError(
        StageErrorCode.STORAGE_ACCESS_DENIED,
        `Failed to delete staged file: ${err instanceof Error ? err.message : String(err)}`,
        { taskId, stageId, path: relativePath },
      );
    }
  }

  public copyFilesToCheckpoint(
    taskId: string,
    stageId: string,
    checkpointId: string,
  ): void {
    this.validateIdentifier(checkpointId, 'checkpointId');
    const filesDir = this.getStageFilesDir(taskId, stageId);
    const targetChkDir = path.join(this.getCheckpointsDir(taskId, stageId), checkpointId);

    if (fs.existsSync(targetChkDir)) {
      fs.rmSync(targetChkDir, { recursive: true, force: true });
    }
    fs.mkdirSync(targetChkDir, { recursive: true, mode: 0o700 });

    if (fs.existsSync(filesDir)) {
      this.copyDirRecursive(filesDir, targetChkDir);
    }
  }

  public restoreFilesFromCheckpoint(
    taskId: string,
    stageId: string,
    checkpointId: string,
  ): void {
    this.validateIdentifier(checkpointId, 'checkpointId');
    const filesDir = this.getStageFilesDir(taskId, stageId);
    const sourceChkDir = path.join(this.getCheckpointsDir(taskId, stageId), checkpointId);

    if (!fs.existsSync(sourceChkDir)) {
      throw new StageError(
        StageErrorCode.CHECKPOINT_NOT_FOUND,
        `Checkpoint storage not found at '${checkpointId}'`,
        { taskId, stageId, details: { checkpointId } },
      );
    }

    // Wipe existing staged files
    if (fs.existsSync(filesDir)) {
      fs.rmSync(filesDir, { recursive: true, force: true });
    }
    fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });

    // Restore from checkpoint snapshot
    this.copyDirRecursive(sourceChkDir, filesDir);
  }

  public removeStageStorage(taskId: string, stageId: string): void {
    const stageDir = this.getStageDir(taskId, stageId);
    if (fs.existsSync(stageDir)) {
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
      } catch (err) {
        throw new StageError(
          StageErrorCode.STORAGE_ACCESS_DENIED,
          `Failed to remove stage storage: ${err instanceof Error ? err.message : String(err)}`,
          { taskId, stageId },
        );
      }
    }
  }

  private copyDirRecursive(src: string, dest: string): void {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
        try {
          fs.chmodSync(destPath, 0o600);
        } catch {
          // Ignore chmod error on Windows
        }
      }
    }
  }

  private validateIdentifier(id: string, name: string): void {
    if (!id || typeof id !== 'string') {
      throw new StageError(
        StageErrorCode.STAGE_STATUS_INVALID,
        `Invalid ${name}: must be a non-empty string`,
      );
    }
    // Only allow alphanumeric, dash, underscore, dot
    if (!/^[a-zA-Z0-9_\-.]+$/.test(id)) {
      throw new StageError(
        StageErrorCode.PATH_TRAVERSAL,
        `Invalid characters in ${name} '${id}'`,
      );
    }
  }
}
