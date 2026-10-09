/**
 * @mediator/workspace-boundary
 *
 * Sprint S04 — Authoritative workspace-selection and canonicalization flow.
 * Shared by IDE extension and CLI.
 *
 * Guarantees:
 * 1. Selected path and canonical path are tracked separately.
 * 2. Missing, unresolved, unavailable, or unconfirmed roots deny file operations.
 * 3. Canonical path changes invalidate prior confirmation.
 * 4. Multi-root IDE workspaces require explicit single-root selection in v1.
 * 5. Mismatched IDE vs CLI selections are rejected (no silent choice).
 * 6. OneDrive-redirected folders are supported and displayed, not blanket-rejected.
 * 7. Cloud-placeholder status is explicitly 'unknown' unless reliably established.
 * 8. Never silently falls back to cwd, home dir, or hard-coded paths.
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
  type WorkspaceRootState,
  type WorkspaceSelectionSource,
  type WorkspaceConfirmationStatus,
  type WorkspaceResolutionStatus,
  type WorkspaceCloudStatus,
  type ContainedPath,
  type FileOperationType,
} from '@mediator/shared-contracts';

export type {
  WorkspaceRootState,
  WorkspaceSelectionSource,
  WorkspaceConfirmationStatus,
  WorkspaceResolutionStatus,
  WorkspaceCloudStatus,
  ContainedPath,
  FileOperationType,
};

// ─── FileSystem Adapter Interface ──────────────────────────────────────────

export interface FileSystemAdapter {
  existsSync(p: string): boolean;
  statSync(p: string): { isDirectory(): boolean; isSymbolicLink?(): boolean; size?: number; mtimeMs?: number };
  realpathSync(p: string): string;
  lstatSync?(p: string): { isDirectory(): boolean; isSymbolicLink(): boolean };
  readFileSync?(p: string, encoding?: BufferEncoding): string;
  writeFileSync?(p: string, data: string): void;
  unlinkSync?(p: string): void;
  mkdirSync?(p: string, options?: { recursive?: boolean }): void;
}

export const defaultFileSystemAdapter: FileSystemAdapter = {
  existsSync: (p: string) => fs.existsSync(p),
  statSync: (p: string) => fs.statSync(p),
  realpathSync: (p: string) => {
    // fs.realpathSync.native uses the OS canonical casing and resolves junctions/symlinks
    if (typeof fs.realpathSync.native === 'function') {
      return fs.realpathSync.native(p);
    }
    return fs.realpathSync(p);
  },
  lstatSync: (p: string) => fs.lstatSync(p),
  readFileSync: (p: string, encoding = 'utf8') => fs.readFileSync(p, encoding),
  writeFileSync: (p: string, data: string) => fs.writeFileSync(p, data, 'utf8'),
  unlinkSync: (p: string) => fs.unlinkSync(p),
  mkdirSync: (p: string, options) => { fs.mkdirSync(p, options); },
};

// Re-export Path Containment & Windows Path Security APIs (S05)
export {
  type ValidatePathOptions,
  normalizeWindowsPath,
  hasAlternateDataStream,
  hasReservedDeviceName,
  hasMalformedWindowsComponents,
  isPathInsideRoot,
  findClosestExistingAncestor,
  validateContainedPath,
  revalidateContainedPath,
  safeReadProjectFile,
  safeWriteProjectFile,
  safeDeleteProjectFile,
} from './pathContainment.js';

// ─── Workspace Selection (IDE & CLI) ───────────────────────────────────────

/**
 * Read workspace from IDE workspace folder list.
 * In Mediator v1, exactly one workspace folder is supported.
 */
export function selectFromIdeFolders(
  folders: readonly string[],
): Result<string, MediatorError> {
  if (!folders || folders.length === 0) {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_NOT_SELECTED,
        'No workspace folder is open in the IDE. Open a project folder first.',
      ),
    );
  }

  if (folders.length > 1) {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_MULTIPLE_ROOTS,
        `Multiple workspace folders detected (${folders.length}). Mediator v1 requires selecting exactly one workspace root.`,
        { detail: { openFolders: [...folders] } },
      ),
    );
  }

  const selected = folders[0];
  if (!selected || selected.trim().length === 0) {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_NOT_SELECTED,
        'Workspace folder path cannot be empty',
      ),
    );
  }

  return ok(selected);
}

/**
 * Select a specific folder from a multi-root IDE setup by index or path.
 */
