/**
 * @mediator/ide-adapter-vscode — Adapter Types & API Facade (Sprint S15)
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

export interface VsCodePosition {
  readonly line: number;
  readonly character: number;
}

export interface VsCodeRange {
  readonly start: VsCodePosition;
  readonly end: VsCodePosition;
}

export interface VsCodeDiagnostic {
  readonly message: string;
  readonly severity: number; // 0 = Error, 1 = Warning, 2 = Info, 3 = Hint
  readonly range: VsCodeRange;
  readonly source?: string | undefined;
  readonly code?: string | number | undefined;
}

export interface VsCodeDocumentSymbol {
  readonly name: string;
  readonly kind: number | string;
  readonly range: VsCodeRange;
  readonly containerName?: string | undefined;
  readonly children?: readonly VsCodeDocumentSymbol[] | undefined;
}

export interface VsCodeTextDocument {
  readonly uri: { readonly fsPath: string };
  getText(range?: VsCodeRange): string;
}

export interface VsCodeTextEditor {
  readonly document: VsCodeTextDocument;
  readonly selection: {
    readonly start: VsCodePosition;
    readonly end: VsCodePosition;
    readonly active: VsCodePosition;
  };
}

export interface VsCodeGitRepository {
  readonly rootUri: { readonly fsPath: string };
  readonly state: {
    readonly HEAD?: {
      readonly name?: string | undefined;
      readonly ahead?: number | undefined;
      readonly behind?: number | undefined;
    } | undefined;
    readonly workingTreeChanges?: readonly { readonly uri: { readonly fsPath: string } }[] | undefined;
    readonly indexChanges?: readonly { readonly uri: { readonly fsPath: string } }[] | undefined;
    readonly untrackedChanges?: readonly { readonly uri: { readonly fsPath: string } }[] | undefined;
  };
}

export interface VsCodeGitApi {
  readonly repositories: readonly VsCodeGitRepository[];
}

export interface VsCodeFileSystemWatcher {
  onDidCreate(listener: (e: { readonly fsPath: string }) => void): { dispose(): void };
  onDidChange(listener: (e: { readonly fsPath: string }) => void): { dispose(): void };
  onDidDelete(listener: (e: { readonly fsPath: string }) => void): { dispose(): void };
  dispose(): void;
}

export interface VsCodeApiFacade {
  readonly env: {
    readonly appName: string;
    readonly appHost?: string | undefined;
  };
  readonly version: string;
  readonly workspace: {
    readonly workspaceFolders?: readonly { readonly uri: { readonly fsPath: string } }[] | undefined;
    createFileSystemWatcher?(glob: string): VsCodeFileSystemWatcher;
  };
  readonly languages: {
    getDiagnostics(uri?: { readonly fsPath: string }): readonly [ { readonly fsPath: string }, readonly VsCodeDiagnostic[] ][];
  };
  readonly window: {
    readonly activeTextEditor?: VsCodeTextEditor | undefined;
  };
  readonly commands?: {
    executeCommand?<T>(command: string, ...args: unknown[]): Promise<T>;
  } | undefined;
  readonly extensions?: {
    getExtension?<T>(extensionId: string): { readonly isActive: boolean; readonly exports: T } | undefined;
  } | undefined;
}

export interface IdeWorkspaceAdapter {
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
