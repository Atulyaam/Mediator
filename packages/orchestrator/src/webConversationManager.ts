/**
 * @mediator/orchestrator — Web Conversation Manager (Phases 3, 4 & 5)
 *
 * Implements persistent web-AI conversation tracking, on-demand context commands,
 * and the autonomous conversation loop for Autopilot.
 *
 * Requirements:
 * - One persistent conversation per task.
 * - Concise coding-assistant instruction wrapping the user prompt.
 * - Minimal on-demand context commands: list_files, read_file, search_code, get_diff, get_task_status.
 * - Fail-closed path containment and parameter validation.
 * - Multi-turn conversation continuation in the same conversation.
 * - Captures real prompts, responses, tool calls, and test results for timeline tracking.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  type CanonicalProviderId,
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
} from '@mediator/shared-contracts';
import { validateContainedPath, inspectWorkspaceRoot, confirmWorkspaceRoot } from '@mediator/workspace-boundary';

export interface ConversationMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool' | 'system';
  readonly content: string;
  readonly timestamp: number;
  readonly commandRequest?: {
    readonly command: string;
    readonly args: Record<string, unknown>;
  } | undefined;
  readonly commandResult?: {
    readonly command: string;
    readonly result?: unknown;
    readonly error?: string;
  } | undefined;
  readonly proposal?: {
    readonly path: string;
    readonly content?: string;
  } | undefined;
  readonly validation?: {
    readonly exitCode: number;
    readonly passed: boolean;
    readonly stdoutSnippet: string;
    readonly stderrSnippet: string;
  } | undefined;
  readonly testResult?: {
    readonly exitCode: number;
    readonly passed: boolean;
    readonly output: string;
  } | undefined;
}

export interface WebConversationSession {
  readonly taskId: string;
  readonly providerId: CanonicalProviderId;
  conversationId: string;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'disconnected';
  round: number;
  history: ConversationMessage[];
  lastActiveTimestamp: number;
}

export interface ParsedAssistantTurn {
  readonly rawText: string;
  readonly isCommand: boolean;
  readonly commandName?: string | undefined;
  readonly commandArgs?: Record<string, unknown> | undefined;
  readonly isProposal: boolean;
  readonly proposal?: {
    readonly path: string;
    readonly content: string;
  } | undefined;
  readonly isComplete: boolean;
  readonly explanation?: string | undefined;
}

export interface ProviderMessageDispatcher {
  sendMessage(
    conversationId: string,
    prompt: string,
    options?: {
      readonly providerId?: CanonicalProviderId | undefined;
      readonly taskId?: string | undefined;
      readonly timeoutMs?: number | undefined;
    },
  ): Promise<{ responseText: string; conversationId: string }>;
}

export class WebConversationManager {
  private readonly workspaceRoot: string;
  private readonly sessions = new Map<string, WebConversationSession>();
  private dispatcher: ProviderMessageDispatcher | null = null;

  constructor(options: { workspaceRoot: string; dispatcher?: ProviderMessageDispatcher }) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    if (options.dispatcher) {
      this.dispatcher = options.dispatcher;
    }
  }

  public setDispatcher(dispatcher: ProviderMessageDispatcher | null): void {
    this.dispatcher = dispatcher;
  }

  public getDispatcher(): ProviderMessageDispatcher | null {
    return this.dispatcher;
  }

  public getOrCreateSession(
    taskId: string,
    providerId: CanonicalProviderId,
    existingConversationId?: string,
  ): WebConversationSession {
    let session = this.sessions.get(taskId);
    if (!session) {
      session = {
        taskId,
        providerId,
        conversationId: existingConversationId ?? `conv_${taskId}_${Date.now()}`,
        status: 'active',
        round: 1,
        history: [],
        lastActiveTimestamp: Date.now(),
      };
      this.sessions.set(taskId, session);
    } else if (existingConversationId && session.conversationId !== existingConversationId) {
      session.conversationId = existingConversationId;
    }
    return session;
  }

  public getSession(taskId: string): WebConversationSession | undefined {
    return this.sessions.get(taskId);
  }

  public listSessions(): WebConversationSession[] {
    return Array.from(this.sessions.values());
  }

  public async sendMessage(
    taskId: string,
    text: string,
  ): Promise<Result<{ responseText: string; conversationId: string }, MediatorError>> {
    const session = this.getOrCreateSession(taskId, 'gemini');
    if (!this.dispatcher) {
      return err(makeMediatorError(ErrorCode.PROVIDER_NOT_CONFIGURED, 'No provider message dispatcher registered.'));
    }
    try {
      const userMsg: ConversationMessage = {
        id: `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };
      session.history.push(userMsg);

      const res = await this.dispatcher.sendMessage(session.conversationId, text, {
        providerId: session.providerId,
        taskId,
      });
      session.conversationId = res.conversationId;

      const assistantMsg: ConversationMessage = {
        id: `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        role: 'assistant',
        content: res.responseText,
        timestamp: Date.now(),
      };
      session.history.push(assistantMsg);
      return ok({ responseText: res.responseText, conversationId: res.conversationId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return err(makeMediatorError(ErrorCode.INTERNAL_ERROR, `Failed sending message: ${msg}`));
    }
  }

  public recordMessage(taskId: string, message: ConversationMessage): void {
    const session = this.getOrCreateSession(taskId, 'gemini');
    session.history.push(message);
    session.lastActiveTimestamp = Date.now();
  }

  public notifySandboxResult(
    taskId: string,
    result: { exitCode: number; output: string; passed: boolean },
  ): void {
    const session = this.getOrCreateSession(taskId, 'gemini');
    const msg: ConversationMessage = {
      id: `sandbox_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      role: 'tool',
      content: `Sandbox validation test run ${result.passed ? 'PASSED' : 'FAILED'} (Exit code: ${result.exitCode}):\n${result.output}`,
      timestamp: Date.now(),
      testResult: result,
    };
    session.history.push(msg);
  }

  /**
   * Wraps the user's initial prompt in a concise coding-assistant instruction.
   */
  public formatInstructionPrompt(userPrompt: string): string {
    return [
      `You are an AI coding assistant working through Mediator IDE.`,
      `Task: ${userPrompt.trim()}`,
      ``,
      `You have access to safe on-demand project tools to inspect files and tests before making changes:`,
      `- list_files(path?: string): list repository files and directories`,
      `- read_file(path: string): inspect the content of a project file`,
      `- search_code(query: string, path?: string): search files for code symbols or text`,
      `- get_diff(): inspect current changes in the isolated worktree`,
      `- get_task_status(): check the task state, iterations, and recent test results`,
      ``,
      `When requesting context, respond ONLY with a JSON block:`,
      `\`\`\`json`,
      `{`,
      `  "command": "read_file",`,
      `  "path": "path/to/file"`,
      `}`,
      `\`\`\``,
      ``,
      `When proposing a fix or new code, output your plan and code strictly in this format:`,
      `\`\`\`json`,
      `{`,
      `  "status": "completed",`,
      `  "proposal": {`,
      `    "path": "path/to/file",`,
      `    "fixed_code": "full corrected file content here"`,
      `  }`,
      `}`,
      `\`\`\``,
      ``,
      `Begin by requesting any relevant files or proposing your solution directly.`,
    ].join('\n');
  }

  /**
   * Parses the assistant's response to detect context commands or code proposals.
   */
  public parseAssistantResponse(text: string): ParsedAssistantTurn {
    const rawText = text.trim();

    // 1. Check for command JSON: { "command": "...", "path": "..." }
    const commandMatch = this.extractJsonBlock(rawText);
    if (commandMatch && typeof commandMatch === 'object' && 'command' in commandMatch) {
      const cmdObj = commandMatch as { command: unknown; path?: unknown; query?: unknown; args?: unknown };
      const commandName = String(cmdObj.command).trim();
      const args: Record<string, unknown> = {};

      if (typeof cmdObj.args === 'object' && cmdObj.args !== null) {
        Object.assign(args, cmdObj.args);
      }
      if (typeof cmdObj.path === 'string') args.path = cmdObj.path;
      if (typeof cmdObj.query === 'string') args.query = cmdObj.query;

      const allowedCommands = ['list_files', 'read_file', 'search_code', 'get_diff', 'get_task_status'];
      if (allowedCommands.includes(commandName)) {
        return {
          rawText,
          isCommand: true,
          commandName,
          commandArgs: args,
          isProposal: false,
          isComplete: false,
        };
      }
    }

    // 2. Check for function call syntax e.g. read_file("foo/bar") or MED_CMD: read_file("foo/bar")
    const fnMatch = rawText.match(/(?:MED_CMD:\s*|call\s+)?(read_file|list_files|search_code|get_diff|get_task_status)\s*\((.*?)\)/i);
    if (fnMatch && fnMatch[1] && fnMatch[2] !== undefined) {
      const commandName = fnMatch[1].toLowerCase();
      const rawArgs = fnMatch[2].trim();
      const args: Record<string, unknown> = {};

      if (commandName === 'read_file' && rawArgs) {
        args.path = rawArgs.replace(/^['"]|['"]$/g, '');
      } else if (commandName === 'list_files') {
        if (rawArgs) args.path = rawArgs.replace(/^['"]|['"]$/g, '');
      } else if (commandName === 'search_code' && rawArgs) {
        const parts = rawArgs.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        const queryPart = parts[0] ?? '';
        args.query = queryPart;
        const pathPart = parts[1];
        if (pathPart) args.path = pathPart;
      }

      return {
        rawText,
        isCommand: true,
        commandName,
        commandArgs: args,
        isProposal: false,
        isComplete: false,
      };
    }

    // 3. Check for proposal: { "proposal": { "path": "...", "fixed_code": "..." } }
    if (commandMatch && typeof commandMatch === 'object') {
      const obj = commandMatch as Record<string, unknown>;
      if (obj.proposal && typeof obj.proposal === 'object') {
        const p = obj.proposal as { path?: unknown; fixed_code?: unknown; content?: unknown };
        if (typeof p.path === 'string' && (typeof p.fixed_code === 'string' || typeof p.content === 'string')) {
          return {
            rawText,
            isCommand: false,
            isProposal: true,
            proposal: {
              path: p.path,
              content: String(p.fixed_code ?? p.content),
            },
            isComplete: obj.status === 'completed',
          };
        }
      }

      // Or root format { "path": "...", "fixed_code": "..." }
      if (typeof obj.path === 'string' && (typeof obj.fixed_code === 'string' || typeof obj.content === 'string')) {
        return {
          rawText,
          isCommand: false,
          isProposal: true,
          proposal: {
            path: obj.path,
            content: String(obj.fixed_code ?? obj.content),
          },
          isComplete: obj.status === 'completed' || true,
        };
      }

      // Or canonical <<<MEDIATOR_PLAN>>> patches
      if (Array.isArray(obj.patches) && obj.patches.length > 0) {
        const firstPatch = obj.patches[0] as { path?: unknown; content?: unknown; fixed_code?: unknown };
        if (typeof firstPatch.path === 'string' && (typeof firstPatch.content === 'string' || typeof firstPatch.fixed_code === 'string')) {
          return {
            rawText,
            isCommand: false,
            isProposal: true,
            proposal: {
              path: firstPatch.path,
              content: String(firstPatch.content ?? firstPatch.fixed_code),
            },
            isComplete: obj.status === 'completed',
          };
        }
      }
    }

    // 4. Check for canonical <<<MEDIATOR_PLAN>>> tags
    const planTagStart = '<<<MEDIATOR_PLAN>>>';
    const planTagEnd = '<<<END_MEDIATOR_PLAN>>>';
    const sIdx = rawText.indexOf(planTagStart);
    if (sIdx !== -1) {
      const eIdx = rawText.indexOf(planTagEnd, sIdx + planTagStart.length);
      const jsonStr = eIdx !== -1
        ? rawText.slice(sIdx + planTagStart.length, eIdx).trim()
        : rawText.slice(sIdx + planTagStart.length).trim();
      try {
        const plan = JSON.parse(jsonStr) as { patches?: Array<{ path?: string; content?: string }> };
        if (Array.isArray(plan.patches) && plan.patches[0]?.path && plan.patches[0]?.content) {
          return {
            rawText,
            isCommand: false,
            isProposal: true,
            proposal: {
              path: plan.patches[0].path,
              content: plan.patches[0].content,
            },
            isComplete: true,
          };
        }
      } catch {
        // continue
      }
    }

    // 5. Normal assistant turn (explanation, reasoning, or clarification request)
    return {
      rawText,
      isCommand: false,
      isProposal: false,
      isComplete: false,
      explanation: rawText,
    };
  }

  /**
   * Safely executes an on-demand context command with strict path containment.
   */
  public async executeContextCommand(
    taskId: string,
    commandName: string,
    args: Record<string, unknown>,
    worktreeRoot?: string,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    await Promise.resolve();
    const targetRoot = worktreeRoot ?? this.workspaceRoot;

    switch (commandName) {
      case 'list_files': {
        const subDirRel = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '';
        const targetDir = subDirRel ? path.resolve(targetRoot, subDirRel) : targetRoot;

        // Path safety check
        if (!targetDir.startsWith(targetRoot)) {
          return { ok: false, error: `Path traversal denied: "${subDirRel}" is outside workspace.` };
        }

        try {
          if (!fs.existsSync(targetDir)) {
            return { ok: false, error: `Directory does not exist: "${subDirRel}"` };
          }

          const entries = this.walkDirSafe(targetDir, targetRoot, 3, 100);
          return {
            ok: true,
            result: {
              directory: subDirRel || '.',
              files: entries,
              count: entries.length,
            },
          };
        } catch (err) {
          return { ok: false, error: `Failed listing files: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      case 'read_file': {
        const rawFilePath = typeof args.path === 'string' ? args.path.trim() : '';
        if (!rawFilePath) {
          return { ok: false, error: 'read_file requires a "path" argument.' };
        }

        // Validate containment
        const inspected = inspectWorkspaceRoot(targetRoot, 'ide');
        const confirmed = confirmWorkspaceRoot(inspected, true);
        const wsState = confirmed.ok ? confirmed.value : inspected;
        const contRes = validateContainedPath(wsState, rawFilePath, {
          operation: 'read',
          mustExist: true,
        });

        if (!contRes.ok) {
          // If not in worktree, try base workspaceRoot
          if (worktreeRoot && worktreeRoot !== this.workspaceRoot) {
            const baseInspected = inspectWorkspaceRoot(this.workspaceRoot, 'ide');
            const baseConfirmed = confirmWorkspaceRoot(baseInspected, true);
            const baseWsState = baseConfirmed.ok ? baseConfirmed.value : baseInspected;
            const baseContRes = validateContainedPath(baseWsState, rawFilePath, {
              operation: 'read',
              mustExist: true,
            });
            if (baseContRes.ok) {
              try {
                const content = fs.readFileSync(baseContRes.value.resolvedPath, 'utf8');
                return {
                  ok: true,
                  result: {
                    path: rawFilePath,
                    content: content.slice(0, 65536),
                    truncated: content.length > 65536,
                    lines: content.split('\n').length,
                  },
                };
              } catch (readErr) {
                return { ok: false, error: `Error reading file: ${readErr instanceof Error ? readErr.message : String(readErr)}` };
              }
            }
          }
          return { ok: false, error: contRes.error.message };
        }

        try {
          const content = fs.readFileSync(contRes.value.resolvedPath, 'utf8');
          const maxBytes = 65536; // 64 KiB
          return {
            ok: true,
            result: {
              path: rawFilePath,
              content: content.slice(0, maxBytes),
              truncated: content.length > maxBytes,
              lines: content.split('\n').length,
            },
          };
        } catch (readErr) {
          return { ok: false, error: `Error reading file: ${readErr instanceof Error ? readErr.message : String(readErr)}` };
        }
      }

      case 'search_code': {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) {
          return { ok: false, error: 'search_code requires a "query" argument.' };
        }

        const subDirRel = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '';
        const targetDir = subDirRel ? path.resolve(targetRoot, subDirRel) : targetRoot;

        if (!targetDir.startsWith(targetRoot)) {
          return { ok: false, error: `Path traversal denied: "${subDirRel}" is outside workspace.` };
        }

        try {
          const matches = this.searchFilesSafe(targetDir, targetRoot, query, 30);
          return {
            ok: true,
            result: {
              query,
              matchCount: matches.length,
              matches,
            },
          };
        } catch (err) {
          return { ok: false, error: `Search error: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      case 'get_diff': {
        if (!worktreeRoot || !fs.existsSync(worktreeRoot)) {
          return { ok: true, result: { diff: '', changedFiles: [], message: 'No isolated worktree active.' } };
        }

        try {
          const diffResult = this.computeWorktreeDiff(worktreeRoot, this.workspaceRoot);
          return { ok: true, result: diffResult };
        } catch (err) {
          return { ok: false, error: `Failed computing diff: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      case 'get_task_status': {
        const session = this.sessions.get(taskId);
        return {
          ok: true,
          result: {
            taskId,
            providerId: session?.providerId ?? 'gemini',
            conversationId: session?.conversationId ?? 'none',
            status: session?.status ?? 'idle',
            round: session?.round ?? 1,
            messageCount: session?.history.length ?? 0,
            hasWorktree: Boolean(worktreeRoot && fs.existsSync(worktreeRoot)),
          },
        };
      }

      default:
        return {
          ok: false,
          error: `Unknown command "${commandName}". Allowed commands: list_files, read_file, search_code, get_diff, get_task_status`,
        };
    }
  }

  /**
   * Creates a provider handler that ties the multi-turn web AI conversation
   * with on-demand tool execution and sandbox test feedback into GuardedAutopilotEngine.
   */
  public createProviderHandler(
    taskId: string,
    getWorktreeRoot: () => string | undefined,
    abortCheck?: () => boolean,
  ): (prompt: string, iteration: number, failureSnippet?: string) => Promise<{ path: string; content: string } | null> {
    return async (promptText: string, iteration: number, failureSnippet?: string): Promise<{ path: string; content: string } | null> => {
      if (abortCheck && abortCheck()) {
        return null;
      }

      if (!this.dispatcher) {
        throw new Error('No ProviderMessageDispatcher registered. Ensure browser bridge or mock dispatcher is active.');
      }

      const session = this.getOrCreateSession(taskId, 'gemini');
      let outgoingPrompt = '';

      if (iteration === 1) {
        outgoingPrompt = this.formatInstructionPrompt(promptText);
      } else if (failureSnippet) {
        outgoingPrompt = [
          `Sandbox validation test failed with genuine errors:`,
          `\`\`\`text`,
          failureSnippet.slice(0, 1500),
          `\`\`\``,
          `Please inspect the failure above, use context tools if you need more information, or output a corrected proposal.`,
        ].join('\n');
      } else {
        outgoingPrompt = promptText;
      }

      let currentTurnPrompt = outgoingPrompt;
      const MAX_CONTEXT_TURNS = 6;
      let turnsTaken = 0;

      while (turnsTaken < MAX_CONTEXT_TURNS) {
        if (abortCheck && abortCheck()) {
          return null;
        }

        turnsTaken++;

        // Record outgoing message
        const msgId = `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const userMsg: ConversationMessage = {
          id: msgId,
          role: 'user',
          content: currentTurnPrompt,
          timestamp: Date.now(),
        };
        session.history.push(userMsg);
        session.lastActiveTimestamp = Date.now();

        // Dispatch to persistent conversation
        let response: { responseText: string; conversationId: string };
        try {
          response = await this.dispatcher.sendMessage(session.conversationId, currentTurnPrompt, {
            providerId: session.providerId,
            taskId,
          });
        } catch (dispatchErr) {
          const errText = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
          session.history.push({
            id: `err_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
            role: 'system',
            content: `Provider error: ${errText}`,
            timestamp: Date.now(),
          });
          return null;
        }

        session.conversationId = response.conversationId;
        const assistantText = response.responseText;

        // Parse assistant turn
        const parsed = this.parseAssistantResponse(assistantText);

        // Record incoming response
        const respId = `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const assistantMsg: ConversationMessage = {
          id: respId,
          role: 'assistant',
          content: assistantText,
          timestamp: Date.now(),
          commandRequest: parsed.isCommand
            ? { command: parsed.commandName!, args: parsed.commandArgs ?? {} }
            : undefined,
          proposal: parsed.isProposal ? parsed.proposal : undefined,
        };
        session.history.push(assistantMsg);

        // If assistant proposed code, return it directly to the autopilot loop
        if (parsed.isProposal && parsed.proposal) {
          return parsed.proposal;
        }

        // If assistant requested a context command, execute it and send the result back
        if (parsed.isCommand && parsed.commandName) {
          const cmdRes = await this.executeContextCommand(
            taskId,
            parsed.commandName,
            parsed.commandArgs ?? {},
            getWorktreeRoot(),
          );

          const toolMsgId = `tool_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
          const toolContent = cmdRes.ok
            ? `Tool Result for ${parsed.commandName}:\n\`\`\`json\n${JSON.stringify(cmdRes.result, null, 2)}\n\`\`\`\nPlease continue with your analysis or code proposal.`
            : `Tool Error for ${parsed.commandName}: ${cmdRes.error}\nPlease continue or try another approach.`;

          const toolMsg: ConversationMessage = {
            id: toolMsgId,
            role: 'tool',
            content: toolContent,
            timestamp: Date.now(),
            commandResult: {
              command: parsed.commandName,
              ...(cmdRes.result !== undefined ? { result: cmdRes.result } : {}),
              ...(cmdRes.error !== undefined ? { error: cmdRes.error } : {}),
            },
          };
          session.history.push(toolMsg);

          // Loop back by sending tool output to the SAME conversation
          currentTurnPrompt = toolContent;
          continue;
        }

        // Assistant returned plain text without tools or proposal
        break;
      }

      return null;
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private extractJsonBlock(text: string): unknown {
    // 1. Try ```json ... ```
    const codeBlockMatch = text.match(/```(?:json|mediator-plan)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
      try {
        return JSON.parse(codeBlockMatch[1]);
      } catch {
        // continue
      }
    }

    // 2. Try raw text if starts with { and ends with }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch {
        // continue
      }
    }

    return null;
  }

  private walkDirSafe(dir: string, root: string, maxDepth: number, maxCount: number): string[] {
    const results: string[] = [];
    const noisy = new Set(['node_modules', '.git', '.mediator', 'dist', 'build', '.worktrees']);

    const scan = (current: string, depth: number): void => {
      if (depth > maxDepth || results.length >= maxCount) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= maxCount) break;
        if (noisy.has(entry.name) || entry.name.startsWith('.')) continue;

        const fullPath = path.join(current, entry.name);
        const relPath = path.relative(root, fullPath).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          results.push(`${relPath}/`);
          scan(fullPath, depth + 1);
        } else if (entry.isFile()) {
          results.push(relPath);
        }
      }
    };

    scan(dir, 0);
    return results;
  }

  private searchFilesSafe(
    dir: string,
    root: string,
    query: string,
    maxMatches: number,
  ): Array<{ path: string; lineNumber: number; lineContent: string }> {
    const matches: Array<{ path: string; lineNumber: number; lineContent: string }> = [];
    const noisy = new Set(['node_modules', '.git', '.mediator', 'dist', 'build', '.worktrees']);
    const lowerQuery = query.toLowerCase();

    const scan = (current: string): void => {
      if (matches.length >= maxMatches) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (matches.length >= maxMatches) break;
        if (noisy.has(entry.name) || entry.name.startsWith('.')) continue;

        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
        } else if (entry.isFile()) {
          // Check extension
          const ext = path.extname(entry.name).toLowerCase();
          const textExts = new Set(['.js', '.ts', '.jsx', '.tsx', '.json', '.md', '.txt', '.css', '.html', '.yaml', '.yml']);
          if (!textExts.has(ext)) continue;

          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split('\n');
            const relPath = path.relative(root, fullPath).replace(/\\/g, '/');

            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= maxMatches) break;
              if (lines[i]!.toLowerCase().includes(lowerQuery)) {
                matches.push({
                  path: relPath,
                  lineNumber: i + 1,
                  lineContent: lines[i]!.trim().slice(0, 160),
                });
              }
            }
          } catch {
            // Ignore unreadable files
          }
        }
      }
    };

    scan(dir);
    return matches;
  }

  private computeWorktreeDiff(
    worktreeRoot: string,
    baseRoot: string,
  ): { diff: string; changedFiles: string[] } {
    const changedFiles: string[] = [];
    const diffSnippets: string[] = [];

    const walk = (current: string): void => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const fullWorktreePath = path.join(current, entry.name);
        const relPath = path.relative(worktreeRoot, fullWorktreePath).replace(/\\/g, '/');
        const fullBasePath = path.join(baseRoot, relPath);

        if (entry.isDirectory()) {
          walk(fullWorktreePath);
        } else if (entry.isFile()) {
          try {
            const worktreeContent = fs.readFileSync(fullWorktreePath, 'utf8');
            let baseContent = '';
            if (fs.existsSync(fullBasePath)) {
              baseContent = fs.readFileSync(fullBasePath, 'utf8');
            }

            if (worktreeContent !== baseContent) {
              changedFiles.push(relPath);
              diffSnippets.push(`--- a/${relPath}\n+++ b/${relPath}\n@@ -1,${baseContent.split('\n').length} +1,${worktreeContent.split('\n').length} @@\n+${worktreeContent.slice(0, 500)}`);
            }
          } catch {
            // ignore
          }
        }
      }
    };

    walk(worktreeRoot);
    return {
      diff: diffSnippets.join('\n\n'),
      changedFiles,
    };
  }
}