export function selectExplicitIdeFolder(
  folders: readonly string[],
  choice: number | string,
): Result<string, MediatorError> {
  if (!folders || folders.length === 0) {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_NOT_SELECTED,
        'No workspace folder is open in the IDE',
      ),
    );
  }

  if (typeof choice === 'number') {
    if (choice < 0 || choice >= folders.length) {
      return err(
        makeMediatorError(
          ErrorCode.WORKSPACE_NOT_SELECTED,
          `Invalid folder index ${choice}. Available: 0 to ${folders.length - 1}`,
          { detail: { availableCount: folders.length, requestedIndex: choice } },
        ),
      );
    }
    const chosen = folders[choice];
    return chosen ? ok(chosen) : err(makeMediatorError(ErrorCode.WORKSPACE_NOT_SELECTED, 'Folder not found'));
  }

  // String match
  const normalizedChoice = path.normalize(choice).toLowerCase();
  const found = folders.find((f) => path.normalize(f).toLowerCase() === normalizedChoice);
  if (!found) {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_NOT_SELECTED,
        `Selected path "${choice}" is not among open workspace folders`,
        { detail: { openFolders: [...folders], requestedPath: choice } },
      ),
    );
  }

  return ok(found);
}

/**
 * Parse an explicitly selected workspace from CLI arguments.
 * Supports:
 *   --workspace <path>
 *   --workspace=<path>
 *   -w <path>
 *   -w=<path>
 */
export function parseCliWorkspaceArg(
  args: readonly string[],
): Result<string | null, MediatorError> {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === '--workspace' || arg === '-w') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        return err(
          makeMediatorError(
            ErrorCode.WORKSPACE_NOT_SELECTED,
            `Flag "${arg}" requires a workspace path argument`,
          ),
        );
      }
      return ok(next);
    }

    if (arg.startsWith('--workspace=')) {
      const val = arg.slice('--workspace='.length);
      if (!val || val.trim().length === 0) {
        return err(
          makeMediatorError(
            ErrorCode.WORKSPACE_NOT_SELECTED,
            'Flag "--workspace=" cannot be empty',
          ),
        );
      }
      return ok(val);
    }

    if (arg.startsWith('-w=')) {
      const val = arg.slice('-w='.length);
      if (!val || val.trim().length === 0) {
        return err(
          makeMediatorError(
            ErrorCode.WORKSPACE_NOT_SELECTED,
            'Flag "-w=" cannot be empty',
          ),
        );
      }
      return ok(val);
    }
  }

  return ok(null);
}

/**
 * Reconcile IDE and CLI workspace selections.
 * If both are provided and point to different locations, refuses to guess.
 */
export function reconcileSelections(
  ideSelection: string | null,
  cliSelection: string | null,
  fsAdapter: FileSystemAdapter = defaultFileSystemAdapter,
): Result<string, MediatorError> {
  if (!ideSelection && !cliSelection) {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_NOT_SELECTED,
        'No workspace selected via IDE or CLI',
      ),
    );
  }

  if (ideSelection && !cliSelection) {
    return ok(ideSelection);
  }

  if (!ideSelection && cliSelection) {
    return ok(cliSelection);
  }

  // Both provided — check if they resolve to the same canonical path
  if (ideSelection && cliSelection) {
    const ideCanonical = tryCanonicalize(ideSelection, fsAdapter);
    const cliCanonical = tryCanonicalize(cliSelection, fsAdapter);

    const normIde = (ideCanonical ?? path.resolve(ideSelection)).toLowerCase();
    const normCli = (cliCanonical ?? path.resolve(cliSelection)).toLowerCase();

    if (normIde !== normCli) {
      return err(
        makeMediatorError(
          ErrorCode.WORKSPACE_MISMATCH,
          `IDE workspace (${ideSelection}) and CLI workspace (${cliSelection}) disagree. Cannot silently select a different directory.`,
          { detail: { ideSelection, cliSelection, ideCanonical, cliCanonical } },
        ),
      );
    }

    // Agree — return canonical or resolved path
    return ok(ideCanonical ?? cliSelection);
  }

  return err(
    makeMediatorError(ErrorCode.WORKSPACE_NOT_SELECTED, 'Workspace selection failed'),
  );
}

// ─── Canonical Path Resolution ─────────────────────────────────────────────

/**
 * Inspect a workspace path without throwing.
 * Always populates all state fields accurately.
 */
