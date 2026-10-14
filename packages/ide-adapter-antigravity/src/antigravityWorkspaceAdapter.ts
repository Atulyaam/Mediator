/**
 * @mediator/ide-adapter-antigravity — Antigravity Workspace Adapter (Sprint S15)
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
  type AntigravityApiFacade,
  type AntigravityWorkspaceAdapterInterface,
} from './antigravityAdapterTypes.js';
import {
  detectAntigravityProduct,
  probeAntigravityCapabilities,
} from './antigravityCapabilities.js';

export const DEFAULT_MAX_DIAGNOSTICS = 100;
export const DEFAULT_MAX_SYMBOLS = 50;
export const DEFAULT_MAX_SELECTION_BYTES = 16 * 1024; // 16 KB

export class AntigravityWorkspaceAdapter implements AntigravityWorkspaceAdapterInterface {
  private cachedRootState: WorkspaceRootState | null = null;

  constructor(
    private readonly api?: AntigravityApiFacade,
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
    } else if (api?.workspaceRootPath) {
      const inspected = inspectWorkspaceRoot(api.workspaceRootPath, 'ide');
      const confirmed = confirmWorkspaceRoot(inspected, true);
      this.cachedRootState = confirmed.ok ? confirmed.value : inspected;
    }
  }

  public getProductInfo(): IdeProductInfo {
    return detectAntigravityProduct(this.api);
  }

  public getCapabilities(correlationId = 'cap-antigravity'): IdeCapabilityMatrix {
    return probeAntigravityCapabilities(this.api, correlationId);
  }

  public getWorkspaceRoot(): Result<WorkspaceRootState, MediatorError> {
    if (this.cachedRootState) {
      return ok(this.cachedRootState);
    }

    if (this.api?.workspaceRootPath) {
      return ok(inspectWorkspaceRoot(this.api.workspaceRootPath, 'ide'));
    }

    return err(
      makeMediatorError(
        ErrorCode.WORKSPACE_NOT_FOUND,
        'No canonical workspace root configured in Antigravity adapter',
      ),
    );
  }

  public async getGitStatus(
    _correlationId = 'git-antigravity',
  ): Promise<Result<IdeGitStatus, MediatorError>> {
    await Promise.resolve();
    if (!this.api?.git || typeof this.api.git.getStatus !== 'function') {
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_UNAVAILABLE,
          'Antigravity Git integration is unavailable: Git extension not loaded or unverified in this runtime',
        ),
      );
    }

    const rootRes = this.getWorkspaceRoot();
    if (!rootRes.ok) {
      return err(rootRes.error);
    }

    try {
      const status = this.api.git.getStatus();
      return ok({
        isAvailable: true,
        branch: status.branch,
        modifiedFiles: status.modified ?? [],
        stagedFiles: status.staged ?? [],
        untrackedFiles: status.untracked ?? [],
      });
    } catch (gitErr: unknown) {
      const msg = gitErr instanceof Error ? gitErr.message : String(gitErr);
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_UNAVAILABLE,
          `Failed to retrieve Git status from Antigravity: ${msg}`,
        ),
      );
    }
  }

  public async getDiagnostics(
    _correlationId = 'diag-antigravity',
    maxItems = DEFAULT_MAX_DIAGNOSTICS,
  ): Promise<Result<IdeDiagnosticsResult, MediatorError>> {
    await Promise.resolve();
    if (!this.api?.languageServer || typeof this.api.languageServer.getDiagnostics !== 'function') {
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_UNAVAILABLE,
          'Antigravity Language Server diagnostics capability is not verified or unavailable in this environment',
        ),
      );
    }

    const rootRes = this.getWorkspaceRoot();
    if (!rootRes.ok) {
      return err(rootRes.error);
    }

    try {
      const raw = this.api.languageServer.getDiagnostics(
        rootRes.value.canonicalPath ?? rootRes.value.selectedPath,
      );
      const items: IdeDiagnosticItem[] = [];
      let truncated = false;

      for (const d of raw) {
        if (items.length >= maxItems) {
          truncated = true;
          break;
        }

        items.push({
          filePath: rootRes.value.selectedPath,
          severity: d.severity,
          message: d.message,
          range: {
            startLine: d.line,
            startCol: d.col,
            endLine: d.line,
            endCol: d.col + 1,
          },
        });
      }

      return ok({
        status: 'supported',
        items,
        totalCount: items.length,
        truncated,
      });
    } catch (err_: unknown) {
      const msg = err_ instanceof Error ? err_.message : String(err_);
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_UNAVAILABLE,
          `Antigravity diagnostics query failed: ${msg}`,
        ),
      );
    }
  }

  public async getSymbols(
    relativePath: string,
    _correlationId = 'sym-antigravity',
    maxItems = DEFAULT_MAX_SYMBOLS,
  ): Promise<Result<IdeSymbolsResult, MediatorError>> {
    await Promise.resolve();
    const rootRes = this.getWorkspaceRoot();
    if (!rootRes.ok) {
      return err(rootRes.error);
    }

    const containment = validateContainedPath(rootRes.value, relativePath, {
      operation: 'read',
      mustExist: true,
    });
    if (!containment.ok) {
      return err(containment.error);
    }

    const exclusion = checkPathExclusion(containment.value.relativePath, MANDATORY_EXCLUSIONS);
    if (exclusion.excluded) {
      return err(
        makeMediatorError(
          ErrorCode.ACTION_DENIED,
          `Cannot inspect symbols for excluded path: ${containment.value.relativePath}`,
        ),
      );
    }

    if (!this.api?.languageServer || typeof this.api.languageServer.getDocumentSymbols !== 'function') {
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_UNAVAILABLE,
          'Antigravity document symbol provider is unverified or unavailable in this runtime',
        ),
      );
    }

    try {
      const raw = this.api.languageServer.getDocumentSymbols(containment.value.resolvedPath);
      const symbols: IdeSymbolItem[] = [];
      let truncated = false;

      for (const s of raw) {
        if (symbols.length >= maxItems) {
          truncated = true;
          break;
        }

        symbols.push({
          name: s.name,
          kind: s.kind,
          filePath: containment.value.relativePath,
          range: {
            startLine: s.startLine,
            startCol: s.startCol,
            endLine: s.endLine,
            endCol: s.endCol,
          },
          containerName: s.containerName,
        });
      }

      return ok({
        status: 'supported',
        symbols,
        truncated,
      });
    } catch (err_: unknown) {
      const msg = err_ instanceof Error ? err_.message : String(err_);
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_UNAVAILABLE,
          `Antigravity symbol lookup failed: ${msg}`,
        ),
      );
    }
  }

  public async discoverTests(
    _correlationId = 'test-discovery-antigravity',
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
        }

        const scripts = (pkg.scripts as Record<string, unknown> | undefined) || {};
        if (scripts['test']) {
          commands.push('npm test');
        }
      } catch {
        // Ignore
      }
    }

    // Scan candidate test files (bounded, zero command execution)
    const scanTests = (dir: string, depth: number): void => {
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
          if (lower === 'node_modules' || lower === '.git' || lower === 'dist' || lower === 'build') {
            continue;
          }
          if (checkPathExclusion(rel, MANDATORY_EXCLUSIONS).excluded) continue;
          scanTests(full, depth + 1);
        } else if (e.isFile()) {
          if (checkPathExclusion(rel, MANDATORY_EXCLUSIONS).excluded) continue;
          const lower = rel.toLowerCase();
          if (lower.includes('.test.') || lower.includes('.spec.') || lower.startsWith('tests/')) {
            testFiles.push(rel);
          }
        }
      }
    };

    scanTests(root, 0);

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
    _correlationId = 'editor-ctx-antigravity',
  ): Promise<Result<EditorSelectionContext | null, MediatorError>> {
    await Promise.resolve();
    if (!consent.allowEditorContext) {
      return err(
        makeMediatorError(
          ErrorCode.CAPABILITY_PERMISSION_DENIED,
          'Editor selection context collection is disabled: user has not explicitly opted in',
        ),
      );
    }

    if (!this.api?.editor || typeof this.api.editor.getActiveDocument !== 'function') {
      return ok(null);
    }

    const doc = this.api.editor.getActiveDocument();
    if (!doc) {
      return ok(null);
    }

    const rootRes = this.getWorkspaceRoot();
    if (!rootRes.ok) {
      return err(rootRes.error);
    }

    const containment = validateContainedPath(rootRes.value, doc.filePath, {
      operation: 'read',
      mustExist: true,
    });
    if (!containment.ok) {
      return err(
        makeMediatorError(
          ErrorCode.ACTION_DENIED,
          `Active editor file is outside canonical workspace: ${doc.filePath}`,
        ),
      );
    }

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

    if (consent.allowSelectedText && doc.selectedText) {
      const maxBytes = consent.maxSelectedTextBytes ?? DEFAULT_MAX_SELECTION_BYTES;
      const bounded =
        Buffer.byteLength(doc.selectedText, 'utf8') > maxBytes
          ? doc.selectedText.slice(0, maxBytes)
          : doc.selectedText;

      const scanRes = scanContent(bounded);
      if (scanRes.ok && shouldBlockContent(scanRes.value)) {
        const red = redactContent(bounded, scanRes.value);
        selectedText = red.redactedContent;
        wasRedacted = true;
      } else if (scanRes.ok) {
        selectedText = bounded;
      }
    }

    return ok({
      filePath: relPath,
      cursorPosition: doc.cursor,
      selectionRange: doc.selectionRange,
      selectedText,
      hasOptedIn: true,
      redacted: wasRedacted,
    });
  }

  public watchWorkspace(
    handler: (event: IdeFileChangeEvent) => void,
  ): { dispose(): void } {
    if (!this.api?.fileWatcher || typeof this.api.fileWatcher.watch !== 'function') {
      return { dispose: (): void => {} };
    }

    const sub = this.api.fileWatcher.watch('**/*', (e) => {
      handler({
        type: e.type,
        path: e.path.replace(/\\/g, '/'),
        timestamp: Date.now(),
      });
    });

    return {
      dispose(): void {
        sub.dispose();
      },
    };
  }
}
