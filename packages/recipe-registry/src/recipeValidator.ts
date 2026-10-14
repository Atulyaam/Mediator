/**
 * @mediator/recipe-registry — Strict Recipe Request Validator (S23)
 *
 * Requirements:
 * - Strict schema, argument, path, and environment validation.
 * - Enforces S05 path containment and S06 exclusion/secret checks.
 * - Rejects:
 *   1. Unknown recipe IDs (RECIPE_UNKNOWN).
 *   2. Tampered or mismatched definition hashes (RECIPE_TAMPERED).
 *   3. Shell injection characters: &, ;, |, `, $, >, <, newlines, parens, quotes.
 *   4. Path traversal (..) or paths outside workspace/stage root (RECIPE_PATH_OUTSIDE_ROOT).
 *   5. Windows drive/UNC/alternate data stream escapes.
 *   6. Secret/excluded paths (PATH_EXCLUDED_BY_RULE).
 *   7. Unauthorized environment variables (PATH, LD_PRELOAD, NODE_OPTIONS, etc.) (RECIPE_ENVIRONMENT_DISALLOWED).
 *   8. Secrets in environment values (SECRET_DETECTED_IN_OUTPUT).
 *   9. User/AI attempts to raise timeout/output caps above pinned limits.
 *   10. Requests attempting to enable network, change mounts or supply sandbox flags.
 * - Under NO-GO-AUTOEXEC, marks canExecuteAutomatically = false and provides safe manual instruction.
 */

import * as path from 'node:path';
import {
  ErrorCode,
  type RecipeDefinition,
  type RecipeExecutionRequest,
  type RecipeValidationResult,
  type S00ExecutionDecision,
  S00ExecutionDecisionValues,
} from '@mediator/shared-contracts';
import { isPathInsideRoot } from '@mediator/workspace-boundary';
import { isPathExcluded, scanContent } from '@mediator/context-security';
import { verifyRecipeDefinitionIntegrity } from './canonicalHasher.js';

export interface RecipeValidatorOptions {
  readonly workspaceRoot: string;
  readonly activeTaskId: string;
  readonly activeSessionId: string;
  readonly s00Decision?: S00ExecutionDecision | undefined;
}

