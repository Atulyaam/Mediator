/**
 * @mediator/browser-extension — Gemini DOM Fixtures & Test Doubles (Sprint S18 + S20)
 *
 * Synthetic, sanitized test fixtures covering all provider states:
 * 1. Supported conversation page (complete response with plain text)
 * 2. Response containing code blocks
 * 3. Still-streaming / incomplete response
 * 4. Login / authentication-required page
 * 5. Missing or ambiguous conversation identity
 * 6. Navigation to a different chat
 * 7. Unknown / changed DOM structure
 * 8. Empty response
 * 9. Oversized response
 * 10. Unsupported page
 * 11. Completed assistant response containing protocol envelope (tags or code block)
 * 12. Conformance ping/pong echo response
 * 13. Branch switched / diverged conversation
 * 14. Active response regeneration in progress
 * 15. User message edited in conversation
 * 16. Interactive composer with send button click simulation
 * 17. Accepted submission (composer cleared + user query in DOM)
 * 18. Uncertain submission (composer still holds text)
 */

import { type MinimalDocument, type MinimalElement } from '../providerTypes.js';

export class MockElement implements MinimalElement {
  public value?: string;
  public onclick?: (() => void) | undefined;

  constructor(
    public readonly tagName: string,
    public textContent: string | null = '',
    public readonly attributes: Record<string, string> = {},
    public readonly children: MockElement[] = [],
  ) {
    if (tagName.toLowerCase() === 'textarea' || tagName.toLowerCase() === 'input') {
      this.value = textContent ?? '';
    }
  }

  public click(): void {
    if (this.onclick) {
      this.onclick();
    }
  }

  public get innerHTML(): string {
    return this.textContent ?? '';
  }

