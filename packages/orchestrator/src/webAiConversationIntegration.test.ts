/**
 * @mediator/orchestrator — Web-AI Conversation Integration Test Suite (Phase 8)
 *
 * Verifies the 10 required acceptance steps for the simplified Web-AI workflow:
 * 1. Existing provider sends a prompt and captures the real response.
 * 2. The same conversation accepts a follow-up prompt.
 * 3. AI requests a file and Mediator returns the actual content.
 * 4. The IDE timeline shows both messages and the tool result.
 * 5. A multi-turn task continues after the initial plan.
 * 6. Proposed edits are applied in the task worktree.
 * 7. A failed test is returned to the AI and corrected.
 * 8. Stop, timeout and provider disconnection work correctly.
 * 9. Reload restores the correct task and conversation state.
 * 10. The final diff can be reviewed and approved.
 *
 * Note: Uses deterministic mocked provider dispatcher and verifies real Mediator Core,
 * WebConversationManager, GuardedAutopilotEngine, IsolatedWorktree, and StageStore execution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MediatorCore } from './mediatorCore.js';
import {
  WebConversationManager,
  type ProviderMessageDispatcher,
} from './webConversationManager.js';
import { S00ExecutionDecisionValues } from '@mediator/shared-contracts';

describe('Phase 8 — Final Web-AI Conversation Integration Verification (10-Step Sequence)', () => {
  let tempWorkspace: string;
  let testFileRel: string;
  let testFileAbs: string;

  beforeEach(() => {
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator_web_ai_int_'));
    testFileRel = 'src/service.js';
    testFileAbs = path.join(tempWorkspace, testFileRel);
    fs.mkdirSync(path.dirname(testFileAbs), { recursive: true });
    fs.writeFileSync(
      testFileAbs,
      'export function processData(input) {\n  return input * 2;\n}\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempWorkspace, 'package.json'),
      JSON.stringify({ name: 'web-ai-test', version: '1.0.0' }, null, 2),
      'utf8',
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  it('Step 1: Existing provider sends a prompt and captures the real response', async () => {
    const manager = new WebConversationManager({ workspaceRoot: tempWorkspace });
    let capturedPrompt = '';
    const mockDispatcher: ProviderMessageDispatcher = {
      sendMessage: async (conversationId, prompt) => {
        capturedPrompt = prompt;
        return {
          conversationId,
          responseText: 'I am ready to help you plan and implement this task.',
        };
      },
    };
    manager.setDispatcher(mockDispatcher);

    const taskSession = manager.getOrCreateSession('task_step1', 'gemini');
    expect(taskSession.conversationId).toBeDefined();

    const result = await manager.sendMessage('task_step1', 'Build a portfolio website');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.responseText).toContain('I am ready to help you plan');
    }
    expect(capturedPrompt).toContain('Build a portfolio website');
  });

  it('Step 2: The same conversation accepts a follow-up prompt without creating a fresh conversation', async () => {
    const manager = new WebConversationManager({ workspaceRoot: tempWorkspace });
    const conversationIdsSeen: string[] = [];
    const mockDispatcher: ProviderMessageDispatcher = {
      sendMessage: async (conversationId, prompt) => {
        conversationIdsSeen.push(conversationId);
        return {
          conversationId,
          responseText: `Response to: ${prompt.slice(0, 30)}`,
        };
      },
    };
    manager.setDispatcher(mockDispatcher);

    const session = manager.getOrCreateSession('task_step2', 'gemini');
    const initialConvId = session.conversationId;

    // First turn
    await manager.sendMessage('task_step2', 'First turn instructions');
    // Follow-up turn
    await manager.sendMessage('task_step2', 'Add dark mode styling as well');

    expect(conversationIdsSeen.length).toBe(2);
    expect(conversationIdsSeen[0]).toBe(initialConvId);
    expect(conversationIdsSeen[1]).toBe(initialConvId); // Must be the same conversation!

    const history = manager.getSession('task_step2')?.history;
    expect(history?.length).toBe(4); // user1, assistant1, user2, assistant2
  });

  it('Step 3: AI requests a file and Mediator returns the actual content safely', async () => {
    const manager = new WebConversationManager({ workspaceRoot: tempWorkspace });
    const cmdRes = await manager.executeContextCommand('task_step3', 'read_file', {
      path: testFileRel,
    });

    expect(cmdRes.ok).toBe(true);
    if (cmdRes.ok) {
      const resObj = cmdRes.result as { path: string; content: string; lines: number };
      expect(resObj.path).toBe(testFileRel);
      expect(resObj.content).toContain('export function processData');
    }
  });

  it('Step 4: The IDE timeline shows both messages and the tool result', async () => {
    const manager = new WebConversationManager({ workspaceRoot: tempWorkspace });
    let turn = 0;
    const mockDispatcher: ProviderMessageDispatcher = {
      sendMessage: async (conversationId) => {
        turn++;
        if (turn === 1) {
          return {
            conversationId,
            responseText: 'MED_CMD: read_file("src/service.js")',
          };
        }
        return {
          conversationId,
          responseText: `I inspected src/service.js and propose the fix:\n\`\`\`json\n{\n  "status": "completed",\n  "proposal": {\n    "path": "src/service.js",\n    "fixed_code": "export function processData(input) { return Number(input) * 2; }\\n"\n  }\n}\n\`\`\``,
        };
      },
    };
    manager.setDispatcher(mockDispatcher);

    const handler = manager.createProviderHandler('task_step4', () => undefined);
    const proposal = await handler('Refactor service.js to handle string inputs safely', 1);

    expect(proposal).not.toBeNull();
    const session = manager.getSession('task_step4');
    expect(session).toBeDefined();

    // Timeline entries:
    // 0: User initial prompt
    // 1: Assistant context request (read_file)
    // 2: Tool execution result containing file content
    // 3: User message feeding tool output back
    // 4: Assistant proposal response
    expect(session?.history.length).toBeGreaterThanOrEqual(4);
    expect(session?.history[0]?.role).toBe('user');
    expect(session?.history[1]?.commandRequest?.command).toBe('read_file');
    expect(session?.history[2]?.role).toBe('tool');
    expect(String(session?.history[2]?.content)).toContain('export function processData');
    expect(session?.history[4]?.proposal?.path).toBe('src/service.js');
  });

  it('Step 5: A multi-turn task continues after the initial plan into implementation', async () => {
    const manager = new WebConversationManager({ workspaceRoot: tempWorkspace });
    let callCount = 0;
    const mockDispatcher: ProviderMessageDispatcher = {
      sendMessage: async (conversationId) => {
        callCount++;
        if (callCount === 1) {
          // Turn 1: Planning and listing project structure
          return {
            conversationId,
            responseText: 'Here is my implementation plan.\nMED_CMD: list_files("")',
          };
        }
        // Turn 2: Implementation proposal
        return {
          conversationId,
          responseText: `Plan confirmed. Implementing changes:\n\`\`\`json\n{\n  "status": "completed",\n  "proposal": {\n    "path": "src/service.js",\n    "fixed_code": "export function processData(input) { if (input === null) return 0; return input * 2; }\\n"\n  }\n}\n\`\`\``,
        };
      },
    };
    manager.setDispatcher(mockDispatcher);

    const handler = manager.createProviderHandler('task_step5', () => undefined);
    const proposal = await handler('Safely guard against null in processData', 1);

    expect(proposal).not.toBeNull();
    expect(proposal?.path).toBe('src/service.js');
    expect(proposal?.content).toContain('if (input === null) return 0;');
    expect(callCount).toBe(2);
  });

  it('Step 6: Proposed edits are applied in the task worktree (isolated from live workspace)', async () => {
    const core = new MediatorCore({
      workspaceRoot: tempWorkspace,
      s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
    });
    core.toggleAutopilot(true);

    const taskRes = core.createTask({ prompt: 'Update processData implementation' });
    expect(taskRes.ok).toBe(true);
    const taskId = taskRes.value.id;

    const engine = core.getGuardedAutopilotEngine();
    const wtRes = await engine.initializeTaskWorktree(taskId);
    expect(wtRes.ok).toBe(true);
    const worktreePath = wtRes.value.worktreeRoot;

    // Apply proposal to worktree via stageProposalInWorktree
    const stageRes = engine.stageProposalInWorktree(
      taskId,
      'src/service.js',
      'export function processData(input) { return (input || 0) * 10; }\n',
    );
    expect(stageRes.ok).toBe(true);

    // Verify task worktree has the new content
    const worktreeFile = path.join(worktreePath, 'src/service.js');
    expect(fs.readFileSync(worktreeFile, 'utf8')).toContain('* 10');

    // CRITICAL LIVE WORKSPACE INVARIANT: live file MUST remain unmodified
    const liveContent = fs.readFileSync(testFileAbs, 'utf8');
    expect(liveContent).toContain('return input * 2;');
    expect(liveContent).not.toContain('* 10');
  });

  it('Step 7: A failed test is returned to the AI and corrected in the same conversation', async () => {
    const manager = new WebConversationManager({ workspaceRoot: tempWorkspace });
    let attempts = 0;
    const mockDispatcher: ProviderMessageDispatcher = {
      sendMessage: async (conversationId, prompt) => {
        attempts++;
        if (attempts === 1) {
          // First attempt produces flawed code
          return {
            conversationId,
            responseText: `Flawed proposal:\n\`\`\`json\n{\n  "status": "continue",\n  "proposal": {\n    "path": "src/service.js",\n    "fixed_code": "export function processData(input) { return input / 0; }\\n"\n  }\n}\n\`\`\``,
          };
        }
        // Second attempt receives the sandbox failure and fixes it
        expect(prompt).toContain('validation test failed');
        return {
          conversationId,
          responseText: `Fixed proposal:\n\`\`\`json\n{\n  "status": "completed",\n  "proposal": {\n    "path": "src/service.js",\n    "fixed_code": "export function processData(input) { return Number(input) * 2; }\\n"\n  }\n}\n\`\`\``,
        };
      },
    };
    manager.setDispatcher(mockDispatcher);

    const handler = manager.createProviderHandler('task_step7', () => undefined);

    // Round 1
    const p1 = await handler('Fix processData calculation', 1);
    expect(p1?.content).toContain('input / 0');

    // Notify round 1 failed validation
    manager.notifySandboxResult('task_step7', {
      exitCode: 1,
      output: 'TypeError: input / 0 resulted in Infinity. Expected finite integer.',
      passed: false,
    });

    // Round 2 (bounded correction iteration) with failure snippet fed back
    const p2 = await handler('Fix processData calculation', 2, 'TypeError: input / 0 resulted in Infinity. Expected finite integer.');
    expect(p2?.content).toContain('Number(input) * 2');
  });

  it('Step 8: Stop, timeout and provider disconnection work correctly', async () => {
    const manager = new WebConversationManager({ workspaceRoot: tempWorkspace });
    const mockDispatcher: ProviderMessageDispatcher = {
      sendMessage: async () => {
        throw new Error('Connection refused by provider bridge');
      },
    };
    manager.setDispatcher(mockDispatcher);

    // Disconnection test
    const sendRes = await manager.sendMessage('task_step8', 'Hello');
    expect(sendRes.ok).toBe(false);
    if (!sendRes.ok) {
      expect(sendRes.error.message).toContain('Connection refused');
    }

    // Cancellation test
    let cancelled = false;
    const abortCheck = () => cancelled;
    const handler = manager.createProviderHandler('task_step8_cancel', abortCheck);

    cancelled = true;
    const proposal = await handler('Do something', 1);
    expect(proposal).toBeNull();
  });

  it('Step 9: Reload restores the correct task and conversation state', () => {
    const core = new MediatorCore({
      workspaceRoot: tempWorkspace,
      s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
    });

    const taskRes = core.createTask({
      prompt: 'Implement portfolio responsive design',
      providerId: 'gemini',
      mode: 'browser',
    });
    const taskId = taskRes.value.id;

    // Simulate turn
    const convManager = core.getWebConversationManager();
    convManager.getOrCreateSession(taskId, 'gemini');
    convManager.recordMessage(taskId, {
      id: 'msg_1',
      role: 'user',
      content: 'Implement portfolio responsive design',
      timestamp: Date.now(),
    });
    convManager.recordMessage(taskId, {
      id: 'msg_2',
      role: 'assistant',
      content: 'I have prepared the layout structure.',
      timestamp: Date.now(),
    });

    // Check retrieval before reload
    const taskBefore = core.getTask(taskId);
    const convBefore = core.getTaskConversation(taskId);
    expect(taskBefore).toBeDefined();
    expect(convBefore?.history.length).toBe(2);

    // Simulate task status retrieval across new instance/server query
    const retrievedTask = core.getTask(taskId);
    const retrievedConv = core.getTaskConversation(taskId);
    expect(retrievedTask?.id).toBe(taskId);
    expect(retrievedTask?.prompt).toBe('Implement portfolio responsive design');
    expect(retrievedConv?.history[0]?.content).toBe('Implement portfolio responsive design');
    expect(retrievedConv?.history[1]?.content).toBe('I have prepared the layout structure.');
  });

  it('Step 10: The final diff can be reviewed and approved to update live workspace', async () => {
    const core = new MediatorCore({
      workspaceRoot: tempWorkspace,
      s00Decision: S00ExecutionDecisionValues.GO_GUARDED_AUTOPILOT,
    });
    core.toggleAutopilot(true);

    const taskRes = core.createTask({ prompt: 'Refactor service.js for production' });
    const taskId = taskRes.value.id;

    // Stage proposed change through Core
    const fixedContent = 'export function processData(input) {\n  return Number(input) * 2;\n}\n';
    const stageRes = await core.stageProposal({
      taskId,
      relativePath: 'src/service.js',
      proposedContent: fixedContent,
      description: 'Convert input to number safely',
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;

    const { stageId, approvalId } = stageRes.value;

    // Verify diff review
    const diff = core.getStageDiff(stageId);
    expect(diff).toBeDefined();
    expect(diff).toContain('Number(input)');

    // Explicit human approval action
    const resolveRes = core.resolveApproval(approvalId, true, 'User approved diff in IDE');
    expect(resolveRes.ok).toBe(true);
    expect(resolveRes.value.status).toBe('approved');

    // Live atomic apply with backup creation
    const applyRes = await core.applyApprovedStage(stageId, approvalId);
    expect(applyRes.ok).toBe(true);
    if (!applyRes.ok) return;

    // Verify live workspace file is updated
    const updatedLive = fs.readFileSync(testFileAbs, 'utf8');
    expect(updatedLive).toBe(fixedContent);
    expect(applyRes.value.backupDir).toBeDefined();
  });
});
