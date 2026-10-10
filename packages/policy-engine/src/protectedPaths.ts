/**
 * @mediator/policy-engine — Protected Paths Classification (S07)
 *
 * Centralized classifier for protected project files.
 *
 * Security invariant: Changes to protected paths (dependency manifests,
 * build scripts, workflows, git hooks, IDE execution settings, policy configs)
 * may be proposed and staged, but CANNOT be automatically applied to the
 * live workspace. They strictly require manual user review and approval.
 *
 * Path comparison is case-insensitive (Windows compat) and normalizes separators.
 */

import { globToRegex } from '@mediator/context-security';

export interface ProtectedPathRule {
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly patterns: readonly string[];
}

export const DEFAULT_PROTECTED_PATH_RULES: readonly ProtectedPathRule[] = [
  // ── Package manifests and dependency lockfiles ───────────────────────────
  {
    id: 'NODE_DEPENDENCIES',
    category: 'dependency_manifest',
    description: 'Node.js package manifests and lockfiles',
    patterns: [
      'package.json', '**/package.json',
      'package-lock.json', '**/package-lock.json',
      'pnpm-lock.yaml', '**/pnpm-lock.yaml',
      'yarn.lock', '**/yarn.lock',
      'npm-shrinkwrap.json', '**/npm-shrinkwrap.json',
    ],
  },
  {
    id: 'PYTHON_DEPENDENCIES',
    category: 'dependency_manifest',
    description: 'Python package manifests, configs and lockfiles',
    patterns: [
      'requirements*.txt', '**/requirements*.txt',
      'pyproject.toml', '**/pyproject.toml',
      'setup.py', '**/setup.py',
      'setup.cfg', '**/setup.cfg',
      'Pipfile', '**/Pipfile',
      'Pipfile.lock', '**/Pipfile.lock',
      'poetry.lock', '**/poetry.lock',
    ],
  },
  {
    id: 'COMPILED_DEPENDENCIES',
    category: 'dependency_manifest',
    description: 'Rust, Go, Java package manifests and lockfiles',
    patterns: [
      'Cargo.toml', '**/Cargo.toml',
      'Cargo.lock', '**/Cargo.lock',
      'go.mod', '**/go.mod',
      'go.sum', '**/go.sum',
      'pom.xml', '**/pom.xml',
      'build.gradle', '**/build.gradle',
      'build.gradle.kts', '**/build.gradle.kts',
    ],
  },

  // ── IDE tasks & execution-sensitive settings ─────────────────────────────
  {
    id: 'IDE_TASKS_CONFIG',
    category: 'ide_execution_config',
    description: 'IDE tasks, launch targets, and workspace settings',
    patterns: [
      '.vscode/tasks.json', '**/.vscode/tasks.json',
      '.vscode/launch.json', '**/.vscode/launch.json',
      '.vscode/settings.json', '**/.vscode/settings.json',
      '.idea/**', '**/.idea/**',
    ],
  },

  // ── CI/CD, hooks & container definitions ─────────────────────────────────
  {
    id: 'WORKFLOWS_AND_HOOKS',
    category: 'automation_hooks',
    description: 'Git hooks, CI/CD workflows, and container definitions',
    patterns: [
      '.git/hooks/**', '**/.git/hooks/**',
      '.husky/**', '**/.husky/**',
      '.github/workflows/**', '**/.github/workflows/**',
      '.gitlab-ci.yml', '**/.gitlab-ci.yml',
      '.devcontainer/**', '**/.devcontainer/**',
    ],
  },

  // ── Build files & shell scripts ──────────────────────────────────────────
  {
    id: 'EXECUTABLE_SCRIPTS',
    category: 'executable_scripts',
    description: 'Build automation files and shell scripts',
    patterns: [
      'Makefile', '**/Makefile',
      'justfile', '**/justfile',
      '*.sh', '**/*.sh',
      '*.bash', '**/*.bash',
      '*.ps1', '**/*.ps1',
      '*.bat', '**/*.bat',
      '*.cmd', '**/*.cmd',
    ],
  },
  {
    id: 'TEST_BUILD_HOOKS',
    category: 'build_hooks',
    description: 'Test runners and setup hooks',
    patterns: [
      'conftest.py', '**/conftest.py',
      'jest.config.*', '**/jest.config.*',
      'vitest.config.*', '**/vitest.config.*',
    ],
  },

  // ── Mediator policy and security configurations ──────────────────────────
  {
    id: 'MEDIATOR_SECURITY_CONFIG',
    category: 'mediator_security',
    description: 'Mediator security configurations and ignore files',
    patterns: [
      '.mediator/**', '**/.mediator/**',
      'mediator.config.*', '**/mediator.config.*',
      '.mediatorignore', '**/.mediatorignore',
    ],
  },
];

export interface ProtectedPathMatch {
  readonly isProtected: boolean;
  readonly matchedRuleId?: string | undefined;
  readonly category?: string | undefined;
  readonly matchedPattern?: string | undefined;
  readonly reason?: string | undefined;
}

/**
 * Normalizes a workspace-relative path for pattern matching:
 * - Replaces backslashes with slashes
 * - Strips any leading slash or relative prefix (./)
 */
export function normalizePathForProtection(filePath: string): string {
  let normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  normalized = normalized.replace(/^\/+/, '');
  return normalized;
}

/**
 * Test whether a workspace-relative path is protected.
 *
 * Pure function: compares normalized path against default and custom protected rules.
 * Case-insensitive for Windows compatibility.
 */
export function isProtectedPath(
  filePath: string,
  customPatterns: readonly string[] = [],
): ProtectedPathMatch {
  const normalized = normalizePathForProtection(filePath);

  // Check custom user-defined protected patterns first
  for (const customPattern of customPatterns) {
    const regex = globToRegex(customPattern);
    if (regex.test(normalized)) {
      return {
        isProtected: true,
        matchedRuleId: 'CUSTOM_PROTECTED_RULE',
        category: 'custom',
        matchedPattern: customPattern,
        reason: `Target path matches custom protected pattern '${customPattern}'`,
      };
    }
  }

  // Check default built-in rules
  for (const rule of DEFAULT_PROTECTED_PATH_RULES) {
    for (const pattern of rule.patterns) {
      const regex = globToRegex(pattern);
      if (regex.test(normalized)) {
        return {
          isProtected: true,
          matchedRuleId: rule.id,
          category: rule.category,
          matchedPattern: pattern,
          reason: `Target path is protected by rule '${rule.id}' (${rule.description}): matches '${pattern}'`,
        };
      }
    }
  }

  return { isProtected: false };
}
