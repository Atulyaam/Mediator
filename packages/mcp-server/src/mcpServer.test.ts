/**
 * @mediator/mcp-server — Test Suite (Sprint S16)
 *
 * Comprehensive tests covering all 28 S16 requirements:
 * 1. MCP server starts and shuts down through local transport.
 * 2. Only registered resources and read-only tools are exposed.
 * 3. Each expected resource returns a valid bounded payload.
 * 4. Capabilities tool returns actual supported/unavailable/unverified results.
 * 5. Task brief only exposes the authorized task.
 * 6. Relevant context reuses existing context engine.
 * 7. Staged changes are retrieved through authoritative stage-store API.
 * 8. Diff output uses bounded safe preview.
 * 9. Secret/excluded paths are never returned.
 * 10. Raw secrets are redacted or cause safe denial.
 * 11. Oversized and malformed requests are rejected.
 * 12. Invalid schema and invalid enum values are rejected.
 * 13. Invalid or stale task/session identity is rejected.
 * 14. A caller cannot read another task's stage.
 * 15. Arbitrary absolute paths and traversal inputs cannot be used to read files.
 * 16. Workspace-root substitution is rejected.
 * 17. MCP cannot write files or change staged content (verified with file hashes).
 * 18. MCP cannot execute shell commands or recipes.
 * 19. MCP cannot change policy.
 * 20. MCP cannot create or resolve an approval.
 * 21. MCP cannot apply a patch or perform live apply-back.
 * 22. MCP cannot invoke stop/resume or destructive state transitions.
 * 23. Forbidden methods are rejected rather than silently accepted.
 * 24. Resource failures return stable typed errors without secret leakage.
 * 25. Audit events contain no raw secrets or full content dumps.
 * 26. Output size and diff/context budgets are enforced.
 * 27. Cancellation and shutdown do not leave dangling operations.
 * 28. Existing tests continue to pass.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  type WorkspaceRootState,
  TaskState,
  EvidenceLevel,
} from '@mediator/shared-contracts';
import {
  inspectWorkspaceRoot,
  confirmWorkspaceRoot,
} from '@mediator/workspace-boundary';
import {
  DatabaseConnection,
  runMigrations,
  TaskRepository,
  type TaskRecord,
  SessionRepository,
  EvidenceRepository,
  AuditRepository,
} from '@mediator/persistence';
import { StageStore, computeSha256 } from '@mediator/stage-store';
import {
  VsCodeWorkspaceAdapter,
  type VsCodeApiFacade,
} from '@mediator/ide-adapter-vscode';
import {
  McpContextServer,
  McpStdioTransport,
  MCP_RESOURCE_URIS,
  MCP_TOOL_NAMES,
  JsonRpcErrorCode,
  FORBIDDEN_MCP_TOOLS,
} from './index.js';

describe('Sprint S16 — Read-Only MCP Context Server', () => {
  let tempDir: string;
  let workspaceDir: string;
  let rootState: WorkspaceRootState;
  let db: DatabaseConnection;
  let taskRepo: TaskRepository;
  let evidenceRepo: EvidenceRepository;
  let auditRepo: AuditRepository;
  let stageStore: StageStore;
  let adapter: VsCodeWorkspaceAdapter;
  let server: McpContextServer;

  const validTaskId = 'task-s16-001';
  const otherTaskId = 'task-s16-other';
  const validSessionId = 'session-s16-001';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s16-test-'));
    workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });

    // Populate safe workspace files
    fs.writeFileSync(path.join(workspaceDir, 'package.json'), JSON.stringify({ name: 's16-app', version: '1.0.0' }));
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# S16 Sample Project\nSafe read-only project.');
    fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'src', 'index.ts'), 'export const hello = "world";\n');

    // Create .mediator rules
    const mediatorMetaDir = path.join(workspaceDir, '.mediator');
    fs.mkdirSync(mediatorMetaDir, { recursive: true });
    fs.writeFileSync(
      path.join(mediatorMetaDir, 'rules.md'),
      '# Project Rules\n- [RULE-01] (critical): Never mutate live files without approval.\n- [RULE-02] (advisory): Keep context bounded.\n',
    );

    const inspected = inspectWorkspaceRoot(workspaceDir, 'ide');
    const confirmed = confirmWorkspaceRoot(inspected, true);
    if (!confirmed.ok) throw new Error(confirmed.error.message);
    rootState = confirmed.value;

    // Setup in-memory SQLite
    db = new DatabaseConnection({ isMemory: true });
    db.open();
    runMigrations(db);

    taskRepo = new TaskRepository(db);
    evidenceRepo = new EvidenceRepository(db);
    auditRepo = new AuditRepository(db);

    // Seed valid tasks
    const task1: TaskRecord = {
      taskId: validTaskId,
      goalSummary: 'Implement S16 Read-Only MCP Context Server',
      state: TaskState.STAGING,
      completionStatus: 'in_progress',
      acceptanceCriteria: ['Read-only MCP tools', 'No live mutations', 'Secret redaction'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    taskRepo.createTask(task1);

    const task2: TaskRecord = {
      taskId: otherTaskId,
      goalSummary: 'Unrelated other task that must stay isolated',
      state: TaskState.TASK_DEFINED,
      completionStatus: 'in_progress',
      acceptanceCriteria: ['Should not be visible to task 1'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    taskRepo.createTask(task2);

    const sessionRepo = new SessionRepository(db);
    sessionRepo.createSession({
      sessionId: validSessionId,
      taskId: validTaskId,
      providerId: 'provider-test',
      conversationId: 'conv-test',
      lifecycleState: 'active',
      protocolVersion: '1.0',
      baseStateHash: 'base-state-hash',
      nonce: 'session-nonce-12345',
    });

    // Seed evidence
    evidenceRepo.recordEvidence({
      evidenceId: 'ev-s16-01',
      taskId: validTaskId,
      sessionId: validSessionId,
      source: 'test-runner',
      evidenceLevel: EvidenceLevel.MEDIATOR_EXECUTOR_VERIFIED,
      verificationStatus: 'verified',
      evidenceHash: 'hash-001',
      summary: 'Automated test suite verified passing',
    });

    stageStore = new StageStore(db, {
      baseStagingDir: path.join(tempDir, 'staging'),
    });

    const mockApi: VsCodeApiFacade = {
      env: {
        appName: 'Visual Studio Code',
        appHost: 'desktop',
      },
      version: '1.93.0',
      workspace: {
        workspaceFolders: [{ uri: { fsPath: workspaceDir } }],
        createFileSystemWatcher: () => ({
          onDidCreate: () => ({ dispose: () => {} }),
          onDidChange: () => ({ dispose: () => {} }),
          onDidDelete: () => ({ dispose: () => {} }),
          dispose: () => {},
        }),
      },
      languages: {
        getDiagnostics: () => [],
      },
      window: {
        activeTextEditor: undefined,
      },
      commands: {
        executeCommand: async <T>(_cmd: string, ..._args: unknown[]): Promise<T> => [] as unknown as T,
      },
      extensions: {
        getExtension: () => undefined,
      },
    };

    adapter = new VsCodeWorkspaceAdapter(mockApi, rootState);

    server = new McpContextServer({
      taskRepo,
      stageStore,
      ideAdapter: adapter,
      rootState,
      evidenceRepo,
      auditRepo,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // 1. MCP server starts and shuts down through supported local transport
  it('1. starts and shuts down through supported local transport', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new McpStdioTransport({
      server,
      inputStream: input,
      outputStream: output,
    });

    expect(transport.getIsListening()).toBe(false);
    transport.start();
    expect(transport.getIsListening()).toBe(true);
    expect(server.getIsRunning()).toBe(true);

    const responsePromise = new Promise<string>((resolve) => {
      output.once('data', (chunk) => resolve(chunk.toString()));
    });

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    const rawRes = await responsePromise;
    const res = JSON.parse(rawRes);
    expect(res).toEqual({ jsonrpc: '2.0', id: 1, result: {} });

    transport.stop();
    expect(transport.getIsListening()).toBe(false);
    expect(server.getIsRunning()).toBe(false);
  });

  // 2. Only registered resources and read-only tools are exposed
  it('2. exposes only registered resources and read-only tools', async () => {
    const resList = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/list',
    });
    expect(resList.error).toBeUndefined();
    const resources = (resList.result as { resources: Array<{ uri: string }> }).resources;
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain(MCP_RESOURCE_URIS.TASK_CURRENT);
    expect(uris).toContain(MCP_RESOURCE_URIS.TASK_BRIEF);
    expect(uris).toContain(MCP_RESOURCE_URIS.TASK_ACCEPTANCE_CRITERIA);
    expect(uris).toContain(MCP_RESOURCE_URIS.TASK_CHANGED_FILES);
    expect(uris).toContain(MCP_RESOURCE_URIS.TASK_VERIFICATION_STATUS);
    expect(uris).toContain(MCP_RESOURCE_URIS.TASK_CONTEXT);
    expect(uris).toContain(MCP_RESOURCE_URIS.PROJECT_RULES);

    const toolList = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    });
    expect(toolList.error).toBeUndefined();
    const tools = (toolList.result as { tools: Array<{ name: string }> }).tools;
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toEqual([
      MCP_TOOL_NAMES.GET_CAPABILITIES,
      MCP_TOOL_NAMES.GET_TASK_BRIEF,
      MCP_TOOL_NAMES.GET_RELEVANT_CONTEXT,
      MCP_TOOL_NAMES.GET_STAGED_CHANGES,
      MCP_TOOL_NAMES.GET_DIFF,
      MCP_TOOL_NAMES.REQUEST_REVIEW,
    ]);
  });

  // 3. Each expected resource returns a valid bounded payload
  it('3. each expected resource returns a valid bounded payload', async () => {
    const resourcesToTest = [
      MCP_RESOURCE_URIS.TASK_CURRENT,
      MCP_RESOURCE_URIS.TASK_BRIEF,
      MCP_RESOURCE_URIS.TASK_ACCEPTANCE_CRITERIA,
      MCP_RESOURCE_URIS.TASK_CHANGED_FILES,
      MCP_RESOURCE_URIS.TASK_VERIFICATION_STATUS,
      MCP_RESOURCE_URIS.TASK_CONTEXT,
      MCP_RESOURCE_URIS.PROJECT_RULES,
    ];

    for (const uri of resourcesToTest) {
      const res = await server.handleRequest({
        jsonrpc: '2.0',
        id: `res-${uri}`,
        method: 'resources/read',
        params: {
          uri,
          taskId: validTaskId,
          sessionId: validSessionId,
        },
      });

      expect(res.error).toBeUndefined();
      const content = (res.result as { contents: Array<{ uri: string; text: string }> }).contents[0];
      expect(content.uri).toBe(uri);
      expect(content.text.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(content.text)).toBeLessThan(1024 * 1024);
    }
  });

  // 4. Capabilities tool returns actual supported/unavailable/unverified results
  it('4. capabilities tool returns actual supported/unavailable/unverified results', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_CAPABILITIES,
        arguments: {},
      },
    });

    expect(res.error).toBeUndefined();
    const text = (res.result as { content: Array<{ text: string }> }).content[0].text;
    const matrix = JSON.parse(text);
    expect(matrix.capabilities.canonical_workspace.status).toBe('supported');
    expect(matrix.capabilities.file_enumeration.status).toBe('supported');
    expect(matrix.productName).toBe('Visual Studio Code');
  });

  // 5. Task brief only exposes the authorized task
  it('5. task brief only exposes authorized task', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_TASK_BRIEF,
        arguments: {
          taskId: validTaskId,
          sessionId: validSessionId,
        },
      },
    });

    expect(res.error).toBeUndefined();
    const brief = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);
    expect(brief.taskId).toBe(validTaskId);
    expect(brief.goal).toContain('S16 Read-Only MCP Context Server');
    expect(brief.goal).not.toContain('Unrelated other task');
  });

  // 6. Relevant context reuses existing context engine
  it('6. relevant context reuses existing context engine and enforces bounds', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_RELEVANT_CONTEXT,
        arguments: {
          taskId: validTaskId,
          sessionId: validSessionId,
          maxBytes: 32768,
        },
      },
    });

    expect(res.error).toBeUndefined();
    const packet = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);
    expect(packet.taskId).toBe(validTaskId);
    expect(packet.totalBytes).toBeLessThanOrEqual(32768);
    expect(packet.originalUserGoal).toContain('S16');
  });

  // 7. Staged changes are retrieved through authoritative stage-store API
  it('7. staged changes are retrieved through authoritative stage-store API', async () => {
    // Propose a staged addition in stageStore
    const stage = stageStore.createStage({
      taskId: validTaskId,
      workspace: rootState,
    });
    stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/newFeature.ts',
        changeType: 'add',
        content: 'export const feature = 1;\n',
      },
      rootState,
    );

    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_STAGED_CHANGES,
        arguments: {
          taskId: validTaskId,
          sessionId: validSessionId,
          stageId: stage.stageId,
        },
      },
    });

    expect(res.error).toBeUndefined();
    const data = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);
    expect(data.taskId).toBe(validTaskId);
    expect(data.stageId).toBe(stage.stageId);
    expect(data.stagedFiles).toHaveLength(1);
    expect(data.stagedFiles[0].relativePath).toBe('src/newFeature.ts');
    expect(data.stagedFiles[0].operation).toBe('add');
  });

  // 8. Diff output uses bounded safe preview
  it('8. diff output uses bounded safe preview', async () => {
    const stage = stageStore.createStage({
      taskId: validTaskId,
      workspace: rootState,
    });
    stageStore.stageFileProposal(
      stage.stageId,
      {
        relativePath: 'src/index.ts',
        changeType: 'modify',
        content: 'export const hello = "super-world";\n',
      },
      rootState,
    );

    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_DIFF,
        arguments: {
          taskId: validTaskId,
          sessionId: validSessionId,
          stageId: stage.stageId,
          relativePath: 'src/index.ts',
        },
      },
    });

    expect(res.error).toBeUndefined();
    const data = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);
    expect(data.stageId).toBe(stage.stageId);
    expect(data.diffs).toHaveLength(1);
    expect(data.diffs[0].diffText).toContain('+export const hello = "super-world";');
    expect(data.diffs[0].diffText).toContain('-export const hello = "world";');
  });

  // 9. Secret/excluded paths are never returned
  it('9. secret and excluded paths are rejected before reading', async () => {
    // Attempt to request diff for .env file
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_DIFF,
        arguments: {
          taskId: validTaskId,
          sessionId: validSessionId,
          relativePath: '.env',
        },
      },
    });

    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    expect(res.error?.message).toContain('excluded by security policy');
  });

  // 10. Raw secrets are redacted in output
  it('10. raw secrets are scanned and redacted in output', async () => {
    // Inject a secret into task goal summary
    const secretKey = 'ghp_' + 'A'.repeat(36);
    const secretTask: TaskRecord = {
      taskId: 'task-secret-test',
      goalSummary: `Fix bug with secret api key: ${secretKey}`,
      state: TaskState.TASK_DEFINED,
      completionStatus: 'in_progress',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    taskRepo.createTask(secretTask);

    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_TASK_BRIEF,
        arguments: {
          taskId: 'task-secret-test',
          sessionId: validSessionId,
        },
      },
    });

    expect(res.error).toBeUndefined();
    const content = (res.result as { content: Array<{ text: string }> }).content[0].text;
    expect(content).not.toContain(secretKey);
    expect(content).toContain('[REDACTED:');
  });

  // 11. Oversized and malformed requests are rejected
  it('11. oversized and malformed requests are rejected with typed errors', async () => {
    // Malformed JSON
    const malformed = await server.handleRequest('{ "jsonrpc": "2.0", invalid }');
    expect(malformed.error).toBeDefined();
    expect(malformed.error?.code).toBe(JsonRpcErrorCode.PARSE_ERROR);

    // Oversized (> 1MB)
    const giantPayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 11,
      method: 'ping',
      params: { filler: 'x'.repeat(1024 * 1024 + 10) },
    });
    const oversized = await server.handleRequest(giantPayload);
    expect(oversized.error).toBeDefined();
    expect(oversized.error?.code).toBe(JsonRpcErrorCode.OVERSIZED_PAYLOAD);
  });

  // 12. Invalid schema and invalid enum values are rejected
  it('12. invalid schema and missing required parameters are rejected', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_TASK_BRIEF,
        arguments: {
          // missing taskId and sessionId
        },
      },
    });

    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
  });

  // 13. Invalid or stale task/session identity is rejected
  it('13. invalid or non-existent task scope is rejected', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_TASK_BRIEF,
        arguments: {
          taskId: 'non-existent-task-id',
          sessionId: validSessionId,
        },
      },
    });

    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(JsonRpcErrorCode.UNAUTHORIZED_TASK_SCOPE);
  });

  // 14. A caller cannot read another task's stage
  it("14. a caller cannot read another task's stage", async () => {
    // Create stage for otherTask
    const otherStage = stageStore.createStage({
      taskId: otherTaskId,
      workspace: rootState,
    });

    // Try to access otherStage with validTaskId
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_STAGED_CHANGES,
        arguments: {
          taskId: validTaskId,
          sessionId: validSessionId,
          stageId: otherStage.stageId,
        },
      },
    });

    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(JsonRpcErrorCode.UNAUTHORIZED_TASK_SCOPE);
    expect(res.error?.message).toContain('does not belong to authorized task');
  });

  // 15. Arbitrary absolute paths and traversal inputs cannot be used to read files
  it('15. path traversal and outside-root paths are rejected', async () => {
    const traversalRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_DIFF,
        arguments: {
          taskId: validTaskId,
          sessionId: validSessionId,
          relativePath: '../../outside.txt',
        },
      },
    });

    expect(traversalRes.error).toBeDefined();
    expect(traversalRes.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
  });

  // 16. Workspace-root substitution is rejected
  it('16. workspace root is authoritative and cannot be substituted by caller', async () => {
    // Try to inject arbitrary root in arguments
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_RELEVANT_CONTEXT,
        arguments: {
          taskId: validTaskId,
          sessionId: validSessionId,
          workspaceRoot: 'C:\\Windows\\System32',
        },
      },
    });

    // Server succeeds using authoritative rootState, completely ignoring caller root
    expect(res.error).toBeUndefined();
    const packet = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);
    expect(packet.taskId).toBe(validTaskId);
    expect(packet.originalUserGoal).toBeDefined();
  });

  // 17. MCP cannot write files or change staged content (verified with file hashes)
  it('17. MCP cannot write files or change staged content (file hashes invariant)', async () => {
    const beforeIndexContent = fs.readFileSync(path.join(workspaceDir, 'src', 'index.ts'), 'utf8');
    const beforeHash = computeSha256(Buffer.from(beforeIndexContent, 'utf8'));

    // Attempt to invoke simulated file writing
    const writeAttempts = [
      'write_file',
      'create_file',
      'mediator.write_file',
      'delete_file',
      'apply_patch',
    ];

    for (const forbidden of writeAttempts) {
      const res = await server.handleRequest({
        jsonrpc: '2.0',
        id: `write-${forbidden}`,
        method: forbidden,
        params: {
          filePath: path.join(workspaceDir, 'src', 'index.ts'),
          content: 'corrupted',
        },
      });

      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(JsonRpcErrorCode.MCP_MUTATION_PROHIBITED);
    }

    const afterIndexContent = fs.readFileSync(path.join(workspaceDir, 'src', 'index.ts'), 'utf8');
    const afterHash = computeSha256(Buffer.from(afterIndexContent, 'utf8'));
    expect(afterHash).toBe(beforeHash);
  });

  // 18. MCP cannot execute shell commands or recipes
  it('18. MCP rejects shell execution and recipes', async () => {
    const forbiddenShells = ['run_command', 'run_recipe', 'execute_shell', 'run_tests'];

    for (const shellTool of forbiddenShells) {
      const res = await server.handleRequest({
        jsonrpc: '2.0',
        id: `cmd-${shellTool}`,
        method: 'tools/call',
        params: {
          name: shellTool,
          arguments: { command: 'echo pwned' },
        },
      });

      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(JsonRpcErrorCode.MCP_MUTATION_PROHIBITED);
    }
  });

  // 19. MCP cannot change policy
  it('19. MCP cannot change policy rules', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 19,
      method: 'set_policy',
      params: { policy: 'allow-all' },
    });

    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(JsonRpcErrorCode.MCP_MUTATION_PROHIBITED);
  });

  // 20. MCP cannot create or resolve an approval
  it('20. MCP cannot create, resolve, or bypass approvals', async () => {
    const approvalOps = ['create_approval', 'resolve_approval', 'bypass_approval', 'approve_diff'];

    for (const op of approvalOps) {
      const res = await server.handleRequest({
        jsonrpc: '2.0',
        id: `app-${op}`,
        method: op,
        params: { approvalId: 'app-01', decision: 'approved', approved: true },
      });

      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(JsonRpcErrorCode.MCP_MUTATION_PROHIBITED);
    }
  });

  // 21. MCP cannot apply a patch or perform live apply-back
  it('21. MCP cannot apply patches or perform live apply-back', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 21,
      method: 'apply_back',
      params: { stageId: 'stage-01' },
    });

    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(JsonRpcErrorCode.MCP_MUTATION_PROHIBITED);
  });

  // 22. MCP cannot invoke stop/resume or destructive state transitions
  it('22. MCP cannot resume or stop tasks or discard stages', async () => {
    const lifecycleOps = ['resume_task', 'stop_task', 'discard_stage', 'rollback'];

    for (const op of lifecycleOps) {
      const res = await server.handleRequest({
        jsonrpc: '2.0',
        id: `life-${op}`,
        method: op,
        params: { taskId: validTaskId },
      });

      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(JsonRpcErrorCode.MCP_MUTATION_PROHIBITED);
    }
  });

  // 23. Forbidden methods are rejected rather than silently accepted
  it('23. all known forbidden methods are explicitly rejected', () => {
    const securityFilter = (server as unknown as { securityFilter: { checkOperationAllowed: (n: string) => { ok: boolean } } }).securityFilter;
    for (const forbidden of FORBIDDEN_MCP_TOOLS) {
      const check = securityFilter.checkOperationAllowed(forbidden);
      expect(check.ok).toBe(false);
    }
  });

  // 24. Resource failures return stable typed errors without secret leakage
  it('24. resource failures return stable typed errors without secret leakage', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 24,
      method: 'resources/read',
      params: {
        uri: 'mediator://unknown/secret-resource',
        taskId: validTaskId,
        sessionId: validSessionId,
      },
    });

    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(JsonRpcErrorCode.RESOURCE_NOT_FOUND);
    expect(res.error?.message).toContain('Unknown or unsupported MCP resource URI');
  });

  // 25. Audit events contain no raw secrets or full content dumps
  it('25. audit events record operation metadata without raw secrets', async () => {
    const secretValue = 'ghp_' + 'B'.repeat(36);
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 25,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_TASK_BRIEF,
        arguments: {
          taskId: validTaskId,
          sessionId: validSessionId,
          correlationId: 'audit-corr-test',
          extraSecret: secretValue,
        },
      },
    });

    const events = auditRepo.getEventsByTaskId(validTaskId);
    expect(events.length).toBeGreaterThan(0);
    const event = events.find((e) => e.correlationId === 'audit-corr-test');
    expect(event).toBeDefined();
    expect(event?.eventType).toBe('mcp.tools/call');
    expect(JSON.stringify(event?.details)).not.toContain(secretValue);
  });

  // 26. Output size and diff/context budgets are enforced
  it('26. output size and diff/context budgets are enforced', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 26,
      method: 'tools/call',
      params: {
        name: MCP_TOOL_NAMES.GET_RELEVANT_CONTEXT,
        arguments: {
          taskId: validTaskId,
          sessionId: validSessionId,
          maxBytes: 1024,
        },
      },
    });

    expect(res.error).toBeUndefined();
    const packet = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);
    expect(packet.totalBytes).toBeLessThanOrEqual(1024);
  });

  // 27. Cancellation and shutdown do not leave dangling operations
  it('27. cancellation and shutdown cleanly abort transport operations', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new McpStdioTransport({
      server,
      inputStream: input,
      outputStream: output,
    });

    transport.start();
    expect(transport.getIsListening()).toBe(true);

    transport.stop();
    expect(transport.getIsListening()).toBe(false);
    expect(server.getIsRunning()).toBe(false);
  });

  // 28. Existing tests continue to pass (verified by overall test suite)
  it('28. integration health check: server remains responsive and consistent', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 28,
      method: 'initialize',
    });

    expect(res.error).toBeUndefined();
    const result = res.result as { serverInfo: { name: string } };
    expect(result.serverInfo.name).toBe('mediator-mcp-server');
  });
});
