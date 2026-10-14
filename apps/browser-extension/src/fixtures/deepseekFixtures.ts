/**
 * @mediator/browser-extension — DeepSeek DOM Fixtures & Test Doubles (Sprint S33)
 *
 * Synthetic, sanitized test fixtures covering all DeepSeek provider states:
 * 1. Supported conversation page (complete response with plain text)
 * 2. Response containing code blocks
 * 3. Still-streaming / incomplete response (loading/stop active)
 * 4. Login / authentication-required page
 * 5. Missing or ambiguous conversation identity (landing / new chat)
 * 6. Branch switched / diverged conversation
 * 7. Active response regeneration in progress
 * 8. User message edited in conversation
 * 9. Interactive composer with send button click simulation
 * 10. Accepted submission (composer cleared + user query in DOM)
 * 11. Uncertain submission (composer still holds text)
 * 12. Unknown / changed DOM structure
 * 13. Unsupported page
 * 14. Empty response
 * 15. Conformance ping/pong echo response
 */

import { type MinimalDocument } from '../providerTypes.js';
import { MockElement } from './geminiFixtures.js';

export function createMockDeepSeekDoc(rootChildren: MockElement[], href = 'https://chat.deepseek.com/chat/c-test-1234'): MinimalDocument {
  const root = new MockElement('body', '', {}, rootChildren);
  return {
    location: { href },
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
  };
}

export function createDeepSeekCompletedTextFixture(
  text: string,
  convId = 'c-test-1234',
  messageId?: string,
  branchId?: string,
): MinimalDocument {
  const assistantAttrs: Record<string, string> = {
    'class': 'ds-message-item chat-message',
    'data-role': 'assistant',
  };
  if (messageId) assistantAttrs['data-message-id'] = messageId;
  if (branchId) assistantAttrs['data-branch-id'] = branchId;

  const assistantTurn = new MockElement(
    'div',
    text,
    assistantAttrs,
  );

  const container = new MockElement(
    'div',
    '',
    { 'data-conversation-id': convId, class: 'chat-container' },
    [assistantTurn],
  );

  return createMockDeepSeekDoc([container], `https://chat.deepseek.com/chat/${convId}`);
}

export function createDeepSeekCompletedWithEnvelopeFixture(
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
    'div',
    inCodeBlock
      ? `Here is the proposed Mediator plan:\n${envelopeJson}`
      : `I have completed the review. Here is the envelope:\n\n<<<MEDIATOR_PLAN>>>\n${envelopeJson}\n<<<END_MEDIATOR_PLAN>>>\n\nPlease review.`,
    {
      'class': 'ds-message-item chat-message',
      'data-role': 'assistant',
      'data-message-id': 'msg-deepseek-env-1',
    },
    assistantContent,
  );

  const container = new MockElement(
    'div',
    '',
    { 'data-conversation-id': convId },
    [assistantTurn],
  );

  return createMockDeepSeekDoc([container], `https://chat.deepseek.com/chat/${convId}`);
}

export function createDeepSeekStreamingFixture(convId = 'c-test-1234'): MinimalDocument {
  const streamingEl = new MockElement(
    'div',
    'Generating...',
    { 'class': 'ds-loading streaming-indicator', 'data-testid': 'generating' },
  );

  const assistantTurn = new MockElement(
    'div',
    'Analyzing code...',
    {
      'class': 'ds-message-item chat-message ds-loading',
      'data-role': 'assistant',
    },
  );

  const container = new MockElement(
    'div',
    '',
    { 'data-conversation-id': convId },
    [assistantTurn, streamingEl],
  );

  return createMockDeepSeekDoc([container], `https://chat.deepseek.com/chat/${convId}`);
}

export function createDeepSeekLoginRequiredFixture(): MinimalDocument {
  const loginButton = new MockElement(
    'button',
    'Sign In',
    { 'data-testid': 'login-button' },
  );
  return createMockDeepSeekDoc([loginButton], 'https://chat.deepseek.com/sign_in');
}

export function createDeepSeekAmbiguousIdentityFixture(): MinimalDocument {
  const landingHeading = new MockElement(
    'h1',
    'Hi, I am DeepSeek.',
    { class: 'landing-heading' },
  );
  const composer = new MockElement(
    'textarea',
    '',
    { id: 'chat-input', placeholder: 'Message DeepSeek...' },
  );
  return createMockDeepSeekDoc([landingHeading, composer], 'https://chat.deepseek.com/');
}

export function createDeepSeekBranchSwitchedFixture(convId = 'c-test-1234'): MinimalDocument {
  const branchIndicator = new MockElement(
    'div',
    'Branch switched: 2 of 2',
    { 'data-branch-diverged': 'true', class: 'branch-switched ds-branch-switched' },
  );
  const container = new MockElement(
    'div',
    '',
    { 'data-conversation-id': convId },
    [branchIndicator],
  );
  return createMockDeepSeekDoc([container], `https://chat.deepseek.com/chat/${convId}`);
}

export function createDeepSeekRegeneratingResponseFixture(convId = 'c-test-1234'): MinimalDocument {
  const regenIndicator = new MockElement(
    'div',
    'Regenerating...',
    { class: 'ds-regenerating' },
  );
  const container = new MockElement(
    'div',
    '',
    { 'data-conversation-id': convId },
    [regenIndicator],
  );
  return createMockDeepSeekDoc([container], `https://chat.deepseek.com/chat/${convId}`);
}