export function inspectWorkspaceRoot(
  selectedPath: string,
  source: WorkspaceSelectionSource,
  fsAdapter: FileSystemAdapter = defaultFileSystemAdapter,
): WorkspaceRootState {
  if (!selectedPath || selectedPath.trim().length === 0) {
    return {
      selectedPath: selectedPath ?? '',
      canonicalPath: null,
      selectionSource: source,
      confirmationStatus: 'pending',
      resolutionStatus: 'unresolved',
      cloudStatus: 'unknown',
    };
  }

  const trimmed = selectedPath.trim();
  const absolutePath = path.resolve(trimmed);

  // Check existence
  let exists = false;
  try {
    exists = fsAdapter.existsSync(absolutePath);
  } catch {
    return {
      selectedPath: trimmed,
      canonicalPath: null,
      selectionSource: source,
      confirmationStatus: 'pending',
      resolutionStatus: 'unavailable',
      cloudStatus: 'unknown',
    };
  }

  if (!exists) {
    return {
      selectedPath: trimmed,
      canonicalPath: null,
      selectionSource: source,
      confirmationStatus: 'pending',
      resolutionStatus: 'missing',
      cloudStatus: detectCloudStatus(trimmed, null),
    };
  }

  // Check directory
  try {
    const stat = fsAdapter.statSync(absolutePath);
    if (!stat.isDirectory()) {
      return {
        selectedPath: trimmed,
        canonicalPath: null,
        selectionSource: source,
        confirmationStatus: 'pending',
        resolutionStatus: 'unavailable',
        cloudStatus: 'unknown',
      };
    }
  } catch {
    return {
      selectedPath: trimmed,
      canonicalPath: null,
      selectionSource: source,
      confirmationStatus: 'pending',
      resolutionStatus: 'unavailable',
      cloudStatus: 'unknown',
    };
  }

  // Canonical resolution via realpath
  let canonical: string | null = null;
  try {
    canonical = fsAdapter.realpathSync(absolutePath);
    // Normalize Windows drive letter to uppercase for consistency
    canonical = normalizeDriveLetter(canonical);
  } catch {
    return {
      selectedPath: trimmed,
      canonicalPath: null,
      selectionSource: source,
      confirmationStatus: 'pending',
      resolutionStatus: 'unresolved',
      cloudStatus: 'unknown',
    };
  }

  const cloudStatus = detectCloudStatus(trimmed, canonical);

  return {
    selectedPath: trimmed,
    canonicalPath: canonical,
    selectionSource: source,
    confirmationStatus: 'pending',
    resolutionStatus: 'resolved',
    cloudStatus,
  };
}

/**
 * Resolve workspace root and validate that it is successfully resolved.
 * Returns a typed error if missing, unavailable, or unresolved.
 */
export function resolveWorkspaceRoot(
  selectedPath: string,
  source: WorkspaceSelectionSource,
  fsAdapter: FileSystemAdapter = defaultFileSystemAdapter,
): Result<WorkspaceRootState, MediatorError> {
  const state = inspectWorkspaceRoot(selectedPath, source, fsAdapter);

  if (state.resolutionStatus === 'missing') {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_UNAVAILABLE,
        `Workspace directory does not exist: "${state.selectedPath}"`,
        { detail: { selectedPath: state.selectedPath, status: 'missing' } },
      ),
    );
  }

  if (state.resolutionStatus === 'unavailable') {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_UNAVAILABLE,
        `Workspace path is inaccessible or is not a directory: "${state.selectedPath}"`,
        { detail: { selectedPath: state.selectedPath, status: 'unavailable' } },
      ),
    );
  }

  if (state.resolutionStatus === 'unresolved' || !state.canonicalPath) {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_UNRESOLVED,
        `Failed to resolve canonical path for workspace: "${state.selectedPath}"`,
        { detail: { selectedPath: state.selectedPath, status: 'unresolved' } },
      ),
    );
  }

  return ok(state);
}

// ─── User Confirmation Lifecycle ───────────────────────────────────────────

/**
 * Confirm or deny the workspace root.
 * Only resolved roots can be confirmed.
 */
export function confirmWorkspaceRoot(
  current: WorkspaceRootState,
  confirmed: boolean,
  timestamp: number = Date.now(),
): Result<WorkspaceRootState, MediatorError> {
  if (current.resolutionStatus !== 'resolved' || !current.canonicalPath) {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_UNRESOLVED,
        'Cannot confirm an unresolved or missing workspace root',
        { detail: { selectedPath: current.selectedPath, status: current.resolutionStatus } },
      ),
    );
  }

  if (!confirmed) {
    return ok({
      ...current,
      confirmationStatus: 'denied',
      confirmationTimestamp: timestamp,
    });
  }

  return ok({
    ...current,
    confirmationStatus: 'confirmed',
    confirmationTimestamp: timestamp,
  });
}

