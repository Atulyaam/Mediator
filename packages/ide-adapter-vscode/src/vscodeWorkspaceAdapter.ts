/**
 * @mediator/ide-adapter-vscode — VS Code Workspace Adapter (Sprint S15)
 *
 * Implements the typed adapter for supported VS Code capabilities.
 * Strictly adheres to non-negotiable security and containment invariants:
 * - Never runs shell or git commands
 * - Never collects editor/selection context without explicit opt-in
 * - Revalidates all file paths against S05 containment and S06 exclusions
 * - Never accesses excluded secret files
 * - Truthfully reports unavailable/unsupported capabilities
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  type Result,
  ok,
  err,
  makeMediatorError,
  ErrorCode,
  type MediatorError,
  type WorkspaceRootState,
  type IdeCapabilityMatrix,
  type IdeProductInfo,
  type IdeGitStatus,
  type IdeDiagnosticsResult,
  type IdeDiagnosticItem,
  type IdeSymbolsResult,
  type IdeSymbolItem,
  type IdeTestDiscoveryResult,
  type EditorSelectionContext,
  type EditorConsentSettings,
  type IdeFileChangeEvent,
} from '@mediator/shared-contracts';
import {
  inspectWorkspaceRoot,
  confirmWorkspaceRoot,
  validateContainedPath,
} from '@mediator/workspace-boundary';
import {
  checkPathExclusion,
  MANDATORY_EXCLUSIONS,
  scanContent,
  shouldBlockContent,
  redactContent,
} from '@mediator/context-security';
import {
  type VsCodeApiFacade,
  type VsCodeGitApi,
  type VsCodeDocumentSymbol,
  type IdeWorkspaceAdapter,
} from './vscodeAdapterTypes.js';
import {
  detectVsCodeProduct,
  probeVsCodeCapabilities,
} from './vscodeCapabilities.js';

export const DEFAULT_MAX_DIAGNOSTICS = 100;
export const DEFAULT_MAX_SYMBOLS = 50;
export const DEFAULT_MAX_SELECTION_BYTES = 16 * 1024; // 16 KB

export class VsCodeWorkspaceAdapter implements IdeWorkspaceAdapter {
  private cachedRootState: WorkspaceRootState | null = null;

  constructor(
    private readonly api: VsCodeApiFacade,
    explicitRoot?: string | WorkspaceRootState,
  ) {
    if (explicitRoot) {
      if (typeof explicitRoot === 'string') {
        const inspected = inspectWorkspaceRoot(explicitRoot, 'ide');
        const confirmed = confirmWorkspaceRoot(inspected, true);
        this.cachedRootState = confirmed.ok ? confirmed.value : inspected;
      } else {
        this.cachedRootState = explicitRoot;
      }
    }
  }

  public confirmWorkspace(confirmed = true): void {
    if (this.cachedRootState) {
      const res = confirmWorkspaceRoot(this.cachedRootState, confirmed);
      if (res.ok) {
        this.cachedRootState = res.value;
      }
    }
  }

  public getProductInfo(): IdeProductInfo {
    return detectVsCodeProduct(this.api);
  }

  public getCapabilities(correlationId = 'cap-vscode'): IdeCapabilityMatrix {
    return probeVsCodeCapabilities(this.api, correlationId);
  }

  public getWorkspaceRoot(): Result<WorkspaceRootState, MediatorError> {
    if (this.cachedRootState) {
      return ok(this.cachedRootState);
    }

    const folders = this.api.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return err(
        makeMediatorError(
          ErrorCode.WORKSPACE_NOT_FOUND,
          'No workspace folder is open in VS Code',
        ),
      );
    }

    if (folders.length > 1) {
      return err(
        makeMediatorError(
          ErrorCode.WORKSPACE_ROOT_AMBIGUOUS,
          `Multi-root workspaces require explicit single-root confirmation in Mediator v1 (${folders.length} folders open)`,
        ),
      );
    }

    const first = folders[0];
    if (!first) {
      return err(
        makeMediatorError(
          ErrorCode.WORKSPACE_NOT_FOUND,
          'No workspace folder is open in VS Code',
        ),
      );
    }

    const inspected = inspectWorkspaceRoot(first.uri.fsPath, 'ide');
    const confirmed = confirmWorkspaceRoot(inspected, true);
    this.cachedRootState = confirmed.ok ? confirmed.value : inspected;
    return ok(this.cachedRootState);
  }

  public async getGitStatus(
    _correlationId = 'git-vscode',
  ): Promise<Result<IdeGitStatus, MediatorError>> {
    await Promise.resolve();
    const gitExt = this.api.extensions?.getExtension?.<{ getAPI?(version: number): VsCodeGitApi }>('vscode.git');
    if (!gitExt || !gitExt.isActive || !gitExt.exports || typeof gitExt.exports.getAPI !== 'function') {
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_UNAVAILABLE,
          'Git status capability is unavailable: vscode.git extension is not active or not installed',
        ),
      );
    }

    const gitApi = gitExt.exports.getAPI(1);
    const rootRes = this.getWorkspaceRoot();
    if (!rootRes.ok) {
      return err(rootRes.error);
    }

    const canonicalRoot = (rootRes.value.canonicalPath ?? rootRes.value.selectedPath).toLowerCase();
    const repo = gitApi.repositories.find((r) => {
      const repoRoot = path.normalize(r.rootUri.fsPath).toLowerCase();
      return repoRoot === canonicalRoot || canonicalRoot.startsWith(repoRoot);
    });

    if (!repo) {
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_UNAVAILABLE,
          `No active Git repository found for workspace: ${rootRes.value.canonicalPath ?? rootRes.value.selectedPath}`,
        ),
      );
    }

    const toRelativeSafe = (p: string): string => {
      const rootPath = rootRes.value.canonicalPath ?? rootRes.value.selectedPath;
      const rel = path.relative(rootPath, p).replace(/\\/g, '/');
      return rel;
    };

    const modified = (repo.state.workingTreeChanges || []).map((c) => toRelativeSafe(c.uri.fsPath));
    const staged = (repo.state.indexChanges || []).map((c) => toRelativeSafe(c.uri.fsPath));
    const untracked = (repo.state.untrackedChanges || []).map((c) => toRelativeSafe(c.uri.fsPath));

    return ok({
      isAvailable: true,
      branch: repo.state.HEAD?.name,
      aheadCount: repo.state.HEAD?.ahead,
      behindCount: repo.state.HEAD?.behind,
      modifiedFiles: modified,
      stagedFiles: staged,
      untrackedFiles: untracked,
    });
  }

  public async getDiagnostics(
    _correlationId = 'diag-vscode',
    maxItems = DEFAULT_MAX_DIAGNOSTICS,
  ): Promise<Result<IdeDiagnosticsResult, MediatorError>> {
    await Promise.resolve();
    if (typeof this.api.languages?.getDiagnostics !== 'function') {
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_UNAVAILABLE,
          'Diagnostics capability is unavailable in this environment',
        ),
      );
    }

    const rootRes = this.getWorkspaceRoot();
    if (!rootRes.ok) {
      return err(rootRes.error);
    }

    const allDiags = this.api.languages.getDiagnostics();
    const items: IdeDiagnosticItem[] = [];
    let truncated = false;

    const severityMap: Record<number, 'error' | 'warning' | 'info' | 'hint'> = {
      0: 'error',
      1: 'warning',
      2: 'info',
      3: 'hint',
    };

    for (const [uri, diags] of allDiags) {
      if (items.length >= maxItems) {
        truncated = true;
        break;
      }

      const filePath = uri.fsPath;
      // 1. Path containment check (S05)
      const containment = validateContainedPath(rootRes.value, filePath, {
        operation: 'read',
        mustExist: false,
      });
      if (!containment.ok) {
        continue; // Outside workspace
      }

      // 2. Secret exclusion check (S06)
      const relPath = containment.value.relativePath;
      const exclusion = checkPathExclusion(relPath, MANDATORY_EXCLUSIONS);
      if (exclusion.excluded) {
        continue; // Secret / excluded path
      }

      for (const d of diags) {
        if (items.length >= maxItems) {
          truncated = true;
          break;
        }

        items.push({
          filePath: relPath,
          severity: severityMap[d.severity] ?? 'info',
          message: d.message,
          range: {
            startLine: d.range.start.line,
            startCol: d.range.start.character,
            endLine: d.range.end.line,
            endCol: d.range.end.character,
          },
          source: d.source,
          code: d.code,
        });
      }
    }

    return ok({
      status: 'supported',
      items,
      totalCount: items.length,
      truncated,
    });
  }

  public async getSymbols(
    relativePath: string,
    _correlationId = 'sym-vscode',
    maxItems = DEFAULT_MAX_SYMBOLS,
  ): Promise<Result<IdeSymbolsResult, MediatorError>> {
    const rootRes = this.getWorkspaceRoot();
    if (!rootRes.ok) {
      return err(rootRes.error);
    }

    // 1. Path containment check
    const containment = validateContainedPath(rootRes.value, relativePath, {
      operation: 'read',
      mustExist: true,
    });
    if (!containment.ok) {
      return err(containment.error);
    }

    // 2. Secret exclusion check
    const exclusion = checkPathExclusion(containment.value.relativePath, MANDATORY_EXCLUSIONS);
    if (exclusion.excluded) {
      return err(
        makeMediatorError(
          ErrorCode.ACTION_DENIED,
          `Cannot inspect symbols for excluded path: ${containment.value.relativePath}`,
        ),
      );
    }

    if (typeof this.api.commands?.executeCommand !== 'function') {
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_UNAVAILABLE,
          'Language symbol provider is unavailable in this environment',
        ),
      );
    }

    try {
      const rawSymbols = await this.api.commands.executeCommand<VsCodeDocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        { fsPath: containment.value.resolvedPath },
      );

      if (!rawSymbols || !Array.isArray(rawSymbols)) {
        return ok({
          status: 'supported',
          symbols: [],
          truncated: false,
        });
      }

      const flat: IdeSymbolItem[] = [];
      let truncated = false;

      const flatten = (syms: readonly VsCodeDocumentSymbol[], container?: string): void => {
        for (const s of syms) {
          if (flat.length >= maxItems) {
            truncated = true;
            return;
          }
          flat.push({
            name: s.name,
            kind: String(s.kind),
            filePath: containment.value.relativePath,
            range: {
              startLine: s.range.start.line,
              startCol: s.range.start.character,
              endLine: s.range.end.line,
              endCol: s.range.end.character,
            },
            containerName: container ?? s.containerName,
          });

          if (s.children && s.children.length > 0) {
            flatten(s.children, s.name);
          }
        }
      };

      flatten(rawSymbols);

      return ok({
        status: 'supported',
        symbols: flat,
        truncated,
      });
    } catch (err_: unknown) {
      const msg = err_ instanceof Error ? err_.message : String(err_);
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_UNAVAILABLE,
          `Symbol provider failed: ${msg}`,
        ),
      );
    }
  }

  public async discoverTests(
    _correlationId = 'test-discovery',
  ): Promise<Result<IdeTestDiscoveryResult, MediatorError>> {
    await Promise.resolve();
    const rootRes = this.getWorkspaceRoot();
    if (!rootRes.ok) {
      return err(rootRes.error);
    }

    const root = rootRes.value.canonicalPath ?? rootRes.value.selectedPath;
    const testFiles: string[] = [];
    const commands: string[] = [];
    let framework: string | undefined;

    // Check package.json for test framework metadata
    const pkgJsonPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
        const allDeps = {
          ...((pkg.dependencies as Record<string, unknown> | undefined) || {}),
          ...((pkg.devDependencies as Record<string, unknown> | undefined) || {}),
        };

        if (allDeps['vitest']) {
          framework = 'vitest';
          commands.push('vitest run');
        } else if (allDeps['jest']) {
          framework = 'jest';
          commands.push('jest');
        } else if (allDeps['mocha']) {
          framework = 'mocha';
          commands.push('mocha');
        }

        const scripts = (pkg.scripts as Record<string, unknown> | undefined) || {};
        if (scripts['test']) {
          commands.push('npm test');
        }
      } catch {
        // Ignore package.json parsing error
      }
    }

    // Check Cargo.toml
    if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
      framework = framework ?? 'cargo';
      commands.push('cargo test');
    }

    // Check pytest / python
    if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'pytest.ini'))) {
      framework = framework ?? 'pytest';
      commands.push('pytest');
    }

    // Scan for candidate test files (metadata only — bounded depth, max 50 test files)
    const scanTestFiles = (dir: string, depth: number): void => {
      if (depth > 5 || testFiles.length >= 50) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const e of entries) {
        if (testFiles.length >= 50) break;
        const full = path.join(dir, e.name);
        const rel = path.relative(root, full).replace(/\\/g, '/');

        if (e.isDirectory()) {
          const lower = e.name.toLowerCase();
          if (
            lower === 'node_modules' ||
            lower === '.git' ||
            lower === 'dist' ||
            lower === 'build' ||
            lower === 'out'
          ) {
            continue;
          }
          if (checkPathExclusion(rel, MANDATORY_EXCLUSIONS).excluded) continue;
          scanTestFiles(full, depth + 1);
        } else if (e.isFile()) {
          if (checkPathExclusion(rel, MANDATORY_EXCLUSIONS).excluded) continue;
          const lower = rel.toLowerCase();
          if (
            lower.includes('.test.') ||
            lower.includes('.spec.') ||
            lower.startsWith('tests/') ||
            lower.startsWith('test/') ||
            lower.includes('/__tests__/')
          ) {
            testFiles.push(rel);
          }
        }
      }
    };

    scanTestFiles(root, 0);

    return ok({
      status: 'supported',
      framework,
      candidateTestFiles: testFiles.sort(),
      testCommands: Array.from(new Set(commands)).sort(),
      isPartial: false,
    });
  }

  public async getEditorContext(
    consent: EditorConsentSettings,
    _correlationId = 'editor-ctx',
  ): Promise<Result<EditorSelectionContext | null, MediatorError>> {
    await Promise.resolve();
    // 1. Explicit user opt-in enforcement
    if (!consent.allowEditorContext) {
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_PERMISSION_DENIED,
          'Editor selection context collection is disabled: user has not explicitly opted in',
        ),
      );
    }

    const editor = this.api.window.activeTextEditor;
    if (!editor) {
      return ok(null);
    }

    const rootRes = this.getWorkspaceRoot();
    if (!rootRes.ok) {
      return err(rootRes.error);
    }

    const filePath = editor.document.uri.fsPath;

    // 2. Workspace containment check (S05)
    const containment = validateContainedPath(rootRes.value, filePath, {
      operation: 'read',
      mustExist: true,
    });
    if (!containment.ok) {
      return err(
        makeMediatorError(
          ErrorCode.ACTION_DENIED,
          `Active editor file is outside canonical workspace: ${filePath}`,
        ),
      );
    }

    // 3. Secret exclusion check (S06)
    const relPath = containment.value.relativePath;
    const exclusion = checkPathExclusion(relPath, MANDATORY_EXCLUSIONS);
    if (exclusion.excluded) {
      return err(
        makeMediatorError(
          ErrorCode.ACTION_DENIED,
          `Active editor file matches mandatory secret exclusions: ${relPath}`,
        ),
      );
    }

    let selectedText: string | undefined;
    let wasRedacted = false;

    // 4. Selected text collection (only if specifically consented)
    if (consent.allowSelectedText) {
      const rawText = editor.document.getText(editor.selection);
      if (rawText && rawText.length > 0) {
        const maxBytes = consent.maxSelectedTextBytes ?? DEFAULT_MAX_SELECTION_BYTES;
        const boundedText =
          Buffer.byteLength(rawText, 'utf8') > maxBytes
            ? rawText.slice(0, maxBytes)
            : rawText;

        // 5. Secret scanning & redaction
        const scanRes = scanContent(boundedText);
        if (scanRes.ok && shouldBlockContent(scanRes.value)) {
          const redResult = redactContent(boundedText, scanRes.value);
          selectedText = redResult.redactedContent;
          wasRedacted = true;
        } else if (scanRes.ok) {
          selectedText = boundedText;
        }
      }
    }

    return ok({
      filePath: relPath,
      cursorPosition: {
        line: editor.selection.active.line,
        character: editor.selection.active.character,
      },
      selectionRange: {
        startLine: editor.selection.start.line,
        startCol: editor.selection.start.character,
        endLine: editor.selection.end.line,
        endCol: editor.selection.end.character,
      },
      selectedText,
      hasOptedIn: true,
      redacted: wasRedacted,
    });
  }

  public watchWorkspace(
    handler: (event: IdeFileChangeEvent) => void,
  ): { dispose(): void } {
    if (typeof this.api.workspace.createFileSystemWatcher !== 'function') {
      return { dispose: (): void => {} };
    }

    const watcher = this.api.workspace.createFileSystemWatcher('**/*');
    const rootRes = this.getWorkspaceRoot();
    const root = rootRes.ok ? (rootRes.value.canonicalPath ?? rootRes.value.selectedPath) : '';

    const toRel = (fsPath: string): string => {
      if (!root) return fsPath;
      return path.relative(root, fsPath).replace(/\\/g, '/');
    };

    const d1 = watcher.onDidCreate((e) => {
      handler({ type: 'create', path: toRel(e.fsPath), timestamp: Date.now() });
    });
    const d2 = watcher.onDidChange((e) => {
      handler({ type: 'modify', path: toRel(e.fsPath), timestamp: Date.now() });
    });
    const d3 = watcher.onDidDelete((e) => {
      handler({ type: 'delete', path: toRel(e.fsPath), timestamp: Date.now() });
    });

    return {
      dispose(): void {
        d1.dispose();
        d2.dispose();
        d3.dispose();
        watcher.dispose();
      },
    };
  }
}