  public getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  public querySelector(selector: string): MinimalElement | null {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0]! : null;
  }

  public querySelectorAll(selector: string): MinimalElement[] {
    const results: MinimalElement[] = [];

    const check = (el: MockElement): void => {
      if (this.matchesSelector(el, selector)) {
        results.push(el);
      }
      for (const child of el.children) {
        check(child);
      }
    };

    for (const child of this.children) {
      check(child);
    }

    return results;
  }

  public matchesSelector(el: MockElement, selector: string): boolean {
    const s = selector.trim();

    if (s.includes(' ')) {
      const parts = s.split(/\s+/);
      if (parts.length === 2) {
        const childSel = parts[1];
        if (childSel && this.matchesSimple(el, childSel)) {
          return true;
        }
        return false;
      }
    }

    if (s.includes(',')) {
      const parts = s.split(',').map((p) => p.trim());
      return parts.some((p) => this.matchesSelector(el, p));
    }

    return this.matchesSimple(el, s);
  }

  private matchesSimple(el: MockElement, s: string): boolean {
    if (s.startsWith('#')) {
      const id = s.slice(1);
      return el.attributes['id'] === id;
    }

    if (s.includes('#')) {
      const [tag, id] = s.split('#');
      if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      return el.attributes['id'] === id;
    }

    if (s.startsWith('.')) {
      const className = s.slice(1);
      const classes = (el.attributes['class'] ?? '').split(/\s+/);
      return classes.includes(className);
    }

    if (s.includes('.')) {
      const [tag, className] = s.split('.');
      if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      const classes = (el.attributes['class'] ?? '').split(/\s+/);
      return classes.includes(className!);
    }

    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1);
      return this.matchAttributeExpr(el, inner);
    }

    if (s.includes('[') && s.endsWith(']')) {
      const tag = s.slice(0, s.indexOf('['));
      if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      const inner = s.slice(s.indexOf('[') + 1, -1);
      return this.matchAttributeExpr(el, inner);
    }

    return el.tagName.toLowerCase() === s.toLowerCase();
  }

  private matchAttributeExpr(el: MockElement, expr: string): boolean {
    if (expr.includes('*=')) {
      const [name, valRaw] = expr.split('*=');
      const val = valRaw?.replace(/['"]/g, '').replace(/\s+[iI]$/, '').toLowerCase() ?? '';
      const actual = (el.attributes[name!] ?? '').toLowerCase();
      return actual.includes(val);
    }
    if (expr.includes('=')) {
      const [name, valRaw] = expr.split('=');
      const val = valRaw?.replace(/['"]/g, '').replace(/\s+[iI]$/, '') ?? '';
      return el.attributes[name!] === val;
    }
    return expr in el.attributes;
  }
}

export class MockDocument implements MinimalDocument {
  constructor(
    public readonly rootElements: MockElement[],
    public readonly location: { href: string } = { href: 'https://gemini.google.com/app/test-conv-001' },
  ) {}

  public querySelector(selector: string): MinimalElement | null {
    for (const root of this.rootElements) {
      if (root.tagName.toLowerCase() === selector.toLowerCase() || (root as unknown as MockElement).matchesSelector?.(root, selector)) {
        return root;
      }
      const found = root.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  public querySelectorAll(selector: string): MinimalElement[] {
    const results: MinimalElement[] = [];
    for (const root of this.rootElements) {
      results.push(...root.querySelectorAll(selector));
    }
    return results;
  }
}

// ─── Fixture Generators (S18) ──────────────────────────────────────────────

/**
 * 1. Supported conversation page (complete response with plain text)
 */
export function createCompletedTextFixture(
  conversationId = 'conv-gemini-123',
  text = 'Here is the completed solution for the requested task.',
): MockDocument {
  const composer = new MockElement('rich-textarea', '', {}, [
    new MockElement('textarea', '', { 'aria-label': 'Enter a prompt here' }),
  ]);

  const assistantMessage = new MockElement(
    'div',
    text,
    { class: 'model-response-text response-complete', 'data-message-author': 'assistant' },
  );

  const container = new MockElement(
    'div',
    '',
    { class: 'conversation-container', 'data-conversation-id': conversationId },
    [assistantMessage, composer],
  );

  return new MockDocument([container], { href: `https://gemini.google.com/app/${conversationId}` });
}

/**
 * 2. Completed assistant response with code blocks
 */
export function createCompletedWithCodeFixture(
  conversationId = 'conv-gemini-code',
  text = 'Here is the implementation in TypeScript:',
  codeSnippet = 'export function validate() { return true; }',
  language = 'typescript',
): MockDocument {
  const codeElem = new MockElement('code', codeSnippet, { class: `language-${language}`, 'data-language': language });
  const preElem = new MockElement('pre', codeSnippet, { class: `code-block language-${language}`, 'data-language': language }, [codeElem]);

  const assistantMessage = new MockElement(
    'div',
    `${text}\n${codeSnippet}`,
    { class: 'model-response-text response-complete', 'data-message-author': 'assistant' },
    [new MockElement('p', text), preElem],
  );

  const composer = new MockElement('textarea', '', { class: 'chat-input-textarea' });
  const container = new MockElement(
    'div',
    '',
    { class: 'conversation-container', 'data-conversation-id': conversationId },
    [assistantMessage, composer],
  );

  return new MockDocument([container], { href: `https://gemini.google.com/app/${conversationId}` });
}

/**
 * 3. Still-streaming / incomplete response
 */
export function createStreamingFixture(
  conversationId = 'conv-gemini-stream',
  partialText = 'I am currently generating the code...',
): MockDocument {
  const streamingMarker = new MockElement('div', '', { class: 'response-streaming cursor-blink', 'data-is-streaming': 'true' });
  const assistantMessage = new MockElement(
    'div',
    partialText,
    { class: 'model-response-text', 'data-message-author': 'assistant' },
    [new MockElement('span', partialText), streamingMarker],
  );

  const container = new MockElement(
    'div',
    '',
    { class: 'conversation-container', 'data-conversation-id': conversationId },
    [assistantMessage],
  );

  return new MockDocument([container], { href: `https://gemini.google.com/app/${conversationId}` });
}

/**
 * 4. Login / authentication-required page
 */
export function createLoginRequiredFixture(): MockDocument {
  const loginBtn = new MockElement('a', 'Sign in with Google', {
    href: 'https://accounts.google.com/signin',
    'data-action': 'sign-in',
    class: 'login-required',
  });

  const wall = new MockElement('div', 'Please sign in to continue', { class: 'auth-wall' }, [loginBtn]);

  return new MockDocument([wall], { href: 'https://gemini.google.com/' });
}

/**
 * 5. Missing or ambiguous conversation identity (landing page without convId)
 */
export function createAmbiguousIdentityFixture(): MockDocument {
  const landingHeader = new MockElement('h1', 'Hello, how can I help?');
  const composer = new MockElement('textarea', '', { 'aria-label': 'Ask Gemini' });
  const landingRoot = new MockElement('div', '', { class: 'landing-page' }, [landingHeader, composer]);

  return new MockDocument([landingRoot], { href: 'https://gemini.google.com/app' });
}

/**
 * 6. Navigation to a different chat
 */
export function createNavigatedChatFixture(newConversationId = 'conv-gemini-navigated'): MockDocument {
  return createCompletedTextFixture(newConversationId, 'New chat response in navigated conversation.');
}

/**
 * 7. Unknown / changed DOM structure
 */
export function createUnknownStructureFixture(): MockDocument {
  const unknownDiv = new MockElement('div', 'Completely unrecognized experimental layout', {
    class: 'experimental-untested-redesign-2027',
  });

  return new MockDocument([unknownDiv], { href: 'https://gemini.google.com/app/conv-999' });
}

/**
 * 8. Empty response element
 */
export function createEmptyResponseFixture(conversationId = 'conv-empty'): MockDocument {
  const emptyAssistantMessage = new MockElement(
    'div',
    '   ',
    { class: 'model-response-text response-complete', 'data-message-author': 'assistant' },
  );

  const container = new MockElement(
    'div',
    '',
    { class: 'conversation-container', 'data-conversation-id': conversationId },
    [emptyAssistantMessage],
  );

  return new MockDocument([container], { href: `https://gemini.google.com/app/${conversationId}` });
}

/**
 * 9. Oversized response fixture
 */
export function createOversizedResponseFixture(conversationId = 'conv-oversized', size = 30000): MockDocument {
  const giantText = 'X'.repeat(size);
  return createCompletedTextFixture(conversationId, giantText);
}

/**
 * 10. Unsupported third-party domain page
 */
export function createUnsupportedPageFixture(): MockDocument {
  const body = new MockElement('div', 'Welcome to an unrelated website');
  return new MockDocument([body], { href: 'https://example.com/some/page' });
}

// ─── Sprint S20 Same-Chat Fixture Generators ───────────────────────────────

export interface EnvelopeFixtureOptions {
  readonly messageId?: string | undefined;
  readonly branchId?: string | undefined;
  readonly introText?: string | undefined;
}

/**
 * 11. Completed assistant response containing a protocol envelope
 */
export function createCompletedWithEnvelopeFixture(
  conversationId: string,
  envelope: string | Record<string, unknown>,
  format: 'tags' | 'code-block' | 'markdown-code' = 'tags',
  options?: EnvelopeFixtureOptions,
): MockDocument {
  const jsonStr = typeof envelope === 'string' ? envelope : JSON.stringify(envelope, null, 2);
  const intro = options?.introText ?? 'Here is my proposed plan:';

  let renderedContent: string;
  let codeChild: MockElement | null = null;

  if (format === 'tags') {
    renderedContent = `${intro}\n<<<MEDIATOR_PLAN>>>\n${jsonStr}\n<<<END_MEDIATOR_PLAN>>>`;
  } else if (format === 'code-block') {
    renderedContent = `${intro}\n${jsonStr}`;
    codeChild = new MockElement('pre', jsonStr, { class: 'code-block language-json', 'data-language': 'json' }, [
      new MockElement('code', jsonStr, { class: 'language-json', 'data-language': 'json' }),
    ]);
  } else {
    renderedContent = `${intro}\n\`\`\`json\n${jsonStr}\n\`\`\``;
  }

  const attrs: Record<string, string> = {
    class: 'model-response-text response-complete',
    'data-message-author': 'assistant',
  };
  if (options?.messageId) {
    attrs['data-message-id'] = options.messageId;
    attrs['id'] = options.messageId;
  }

  const assistantChildren: MockElement[] = [new MockElement('p', intro)];
  if (codeChild) {
    assistantChildren.push(codeChild);
  }

  const assistantMessage = new MockElement('div', renderedContent, attrs, assistantChildren);

  const composerTextarea = new MockElement('textarea', '', {
    class: 'chat-input-textarea',
    'aria-label': 'Enter a prompt here',
  });
  const sendButton = new MockElement('button', 'Send', {
    class: 'send-button',
    'aria-label': 'Send message',
  });

  const composerContainer = new MockElement('div', '', { class: 'composer-container' }, [
    composerTextarea,
    sendButton,
  ]);

  const containerChildren: MockElement[] = [assistantMessage, composerContainer];

  if (options?.branchId) {
    containerChildren.push(
      new MockElement('div', `Branch ${options.branchId}`, {
        class: 'branch-indicator',
        'data-branch-id': options.branchId,
      }),
    );
  }

  const container = new MockElement(
    'div',
    '',
    { class: 'conversation-container', 'data-conversation-id': conversationId },
    containerChildren,
  );

  return new MockDocument([container], { href: `https://gemini.google.com/app/${conversationId}` });
}

/**
 * 12. Conformance ping/pong echo response fixture
 */
export function createConformancePingPongFixture(
  conversationId: string,
  sessionNonce: string,
  taskId = 'task-demo-01',
  sessionId = 'session-demo-01',
  round = 1,
  sequence = 1,
): MockDocument {
  const envelope = {
    protocol_version: '1.3',
    task_id: taskId,
    session_id: sessionId,
    nonce: sessionNonce,
    round,
    sequence,
    conversation: {
      provider: 'google-gemini',
      conversation_id: conversationId,
      tab_id: 1,
    },
    base_state_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    status: 'continue',
    actions: [
      {
        id: 'act_ping_1',
        type: 'get_task_brief',
        parameters: {},
      },
    ],
    content_blocks: [],
  };

  return createCompletedWithEnvelopeFixture(conversationId, envelope, 'tags', {
    messageId: 'msg-assistant-conformance-1',
    branchId: '1/1',
  });
}

/**
 * 13. Branch switched / diverged conversation fixture
 */
export function createBranchSwitchedFixture(
  conversationId = 'conv-gemini-branch',
  branchId = '2/2',
): MockDocument {
  const branchDivergedElem = new MockElement('div', 'Branch 2 of 2', {
    class: 'branch-switched',
    'data-branch-diverged': 'true',
    'data-branch-id': branchId,
  });

  const assistantMessage = new MockElement(
    'div',
    'Alternative answer on branch 2',
    { class: 'model-response-text response-complete', 'data-message-author': 'assistant' },
    [branchDivergedElem],
  );

  const container = new MockElement(
    'div',
    '',
    { class: 'conversation-container', 'data-conversation-id': conversationId },
    [assistantMessage],
  );

  return new MockDocument([container], { href: `https://gemini.google.com/app/${conversationId}` });
}

/**
 * 14. Active response regeneration in progress
 */
export function createRegeneratingResponseFixture(conversationId = 'conv-gemini-regen'): MockDocument {
  const regenElem = new MockElement('div', 'Regenerating...', {
    class: 'regeneration-indicator',
    'data-is-regenerating': 'true',
  });

  const assistantMessage = new MockElement(
    'div',
    'Old answer being replaced...',
    { class: 'model-response-text', 'data-message-author': 'assistant' },
    [regenElem],
  );

  const container = new MockElement(
    'div',
    '',
    { class: 'conversation-container', 'data-conversation-id': conversationId },
    [assistantMessage],
  );

  return new MockDocument([container], { href: `https://gemini.google.com/app/${conversationId}` });
}

/**
 * 15. User message edited in conversation
 */
export function createEditedMessageFixture(conversationId = 'conv-gemini-edited'): MockDocument {
  const editedIndicator = new MockElement('span', '(edited)', {
    class: 'edited-indicator',
    'data-message-edited': 'true',
  });

  const userMessage = new MockElement(
    'div',
    'Edited user prompt',
    { class: 'user-message', 'data-message-author': 'user' },
    [editedIndicator],
  );

  const assistantMessage = new MockElement(
    'div',
    'Response to edited prompt',
    { class: 'model-response-text response-complete', 'data-message-author': 'assistant' },
  );

  const container = new MockElement(
    'div',
    '',
    { class: 'conversation-container', 'data-conversation-id': conversationId },
    [userMessage, assistantMessage],
  );

  return new MockDocument([container], { href: `https://gemini.google.com/app/${conversationId}` });
}

/**
 * 16. Interactive composer with send button click simulation
 */
export function createInteractiveComposerFixture(
  conversationId = 'conv-interactive',
  initialValue = '',
): { doc: MockDocument; composer: MockElement; sendButton: MockElement } {
  const composer = new MockElement('textarea', initialValue, {
    class: 'chat-input-textarea',
    'aria-label': 'Enter a prompt here',
  });

  const sendButton = new MockElement('button', 'Send', {
    class: 'send-button',
    'aria-label': 'Send message',
  });

  const assistantMessage = new MockElement(
    'div',
    'Ready for your input.',
    { class: 'model-response-text response-complete', 'data-message-author': 'assistant' },
  );

  const container = new MockElement(
    'div',
    '',
    { class: 'conversation-container', 'data-conversation-id': conversationId },
    [assistantMessage, composer, sendButton],
  );

  const doc = new MockDocument([container], { href: `https://gemini.google.com/app/${conversationId}` });

  sendButton.onclick = (): void => {
    // Simulated composer clearing and user message append
    const text = composer.value ?? '';
    composer.value = '';
    const userMsg = new MockElement('div', text, {
      class: 'user-message',
      'data-message-author': 'user',
    });
    container.children.push(userMsg);
  };

  return { doc, composer, sendButton };
}

/**
 * 17. Accepted submission (composer cleared + user query in DOM)
 */
export function createAcceptedSubmissionFixture(
  conversationId: string,
  submittedText: string,
): MockDocument {
  const userMessage = new MockElement(
    'div',
    submittedText,
    { class: 'user-message', 'data-message-author': 'user' },
  );

  const composer = new MockElement('textarea', '', {
    class: 'chat-input-textarea',
    'aria-label': 'Enter a prompt here',
  });
  composer.value = ''; // explicitly cleared

  const sendButton = new MockElement('button', 'Send', {
    class: 'send-button',
    'aria-label': 'Send message',
  });

  const container = new MockElement(
    'div',
    '',
    { class: 'conversation-container', 'data-conversation-id': conversationId },
    [userMessage, composer, sendButton],
  );

  return new MockDocument([container], { href: `https://gemini.google.com/app/${conversationId}` });
}

/**
 * 18. Uncertain submission (composer still holds text, no user message)
 */
export function createUncertainSubmissionFixture(
  conversationId: string,
  submittedText: string,
): MockDocument {
  const composer = new MockElement('textarea', submittedText, {
    class: 'chat-input-textarea',
    'aria-label': 'Enter a prompt here',
  });
  composer.value = submittedText; // Uncleared

  const sendButton = new MockElement('button', 'Send', {
    class: 'send-button',
    'aria-label': 'Send message',
  });

  const container = new MockElement(
    'div',
    '',
    { class: 'conversation-container', 'data-conversation-id': conversationId },
    [composer, sendButton],
  );

  return new MockDocument([container], { href: `https://gemini.google.com/app/${conversationId}` });
}