export function createDeepSeekEditedMessageFixture(convId = 'c-test-1234'): MinimalDocument {
  const editedIndicator = new MockElement(
    'div',
    'Message edited',
    { class: 'ds-message-edited' },
  );
  const container = new MockElement(
    'div',
    '',
    { 'data-conversation-id': convId },
    [editedIndicator],
  );
  return createMockDeepSeekDoc([container], `https://chat.deepseek.com/chat/${convId}`);
}

export function createDeepSeekInteractiveComposerFixture(
  convId = 'c-test-1234',
  initialComposerValue = '',
): { doc: MinimalDocument; composer: MockElement; sendButton: MockElement } {
  const composerText = initialComposerValue;
  const userMessages: MockElement[] = [];

  const sendBtn = new MockElement(
    'button',
    'Send',
    { 'data-testid': 'send-button', 'aria-label': 'Send message', class: 'ds-send-btn' },
  );

  const composer = new MockElement(
    'textarea',
    composerText,
    { id: 'chat-input', placeholder: 'Message DeepSeek...' },
  );
  composer.value = composerText;

  const assistantMessage = new MockElement(
    'div',
    'Ready for your input.',
    {
      'class': 'ds-message-item chat-message response-complete',
      'data-role': 'assistant',
    },
  );

  const container = new MockElement(
    'div',
    '',
    { 'data-conversation-id': convId, class: 'chat-container' },
    [assistantMessage, ...userMessages, composer, sendBtn],
  );

  sendBtn.onclick = (): void => {
    if (composer.value && composer.value.trim().length > 0) {
      const submittedText = composer.value;
      composer.value = '';
      composer.textContent = '';
      const userTurn = new MockElement(
        'div',
        submittedText,
        { 'data-role': 'user', class: 'ds-user-message user-query' },
      );
      userMessages.push(userTurn);
      container.children.unshift(userTurn);
    }
  };

  const doc = createMockDeepSeekDoc([container], `https://chat.deepseek.com/chat/${convId}`);
  return { doc, composer, sendButton: sendBtn };
}


export function createDeepSeekAcceptedSubmissionFixture(
  promptText: string,
  convId = 'c-test-1234',
): MinimalDocument {
  const userTurn = new MockElement(
    'div',
    promptText,
    { 'data-role': 'user', class: 'ds-user-message user-query' },
  );

  const composer = new MockElement(
    'textarea',
    '',
    { id: 'chat-input', placeholder: 'Message DeepSeek...' },
  );
  composer.value = '';

  const sendBtn = new MockElement(
    'button',
    'Send',
    { 'data-testid': 'send-button', 'aria-label': 'Send message', class: 'ds-send-btn' },
  );

  const container = new MockElement(
    'div',
    '',
    { 'data-conversation-id': convId },
    [userTurn, composer, sendBtn],
  );

  return createMockDeepSeekDoc([container], `https://chat.deepseek.com/chat/${convId}`);
}

export function createDeepSeekUncertainSubmissionFixture(
  promptText: string,
  convId = 'c-test-1234',
): MinimalDocument {
  const composer = new MockElement(
    'textarea',
    promptText,
    { id: 'chat-input', placeholder: 'Message DeepSeek...' },
  );
  composer.value = promptText;

  const sendBtn = new MockElement(
    'button',
    'Send',
    { 'data-testid': 'send-button', 'aria-label': 'Send message', class: 'ds-send-btn' },
  );

  const container = new MockElement(
    'div',
    '',
    { 'data-conversation-id': convId },
    [composer, sendBtn],
  );

  return createMockDeepSeekDoc([container], `https://chat.deepseek.com/chat/${convId}`);
}

export function createDeepSeekUnknownStructureFixture(convId = 'c-test-1234'): MinimalDocument {
  const strangeEl = new MockElement('section', 'Unexpected layout', { id: 'alien-root' });
  return createMockDeepSeekDoc([strangeEl], `https://chat.deepseek.com/chat/${convId}`);
}

export function createDeepSeekUnsupportedPageFixture(): MinimalDocument {
  const div = new MockElement('div', 'Not deepseek', {});
  return createMockDeepSeekDoc([div], 'https://random-website.org/some-page');
}

export function createDeepSeekEmptyResponseFixture(convId = 'c-test-1234'): MinimalDocument {
  const assistantTurn = new MockElement(
    'div',
    '',
    { 'class': 'ds-message-item chat-message', 'data-role': 'assistant' },
  );
  const container = new MockElement('div', '', { 'data-conversation-id': convId }, [assistantTurn]);
  return createMockDeepSeekDoc([container], `https://chat.deepseek.com/chat/${convId}`);
}

export function createDeepSeekConformancePingPongFixture(
  nonce: string,
  convId = 'c-test-1234',
  taskId = 'task-conf-1',
  sessionId = 'sess-conf-1',
): MinimalDocument {
  const envelope = JSON.stringify({
    protocol_version: '1.3',
    task_id: taskId,
    session_id: sessionId,
    nonce,
    round_number: 1,
    sequence_number: 1,
    action_type: 'ping',
    status: 'completed',
    payload_hash: 'hash_ping_echo',
    conversation_id: convId,
    content: `CONFORMANCE_PONG:${nonce}`,
  });

  return createDeepSeekCompletedWithEnvelopeFixture(envelope, convId, { inCodeBlock: false });
}
