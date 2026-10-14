/**
 * @mediator/browser-extension — ChatGPT DOM Fixtures & Test Doubles (Sprint S27)
 *
 * Synthetic, sanitized test fixtures covering all ChatGPT provider states:
 * 1. Supported conversation page (complete response with plain text)
 * 2. Response containing code blocks
 * 3. Still-streaming / incomplete response (stop button active)
 * 4. Login / authentication-required page
 * 5. Missing or ambiguous conversation identity (new chat / landing)
 * 6. Navigation to a different chat
 * 7. Unknown / changed DOM structure
 * 8. Empty response
 * 9. Completed assistant response containing protocol envelope (tags or code block)
 * 10. Conformance ping/pong echo response
 * 11. Branch switched / diverged conversation
 * 12. Active response regeneration in progress
 * 13. User message edited in conversation
 * 14. Interactive composer with send button click simulation
 * 15. Accepted submission (composer cleared + user query in DOM)
 * 16. Uncertain submission (composer still holds text)
 */

import { type MinimalDocument } from '../providerTypes.js';
import { MockElement } from './geminiFixtures.js';

export function createMockChatGPTDoc(rootChildren: MockElement[], href = 'https://chatgpt.com/c/c-test-1234'): MinimalDocument {
  const root = new MockElement('body', '', {}, rootChildren);
  return {
    location: { href },
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
  };
}

export function createChatGPTCompletedTextFixture(
  text: string,
  convId = 'c-test-1234',
  messageId?: string,
  branchId?: string,
): MinimalDocument {
  const assistantAttrs: Record<string, string> = {
    'data-message-author-role': 'assistant',
    'class': 'agent-turn',
  };
  if (messageId) assistantAttrs['data-message-id'] = messageId;
  if (branchId) assistantAttrs['data-branch-id'] = branchId;

  const assistantTurn = new MockElement(
    'article',
    text,
    assistantAttrs,
  );

  const container = new MockElement(
    'main',
    '',
    { 'data-conversation-id': convId },
    [assistantTurn],
  );

  return createMockChatGPTDoc([container], `https://chatgpt.com/c/${convId}`);
}

export function createChatGPTCompletedWithEnvelopeFixture(
  envelopeJson: string,
  convId = 'c-test-1234',
  options?: { inCodeBlock?: boolean; language?: string },
): MinimalDocument {
  const inCodeBlock = options?.inCodeBlock ?? false;
  const language = options?.language ?? 'json';

  let assistantContent: MockElement[];

  if (inCodeBlock) {
    const codeEl = new MockElement(
      'code',
      envelopeJson,
      { 'data-language': language, class: `language-${language}` },
    );
    const preEl = new MockElement('pre', envelopeJson, {}, [codeEl]);
    assistantContent = [
      new MockElement('p', 'Here is the proposed Mediator plan:'),
      preEl,
    ];
  } else {
    const fullText = `I have completed the review. Here is the envelope:\n\n<<<MEDIATOR_PLAN>>>\n${envelopeJson}\n<<<END_MEDIATOR_PLAN>>>\n\nPlease review.`;
    assistantContent = [
      new MockElement('div', fullText),
    ];
  }

  const assistantTurn = new MockElement(
    'article',
    inCodeBlock
      ? `Here is the proposed Mediator plan:\n${envelopeJson}`
      : `I have completed the review. Here is the envelope:\n\n<<<MEDIATOR_PLAN>>>\n${envelopeJson}\n<<<END_MEDIATOR_PLAN>>>\n\nPlease review.`,
    {
      'data-message-author-role': 'assistant',
      'class': 'agent-turn',
      'data-message-id': 'msg-assistant-env-1',
    },
    assistantContent,
  );

  const container = new MockElement(
    'main',
    '',
    { 'data-conversation-id': convId },
    [assistantTurn],
  );

  return createMockChatGPTDoc([container], `https://chatgpt.com/c/${convId}`);
}

export function createChatGPTStreamingFixture(convId = 'c-test-1234'): MinimalDocument {
  const stopButton = new MockElement(
    'button',
    'Stop',
    { 'data-testid': 'stop-button', 'aria-label': 'Stop streaming' },
  );

  const assistantTurn = new MockElement(
    'article',
    'Analyzing code...',
    {
      'data-message-author-role': 'assistant',
      'class': 'agent-turn result-streaming',
    },
  );

  const container = new MockElement(
    'main',
    '',
    { 'data-conversation-id': convId },
    [assistantTurn, stopButton],
  );

  return createMockChatGPTDoc([container], `https://chatgpt.com/c/${convId}`);
}

export function createChatGPTLoginRequiredFixture(): MinimalDocument {
  const loginButton = new MockElement(
    'button',
    'Log in',
    { 'data-testid': 'login-button' },
  );
  return createMockChatGPTDoc([loginButton], 'https://chatgpt.com/auth/login');
}

export function createChatGPTAmbiguousIdentityFixture(): MinimalDocument {
  const landingWelcome = new MockElement(
    'h1',
    'What can I help with today?',
    { class: 'landing-heading' },
  );
  const composer = new MockElement(
    'textarea',
    '',
    { id: 'prompt-textarea', placeholder: 'Ask anything' },
  );
  return createMockChatGPTDoc([landingWelcome, composer], 'https://chatgpt.com/');
}

