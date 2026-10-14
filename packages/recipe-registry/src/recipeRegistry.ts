/**
 * @mediator/recipe-registry — Fixed Recipe Registry Service (S23)
 *
 * Requirements:
 * - Deterministic, idempotent initialization of fixed recipes.
 * - Hash pinning and definition integrity verification.
 * - Strict argument/path/environment validation under NO-GO-AUTOEXEC.
 * - Bounded dependency inspection without automatic script execution.
 * - Safe manual instructions generation with explicit unverified warnings.
 */

import {
  type RecipeDefinition,
  type RecipeId,
  type RecipeExecutionRequest,
  type RecipeValidationResult,
  type DependencyInspectionReport,
  type SuggestedManualRecipe,
} from '@mediator/shared-contracts';
import { getAllFixedRecipeDefinitions } from './recipeDefinitions.js';
import { RecipeValidator, type RecipeValidatorOptions } from './recipeValidator.js';
import { DependencyInspector, type DependencyInspectorOptions } from './dependencyInspector.js';
import { verifyRecipeDefinitionIntegrity } from './canonicalHasher.js';

export interface RecipeRegistryServiceOptions {
  readonly dependencyInspectorOptions?: DependencyInspectorOptions | undefined;
}

export class RecipeRegistryService {
  private readonly recipes: Map<RecipeId, RecipeDefinition>;
  private readonly validator: RecipeValidator;
  private readonly dependencyInspector: DependencyInspector;

  public constructor(options?: RecipeRegistryServiceOptions) {
    this.recipes = new Map();
    const fixedList = getAllFixedRecipeDefinitions();
    for (const def of fixedList) {
      this.recipes.set(def.recipeId, def);
    }
    this.validator = new RecipeValidator(fixedList);
    this.dependencyInspector = new DependencyInspector(options?.dependencyInspectorOptions);
  }

  /**
   * Idempotent initialization check.
   */
  public initialize(): { readonly initialized: boolean; readonly recipeCount: number } {
    return {
      initialized: true,
      recipeCount: this.recipes.size,
    };
  }

  /**
   * Get a recipe by its ID.
   */
  public getRecipe(recipeId: RecipeId): RecipeDefinition | undefined {
    return this.recipes.get(recipeId);
  }

  /**
   * List all registered recipes.
   */
  public listRecipes(): readonly RecipeDefinition[] {
    return Array.from(this.recipes.values());
  }

  /**
   * Check if a recipe definition has been tampered with or corrupted.
   */
  public verifyIntegrity(recipeId: RecipeId): boolean {
    const recipe = this.recipes.get(recipeId);
    if (!recipe) return false;
    return verifyRecipeDefinitionIntegrity(recipe);
  }

  /**
   * Validate a recipe execution request against strict contracts and containment rules.
   */
  public validateRequest(
    request: RecipeExecutionRequest,
    options: RecipeValidatorOptions,
  ): RecipeValidationResult {
    return this.validator.validateRequest(request, options);
  }

  /**
   * Statically inspect project dependencies without executing any scripts.
   */
  public async inspectDependencies(workspaceRoot: string): Promise<DependencyInspectionReport> {
    return this.dependencyInspector.inspect(workspaceRoot);
  }

  /**
   * Generate safe copyable manual instructions for user terminal execution.
   */
  public generateManualInstruction(
    recipeId: RecipeId,
    args: readonly string[] = [],
    workspaceRoot: string = '.',
  ): SuggestedManualRecipe {
    const recipe = this.recipes.get(recipeId);
    if (!recipe) {
      return {
        recipeId,
        commandText: `# Unknown recipe: ${recipeId}`,
        instructions: 'This recipe is not registered in the trusted registry.',
        workingDirectory: workspaceRoot,
        safeToRunManually: false,
      };
    }

    const defaultArgs = recipe.defaultArgs ?? recipe.fixedArgs ?? [];
    const parts = [recipe.executable, ...defaultArgs, ...args];
    const commandText = parts.join(' ');
    const instructions = [
      'MANUAL EXECUTION ONLY — NOT EXECUTED OR VERIFIED BY MEDIATOR',
      `Category: ${recipe.category}`,
      `Description: ${recipe.description}`,
      `Run directory: ${workspaceRoot}`,
      'Copy the command below and execute it in your local IDE terminal.',
    ].join('\n');

    return {
      recipeId,
      commandText,
      instructions,
      workingDirectory: workspaceRoot,
      safeToRunManually: true,
    };
  }

  /**
   * Generate an isolated synthetic .env.test template without workspace secrets.
   */
  public generateSyntheticEnvTest(workspaceRoot: string): {
    readonly filename: string;
    readonly content: string;
    readonly isSafe: boolean;
  } {
    return this.dependencyInspector.generateSyntheticEnvTest(workspaceRoot);
  }
}