/**
 * Update the selected workspace root.
 * If the canonical path changes, previous confirmation is invalidated!
 */
export function updateWorkspaceRoot(
  current: WorkspaceRootState,
  newSelectedPath: string,
  source: WorkspaceSelectionSource,
  fsAdapter: FileSystemAdapter = defaultFileSystemAdapter,
): Result<WorkspaceRootState, MediatorError> {
  const next = inspectWorkspaceRoot(newSelectedPath, source, fsAdapter);

  // If canonical path is identical, preserve confirmation status
  if (
    current.canonicalPath &&
    next.canonicalPath &&
    current.canonicalPath.toLowerCase() === next.canonicalPath.toLowerCase()
  ) {
    return ok({
      ...next,
      confirmationStatus: current.confirmationStatus,
      confirmationTimestamp: current.confirmationTimestamp,
    });
  }

  // Canonical path changed or unresolved — prior confirmation invalidated
  return ok({
    ...next,
    confirmationStatus: 'pending',
    confirmationTimestamp: undefined,
  });
}

/**
 * Gate check before any project file read or write.
 * Returns canonicalPath on success, or a typed MediatorError.
 */
export function checkWorkspacePermittedForFileOps(
  workspace: WorkspaceRootState | null | undefined,
): Result<string, MediatorError> {
  if (!workspace || !workspace.selectedPath) {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_NOT_SELECTED,
        'No workspace root is selected. Select a workspace folder before performing file operations.',
      ),
    );
  }

  if (workspace.resolutionStatus === 'missing') {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_UNAVAILABLE,
        `Workspace directory does not exist: "${workspace.selectedPath}"`,
        { detail: { selectedPath: workspace.selectedPath, status: 'missing' } },
      ),
    );
  }

  if (workspace.resolutionStatus !== 'resolved' || !workspace.canonicalPath) {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_UNRESOLVED,
        `Workspace root has not been successfully resolved: "${workspace.selectedPath}"`,
        { detail: { selectedPath: workspace.selectedPath, status: workspace.resolutionStatus } },
      ),
    );
  }

  if (workspace.confirmationStatus === 'denied') {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_CONFIRMATION_DENIED,
        `User denied confirmation for workspace root "${workspace.canonicalPath}". Project file operations are blocked.`,
        { detail: { canonicalPath: workspace.canonicalPath } },
      ),
    );
  }

  if (workspace.confirmationStatus !== 'confirmed') {
    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_CONFIRMATION_REQUIRED,
        `Workspace root "${workspace.canonicalPath}" requires explicit user confirmation before file operations can proceed.`,
        {
          detail: {
            selectedPath: workspace.selectedPath,
            canonicalPath: workspace.canonicalPath,
            confirmationStatus: workspace.confirmationStatus,
          },
        },
      ),
    );
  }

  return ok(workspace.canonicalPath);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function tryCanonicalize(p: string, fsAdapter: FileSystemAdapter): string | null {
  try {
    const abs = path.resolve(p);
    if (!fsAdapter.existsSync(abs)) return null;
    return normalizeDriveLetter(fsAdapter.realpathSync(abs));
  } catch {
    return null;
  }
}

function normalizeDriveLetter(p: string): string {
  // On Windows, drive letters might be 'c:\' or 'C:\'. Standardize to uppercase 'C:\'.
  if (/^[a-z]:[\\/]/i.test(p)) {
    const drive = p.charAt(0).toUpperCase();
    return `${drive}:${p.slice(2)}`;
  }
  return p;
}

/**
 * Detect OneDrive redirection and cloud storage backing.
 * OneDrive folders on Windows typically reside under ...\OneDrive\...
 * If Desktop is redirected to OneDrive, the canonical path reflects this redirection.
 */
export function detectCloudStatus(
  selectedPath: string,
  canonicalPath: string | null,
): WorkspaceCloudStatus {
  const normSelected = selectedPath.toLowerCase();
  const normCanonical = (canonicalPath ?? '').toLowerCase();

  const isOneDrive =
    normSelected.includes('onedrive') ||
    normCanonical.includes('onedrive') ||
    normSelected.includes('one drive') ||
    normCanonical.includes('one drive');

  if (isOneDrive) {
    return 'onedrive_redirected';
  }

  // If canonical path is known and does not have cloud patterns, classify as not_cloud
  if (canonicalPath) {
    return 'not_cloud';
  }

  // Without resolution or established reparse points, remain explicitly unknown
  return 'unknown';
}
