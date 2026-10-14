/**
 * @mediator/recipe-registry — Canonical Recipe Hasher & Tamper Detection (S23)
 *
 * Requirements:
 * - Deterministic, versioned canonical serialization of recipe definitions.
 * - SHA-256 hash over all security-relevant fields:
 *   recipeId, recipeVersion, displayName, description, category, executable,
 *   defaultArgs, argumentSchema, workingDirectoryPolicy, scopePolicy,
 *   envAllowlist, timeoutMs, maxOutputBytes, requiredCapabilities,
 *   requiredApprovalLevel, supportedProjectTypes, dependencyRequirements,
 *   riskClassification, executionStatus, provenance.
 * - Strict rejection of tampering, field modifications, or unpinned definitions.
 */

import { createHash } from 'node:crypto';
import type { RecipeDefinition } from '@mediator/shared-contracts';

/**
 * Deterministically serialize any JavaScript value to canonical JSON string.
 * - Sorted keys recursively.
 * - Undefined values omitted.
 * - Compact (no extraneous whitespace).
 */
export function canonicalJsonStringify(val: unknown): string {
  if (val === null || val === undefined) {
    return 'null';
  }
  if (typeof val === 'boolean' || typeof val === 'number') {
    return JSON.stringify(val);
  }
  if (typeof val === 'string') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map((item) => canonicalJsonStringify(item)).join(',') + ']';
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = (val as Record<string, unknown>)[key];
      if (v !== undefined) {
        parts.push(JSON.stringify(key) + ':' + canonicalJsonStringify(v));
      }
    }
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(String(val));
}

/**
 * Security-relevant fields included in canonical recipe definition hash.
 */
export interface CanonicalRecipePayload {
  readonly recipeId: string;
  readonly recipeVersion: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly executable: string;
  readonly defaultArgs: readonly string[];
  readonly argumentSchema: {
    readonly maxArgs: number;
    readonly allowedFlags?: readonly string[];
    readonly allowsPathTarget?: boolean;
    readonly pathTargetPattern?: string;
  };
  readonly workingDirectoryPolicy: string;
  readonly scopePolicy: string;
  readonly envAllowlist: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly requiredCapabilities: readonly string[];
  readonly requiredApprovalLevel: string;
  readonly supportedProjectTypes: readonly string[];
  readonly dependencyRequirements: readonly string[];
  readonly riskClassification: string;
  readonly executionStatus: string;
  readonly provenance: string;
}

/**
 * Extract canonical security-relevant fields from a recipe definition.
 */
export function extractCanonicalRecipePayload(
  definition: Omit<RecipeDefinition, 'definitionHash'>,
): CanonicalRecipePayload {
  const argSchema = definition.argumentSchema ?? { maxArgs: 0 };
  const allowedFlags = argSchema.allowedFlags ? [...argSchema.allowedFlags].sort() : [];
  return {
    recipeId: definition.recipeId,
    recipeVersion: definition.recipeVersion ?? definition.version ?? '1.0.0',
    displayName: definition.displayName,
    description: definition.description,
    category: definition.category,
    executable: definition.executable,
    defaultArgs: definition.defaultArgs ? [...definition.defaultArgs] : definition.fixedArgs ? [...definition.fixedArgs] : [],
    argumentSchema: {
      maxArgs: argSchema.maxArgs,
      allowedFlags,
      allowsPathTarget: argSchema.allowsPathTarget ?? false,
      pathTargetPattern: argSchema.pathTargetPattern ?? '',
    },
    workingDirectoryPolicy: definition.workingDirectoryPolicy,
    scopePolicy: definition.scopePolicy ?? definition.permittedInputScope ?? 'stage-isolated',
    envAllowlist: [...definition.envAllowlist].sort(),
    timeoutMs: definition.timeoutMs,
    maxOutputBytes: definition.maxOutputBytes,
    requiredCapabilities: [...definition.requiredCapabilities].sort(),
    requiredApprovalLevel: definition.requiredApprovalLevel ?? definition.requiredPolicyLevel ?? 'manual-review',
    supportedProjectTypes: [...definition.supportedProjectTypes].sort(),
    dependencyRequirements: [...definition.dependencyRequirements].sort(),
    riskClassification: definition.riskClassification,
    executionStatus: definition.executionStatus,
    provenance: definition.provenance ?? definition.definitionProvenance ?? 'built-in-trusted',
  };
}

/**
 * Computes canonical SHA-256 hash of a recipe definition.
 */
export function computeRecipeDefinitionHash(
  definition: Omit<RecipeDefinition, 'definitionHash'>,
): string {
  const payload = extractCanonicalRecipePayload(definition);
  const canonicalJson = canonicalJsonStringify(payload);
  return createHash('sha256').update(Buffer.from(canonicalJson, 'utf8')).digest('hex');
}

/**
 * Verifies that a recipe definition's declared hash strictly matches its computed canonical hash.
 */
export function verifyRecipeDefinitionIntegrity(definition: RecipeDefinition): boolean {
  if (!definition.definitionHash || definition.definitionHash.length !== 64) {
    return false;
  }
  const expectedHash = computeRecipeDefinitionHash(definition);
  return definition.definitionHash === expectedHash;
}
