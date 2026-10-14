/**
 * @mediator/context-engine — Incremental Project Map (S11)
 *
 * Requirements:
 * - Bounded, local overview of project structure, languages, frameworks,
 *   entry points, configs, test locations, and file metadata.
 * - Confirmed canonical workspace root required (S04/S05).
 * - Reuses path containment (S05) and secret exclusions (S06).
 * - Never reads excluded secret files merely to build the project map.
 * - Skips noisy directories by default (node_modules, dist, build, .git, etc.).
 * - Incremental refresh when mtimeMs or size change; reuses content hashes.
 * - Unreadable or unsafe files marked unavailable rather than guessed.
 * - Narrow adapter interface for future IDE symbols and diagnostics.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  type WorkspaceRootState,
  type IdeFileChangeEvent,
} from '@mediator/shared-contracts';
import {
  checkWorkspacePermittedForFileOps,
  validateContainedPath,
} from '@mediator/workspace-boundary';
import {
  checkPathExclusion,
  MANDATORY_EXCLUSIONS,
} from '@mediator/context-security';
import {
  ContextEngineError,
  ContextEngineErrorCode,
} from './errors.js';

export const DEFAULT_NOISY_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.github',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  '.turbo',
  '.cache',
  'coverage',
  '.parcel-cache',
  '.vs',
  '.idea',
  '.vscode',
  'bin',
  'obj',
];

export const MAX_PROJECT_MAP_FILES = 500;
export const MAX_SCAN_DEPTH = 8;
export const MAX_INDEXABLE_FILE_BYTES = 512 * 1024; // 512 KB per file for hashing

export interface IdeSymbolsAdapter {
  getSymbols?(relativePath: string): Promise<string[]> | string[];
  getDiagnostics?(relativePath: string): Promise<string[]> | string[];
}

export interface ProjectFileEntry {
  readonly relativePath: string;
  readonly byteSize: number;
  readonly mtimeMs: number;
  readonly contentHash: string; // SHA-256
  readonly available: boolean;
  readonly unavailableReason?: string | undefined;
  readonly language?: string | undefined;
  readonly isEntryPoint?: boolean | undefined;
  readonly isConfig?: boolean | undefined;
  readonly isTest?: boolean | undefined;
}

export interface ProjectMap {
  readonly workspaceId: string;
  readonly projectName: string;
  readonly canonicalRoot: string;
  readonly detectedLanguages: readonly string[];
  readonly detectedFrameworks: readonly string[];
  readonly entryPoints: readonly string[];
  readonly configFiles: readonly string[];
  readonly testLocations: readonly string[];
  readonly testCommands: readonly string[];
  readonly files: Record<string, ProjectFileEntry>;
  readonly totalFilesScanned: number;
  readonly totalBytes: number;
  readonly lastScannedAt: number;
  readonly version: number;
  readonly isStale?: boolean | undefined;
  readonly staleReason?: string | undefined;
  readonly freshness?: 'fresh' | 'stale' | 'partially_available' | undefined;
}

export function isStagingOrAppDataPath(relPath: string, fullPath?: string): boolean {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();
  if (
    norm.startsWith('.mediator/') ||
    norm === '.mediator' ||
    norm.startsWith('staging/') ||
    norm.includes('/staging/')
  ) {
    return true;
  }
  if (fullPath) {
    const fullNorm = fullPath.replace(/\\/g, '/').toLowerCase();
    if (fullNorm.includes('/appdata/') && fullNorm.includes('/mediator/')) {
      return true;
    }
  }
  return false;
}

export interface ScanProjectOptions {
  readonly previousMap?: ProjectMap | undefined;
  readonly ideAdapter?: IdeSymbolsAdapter | undefined;
  readonly extraIgnoredDirs?: readonly string[] | undefined;
  readonly maxFiles?: number | undefined;
  readonly maxDepth?: number | undefined;
}

/**
 * Detect language from file path extension
 */
