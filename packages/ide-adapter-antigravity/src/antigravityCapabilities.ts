/**
 * @mediator/ide-adapter-antigravity — Truthful Capability Probing (Sprint S15)
 */

import {
  type IdeCapabilityId,
  type IdeCapabilityReportItem,
  type IdeCapabilityMatrix,
  type IdeProductInfo,
} from '@mediator/shared-contracts';
import { type AntigravityApiFacade } from './antigravityAdapterTypes.js';

export function detectAntigravityProduct(api?: AntigravityApiFacade): IdeProductInfo {
  const envName = api?.env?.appName || process.env.ANTIGRAVITY_APP_NAME || 'Antigravity';
  const version = api?.env?.version || process.env.ANTIGRAVITY_VERSION || '2.0.0';

  return {
    productName: envName,
    version,
    ideFamily: 'antigravity',
    environment: 'desktop',
    isVSCode: false,
    isAntigravity: true,
  };
}

export function probeAntigravityCapabilities(
  api?: AntigravityApiFacade,
  correlationId = 'probe-antigravity',
): IdeCapabilityMatrix {
  const product = detectAntigravityProduct(api);
  const now = Date.now();

  const hasGit = typeof api?.git?.getStatus === 'function';
  const hasDiag = typeof api?.languageServer?.getDiagnostics === 'function';
  const hasSymbols = typeof api?.languageServer?.getDocumentSymbols === 'function';
  const hasWatcher = typeof api?.fileWatcher?.watch === 'function';
  const hasRoot = !!api?.workspaceRootPath;

  const capabilities: Record<IdeCapabilityId, IdeCapabilityReportItem> = {
    canonical_workspace: {
      capabilityId: 'canonical_workspace',
      status: hasRoot ? 'supported' : 'unavailable',
      dataSource: 'Antigravity canonical workspace root configuration',
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      reason: hasRoot ? undefined : 'No workspace root configured in Antigravity adapter',
      correlationId,
    },
    file_enumeration: {
      capabilityId: 'file_enumeration',
      status: 'supported',
      dataSource: 'local bounded project scanner',
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      correlationId,
    },
    git_status: {
      capabilityId: 'git_status',
      status: hasGit ? 'supported' : 'unavailable',
      dataSource: hasGit ? 'Antigravity Git API' : undefined,
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      reason: hasGit ? undefined : 'Antigravity Git integration is unavailable or unverified in this environment',
      correlationId,
    },
    diagnostics: {
      capabilityId: 'diagnostics',
      status: hasDiag ? 'supported' : 'not_yet_verified',
      dataSource: hasDiag ? 'Antigravity Language Server API' : undefined,
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      reason: hasDiag ? undefined : 'Antigravity Language Server diagnostics not verified in this runtime',
      correlationId,
    },
    language_symbols: {
      capabilityId: 'language_symbols',
      status: hasSymbols ? 'supported' : 'not_yet_verified',
      dataSource: hasSymbols ? 'Antigravity Document Symbol Provider' : undefined,
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      reason: hasSymbols ? undefined : 'Antigravity document symbol provider not verified in this runtime',
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
      dataSource: 'Antigravity active editor (strictly opt-in with secret scanning)',
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      correlationId,
    },
    file_change_events: {
      capabilityId: 'file_change_events',
      status: hasWatcher ? 'supported' : 'unavailable',
      dataSource: hasWatcher ? 'Antigravity File Watcher API' : undefined,
      productName: product.productName,
      productVersion: product.version,
      timestamp: now,
      reason: hasWatcher ? undefined : 'Antigravity file watcher unavailable in current environment',
      correlationId,
    },
    ide_product_info: {
      capabilityId: 'ide_product_info',
      status: 'supported',
      dataSource: 'Antigravity environment inspection',
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
