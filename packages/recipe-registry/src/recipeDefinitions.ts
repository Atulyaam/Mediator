/**
 * @mediator/recipe-registry — Fixed Canonical Recipe Definitions (S23)
 *
 * Requirements:
 * - Fixed, approved recipe set:
 *   1. project.test
 *   2. project.lint
 *   3. project.typecheck
 *   4. project.build
 *   5. project.single_test
 *   6. git.status
 *   7. git.diff
 * - All definitions are deterministically hashed and immutable.
 * - Under NO-GO-AUTOEXEC, executionStatus is strictly 'manual-only'.
 * - No arbitrary shell commands or runners permitted.
 */

import type { RecipeDefinition, RecipeId } from '@mediator/shared-contracts';
import { computeRecipeDefinitionHash } from './canonicalHasher.js';

type RawRecipeDefinition = Omit<RecipeDefinition, 'definitionHash'>;

const RAW_FIXED_RECIPES: Record<RecipeId, RawRecipeDefinition> = {
  'project.test': {
    recipeId: 'project.test',
    version: '1.0.0',
    recipeVersion: '1.0.0',
    displayName: 'Run Project Tests',
    description: 'Execute the project test suite using npm test against the isolated stage or workspace.',
    category: 'test',
    executable: 'npm',
    defaultArgs: ['test'],
    fixedArgs: ['test'],
    argumentSchema: {
      maxArgs: 0,
      allowedFlags: [],
      allowsPathTarget: false,
    },
    workingDirectoryPolicy: 'stage-root',
    scopePolicy: 'stage-isolated',
    envAllowlist: ['NODE_ENV', 'CI'],
    timeoutMs: 60000,
    maxOutputBytes: 1048576,
    requiredCapabilities: ['host-child-process-confinement', 'host-network-default-deny'],
    requiredApprovalLevel: 'manual-review',
    supportedProjectTypes: ['node', 'npm'],
    dependencyRequirements: ['package.json'],
    riskClassification: 'low',
    executionStatus: 'manual-only',
    provenance: 'built-in-trusted',
  },

  'project.lint': {
    recipeId: 'project.lint',
    version: '1.0.0',
    recipeVersion: '1.0.0',
    displayName: 'Lint Project Source',
    description: 'Execute ESLint checks across project files using npm run lint.',
    category: 'lint',
    executable: 'npm',
    defaultArgs: ['run', 'lint'],
    fixedArgs: ['run', 'lint'],
    argumentSchema: {
      maxArgs: 0,
      allowedFlags: [],
      allowsPathTarget: false,
    },
    workingDirectoryPolicy: 'stage-root',
    scopePolicy: 'stage-isolated',
    envAllowlist: ['NODE_ENV', 'CI'],
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
    requiredCapabilities: ['host-child-process-confinement'],
    requiredApprovalLevel: 'manual-review',
    supportedProjectTypes: ['node', 'npm'],
    dependencyRequirements: ['package.json'],
    riskClassification: 'low',
    executionStatus: 'manual-only',
    provenance: 'built-in-trusted',
  },

  'project.typecheck': {
    recipeId: 'project.typecheck',
    version: '1.0.0',
    recipeVersion: '1.0.0',
    displayName: 'TypeScript Typecheck',
    description: 'Perform static type analysis with TypeScript compiler using npm run typecheck.',
    category: 'typecheck',
    executable: 'npm',
    defaultArgs: ['run', 'typecheck'],
    fixedArgs: ['run', 'typecheck'],
    argumentSchema: {
      maxArgs: 0,
      allowedFlags: [],
      allowsPathTarget: false,
    },
    workingDirectoryPolicy: 'stage-root',
    scopePolicy: 'stage-isolated',
    envAllowlist: ['NODE_ENV', 'CI'],
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
    requiredCapabilities: ['host-child-process-confinement'],
    requiredApprovalLevel: 'manual-review',
    supportedProjectTypes: ['node', 'typescript'],
    dependencyRequirements: ['package.json', 'tsconfig.json'],
    riskClassification: 'low',
    executionStatus: 'manual-only',
    provenance: 'built-in-trusted',
  },

  'project.build': {
    recipeId: 'project.build',
    version: '1.0.0',
    recipeVersion: '1.0.0',
    displayName: 'Build Project',
    description: 'Compile project artifacts using npm run build.',
    category: 'build',
    executable: 'npm',
    defaultArgs: ['run', 'build'],
    fixedArgs: ['run', 'build'],
    argumentSchema: {
      maxArgs: 0,
      allowedFlags: [],
      allowsPathTarget: false,
    },
    workingDirectoryPolicy: 'stage-root',
    scopePolicy: 'stage-isolated',
    envAllowlist: ['NODE_ENV', 'CI'],
    timeoutMs: 60000,
    maxOutputBytes: 2097152,
    requiredCapabilities: ['host-child-process-confinement'],
    requiredApprovalLevel: 'manual-review',
    supportedProjectTypes: ['node', 'npm'],
    dependencyRequirements: ['package.json'],
    riskClassification: 'low',
    executionStatus: 'manual-only',
    provenance: 'built-in-trusted',
  },

  'project.single_test': {
    recipeId: 'project.single_test',
    version: '1.0.0',
    recipeVersion: '1.0.0',
    displayName: 'Run Single Test File',
    description: 'Execute a single test file using npm test -- <relative-test-path>. Traversal and arbitrary flags rejected.',
    category: 'test',
    executable: 'npm',
    defaultArgs: ['test', '--'],
    fixedArgs: ['test', '--'],
    argumentSchema: {
      maxArgs: 1,
      allowedFlags: [],
      allowsPathTarget: true,
      pathTargetPattern: '^(?!.*(?:\\.\\.|[;&|`$><\\\\:])).+\\.(?:test|spec)\\.(?:ts|js|mjs|cjs|jsx|tsx)$',
    },
    workingDirectoryPolicy: 'stage-root',
    scopePolicy: 'stage-isolated',
    envAllowlist: ['NODE_ENV', 'CI'],
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
    requiredCapabilities: ['host-child-process-confinement', 'host-network-default-deny'],
    requiredApprovalLevel: 'manual-review',
    supportedProjectTypes: ['node', 'npm'],
    dependencyRequirements: ['package.json'],
    riskClassification: 'low',
    executionStatus: 'manual-only',
    provenance: 'built-in-trusted',
  },

  'git.status': {
    recipeId: 'git.status',
    version: '1.0.0',
    recipeVersion: '1.0.0',
    displayName: 'Git Status (Short)',
    description: 'Inspect working copy modifications safely using git status --short.',
    category: 'vcs',
    executable: 'git',
    defaultArgs: ['status', '--short'],
    fixedArgs: ['status', '--short'],
    argumentSchema: {
      maxArgs: 0,
      allowedFlags: [],
      allowsPathTarget: false,
    },
    workingDirectoryPolicy: 'workspace-root',
    scopePolicy: 'workspace-readonly',
    envAllowlist: [],
    timeoutMs: 10000,
    maxOutputBytes: 524288,
    requiredCapabilities: [],
    requiredApprovalLevel: 'manual-review',
    supportedProjectTypes: ['any'],
    dependencyRequirements: ['.git'],
    riskClassification: 'low',
    executionStatus: 'manual-only',
    provenance: 'built-in-trusted',
  },

  'git.diff': {
    recipeId: 'git.diff',
    version: '1.0.0',
    recipeVersion: '1.0.0',
    displayName: 'Git Diff',
    description: 'Inspect unstaged diffs safely using git diff.',
    category: 'vcs',
    executable: 'git',
    defaultArgs: ['diff'],
    fixedArgs: ['diff'],
    argumentSchema: {
      maxArgs: 0,
      allowedFlags: [],
      allowsPathTarget: false,
    },
    workingDirectoryPolicy: 'workspace-root',
    scopePolicy: 'workspace-readonly',
    envAllowlist: [],
    timeoutMs: 10000,
    maxOutputBytes: 1048576,
    requiredCapabilities: [],
    requiredApprovalLevel: 'manual-review',
    supportedProjectTypes: ['any'],
    dependencyRequirements: ['.git'],
    riskClassification: 'low',
    executionStatus: 'manual-only',
    provenance: 'built-in-trusted',
  },

  'python.test': {
    recipeId: 'python.test',
    version: '1.0.0',
    recipeVersion: '1.0.0',
    displayName: 'Run Python Test Suite',
    description: 'Execute Python unittest discovery against the isolated stage or workspace.',
    category: 'test',
    executable: 'python3',
    defaultArgs: ['-m', 'unittest', 'discover'],
    fixedArgs: ['-m', 'unittest', 'discover'],
    argumentSchema: {
      maxArgs: 0,
      allowedFlags: [],
      allowsPathTarget: false,
    },
    workingDirectoryPolicy: 'stage-root',
    scopePolicy: 'stage-isolated',
    envAllowlist: ['PYTHONUNBUFFERED', 'CI'],
    timeoutMs: 60000,
    maxOutputBytes: 1048576,
    requiredCapabilities: ['host-child-process-confinement', 'host-network-default-deny'],
    requiredApprovalLevel: 'manual-review',
    supportedProjectTypes: ['python'],
    dependencyRequirements: [],
    riskClassification: 'low',
    executionStatus: 'manual-only',
    provenance: 'built-in-trusted',
  },

  'python.single_test': {
    recipeId: 'python.single_test',
    version: '1.0.0',
    recipeVersion: '1.0.0',
    displayName: 'Run Single Python Test File',
    description: 'Execute a single Python test module safely.',
    category: 'test',
    executable: 'python3',
    defaultArgs: ['-m', 'unittest'],
    fixedArgs: ['-m', 'unittest'],
    argumentSchema: {
      maxArgs: 1,
      allowedFlags: [],
      allowsPathTarget: true,
      pathTargetPattern: '^(?!.*(?:\\.\\.|[;&|`$><\\\\:])).+\\.py$',
    },
    workingDirectoryPolicy: 'stage-root',
    scopePolicy: 'stage-isolated',
    envAllowlist: ['PYTHONUNBUFFERED', 'CI'],
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
    requiredCapabilities: ['host-child-process-confinement', 'host-network-default-deny'],
    requiredApprovalLevel: 'manual-review',
    supportedProjectTypes: ['python'],
    dependencyRequirements: [],
    riskClassification: 'low',
    executionStatus: 'manual-only',
    provenance: 'built-in-trusted',
  },
};

/**
 * Creates a fully hash-pinned recipe definition with deterministic SHA-256 hash.
 */
export function buildFixedRecipeDefinition(recipeId: RecipeId): RecipeDefinition {
  const raw = RAW_FIXED_RECIPES[recipeId];
  if (!raw) {
    throw new Error(`Unknown recipe ID: ${recipeId}`);
  }
  const definitionHash = computeRecipeDefinitionHash(raw);
  return {
    ...raw,
    definitionHash,
  };
}

/**
 * Returns all canonical fixed recipe definitions.
 */
export function getAllFixedRecipeDefinitions(): readonly RecipeDefinition[] {
  return (Object.keys(RAW_FIXED_RECIPES) as RecipeId[]).map(buildFixedRecipeDefinition);
}