function detectLanguage(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'TypeScript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'JavaScript';
    case '.py':
      return 'Python';
    case '.rs':
      return 'Rust';
    case '.go':
      return 'Go';
    case '.java':
      return 'Java';
    case '.c':
    case '.cpp':
    case '.h':
      return 'C/C++';
    case '.cs':
      return 'C#';
    case '.rb':
      return 'Ruby';
    case '.php':
      return 'PHP';
    case '.json':
      return 'JSON';
    case '.yaml':
    case '.yml':
      return 'YAML';
    case '.md':
      return 'Markdown';
    case '.html':
      return 'HTML';
    case '.css':
      return 'CSS';
    case '.sql':
      return 'SQL';
    default:
      return undefined;
  }
}

/**
 * Identify if a file is an entry point
 */
function isEntryPointFile(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(norm);
  const entryBases = [
    'index.ts',
    'index.js',
    'main.ts',
    'main.js',
    'main.py',
    'app.ts',
    'app.js',
    'main.rs',
    'main.go',
    'server.ts',
    'server.js',
  ];
  return (
    entryBases.includes(base) ||
    norm.startsWith('src/index.') ||
    norm.startsWith('src/main.') ||
    norm.startsWith('src/app.')
  );
}

/**
 * Identify if a file is a configuration file
 */
function isConfigFile(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  return (
    base === 'package.json' ||
    base === 'tsconfig.json' ||
    base.startsWith('tsconfig.') ||
    base === 'cargo.toml' ||
    base === 'pyproject.toml' ||
    base === 'go.mod' ||
    base === 'pom.xml' ||
    base.startsWith('vite.config.') ||
    base.startsWith('vitest.config.') ||
    base.startsWith('webpack.config.') ||
    base.startsWith('rollup.config.') ||
    base === '.eslintrc.json' ||
    base === '.prettierrc' ||
    base === 'dockerfile'
  );
}

/**
 * Identify if a file is a test file
 */
function isTestFile(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();
  return (
    norm.includes('.test.') ||
    norm.includes('.spec.') ||
    norm.startsWith('tests/') ||
    norm.startsWith('test/') ||
    norm.includes('/__tests__/')
  );
}

/**
 * Incrementally scan a confirmed workspace root to build or refresh a ProjectMap.
 */