export function createChatGPTBranchSwitchedFixture(convId = 'c-test-1234'): MinimalDocument {
  const branchIndicator = new MockElement(
    'div',
    'Branch diverged: 2 of 2',
    { 'data-branch-diverged': 'true', class: 'branch-switched' },
  );
  const container = new MockElement(
    'main',
    '',
    { 'data-conversation-id': convId },
    [branchIndicator],
  );
  return createMockChatGPTDoc([container], `https://chatgpt.com/c/${convId}`);
}

export function createChatGPTRegeneratingResponseFixture(convId = 'c-test-1234'): MinimalDocument {
  const regenIndicator = new MockElement(
    'div',
    'Regenerating...',
    { 'data-is-regenerating': 'true', class: 'regeneration-indicator' },
  );
  const container = new MockElement(
    'main',
    '',
    { 'data-conversation-id': convId },
    [regenIndicator],
  );
  return createMockChatGPTDoc([container], `https://chatgpt.com/c/${convId}`);
}

export function createChatGPTEditedMessageFixture(convId = 'c-test-1234'): MinimalDocument {
  const editedIndicator = new MockElement(
    'div',
    'Message edited',
    { 'data-message-edited': 'true', class: 'edited-indicator' },
  );
  const container = new MockElement(
    'main',
    '',
    { 'data-conversation-id': convId },
    [editedIndicator],
  );
  return createMockChatGPTDoc([container], `https://chatgpt.com/c/${convId}`);
}

export function createChatGPTInteractiveComposerFixture(
  convId = 'c-test-1234',
  initialComposerValue = '',
): { doc: MinimalDocument; composer: MockElement; sendButton: MockElement } {
  const composer = new MockElement(
    'textarea',
    initialComposerValue,
    { id: 'prompt-textarea', placeholder: 'Message ChatGPT' },
  );

  const sendButton = new MockElement(
    'button',
    'Send',
    { 'data-testid': 'send-button', 'aria-label': 'Send prompt' },
  );

  const assistantMessage = new MockElement(
    'article',
    'Ready for your input.',
    {
      'data-message-author-role': 'assistant',
      'class': 'agent-turn response-complete',
    },
  );

  const containerChildren: MockElement[] = [assistantMessage, composer, sendButton];

  const container = new MockElement(
    'main',
    '',
    { 'data-conversation-id': convId },
    containerChildren,
  );

  const doc = createMockChatGPTDoc([container], `https://chatgpt.com/c/${convId}`);

  sendButton.onclick = (): void => {
    const text = composer.value ?? '';
    composer.value = '';
    const userMsg = new MockElement('article', text, {
      'data-message-author-role': 'user',
      'class': 'user-turn',
    });
    containerChildren.push(userMsg);
  };

  return { doc, composer, sendButton };
}

export function createChatGPTAcceptedSubmissionFixture(
  queryText: string,
  convId = 'c-test-1234',
): MinimalDocument {
  const emptyComposer = new MockElement(
    'textarea',
    '',
    { id: 'prompt-textarea', placeholder: 'Message ChatGPT' },
  );
  const userTurn = new MockElement(
    'article',
    queryText,
    { 'data-message-author-role': 'user', class: 'user-turn' },
  );
  const container = new MockElement(
    'main',
    '',
    { 'data-conversation-id': convId },
    [emptyComposer, userTurn],
  );
  return createMockChatGPTDoc([container], `https://chatgpt.com/c/${convId}`);
}

export function createChatGPTUncertainSubmissionFixture(
  unsubmittedText: string,
  convId = 'c-test-1234',
): MinimalDocument {
  const dirtyComposer = new MockElement(
    'textarea',
    unsubmittedText,
    { id: 'prompt-textarea', placeholder: 'Message ChatGPT' },
  );
  const container = new MockElement(
    'main',
    '',
    { 'data-conversation-id': convId },
    [dirtyComposer],
  );
  return createMockChatGPTDoc([container], `https://chatgpt.com/c/${convId}`);
}

export function createChatGPTUnknownStructureFixture(convId = 'c-test-1234'): MinimalDocument {
  const weirdDiv = new MockElement('div', 'Unrecognized third-party frame', { id: 'unknown-vendor' });
  return createMockChatGPTDoc([weirdDiv], `https://chatgpt.com/c/${convId}`);
}

export function createChatGPTUnsupportedPageFixture(): MinimalDocument {
  return createMockChatGPTDoc([], 'https://unsupported-search-engine.org');
}

export function createChatGPTEmptyResponseFixture(convId = 'c-test-1234'): MinimalDocument {
  const assistantTurn = new MockElement(
    'article',
    '   ',
    { 'data-message-author-role': 'assistant', class: 'agent-turn' },
  );
  const container = new MockElement('main', '', { 'data-conversation-id': convId }, [assistantTurn]);
  return createMockChatGPTDoc([container], `https://chatgpt.com/c/${convId}`);
}

export function createChatGPTConformancePingPongFixture(
  sessionNonce: string,
  convId = 'c-test-1234',
): MinimalDocument {
  const echoText = `CONFORMANCE_PONG: ${sessionNonce} :: ALL_BOUNDARIES_VERIFIED`;
  return createChatGPTCompletedTextFixture(echoText, convId, 'msg-conformance-echo');
}
