/**
 * @mediator/workspace-boundary — Path Containment & Windows Path Security (S05)
 *
 * Security invariant:
 * Every Mediator-managed project-file operation must remain within the
 * previously confirmed canonical workspace root. If containment cannot be proven,
 * deny the operation.
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
  type ContainedPath,
  type FileOperationType,
} from '@mediator/shared-contracts';
import {
  checkWorkspacePermittedForFileOps,
  type FileSystemAdapter,
  defaultFileSystemAdapter,
} from './index.js';

// ─── Options & Interfaces ───────────────────────────────────────────────────

export interface ValidatePathOptions {
  /** The operation intended: 'read' | 'write' | 'delete' | 'patch' | 'rename' | 'list' */
  readonly operation?: FileOperationType | undefined;
  /** If true, requires the target to already exist on disk (e.g. for read/patch/delete) */
  readonly mustExist?: boolean | undefined;
  /** Custom FileSystemAdapter for dependency injection and testing */
  readonly fsAdapter?: FileSystemAdapter | undefined;
}

// ─── Windows Path Normalization & Security Classifiers ──────────────────────

/**
 * Normalize Windows path representation:
 * - NFC Unicode normalization
 * - Handle \\?\ extended prefixes
 * - Standardize drive letters to uppercase (C:\)
 * - Strip redundant trailing separators unless root drive
 */
