/**
 * @mediator/ide-adapter-antigravity — Adapter Types (Sprint S15)
 */

import {
  type IdeCapabilityMatrix,
  type IdeProductInfo,
  type IdeGitStatus,
  type IdeDiagnosticsResult,
  type IdeSymbolsResult,
  type IdeTestDiscoveryResult,
  type EditorSelectionContext,
  type EditorConsentSettings,
  type IdeFileChangeEvent,
  type WorkspaceRootState,
  type Result,
  type MediatorError,
} from '@mediator/shared-contracts';

export interface AntigravityRuntimeConfig {
  readonly productVersion?: string | undefined;
  readonly isHeadless?: boolean | undefined;
  readonly languageServerAvailable?: boolean | undefined;
  readonly gitExtensionAvailable?: boolean | undefined;
}

export interface AntigravityApiFacade {
  readonly env?: {
    readonly appName?: string | undefined;
    readonly version?: string | undefined;
  } | undefined;
  readonly workspaceRootPath?: string | undefined;
  readonly languageServer?: {
    getDiagnostics?(uri: string): Array<{
      message: string;
      severity: 'error' | 'warning' | 'info' | 'hint';
      line: number;
      col: number;
    }>;
    getDocumentSymbols?(uri: string): Array<{
      name: string;
      kind: string;
      startLine: number;
      startCol: number;
      endLine: number;
      endCol: number;
      containerName?: string;
    }>;
  } | undefined;
  readonly editor?: {
    getActiveDocument?(): {
      readonly filePath: string;
      readonly selectedText?: string;
      readonly cursor: { line: number; character: number };
      readonly selectionRange?: { startLine: number; startCol: number; endLine: number; endCol: number };
    } | null;
  } | undefined;
  readonly git?: {
    getStatus?(): {
      branch?: string;
      modified: string[];
      staged: string[];
      untracked: string[];
    };
  } | undefined;
  readonly fileWatcher?: {
    watch(pattern: string, handler: (e: { type: 'create' | 'modify' | 'delete' | 'rename'; path: string }) => void): { dispose(): void };
  } | undefined;
}

export interface AntigravityWorkspaceAdapterInterface {
  getProductInfo(): IdeProductInfo;
  getCapabilities(correlationId?: string): IdeCapabilityMatrix;
  getWorkspaceRoot(): Result<WorkspaceRootState, MediatorError>;
  getGitStatus(correlationId?: string): Promise<Result<IdeGitStatus, MediatorError>>;
  getDiagnostics(correlationId?: string, maxItems?: number): Promise<Result<IdeDiagnosticsResult, MediatorError>>;
  getSymbols(relativePath: string, correlationId?: string, maxItems?: number): Promise<Result<IdeSymbolsResult, MediatorError>>;
  discoverTests(correlationId?: string): Promise<Result<IdeTestDiscoveryResult, MediatorError>>;
  getEditorContext(consent: EditorConsentSettings, correlationId?: string): Promise<Result<EditorSelectionContext | null, MediatorError>>;
  watchWorkspace(handler: (event: IdeFileChangeEvent) => void): { dispose(): void };
}
