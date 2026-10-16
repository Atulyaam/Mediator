/**
 * @mediator/orchestrator — Web Conversation Manager & Context Commands Test Suite
 *
 * Verifies:
 * 1. Wrapping prompt in concise coding assistant instruction.
 * 2. Parsing context commands and code proposals.
 * 3. Execution of list_files, read_file, search_code, get_diff, get_task_status.
 * 4. Strict path containment (rejection of .. / traversal, outside paths, device names).
 * 5. Autonomous multi-turn conversation loop with context requests and failure feedback.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  WebConversationManager,
  type ProviderMessageDispatcher,
} from './webConversationManager.js';
import { MediatorCore } from './mediatorCore.js';

describe('WebConversationManager & Minimal Context Commands', () => {
  let tmpDir: string;
  let manager: WebConversationManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-conv-test-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, 'src', 'utils.js'),
      'export function add(a, b) {\n  return a + b;\n}\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'SPRINT_STATUS.md'),
      '# Sprint Status\n\nSprint 2 in progress.\n',
      'utf8',
    );

    manager = new WebConversationManager({ workspaceRoot: tmpDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('1. formats concise coding assistant instruction wrapping user prompt', () => {
    const formatted = manager.formatInstructionPrompt('Build a portfolio website');
    expect(formatted).toContain('Task: Build a portfolio website');
    expect(formatted).toContain('list_files(path?: string)');
    expect(formatted).toContain('read_file(path: string)');
    expect(formatted).toContain('search_code(query: string, path?: string)');
    expect(formatted).toContain('get_diff()');
    expect(formatted).toContain('get_task_status()');
    expect(formatted).toContain('"command": "read_file"');
  });

  it('2. parses context command from assistant JSON code block', () => {
    const jsonResponse = `I need to inspect the status file first.
\`\`\`json
{
  "command": "read_file",
  "path": "docs/SPRINT_STATUS.md"
}
\`\`\``;

    const parsed = manager.parseAssistantResponse(jsonResponse);
    expect(parsed.isCommand).toBe(true);
    expect(parsed.commandName).toBe('read_file');
    expect(parsed.commandArgs?.path).toBe('docs/SPRINT_STATUS.md');
    expect(parsed.isProposal).toBe(false);
  });

  it('3. parses context command from inline function call syntax', () => {
    const callResponse = `call read_file("docs/SPRINT_STATUS.md")`;
    const parsed = manager.parseAssistantResponse(callResponse);
    expect(parsed.isCommand).toBe(true);
    expect(parsed.commandName).toBe('read_file');
    expect(parsed.commandArgs?.path).toBe('docs/SPRINT_STATUS.md');
  });

  it('4. executes read_file safely and returns file content', async () => {
    const res = await manager.executeContextCommand('task_1', 'read_file', {
      path: 'docs/SPRINT_STATUS.md',
    });
    expect(res.ok).toBe(true);
    const result = res.result as { path: string; content: string; lines: number };
    expect(result.path).toBe('docs/SPRINT_STATUS.md');
    expect(result.content).toContain('Sprint 2 in progress');
    expect(result.lines).toBeGreaterThan(1);
  });

  it('5. strictly rejects read_file attempting path traversal outside workspace', async () => {
    const res = await manager.executeContextCommand('task_1', 'read_file', {
      path: '../../Windows/System32/drivers/etc/hosts',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  it('6. executes list_files safely and lists workspace files', async () => {
    const res = await manager.executeContextCommand('task_1', 'list_files', {});
    expect(res.ok).toBe(true);
    const result = res.result as { files: string[]; count: number };
    expect(result.files).toContain('docs/SPRINT_STATUS.md');
    expect(result.files).toContain('src/utils.js');
  });

  it('7. executes search_code safely and locates symbols', async () => {
    const res = await manager.executeContextCommand('task_1', 'search_code', {
      query: 'export function add',
    });
    expect(res.ok).toBe(true);
    const result = res.result as { matchCount: number; matches: Array<{ path: string; lineNumber: number; lineContent: string }> };
    expect(result.matchCount).toBe(1);
    expect(result.matches[0]?.path).toBe('src/utils.js');
    expect(result.matches[0]?.lineNumber).toBe(1);
  });

  it('8. parses code proposal from assistant response', () => {
    const proposalText = `Here is the solution:
\`\`\`json
{
  "status": "completed",
  "proposal": {
    "path": "src/utils.js",
    "fixed_code": "export function add(a, b) { return a + b; }\\nexport function sub(a, b) { return a - b; }\\n"
  }
}
\`\`\``;

    const parsed = manager.parseAssistantResponse(proposalText);
    expect(parsed.isProposal).toBe(true);
    expect(parsed.proposal?.path).toBe('src/utils.js');
    expect(parsed.proposal?.content).toContain('sub(a, b)');
  });

  it('9. maintains single persistent conversation session across turns', async () => {
    const session = manager.getOrCreateSession('task_test_9', 'gemini');
    expect(session.conversationId).toBeDefined();

    // Add user message
    session.history.push({
      id: 'm1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    });

    const retrieved = manager.getSession('task_test_9');
    expect(retrieved).toBe(session);
    expect(retrieved?.history.length).toBe(1);
    expect(retrieved?.conversationId).toBe(session.conversationId);
  });

  it('10. autonomous multi-turn provider handler executes tool call and receives proposal in same conversation', async () => {
    // Mock dispatcher that first asks for read_file("src/utils.js"), then proposes fix
    const responses = [
      `\`\`\`json\n{\n  "command": "read_file",\n  "path": "src/utils.js"\n}\n\`\`\``,
      `\`\`\`json\n{\n  "status": "completed",\n  "proposal": {\n    "path": "src/utils.js",\n    "fixed_code": "export function add(a, b) { return Number(a) + Number(b); }\\n"\n  }\n}\n\`\`\``,
    ];
    let callCount = 0;

    const mockDispatcher: ProviderMessageDispatcher = {
      sendMessage: async (conversationId, prompt) => {
        const reply = responses[callCount++] ?? 'Done';
        return { responseText: reply, conversationId };
      },
    };

    manager.setDispatcher(mockDispatcher);
    const handler = manager.createProviderHandler('task_multi_turn', () => undefined);

    const proposal = await handler('Fix type coercion in add function', 1);
    expect(proposal).not.toBeNull();
    expect(proposal?.path).toBe('src/utils.js');
    expect(proposal?.content).toContain('Number(a)');

    // Verify conversation history captured both turns
    const session = manager.getSession('task_multi_turn');
    expect(session).toBeDefined();
    expect(session?.history.length).toBeGreaterThanOrEqual(4); // User initial -> Assistant command -> Tool result -> Assistant proposal
    expect(session?.history[1]?.commandRequest?.command).toBe('read_file');
    expect(session?.history[2]?.role).toBe('tool');
    expect(session?.history[3]?.role).toBe('user');
    expect(session?.history[4]?.proposal?.path).toBe('src/utils.js');
  });
});