const FORBIDDEN_SHELL_CHARS_REGEX = /[;&|`$><\r\n(){}"'*\\]/;
const FORBIDDEN_ENV_KEYS = new Set([
  'PATH',
  'SHELL',
  'COMSPEC',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PYTHONPATH',
  'PERLLIB',
  'RUBYLIB',
  'IFS',
  'BASH_ENV',
]);

export class RecipeValidator {
  private readonly recipes: Map<string, RecipeDefinition>;

  public constructor(recipes: readonly RecipeDefinition[]) {
    this.recipes = new Map(recipes.map((r) => [r.recipeId, r]));
  }

  public validateRequest(
    request: RecipeExecutionRequest,
    options: RecipeValidatorOptions,
  ): RecipeValidationResult {
    const s00Decision = options.s00Decision ?? S00ExecutionDecisionValues.NO_GO_AUTOEXEC;

    // 1. Known recipe check
    const recipe = this.recipes.get(request.recipeId);
    if (!recipe) {
      return {
        valid: false,
        recipeId: request.recipeId,
        definitionHash: request.definitionHash ?? '',
        errors: [`Unknown recipe ID: "${request.recipeId}"`],
        errorCode: ErrorCode.RECIPE_UNKNOWN,
        canExecuteAutomatically: false,
        executionBlockedReason: `Recipe "${request.recipeId}" is not registered in the fixed registry.`,
      };
    }

    // 2. Definition integrity check
    if (!verifyRecipeDefinitionIntegrity(recipe)) {
      return {
        valid: false,
        recipeId: recipe.recipeId,
        definitionHash: recipe.definitionHash,
        errors: [`Recipe definition integrity verification failed for "${recipe.recipeId}". Pinned hash mismatch.`],
        errorCode: ErrorCode.RECIPE_TAMPERED,
        canExecuteAutomatically: false,
        executionBlockedReason: 'Recipe definition has been tampered with or corrupted.',
      };
    }

    // If caller provided a definitionHash, it must match
    if (request.definitionHash && request.definitionHash !== recipe.definitionHash) {
      return {
        valid: false,
        recipeId: recipe.recipeId,
        definitionHash: request.definitionHash,
        errors: [
          `Supplied definition hash "${request.definitionHash}" does not match pinned hash "${recipe.definitionHash}".`,
        ],
        errorCode: ErrorCode.RECIPE_TAMPERED,
        canExecuteAutomatically: false,
        executionBlockedReason: 'Supplied recipe definition hash does not match pinned registry hash.',
      };
    }

    // 3. Task / Session context check
    if (request.taskId !== options.activeTaskId) {
      return {
        valid: false,
        recipeId: recipe.recipeId,
        definitionHash: recipe.definitionHash,
        errors: [`Request taskId "${request.taskId}" does not match active taskId "${options.activeTaskId}".`],
        errorCode: ErrorCode.TASK_SCOPE_MISMATCH,
        canExecuteAutomatically: false,
        executionBlockedReason: 'Task scope mismatch.',
      };
    }

    if (request.sessionId !== options.activeSessionId) {
      return {
        valid: false,
        recipeId: recipe.recipeId,
        definitionHash: recipe.definitionHash,
        errors: [`Request sessionId "${request.sessionId}" does not match active sessionId "${options.activeSessionId}".`],
        errorCode: ErrorCode.SESSION_INVALID,
        canExecuteAutomatically: false,
        executionBlockedReason: 'Session scope mismatch.',
      };
    }

    // 4. Working directory containment check
    const workingDir = request.workingDirectory ?? options.workspaceRoot;
    if (!isPathInsideRoot(options.workspaceRoot, workingDir)) {
      return {
        valid: false,
        recipeId: recipe.recipeId,
        definitionHash: recipe.definitionHash,
        errors: [`Working directory "${workingDir}" is outside workspace root "${options.workspaceRoot}".`],
        errorCode: ErrorCode.RECIPE_PATH_OUTSIDE_ROOT,
        canExecuteAutomatically: false,
        executionBlockedReason: 'Working directory path escapes workspace root.',
      };
    }

    // 5. Arguments validation
    const argSchema = recipe.argumentSchema ?? { maxArgs: 0, allowedFlags: [], allowsPathTarget: false };
    const args = request.args ?? [];
    if (args.length > argSchema.maxArgs) {
      return {
        valid: false,
        recipeId: recipe.recipeId,
        definitionHash: recipe.definitionHash,
        errors: [
          `Recipe "${recipe.recipeId}" accepts at most ${argSchema.maxArgs} arguments, but received ${args.length}.`,
        ],
        errorCode: ErrorCode.RECIPE_ARGUMENTS_INVALID,
        canExecuteAutomatically: false,
        executionBlockedReason: 'Too many arguments supplied.',
      };
    }

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg.length > 256) {
        return {
          valid: false,
          recipeId: recipe.recipeId,
          definitionHash: recipe.definitionHash,
          errors: [`Argument at index ${i} exceeds maximum length of 256 characters.`],
          errorCode: ErrorCode.RECIPE_ARGUMENTS_INVALID,
          canExecuteAutomatically: false,
          executionBlockedReason: 'Argument length limit exceeded.',
        };
      }

      if (FORBIDDEN_SHELL_CHARS_REGEX.test(arg)) {
        return {
          valid: false,
          recipeId: recipe.recipeId,
          definitionHash: recipe.definitionHash,
          errors: [`Argument at index ${i} contains forbidden shell metacharacters: "${arg}".`],
          errorCode: ErrorCode.RECIPE_ARGUMENTS_INVALID,
          canExecuteAutomatically: false,
          executionBlockedReason: 'Forbidden shell characters detected.',
        };
      }

      // Traversal check
      if (arg.includes('..') || arg.includes(':') || arg.startsWith('/') || arg.startsWith('\\')) {
        return {
          valid: false,
          recipeId: recipe.recipeId,
          definitionHash: recipe.definitionHash,
          errors: [`Argument at index ${i} contains path traversal or absolute path syntax: "${arg}".`],
          errorCode: ErrorCode.RECIPE_PATH_OUTSIDE_ROOT,
          canExecuteAutomatically: false,
          executionBlockedReason: 'Path traversal syntax detected in argument.',
        };
      }
    }

    // 6. Path target specific validation (e.g. project.single_test)
    if (argSchema.allowsPathTarget) {
      if (args.length !== 1) {
        return {
          valid: false,
          recipeId: recipe.recipeId,
          definitionHash: recipe.definitionHash,
          errors: [`Recipe "${recipe.recipeId}" requires exactly 1 target path argument.`],
          errorCode: ErrorCode.RECIPE_ARGUMENTS_INVALID,
          canExecuteAutomatically: false,
          executionBlockedReason: 'Target path required.',
        };
      }

      const targetPath = args[0]!;
      if (argSchema.pathTargetPattern) {
        const regex = new RegExp(argSchema.pathTargetPattern);
        if (!regex.test(targetPath)) {
          return {
            valid: false,
            recipeId: recipe.recipeId,
            definitionHash: recipe.definitionHash,
            errors: [
              `Target path "${targetPath}" does not match required test pattern "${argSchema.pathTargetPattern}".`,
            ],
            errorCode: ErrorCode.RECIPE_ARGUMENTS_INVALID,
            canExecuteAutomatically: false,
            executionBlockedReason: 'Target path does not match permitted test file pattern.',
          };
        }
      }

      // Check containment inside workspaceRoot
      const resolvedTarget = path.resolve(options.workspaceRoot, targetPath);
      if (!isPathInsideRoot(options.workspaceRoot, resolvedTarget)) {
        return {
          valid: false,
          recipeId: recipe.recipeId,
          definitionHash: recipe.definitionHash,
          errors: [`Target path "${targetPath}" resolves outside workspace root.`],
          errorCode: ErrorCode.RECIPE_PATH_OUTSIDE_ROOT,
          canExecuteAutomatically: false,
          executionBlockedReason: 'Target path escapes workspace root.',
        };
      }

      // Exclusion and secret check on targetPath
      if (isPathExcluded(targetPath)) {
        return {
          valid: false,
          recipeId: recipe.recipeId,
          definitionHash: recipe.definitionHash,
          errors: [`Target path "${targetPath}" is excluded by security rules (.mediatorignore or mandatory exclusions).`],
          errorCode: ErrorCode.PATH_EXCLUDED_BY_RULE,
          canExecuteAutomatically: false,
          executionBlockedReason: 'Target path is an excluded or protected file.',
        };
      }
    }

    // 7. Environment overrides validation
    if (request.envOverrides && Object.keys(request.envOverrides).length > 0) {
      for (const [key, val] of Object.entries(request.envOverrides)) {
        const upperKey = key.toUpperCase();
        if (FORBIDDEN_ENV_KEYS.has(upperKey) || !recipe.envAllowlist.includes(key)) {
          return {
            valid: false,
            recipeId: recipe.recipeId,
            definitionHash: recipe.definitionHash,
            errors: [`Environment variable override "${key}" is disallowed for recipe "${recipe.recipeId}".`],
            errorCode: ErrorCode.RECIPE_ENVIRONMENT_DISALLOWED,
            canExecuteAutomatically: false,
            executionBlockedReason: `Environment variable "${key}" is not in the recipe allowlist.`,
          };
        }

        if (typeof val === 'string') {
          const scan = scanContent(val);
          if (scan.ok && scan.value.findings.length > 0) {
            return {
              valid: false,
              recipeId: recipe.recipeId,
              definitionHash: recipe.definitionHash,
              errors: [`Environment variable "${key}" contains suspected secrets.`],
              errorCode: ErrorCode.SECRET_DETECTED_IN_OUTPUT,
              canExecuteAutomatically: false,
              executionBlockedReason: 'Secret detected in environment override value.',
            };
          }
        }
      }
    }

    // 8. Resource limit validation
    if (request.timeoutMs && request.timeoutMs > recipe.timeoutMs) {
      return {
        valid: false,
        recipeId: recipe.recipeId,
        definitionHash: recipe.definitionHash,
        errors: [`Requested timeout ${request.timeoutMs}ms exceeds recipe cap of ${recipe.timeoutMs}ms.`],
        errorCode: ErrorCode.RECIPE_ARGUMENTS_INVALID,
        canExecuteAutomatically: false,
        executionBlockedReason: 'Timeout limit cannot be raised above recipe cap.',
      };
    }

    if (request.maxOutputBytes && request.maxOutputBytes > recipe.maxOutputBytes) {
      return {
        valid: false,
        recipeId: recipe.recipeId,
        definitionHash: recipe.definitionHash,
        errors: [`Requested max output ${request.maxOutputBytes} bytes exceeds recipe cap of ${recipe.maxOutputBytes} bytes.`],
        errorCode: ErrorCode.RECIPE_ARGUMENTS_INVALID,
        canExecuteAutomatically: false,
        executionBlockedReason: 'Output cap cannot be raised above recipe cap.',
      };
    }

    // 9. S00 Feasibility Decision & Execution status
    // Under NO-GO-AUTOEXEC, automatic execution is strictly disabled.
    const isNoGo = s00Decision === S00ExecutionDecisionValues.NO_GO_AUTOEXEC;
    const canExecuteAutomatically = !isNoGo;
    const executionBlockedReason = isNoGo
      ? 'Automatic execution disabled by S00 feasibility decision NO-GO-AUTOEXEC. Recipes are manual suggestions only.'
      : undefined;

    // Generate safe copyable manual instruction
    const commandText = this.buildSafeCommandText(recipe, args);
    const suggestedManualRecipe = {
      recipeId: recipe.recipeId,
      commandText,
      instructions: `Manual execution only. Not executed or verified by Mediator.\nRun from: ${workingDir}`,
      workingDirectory: workingDir,
      safeToRunManually: true,
    };

    const defaultArgs = recipe.defaultArgs ?? recipe.fixedArgs ?? [];
    return {
      valid: true,
      ok: true,
      recipeId: recipe.recipeId,
      definitionHash: recipe.definitionHash,
      canExecuteAutomatically,
      executionBlockedReason,
      suggestedManualRecipe,
      effectiveArgs: [...defaultArgs, ...args],
      effectiveWorkingDirectory: workingDir,
    };
  }

  private buildSafeCommandText(recipe: RecipeDefinition, args: readonly string[]): string {
    const defaultArgs = recipe.defaultArgs ?? recipe.fixedArgs ?? [];
    const parts = [recipe.executable, ...defaultArgs, ...args];
    return parts.join(' ');
  }
}