export function scanProjectMap(
  rootState: WorkspaceRootState,
  options?: ScanProjectOptions,
): ProjectMap {
  // 1. Validate confirmed canonical workspace root
  const permitted = checkWorkspacePermittedForFileOps(rootState);
  if (!permitted.ok) {
    throw new ContextEngineError(
      ContextEngineErrorCode.UNSAFE_WORKSPACE_ROOT,
      `Cannot scan unconfirmed or unsafe workspace root: ${permitted.error.message}`,
      { detail: { rootState, error: permitted.error } },
    );
  }

  const canonicalRoot = permitted.value;
  if (!canonicalRoot || !fs.existsSync(canonicalRoot)) {
    throw new ContextEngineError(
      ContextEngineErrorCode.UNSAFE_WORKSPACE_ROOT,
      `Workspace canonical path does not exist on disk: ${canonicalRoot}`,
      { detail: { canonicalRoot } },
    );
  }

  const workspaceId =
    rootState.selectedPath.toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'workspace';
  const ignoredDirs = new Set([
    ...DEFAULT_NOISY_DIRS,
    ...(options?.extraIgnoredDirs ?? []),
  ]);
  const maxFiles = options?.maxFiles ?? MAX_PROJECT_MAP_FILES;
  const maxDepth = options?.maxDepth ?? MAX_SCAN_DEPTH;
  const previousFiles = options?.previousMap?.files ?? {};

  const fileEntries: Record<string, ProjectFileEntry> = {};
  const detectedLanguages = new Set<string>();
  const detectedFrameworks = new Set<string>();
  const entryPoints: string[] = [];
  const configFiles: string[] = [];
  const testLocations = new Set<string>();
  const testCommands = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;

  // Derive default project name from package.json or root directory basename
  let projectName = path.basename(canonicalRoot);

  // Helper: walk directory recursively
  function walkDir(currentDir: string, currentDepth: number): void {
    if (currentDepth > maxDepth || fileCount >= maxFiles) {
      return;
    }

    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirEntries) {
      if (fileCount >= maxFiles) break;

      const fullPath = path.join(currentDir, dirent.name);
      const relPath = path.relative(canonicalRoot, fullPath).replace(/\\/g, '/');

      if (dirent.isDirectory()) {
        const dirName = dirent.name.toLowerCase();
        // Skip noisy directories
        if (ignoredDirs.has(dirName) || ignoredDirs.has(dirent.name)) {
          continue;
        }

        // Never index staging or appdata directories as workspace content
        if (isStagingOrAppDataPath(relPath, fullPath)) {
          continue;
        }

        // Check path exclusion (S06)
        const exclusion = checkPathExclusion(relPath, MANDATORY_EXCLUSIONS);
        if (exclusion.excluded) {
          continue;
        }

        walkDir(fullPath, currentDepth + 1);
      } else if (dirent.isFile() || dirent.isSymbolicLink()) {
        // Enforce path containment
        const containment = validateContainedPath(rootState, fullPath, {
          operation: 'read',
          mustExist: true,
        });
        if (!containment.ok) {
          continue; // Outside root or escaping symlink
        }

        // Enforce secret exclusions (S06) — NEVER READ EXCLUDED SECRET FILES!
        const exclusion = checkPathExclusion(relPath, MANDATORY_EXCLUSIONS);
        if (exclusion.excluded) {
          continue; // Skipped without opening
        }

        // Never index staging or appdata files as workspace content
        if (isStagingOrAppDataPath(relPath, fullPath)) {
          continue;
        }

        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          fileEntries[relPath] = {
            relativePath: relPath,
            byteSize: 0,
            mtimeMs: 0,
            contentHash: '',
            available: false,
            unavailableReason: `Stat failed: ${msg}`,
          };
          fileCount++;
          continue;
        }

        // Check incremental cache hit
        const prevEntry = previousFiles[relPath];
        let contentHash = '';
        let isAvailable = true;
        let unavailableReason: string | undefined;

        if (
          prevEntry &&
          prevEntry.available &&
          prevEntry.mtimeMs === stat.mtimeMs &&
          prevEntry.byteSize === stat.size
        ) {
          // Re-use cached content hash without reading disk!
          contentHash = prevEntry.contentHash;
        } else {
          // Read and hash
          try {
            if (stat.size > MAX_INDEXABLE_FILE_BYTES) {
              // Bounded: hash only up to max indexable bytes
              const fd = fs.openSync(fullPath, 'r');
              const buffer = Buffer.alloc(MAX_INDEXABLE_FILE_BYTES);
              const bytesRead = fs.readSync(fd, buffer, 0, MAX_INDEXABLE_FILE_BYTES, 0);
              fs.closeSync(fd);
              contentHash = crypto
                .createHash('sha256')
                .update(buffer.subarray(0, bytesRead))
                .digest('hex');
            } else {
              const fileContent = fs.readFileSync(fullPath);
              contentHash = crypto.createHash('sha256').update(fileContent).digest('hex');
            }
          } catch (readErr: unknown) {
            isAvailable = false;
            unavailableReason =
              readErr instanceof Error ? readErr.message : String(readErr);
          }
        }

        const lang = detectLanguage(relPath);
        if (lang) detectedLanguages.add(lang);

        const isEntry = isEntryPointFile(relPath);
        if (isEntry) entryPoints.push(relPath);

        const isCfg = isConfigFile(relPath);
        if (isCfg) configFiles.push(relPath);

        const isTst = isTestFile(relPath);
        if (isTst) {
          const testDir = path.dirname(relPath);
          testLocations.add(testDir === '.' ? 'root' : testDir);
        }

        fileEntries[relPath] = {
          relativePath: relPath,
          byteSize: stat.size,
          mtimeMs: stat.mtimeMs,
          contentHash,
          available: isAvailable,
          unavailableReason,
          language: lang,
          isEntryPoint: isEntry,
          isConfig: isCfg,
          isTest: isTst,
        };

        totalBytes += stat.size;
        fileCount++;
      }
    }
  }

  walkDir(canonicalRoot, 0);

  // Parse package.json for project name, frameworks and test commands if available
  const pkgJsonPath = path.join(canonicalRoot, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkgContent = fs.readFileSync(pkgJsonPath, 'utf8');
      const parsed = JSON.parse(pkgContent) as Record<string, unknown>;
      if (typeof parsed.name === 'string') {
        projectName = parsed.name;
      }
      if (parsed.scripts && typeof parsed.scripts === 'object') {
        const scripts = parsed.scripts as Record<string, unknown>;
        if (scripts.test) {
          testCommands.add('npm test');
        }
      }
      const allDeps: Record<string, unknown> = {
        ...((parsed.dependencies as Record<string, unknown> | undefined) || {}),
        ...((parsed.devDependencies as Record<string, unknown> | undefined) || {}),
      };
      if (allDeps['vitest']) testCommands.add('vitest run');
      if (allDeps['jest']) testCommands.add('jest');
      if (allDeps['mocha']) testCommands.add('mocha');
      if (allDeps['next']) detectedFrameworks.add('Next.js');
      if (allDeps['react']) detectedFrameworks.add('React');
      if (allDeps['vue']) detectedFrameworks.add('Vue');
      if (allDeps['express']) detectedFrameworks.add('Express');
      if (allDeps['typescript']) detectedLanguages.add('TypeScript');
    } catch {
      // Ignore package.json parsing error
    }
  }

  // Parse Cargo.toml for Rust projects
  const cargoPath = path.join(canonicalRoot, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    detectedLanguages.add('Rust');
    testCommands.add('cargo test');
    try {
      const cargoContent = fs.readFileSync(cargoPath, 'utf8');
      const nameMatch = cargoContent.match(/name\s*=\s*"([^"]+)"/);
      if (nameMatch && nameMatch[1]) {
        projectName = nameMatch[1];
      }
    } catch {
      // Ignore
    }
  }

  // Parse pyproject.toml / requirements.txt for Python projects
  if (
    fs.existsSync(path.join(canonicalRoot, 'pyproject.toml')) ||
    fs.existsSync(path.join(canonicalRoot, 'requirements.txt'))
  ) {
    detectedLanguages.add('Python');
    testCommands.add('pytest');
  }

  // Parse go.mod for Go projects
  if (fs.existsSync(path.join(canonicalRoot, 'go.mod'))) {
    detectedLanguages.add('Go');
    testCommands.add('go test ./...');
  }

  const previousVersion = options?.previousMap?.version ?? 0;

  return {
    workspaceId,
    projectName,
    canonicalRoot,
    detectedLanguages: Array.from(detectedLanguages).sort(),
    detectedFrameworks: Array.from(detectedFrameworks).sort(),
    entryPoints: entryPoints.sort(),
    configFiles: configFiles.sort(),
    testLocations: Array.from(testLocations).sort(),
    testCommands: Array.from(testCommands).sort(),
    files: fileEntries,
    totalFilesScanned: fileCount,
    totalBytes,
    lastScannedAt: Date.now(),
    version: previousVersion + 1,
    freshness: 'fresh',
    isStale: false,
  };
}