export function normalizeWindowsPath(p: string): string {
  if (!p) return p;
  let normalized = p.normalize('NFC');

  // Handle extended length prefix \\?\ and \\?\UNC\
  if (normalized.startsWith('\\\\?\\UNC\\') || normalized.startsWith('//?/UNC/')) {
    normalized = '\\\\' + normalized.slice(8);
  } else if (normalized.startsWith('\\\\?\\') || normalized.startsWith('//?/')) {
    normalized = normalized.slice(4);
  }

  normalized = path.normalize(normalized);

  // Normalize drive letter to uppercase C:\ on Windows
  if (/^[a-z]:[\\/]/i.test(normalized)) {
    normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  // Remove trailing separator unless root drive (e.g. "C:\" or "\")
  if (
    normalized.length > 3 &&
    (normalized.endsWith('\\') || normalized.endsWith('/')) &&
    !/^[A-Z]:[\\/]$/i.test(normalized)
  ) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Detect Alternate Data Streams (ADS).
 * Windows NTFS streams use syntax `file.txt:stream` or `dir:stream` or `foo::$DATA`.
 * A colon at index 1 is valid only if part of an absolute drive prefix `C:\`.
 * Any other colon is an Alternate Data Stream or invalid Windows syntax.
 */
export function hasAlternateDataStream(p: string): boolean {
  let rest = p;
  // If starts with drive letter "C:\" or "C:", strip drive specification
  if (/^[a-zA-Z]:/.test(p)) {
    rest = p.slice(2);
  }
  return rest.includes(':');
}

/**
 * Windows reserved device names:
 * CON, PRN, AUX, NUL, COM1-COM9, LPT1-LPT9.
 * Windows matches these case-insensitively, anywhere in the path, with any file extension.
 * e.g. CON.txt, NUL.json, aux, com1.log, dir/con/file.txt.
 */
const RESERVED_DEVICE_REGEX = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

export function hasReservedDeviceName(p: string): boolean {
  const segments = p.split(/[\\/]/);
  for (const rawSeg of segments) {
    if (!rawSeg) continue;
    // Windows strips trailing spaces and dots before checking device name
    const trimmed = rawSeg.replace(/[.\s]+$/, '');
    if (RESERVED_DEVICE_REGEX.test(trimmed) || RESERVED_DEVICE_REGEX.test(rawSeg)) {
      return true;
    }
  }
  return false;
}

/**
 * Check for illegal Windows filename characters and trailing dots/spaces:
 * - Null bytes (\0)
 * - Illegal characters: < > " | * ?
 * - Trailing dots or spaces on segments (e.g. "file.txt." or "foo ")
 * Windows automatically strips trailing dots and spaces, which causes alias escapes.
 */
export function hasMalformedWindowsComponents(p: string): boolean {
  if (p.includes('\0')) return true;

  let checkStr = p;
  if (checkStr.startsWith('\\\\?\\') || checkStr.startsWith('//?/')) {
    checkStr = checkStr.slice(4);
  }

  // Illegal Win32 characters
  if (/[<>"|*?]/.test(checkStr)) return true;

  const segments = checkStr.split(/[\\/]/);
  for (const seg of segments) {
    if (!seg) continue;
    // "." and ".." are valid directory traversal tokens, not trailing dots on a filename
    if (seg === '.' || seg === '..') continue;

    // Segment ending with dot or space
    if (/[.\s]$/.test(seg)) return true;
    // Segment starting with space
    if (/^\s/.test(seg)) return true;
  }

  return false;
}

/**
 * Check whether a candidate path resides strictly within the canonical root.
 *
 * Prevents sibling prefix attacks:
 * For root "C:\project", candidate "C:\project-evil\file.txt" MUST return false!
 * Candidate "C:\project\file.txt" returns true.
 * Candidate "C:\project" returns true.
 */
export function isPathInsideRoot(canonicalRoot: string, candidate: string): boolean {
  const normRoot = normalizeWindowsPath(canonicalRoot).toLowerCase();
  const normCandidate = normalizeWindowsPath(candidate).toLowerCase();

  // Exact match (the root itself)
  if (normCandidate === normRoot) {
    return true;
  }

  // If root ends with separator (e.g. "C:\"), simple prefix check is safe
  if (normRoot.endsWith(path.sep) || normRoot.endsWith('/')) {
    return normCandidate.startsWith(normRoot);
  }

  // Root does NOT end with separator (e.g. "C:\project")
  // Candidate MUST start with normRoot + path.sep
  const rootWithSep = normRoot + path.sep;
  const rootWithAltSep = normRoot + '/';

  return normCandidate.startsWith(rootWithSep) || normCandidate.startsWith(rootWithAltSep);
}

/**
 * Find the closest existing ancestor directory for a candidate path.
 * Used to validate the destination of non-existent files before creation.
 */
export function findClosestExistingAncestor(
  targetPath: string,
  fsAdapter: FileSystemAdapter,
): { ancestorPath: string; remainder: string } {
  let curr = targetPath;
  while (curr && curr !== path.dirname(curr)) {
    curr = path.dirname(curr);
    if (fsAdapter.existsSync(curr)) {
      return {
        ancestorPath: curr,
        remainder: path.relative(curr, targetPath),
      };
    }
  }

  return {
    ancestorPath: path.dirname(targetPath),
    remainder: path.basename(targetPath),
  };
}

// ─── Primary Path Containment API ──────────────────────────────────────────

/**
 * Validate that a target path is strictly contained within the confirmed canonical workspace root.
 *
 * Core security guarantees:
 * 1. Requires confirmed and resolved workspace root; unconfirmed/denied/missing roots fail closed.
 * 2. Rejects Alternate Data Streams (ADS).
 * 3. Rejects reserved Windows device names (CON, NUL, AUX, COM*, LPT*).
 * 4. Rejects illegal characters and trailing dots/spaces.
 * 5. Rejects parent-directory traversal (../) and outside absolute paths.
 * 6. Defends against sibling-prefix bypasses (e.g. C:\project-evil vs C:\project).
 * 7. Resolves physical symlinks/junctions; denies if target points outside root.
 * 8. For non-existent files, verifies that the existing ancestor does not point outside.
 * 9. Returns typed errors without silent fallback.
 */
export function validateContainedPath(
  workspace: WorkspaceRootState,
  targetPath: string,
  options?: ValidatePathOptions,
): Result<ContainedPath, MediatorError> {
  const fsAdapter = options?.fsAdapter ?? defaultFileSystemAdapter;

  // 1. Verify workspace permission & canonical root
  const permitted = checkWorkspacePermittedForFileOps(workspace);
  if (!permitted.ok) {
    return err(permitted.error);
  }
  const canonicalRoot = normalizeWindowsPath(permitted.value);

  // 2. Validate target path input string
  if (!targetPath || typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    return err(
      makeMediatorError(ErrorCode.PATH_MALFORMED, 'Target path cannot be empty or whitespace only'),
    );
  }

  // 3. Alternate Data Streams (ADS) check
  if (hasAlternateDataStream(targetPath)) {
    return err(
      makeMediatorError(
        ErrorCode.PATH_ALTERNATE_DATA_STREAM,
        `Alternate Data Stream (ADS) syntax is forbidden: "${targetPath}"`,
        { detail: { targetPath } },
      ),
    );
  }

  // 4. Reserved Windows device names check
  if (hasReservedDeviceName(targetPath)) {
    return err(
      makeMediatorError(
        ErrorCode.PATH_RESERVED_DEVICE,
        `Path references reserved Windows device name: "${targetPath}"`,
        { detail: { targetPath } },
      ),
    );
  }

  // 5. Illegal characters and trailing dots/spaces check
  if (hasMalformedWindowsComponents(targetPath)) {
    return err(
      makeMediatorError(
        ErrorCode.PATH_MALFORMED,
        `Path contains invalid Windows characters, null bytes, or trailing dots/spaces: "${targetPath}"`,
        { detail: { targetPath } },
      ),
    );
  }

  // 6. UNC and outside absolute path handling
  if (targetPath.startsWith('\\\\') || targetPath.startsWith('//')) {
    // Extended prefix or UNC
    const normTarget = normalizeWindowsPath(targetPath);
    if (!isPathInsideRoot(canonicalRoot, normTarget)) {
      return err(
        makeMediatorError(
          ErrorCode.PATH_OUTSIDE_ROOT,
          `UNC or outside network path is not contained within workspace: "${targetPath}"`,
          { detail: { targetPath, canonicalRoot } },
        ),
      );
    }
  }

  // 7. Lexical resolution and containment
  let lexicalTarget: string;
  const isTargetAbsolute = path.isAbsolute(targetPath) || /^[a-zA-Z]:/i.test(targetPath);

  if (isTargetAbsolute) {
    lexicalTarget = normalizeWindowsPath(path.resolve(targetPath));
    if (!isPathInsideRoot(canonicalRoot, lexicalTarget)) {
      return err(
        makeMediatorError(
          ErrorCode.PATH_OUTSIDE_ROOT,
          `Absolute path is outside canonical workspace root: "${targetPath}"`,
          { detail: { targetPath, canonicalRoot, resolvedLexical: lexicalTarget } },
        ),
      );
    }
  } else {
    lexicalTarget = normalizeWindowsPath(path.resolve(canonicalRoot, targetPath));
    if (!isPathInsideRoot(canonicalRoot, lexicalTarget)) {
      return err(
        makeMediatorError(
          ErrorCode.PATH_TRAVERSAL,
          `Path traversal escapes canonical workspace root: "${targetPath}"`,
          { detail: { targetPath, canonicalRoot, resolvedLexical: lexicalTarget } },
        ),
      );
    }
  }

  // 8. Physical filesystem resolution & symlink/junction defense
  const targetExists = fsAdapter.existsSync(lexicalTarget);

  if (targetExists) {
    let resolvedCanonical: string;
    try {
      resolvedCanonical = normalizeWindowsPath(fsAdapter.realpathSync(lexicalTarget));
    } catch {
      return err(
        makeMediatorError(
          ErrorCode.PATH_DENIED,
          `Failed to resolve realpath for existing target: "${targetPath}"`,
          { detail: { targetPath, lexicalTarget } },
        ),
      );
    }

    // Verify physical canonical containment
    if (!isPathInsideRoot(canonicalRoot, resolvedCanonical)) {
      return err(
        makeMediatorError(
          ErrorCode.PATH_SYMLINK_ESCAPE,
          `Path resolves outside canonical workspace root via symlink, junction, or reparse point: "${targetPath}" -> "${resolvedCanonical}"`,
          { detail: { targetPath, canonicalRoot, resolvedCanonical } },
        ),
      );
    }

    let isDirectory = false;
    try {
      const st = fsAdapter.statSync(resolvedCanonical);
      isDirectory = st.isDirectory();
    } catch {
      // Ignored if stat fails
    }

    const rel = path.relative(canonicalRoot, resolvedCanonical).replace(/\\/g, '/');

    return ok({
      inputPath: targetPath,
      resolvedPath: resolvedCanonical,
      relativePath: rel,
      exists: true,
      isDirectory,
    });
  }

  // 9. Non-existent target file handling
  if (options?.mustExist) {
    return err(
      makeMediatorError(
        ErrorCode.PATH_DENIED,
        `Target file does not exist on disk: "${targetPath}"`,
        { detail: { targetPath, lexicalTarget } },
      ),
    );
  }

  // Find the closest existing ancestor to verify parent symlinks/junctions
  const { ancestorPath, remainder } = findClosestExistingAncestor(lexicalTarget, fsAdapter);

  // If ancestor is outside root lexically
  if (!isPathInsideRoot(canonicalRoot, ancestorPath)) {
    return err(
      makeMediatorError(
        ErrorCode.PATH_OUTSIDE_ROOT,
        `Target ancestor directory is outside canonical workspace root: "${ancestorPath}"`,
        { detail: { targetPath, ancestorPath, canonicalRoot } },
      ),
    );
  }

  // Resolve ancestor canonical path on disk
  let resolvedAncestor: string;
  try {
    resolvedAncestor = normalizeWindowsPath(fsAdapter.realpathSync(ancestorPath));
  } catch {
    return err(
      makeMediatorError(
        ErrorCode.PATH_DENIED,
        `Failed to resolve realpath for existing ancestor directory: "${ancestorPath}"`,
        { detail: { targetPath, ancestorPath } },
      ),
    );
  }

  // Verify that the ancestor did not escape via symlink or junction
  if (!isPathInsideRoot(canonicalRoot, resolvedAncestor)) {
    return err(
      makeMediatorError(
        ErrorCode.PATH_SYMLINK_ESCAPE,
        `Target ancestor directory "${ancestorPath}" resolves outside canonical workspace root via symlink or junction: "${resolvedAncestor}"`,
        { detail: { targetPath, ancestorPath, canonicalRoot, resolvedAncestor } },
      ),
    );
  }

  // Project intended destination from resolved ancestor
  const projectedTarget = normalizeWindowsPath(path.resolve(resolvedAncestor, remainder));

  if (!isPathInsideRoot(canonicalRoot, projectedTarget)) {
    return err(
      makeMediatorError(
        ErrorCode.PATH_OUTSIDE_ROOT,
        `Projected target destination escapes canonical workspace root: "${projectedTarget}"`,
        { detail: { targetPath, canonicalRoot, projectedTarget } },
      ),
    );
  }

  const rel = path.relative(canonicalRoot, projectedTarget).replace(/\\/g, '/');

  return ok({
    inputPath: targetPath,
    resolvedPath: projectedTarget,
    relativePath: rel,
    exists: false,
  });
}

// ─── TOCTOU Mitigation & Safe Filesystem Operations ────────────────────────

/**
 * Revalidate an existing ContainedPath immediately before filesystem access.
 * If the path or its parent directory was replaced or swapped between validation and use,
 * this catches the discrepancy and fails closed.
 */
export function revalidateContainedPath(
  workspace: WorkspaceRootState,
  previous: ContainedPath,
  fsAdapter: FileSystemAdapter = defaultFileSystemAdapter,
): Result<ContainedPath, MediatorError> {
  const rechecked = validateContainedPath(workspace, previous.inputPath, {
    fsAdapter,
  });

  if (!rechecked.ok) {
    return err(rechecked.error);
  }

  // Verify that the resolved target path has not shifted
  const normPrev = normalizeWindowsPath(previous.resolvedPath).toLowerCase();
  const normNext = normalizeWindowsPath(rechecked.value.resolvedPath).toLowerCase();

  if (normPrev !== normNext) {
    return err(
      makeMediatorError(
        ErrorCode.PATH_DENIED,
        `TOCTOU race detected: Target canonical path changed between validation and access: "${previous.resolvedPath}" -> "${rechecked.value.resolvedPath}"`,
        { detail: { previous: previous.resolvedPath, current: rechecked.value.resolvedPath } },
      ),
    );
  }

  return ok(rechecked.value);
}

/**
 * Safe reading of a project file with TOCTOU revalidation.
 */
export function safeReadProjectFile(
  workspace: WorkspaceRootState,
  targetPath: string,
  fsAdapter: FileSystemAdapter = defaultFileSystemAdapter,
): Result<string, MediatorError> {
  const validated = validateContainedPath(workspace, targetPath, {
    operation: 'read',
    mustExist: true,
    fsAdapter,
  });

  if (!validated.ok) {
    return err(validated.error);
  }

  const contained = validated.value;

  // Immediate post-validation check to minimize TOCTOU window
  try {
    const postCheck = normalizeWindowsPath(fsAdapter.realpathSync(contained.resolvedPath));
    if (!isPathInsideRoot(workspace.canonicalPath ?? '', postCheck)) {
      return err(
        makeMediatorError(
          ErrorCode.PATH_SYMLINK_ESCAPE,
          `TOCTOU detection: Path swapped to outside target before read: "${postCheck}"`,
        ),
      );
    }
  } catch {
    return err(
      makeMediatorError(ErrorCode.PATH_DENIED, `Cannot access file for reading: "${contained.resolvedPath}"`),
    );
  }

  try {
    const content = fsAdapter.readFileSync
      ? fsAdapter.readFileSync(contained.resolvedPath, 'utf8')
      : fs.readFileSync(contained.resolvedPath, 'utf8');
    return ok(content);
  } catch (errObj) {
    return err(
      makeMediatorError(
        ErrorCode.PATH_DENIED,
        `Read failed on contained file "${contained.relativePath}": ${(errObj as Error).message}`,
      ),
    );
  }
}

/**
 * Safe writing of a project file with ancestor validation and post-write verification.
 */
export function safeWriteProjectFile(
  workspace: WorkspaceRootState,
  targetPath: string,
  content: string,
  fsAdapter: FileSystemAdapter = defaultFileSystemAdapter,
): Result<ContainedPath, MediatorError> {
  const validated = validateContainedPath(workspace, targetPath, {
    operation: 'write',
    mustExist: false,
    fsAdapter,
  });

  if (!validated.ok) {
    return err(validated.error);
  }

  const contained = validated.value;
  const canonicalRoot = workspace.canonicalPath ?? '';

  try {
    // Ensure parent directory exists
    const parentDir = path.dirname(contained.resolvedPath);
    if (!fsAdapter.existsSync(parentDir)) {
      if (fsAdapter.mkdirSync) {
        fsAdapter.mkdirSync(parentDir, { recursive: true });
      } else {
        fs.mkdirSync(parentDir, { recursive: true });
      }
    }

    if (fsAdapter.writeFileSync) {
      fsAdapter.writeFileSync(contained.resolvedPath, content);
    } else {
      fs.writeFileSync(contained.resolvedPath, content, 'utf8');
    }

    // Immediate post-write verification: ensure written file still resolves inside root
    const postCheck = normalizeWindowsPath(fsAdapter.realpathSync(contained.resolvedPath));
    if (!isPathInsideRoot(canonicalRoot, postCheck)) {
      // Abort: file was redirected to outside target via race
      try {
        if (fsAdapter.unlinkSync) {
          fsAdapter.unlinkSync(contained.resolvedPath);
        } else {
          fs.unlinkSync(contained.resolvedPath);
        }
      } catch {
        // Best effort cleanup
      }
      return err(
        makeMediatorError(
          ErrorCode.PATH_SYMLINK_ESCAPE,
          `TOCTOU detection: Written file resolved outside canonical root: "${postCheck}"`,
        ),
      );
    }

    return ok({
      ...contained,
      exists: true,
    });
  } catch (errObj) {
    return err(
      makeMediatorError(
        ErrorCode.PATH_DENIED,
        `Write failed on contained file "${contained.relativePath}": ${(errObj as Error).message}`,
      ),
    );
  }
}

/**
 * Safe deletion of a project file with pre-deletion verification.
 */
export function safeDeleteProjectFile(
  workspace: WorkspaceRootState,
  targetPath: string,
  fsAdapter: FileSystemAdapter = defaultFileSystemAdapter,
): Result<boolean, MediatorError> {
  const validated = validateContainedPath(workspace, targetPath, {
    operation: 'delete',
    mustExist: true,
    fsAdapter,
  });

  if (!validated.ok) {
    return err(validated.error);
  }

  const contained = validated.value;

  try {
    const postCheck = normalizeWindowsPath(fsAdapter.realpathSync(contained.resolvedPath));
    if (!isPathInsideRoot(workspace.canonicalPath ?? '', postCheck)) {
      return err(
        makeMediatorError(
          ErrorCode.PATH_SYMLINK_ESCAPE,
          `TOCTOU detection: Path swapped before deletion: "${postCheck}"`,
        ),
      );
    }

    if (fsAdapter.unlinkSync) {
      fsAdapter.unlinkSync(contained.resolvedPath);
    } else {
      fs.unlinkSync(contained.resolvedPath);
    }
    return ok(true);
  } catch (errObj) {
    return err(
      makeMediatorError(
        ErrorCode.PATH_DENIED,
        `Delete failed on contained file "${contained.relativePath}": ${(errObj as Error).message}`,
      ),
    );
  }
}
