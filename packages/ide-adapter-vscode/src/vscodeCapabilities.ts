/**
 * @mediator/ide-adapter-vscode — Truthful Capability Probing (Sprint S15)
 */

import {
  type IdeCapabilityId,
  type IdeCapabilityReportItem,
  type IdeCapabilityMatrix,
  type IdeProductInfo,
} from '@mediator/shared-contracts';
import { type VsCodeApiFacade } from './vscodeAdapterTypes.js';

export function detectVsCodeProduct(api: VsCodeApiFacade): IdeProductInfo {
  const appName = api.env.appName || 'Visual Studio Code';
  const isVSCode = appName.toLowerCase().includes('visual studio code') || appName.toLowerCase().includes('code');
  const isAntigravity = appName.toLowerCase().includes('antigravity');

  return {
    productName: appName,
    version: api.version,
    ideFamily: isVSCode ? 'vscode' : isAntigravity ? 'antigravity' : 'unknown',
    environment: api.env.appHost === 'web' ? 'web' : 'desktop',
    isVSCode,
    isAntigravity,
  };
}

export function probeVsCodeCapabilities(
  api: VsCodeApiFacade,
  correlationId = 'probe-vscode',
): IdeCapabilityMatrix {
  const product = detectVsCodeProduct(api);
  const now = Date.now();

  const gitExt = api.extensions?.getExtension?.<{ getAPI?(version: number): unknown }>('vscode.git');
  const gitActive = !!gitExt && gitExt.isActive;

  const hasWatcher = typeof api.workspace?.createFileSystemWatcher === 'function';
  const hasCommands = typeof api.commands?.executeCommand === 'function';

  const capabilities: Record<IdeCapabilityId, IdeCapabilityReportItem> = {
    canonical_workspace: {
      capabilityId: 'canonical_workspace',
      status: api.workspace.workspaceFolders && api.workspace.workspaceFolders.length > 0 ? 'supported' : 'unavailable',
      dataSource: 'vscode.workspace.workspaceFolders',
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      reason: api.workspace.workspaceFolders?.length ? undefined : 'No workspace folders open in VS Code',
      correlationId,
    },
    file_enumeration: {
      capabilityId: 'file_enumeration',
      status: 'supported',
      dataSource: 'vscode.workspace.fs / local bounded scanner',
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      correlationId,
    },
    git_status: {
      capabilityId: 'git_status',
      status: gitActive ? 'supported' : 'unavailable',
      dataSource: gitActive ? 'vscode.git extension API' : undefined,
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      reason: gitActive ? undefined : 'vscode.git extension is not active or available',
      correlationId,
    },
    diagnostics: {
      capabilityId: 'diagnostics',
      status: typeof api.languages?.getDiagnostics === 'function' ? 'supported' : 'unavailable',
      dataSource: 'vscode.languages.getDiagnostics',
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      reason: typeof api.languages?.getDiagnostics === 'function' ? undefined : 'vscode.languages.getDiagnostics unavailable',
      correlationId,
    },
    language_symbols: {
      capabilityId: 'language_symbols',
      status: hasCommands ? 'supported' : 'unavailable',
      dataSource: hasCommands ? 'vscode.executeDocumentSymbolProvider' : undefined,
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      reason: hasCommands ? undefined : 'VS Code command execution API unavailable',
      correlationId,
    },
    test_discovery: {
      capabilityId: 'test_discovery',
      status: 'supported',
      dataSource: 'project metadata & config inspection (zero command execution)',
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      correlationId,
    },
    editor_context: {
      capabilityId: 'editor_context',
      status: 'supported',
      dataSource: 'vscode.window.activeTextEditor (strictly opt-in with secret scanning)',
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      correlationId,
    },
    file_change_events: {
      capabilityId: 'file_change_events',
      status: hasWatcher ? 'supported' : 'unavailable',
      dataSource: hasWatcher ? 'vscode.workspace.createFileSystemWatcher' : undefined,
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      reason: hasWatcher ? undefined : 'FileSystemWatcher API unavailable',
      correlationId,
    },
    ide_product_info: {
      capabilityId: 'ide_product_info',
      status: 'supported',
      dataSource: 'vscode.env / vscode.version',
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      correlationId,
    },
  };

  return {
    productName: product.productName,
    productVersion: product.version,
    ideFamily: product.ideFamily,
    verifiedAt: now,
    correlationId,
    capabilities,
  };
}