/**
 * Incrementally update an existing ProjectMap for a single file event.
 * Revalidates path containment and secret exclusions.
 * Staging / app-data paths are strictly ignored.
 */
export function updateProjectMapIncremental(
  currentMap: ProjectMap,
  rootState: WorkspaceRootState,
  event: IdeFileChangeEvent,
): ProjectMap {
  const permitted = checkWorkspacePermittedForFileOps(rootState);
  if (!permitted.ok) {
    throw new ContextEngineError(
      ContextEngineErrorCode.UNSAFE_WORKSPACE_ROOT,
      `Cannot update project map for unconfirmed or unsafe workspace root: ${permitted.error.message}`,
      { detail: { rootState, error: permitted.error } },
    );
  }

  const canonicalRoot = permitted.value;
  if (canonicalRoot.toLowerCase() !== currentMap.canonicalRoot.toLowerCase()) {
    throw new ContextEngineError(
      ContextEngineErrorCode.UNSAFE_WORKSPACE_ROOT,
      `Workspace canonical root mismatch: expected ${currentMap.canonicalRoot}, got ${canonicalRoot}`,
      { detail: { expected: currentMap.canonicalRoot, actual: canonicalRoot } },
    );
  }

  const normRel = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
  const targetRel = normRel(event.path);

  // Check if target is staging or app-data
  if (isStagingOrAppDataPath(targetRel)) {
    return currentMap; // Ignore staging events completely
  }

  const files = { ...currentMap.files };
  let totalBytes = currentMap.totalBytes;
  let fileCount = currentMap.totalFilesScanned;

  if (event.type === 'delete') {
    const existing = files[targetRel];
    if (!existing) {
      return currentMap; // Not in map, nothing to delete
    }

    delete files[targetRel];
    totalBytes = Math.max(0, totalBytes - existing.byteSize);
    fileCount = Math.max(0, fileCount - 1);

    return {
      ...currentMap,
      files,
      totalBytes,
      totalFilesScanned: fileCount,
      lastScannedAt: Date.now(),
      version: currentMap.version + 1,
      freshness: 'fresh',
      isStale: false,
      entryPoints: currentMap.entryPoints.filter((e) => e !== targetRel),
      configFiles: currentMap.configFiles.filter((c) => c !== targetRel),
    };
  }

  if (event.type === 'rename' && event.oldPath) {
    const oldRel = normRel(event.oldPath);
    const oldEntry = files[oldRel];
    if (oldEntry) {
      delete files[oldRel];
      totalBytes = Math.max(0, totalBytes - oldEntry.byteSize);
      fileCount = Math.max(0, fileCount - 1);
    }
  }

  // Handle 'create', 'modify', or new target of 'rename'
  const fullPath = path.join(canonicalRoot, targetRel);

  // Check containment
  const containment = validateContainedPath(rootState, fullPath, {
    operation: 'read',
    mustExist: true,
  });
  if (!containment.ok) {
    return currentMap; // Outside root or escaping symlink
  }

  // Check S06 secret exclusion
  const exclusion = checkPathExclusion(targetRel, MANDATORY_EXCLUSIONS);
  if (exclusion.excluded) {
    return currentMap; // Never read or index excluded secret files!
  }

  // Check noisy directories
  const segments = targetRel.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]?.toLowerCase();
    if (seg && DEFAULT_NOISY_DIRS.includes(seg)) {
      return currentMap; // In noisy directory
    }
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(fullPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const existing = files[targetRel];
    if (existing) {
      totalBytes = Math.max(0, totalBytes - existing.byteSize);
    } else {
      fileCount++;
    }
    files[targetRel] = {
      relativePath: targetRel,
      byteSize: 0,
      mtimeMs: 0,
      contentHash: '',
      available: false,
      unavailableReason: `Stat failed: ${msg}`,
    };

    return {
      ...currentMap,
      files,
      totalBytes,
      totalFilesScanned: fileCount,
      lastScannedAt: Date.now(),
      version: currentMap.version + 1,
      freshness: 'fresh',
      isStale: false,
    };
  }

  let contentHash = '';
  let isAvailable = true;
  let unavailableReason: string | undefined;

  try {
    if (stat.size > MAX_INDEXABLE_FILE_BYTES) {
      const fd = fs.openSync(fullPath, 'r');
      const buffer = Buffer.alloc(MAX_INDEXABLE_FILE_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, MAX_INDEXABLE_FILE_BYTES, 0);
      fs.closeSync(fd);
      contentHash = crypto
        .createHash('sha256')
        .update(buffer.subarray(0, bytesRead))
        .digest('hex');
    } else {
      const fileContent = fs.readFileSync(fullPath);
      contentHash = crypto.createHash('sha256').update(fileContent).digest('hex');
    }
  } catch (readErr: unknown) {
    isAvailable = false;
    unavailableReason = readErr instanceof Error ? readErr.message : String(readErr);
  }

  const existing = files[targetRel];
  if (existing) {
    totalBytes = totalBytes - existing.byteSize + stat.size;
  } else {
    totalBytes += stat.size;
    fileCount++;
  }

  const lang = detectLanguage(targetRel);
  const isEntry = isEntryPointFile(targetRel);
  const isCfg = isConfigFile(targetRel);
  const isTst = isTestFile(targetRel);

  files[targetRel] = {
    relativePath: targetRel,
    byteSize: stat.size,
    mtimeMs: stat.mtimeMs,
    contentHash,
    available: isAvailable,
    unavailableReason,
    language: lang,
    isEntryPoint: isEntry,
    isConfig: isCfg,
    isTest: isTst,
  };

  const detectedLanguages = new Set(currentMap.detectedLanguages);
  if (lang) detectedLanguages.add(lang);

  const entryPoints = new Set(currentMap.entryPoints);
  if (isEntry) entryPoints.add(targetRel);

  const configFiles = new Set(currentMap.configFiles);
  if (isCfg) configFiles.add(targetRel);

  const testLocations = new Set(currentMap.testLocations);
  if (isTst) {
    const testDir = path.dirname(targetRel);
    testLocations.add(testDir === '.' ? 'root' : testDir);
  }

  return {
    ...currentMap,
    files,
    totalBytes,
    totalFilesScanned: fileCount,
    detectedLanguages: Array.from(detectedLanguages).sort(),
    entryPoints: Array.from(entryPoints).sort(),
    configFiles: Array.from(configFiles).sort(),
    testLocations: Array.from(testLocations).sort(),
    lastScannedAt: Date.now(),
    version: currentMap.version + 1,
    freshness: 'fresh',
    isStale: false,
  };
}

