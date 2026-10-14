import WebSocket from 'ws';

async function main() {
  console.log('=== [LIVE PROVIDER] Submitting Real Coding Task to ChatGPT ===');
  const version = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  let id = 1;
  const send = (method, params = {}) => new Promise((resolve) => {
    const curId = id++;
    const handler = (msg) => {
      const data = JSON.parse(msg.toString());
      if (data.id === curId) {
        ws.off('message', handler);
        resolve(data.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id: curId, method, params }));
  });

  await new Promise((r) => ws.on('open', r));

  console.log('[Live ChatGPT] Creating new chat target on https://chatgpt.com...');
  const target = await send('Target.createTarget', { url: 'https://chatgpt.com' });
  const attach = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sId = attach.sessionId;

  const sendSession = (method, params = {}) => new Promise((resolve, reject) => {
    const curId = id++;
    const handler = (msg) => {
      const data = JSON.parse(msg.toString());
      if (data.id === curId && data.sessionId === sId) {
        ws.off('message', handler);
        if (data.error) reject(new Error(JSON.stringify(data.error)));
        else resolve(data.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id: curId, sessionId: sId, method, params }));
  });

  await sendSession('Page.enable');
  await sendSession('Runtime.enable');
  await new Promise((r) => setTimeout(r, 6000));

  // Focus ProseMirror composer
  console.log('[Live ChatGPT] Focusing ProseMirror composer...');
  const focusRes = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const composer = document.querySelector('.ProseMirror') || document.querySelector('[contenteditable="true"]');
      if (composer) {
        composer.focus();
        return { ok: true };
      }
      return { ok: false, error: 'Composer not found' };
    })()`,
    returnByValue: true
  });
  console.log('[Live ChatGPT] Focus result:', focusRes.result?.value);

  // Coding prompt
  const codingPrompt = `You are an AI coding assistant for Mediator.
Task: Fix the bug in src/math.js.
Problem: multiply(a, b) currently returns a + b instead of a * b.

Provide the full corrected file src/math.js.
Output your solution strictly in the following JSON format inside a single json markdown code block:
\`\`\`json
{
  "path": "src/math.js",
  "fixed_code": "// Mathematics calculation module\\nexport function multiply(a, b) {\\n  return a * b;\\n}\\n\\nexport function divide(a, b) {\\n  if (b === 0) throw new Error('Division by zero');\\n  return a / b;\\n}\\n"
}
\`\`\`
Do not include any other markdown text or conversation outside the json code block.`;

  console.log('[Live ChatGPT] Typing prompt via Input.insertText...');
  await sendSession('Input.insertText', { text: codingPrompt });
  await new Promise((r) => setTimeout(r, 1000));

  console.log('[Live ChatGPT] Submitting prompt via form.requestSubmit...');
  const submitRes = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const sendBtn = document.querySelector('button[aria-label="Send"]') || document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[type="submit"]');
      if (sendBtn) {
        const form = sendBtn.closest('form');
        if (form && form.requestSubmit) {
          form.requestSubmit(sendBtn);
          return { ok: true, method: 'form.requestSubmit' };
        }
        sendBtn.click();
        return { ok: true, method: 'button.click' };
      }
      return { ok: false, error: 'No send button found' };
    })()`,
    returnByValue: true
  });
  console.log('[Live ChatGPT] Submit result:', submitRes.result?.value);

  // Monitor assistant response
  console.log('[Live ChatGPT] Polling for live assistant response...');
  let complete = false;
  let responseData = null;

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await sendSession('Runtime.evaluate', {
      expression: `(() => {
        const url = window.location.href;
        const isStreaming = Boolean(document.querySelector('button[aria-label="Stop streaming"], button[data-testid="stop-button"]'));
        const assistants = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], .agent-turn, article[data-testid^="conversation-turn-"]'));
        const last = assistants[assistants.length - 1];
        const text = last ? last.innerText : '';
        const codeBlock = last ? last.querySelector('pre code') : null;
        return {
          url,
          isStreaming,
          assistantCount: assistants.length,
          textLength: text.length,
          snippet: text.slice(0, 300),
          fullText: text,
          codeBlockText: codeBlock ? codeBlock.innerText : null
        };
      })()`,
      returnByValue: true
    });

    const status = poll.result?.value;
    console.log(`Poll ${i + 1}/30: url=${status?.url}, streaming=${status?.isStreaming}, len=${status?.textLength}, hasCode=${Boolean(status?.codeBlockText)}`);

    if (status?.textLength > 30 && !status?.isStreaming) {
      complete = true;
      responseData = status;
      break;
    }
  }

  if (complete) {
    console.log('=== [SUCCESS] Genuine ChatGPT Response Captured! ===');
    console.log('Conversation URL:', responseData.url);
    console.log('Response Snippet:\n', responseData.snippet);
    console.log('Code Block Text:\n', responseData.codeBlockText);
  } else {
    console.error('=== [FAILED] Did not capture complete response in time. ===');
  }

  await send('Target.closeTarget', { targetId: target.targetId });
  ws.close();
}

main().catch(console.error);
