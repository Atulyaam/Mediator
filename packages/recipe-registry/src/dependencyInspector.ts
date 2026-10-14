/**
 * @mediator/recipe-registry — Dependency Inspector & Manual-Test Readiness (S23)
 *
 * Requirements:
 * - Static, bounded metadata inspection of package manifests and lockfiles.
 * - Strict separation of dependency provisioning from test execution.
 * - ZERO execution of npm/yarn/pnpm commands, lifecycle hooks, or network queries.
 * - Identifies dependency risks:
 *   - Dangerous lifecycle scripts (preinstall, postinstall, curl, wget, eval, bash, etc.).
 *   - Missing node_modules or missing lockfiles.
 * - Generates synthetic .env.test WITHOUT copying secrets, API keys, or workspace .env.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  type DependencyInspectionReport,
  type DependencyReadinessState,
} from '@mediator/shared-contracts';
import { scanContent } from '@mediator/context-security';

const SUSPICIOUS_SCRIPT_PATTERNS = [
  /curl\s/i,
  /wget\s/i,
  /base64\s/i,
  /powershell\s/i,
  /cmd\.exe/i,
  /\beval\(/i,
  /sh\s+-c/i,
  /bash\s+-c/i,
  /python\s+-c/i,
  /node\s+-e/i,
  /http[s]?:\/\//i,
];

const RISKY_LIFECYCLE_HOOKS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
]);

export interface DependencyInspectorOptions {
  readonly maxFileSizeBytes?: number | undefined;
}

export class DependencyInspector {
  private readonly maxFileSizeBytes: number;

  public constructor(options?: DependencyInspectorOptions) {
    this.maxFileSizeBytes = options?.maxFileSizeBytes ?? 1024 * 1024; // 1MB cap
  }

  /**
   * Safely inspect dependencies in the target workspace.
   * Never executes any scripts or package manager tools.
   */
  public async inspect(workspaceRoot: string): Promise<DependencyInspectionReport> {
    await Promise.resolve();
    const inspectedAt = Date.now();
    const manifestPath = path.join(workspaceRoot, 'package.json');
    const lockfilePath = path.join(workspaceRoot, 'package-lock.json');
    const nodeModulesPath = path.join(workspaceRoot, 'node_modules');

    const manifestExists = fs.existsSync(manifestPath);
    const lockfileExists = fs.existsSync(lockfilePath);
    const nodeModulesExists = fs.existsSync(nodeModulesPath);

    if (!manifestExists) {
      const pythonReqPath = path.join(workspaceRoot, 'requirements.txt');
      const pyprojectPath = path.join(workspaceRoot, 'pyproject.toml');
      if (fs.existsSync(pythonReqPath) || fs.existsSync(pyprojectPath)) {
        const hasReq = fs.existsSync(pythonReqPath);
        const vendorPath = path.join(workspaceRoot, 'vendor');
        const wheelsPath = path.join(workspaceRoot, 'wheels');
        const hasVendor = fs.existsSync(vendorPath) || fs.existsSync(wheelsPath);
        return {
          state: 'ready-for-manual-check',
          manifestObserved: hasReq,
          lockfileObserved: hasVendor,
          installedDependenciesCount: hasVendor ? 1 : 0,
          riskSignals: [],
          canRunManualRecipe: true,
          manualHandoffMessage: 'Python project detected with offline capabilities.',
          inspectedAt,
        };
      }

      return {
        state: 'blocked',
        manifestObserved: false,
        lockfileObserved: false,
        installedDependenciesCount: 0,
        riskSignals: ['Missing package.json manifest in workspace.'],
        missingDependencies: ['package.json'],
        canRunManualRecipe: false,
        manualHandoffMessage: 'Cannot prepare manual test suggestions: workspace lacks a package.json manifest.',
        inspectedAt,
      };
    }

    // Bounded read of package.json
    let manifestContent = '';
    try {
      const stats = fs.statSync(manifestPath);
      if (stats.size > this.maxFileSizeBytes) {
        return {
          state: 'blocked',
          manifestObserved: true,
          lockfileObserved: lockfileExists,
          installedDependenciesCount: 0,
          riskSignals: [`package.json exceeds maximum size limit (${stats.size} > ${this.maxFileSizeBytes} bytes).`],
          canRunManualRecipe: false,
          manualHandoffMessage: 'package.json manifest is too large for safe bounded inspection.',
          inspectedAt,
        };
      }
      manifestContent = fs.readFileSync(manifestPath, 'utf8');
    } catch (readErr) {
      return {
        state: 'blocked',
        manifestObserved: false,
        lockfileObserved: lockfileExists,
        installedDependenciesCount: 0,
        riskSignals: [`Failed to read package.json: ${String(readErr)}`],
        canRunManualRecipe: false,
        manualHandoffMessage: 'Unable to access package.json manifest.',
        inspectedAt,
      };
    }

    // Parse JSON
    let pkgJson: Record<string, unknown> = {};
    try {
      pkgJson = JSON.parse(manifestContent) as Record<string, unknown>;
    } catch (parseErr) {
      return {
        state: 'blocked',
        manifestObserved: true,
        lockfileObserved: lockfileExists,
        installedDependenciesCount: 0,
        riskSignals: [`Malformed package.json syntax: ${String(parseErr)}`],
        canRunManualRecipe: false,
        manualHandoffMessage: 'package.json contains invalid JSON syntax.',
        inspectedAt,
      };
    }

    const dependencies = (pkgJson.dependencies as Record<string, string>) || {};
    const devDependencies = (pkgJson.devDependencies as Record<string, string>) || {};
    const scripts = (pkgJson.scripts as Record<string, string>) || {};

    const declaredDepCount = Object.keys(dependencies).length + Object.keys(devDependencies).length;
    const riskSignals: string[] = [];

    // Analyze scripts for dangerous lifecycle hooks and shell commands
    for (const [scriptName, scriptBody] of Object.entries(scripts)) {
      if (typeof scriptBody === 'string') {
        if (RISKY_LIFECYCLE_HOOKS.has(scriptName)) {
          riskSignals.push(`Risky lifecycle script detected: "${scriptName}": "${scriptBody}"`);
        }
        for (const pattern of SUSPICIOUS_SCRIPT_PATTERNS) {
          if (pattern.test(scriptBody)) {
            riskSignals.push(`Suspicious pattern in script "${scriptName}": "${scriptBody}"`);
            break;
          }
        }
      }
    }

    // Check lockfile presence
    if (!lockfileExists) {
      riskSignals.push('No package-lock.json observed. Supply-chain provenance is unpinned.');
    }

    // Check node_modules presence
    let installedDependenciesCount = 0;
    if (nodeModulesExists) {
      try {
        const entries = fs.readdirSync(nodeModulesPath);
        installedDependenciesCount = entries.filter((e) => !e.startsWith('.')).length;
      } catch {
        installedDependenciesCount = 0;
      }
    }

    // Determine state
    let state: DependencyReadinessState = 'manifest-observed';
    let canRunManualRecipe = false;
    let manualHandoffMessage = '';

    if (declaredDepCount > 0 && (!nodeModulesExists || installedDependenciesCount === 0)) {
      state = 'dependencies-unavailable';
      canRunManualRecipe = false;
      manualHandoffMessage =
        'Dependencies are not installed in node_modules. Run "npm install" manually in your terminal before running test recipes.';
    } else if (riskSignals.some((r) => r.startsWith('Risky lifecycle') || r.startsWith('Suspicious pattern'))) {
      state = 'dependency-risk-review-required';
      canRunManualRecipe = true;
      manualHandoffMessage =
        'Potential script execution risks detected in package.json. Review manifests before running manual tests.';
    } else {
      state = 'ready-for-manual-check';
      canRunManualRecipe = true;
      manualHandoffMessage =
        'Dependencies appear ready for manual check. You can execute suggested recipes in your local terminal.';
    }

    return {
      state,
      manifestObserved: true,
      lockfileObserved: lockfileExists,
      installedDependenciesCount,
      riskSignals,
      missingDependencies: state === 'dependencies-unavailable' ? ['node_modules'] : undefined,
      canRunManualRecipe,
      manualHandoffMessage,
      inspectedAt,
    };
  }

  /**
   * Generates a synthetic, isolated .env.test template.
   * Guarantees that NO existing workspace .env, secrets, or keys are copied.
   */
  public generateSyntheticEnvTest(_workspaceRoot: string): {
    readonly filename: string;
    readonly content: string;
    readonly isSafe: boolean;
  } {
    // Isolated synthetic defaults
    const lines = [
      '# Mediator Synthetic Test Environment',
      '# This file is generated strictly with isolated synthetic constants.',
      '# NO workspace secrets, API keys, or production values are copied.',
      'NODE_ENV=test',
      'CI=true',
      'MEDIATOR_TEST_MODE=isolated',
      'PORT=0',
      'LOG_LEVEL=silent',
    ];

    const content = lines.join('\n') + '\n';

    // Verify through secret scanner that no secrets exist
    const scan = scanContent(content);
    const isSafe = scan.ok && scan.value.findings.length === 0;

    return {
      filename: '.env.test',
      content,
      isSafe,
    };
  }
}