/**
 * Concurrency-safe incremental project map manager.
 * Serializes file change events and tracks map freshness.
 */
export class IncrementalProjectMapManager {
  private map: ProjectMap;
  private eventQueue: Promise<void> = Promise.resolve();
  private isDisposed = false;

  constructor(
    private readonly rootState: WorkspaceRootState,
    initialMap?: ProjectMap,
  ) {
    this.map = initialMap ?? scanProjectMap(rootState);
  }

  public getMap(): ProjectMap {
    return this.map;
  }

  public getFreshness(): 'fresh' | 'stale' | 'partially_available' {
    return this.map.freshness ?? (this.map.isStale ? 'stale' : 'fresh');
  }

  public handleFileEvent(event: IdeFileChangeEvent): Promise<ProjectMap> {
    if (this.isDisposed) {
      return Promise.resolve(this.map);
    }

    this.eventQueue = this.eventQueue.then(() => {
      this.map = updateProjectMapIncremental(this.map, this.rootState, event);
    });

    return this.eventQueue.then(() => this.map);
  }

  public handleWatcherError(err: Error | string): void {
    const reason = err instanceof Error ? err.message : String(err);
    this.map = {
      ...this.map,
      isStale: true,
      staleReason: `Watcher error: ${reason}`,
      freshness: 'stale',
      lastScannedAt: Date.now(),
    };
  }

  public markStale(reason: string): void {
    this.map = {
      ...this.map,
      isStale: true,
      staleReason: reason,
      freshness: 'stale',
      lastScannedAt: Date.now(),
    };
  }

  public refresh(
    options?: ScanProjectOptions,
    cancellationToken?: { isCancelled: boolean },
  ): Promise<ProjectMap> {
    if (cancellationToken?.isCancelled) {
      return Promise.resolve(this.map);
    }

    return new Promise<ProjectMap>((resolve, reject) => {
      this.eventQueue = this.eventQueue.then(() => {
        if (cancellationToken?.isCancelled) {
          resolve(this.map);
          return;
        }
        try {
          this.map = scanProjectMap(this.rootState, {
            ...options,
            previousMap: this.map,
          });
          resolve(this.map);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  public dispose(): void {
    this.isDisposed = true;
  }
}

