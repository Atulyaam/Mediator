import WebSocket from 'ws';

async function main() {
  console.log('=== Testing Live OpenAI ChatGPT Browser Bridge ===');
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

  console.log('[ChatGPT Test] Creating target for https://chatgpt.com...');
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
  await sendSession('DOM.enable');
  await new Promise((r) => setTimeout(r, 6000));

  // Check authentication
  const authCheck = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const loginBtn = document.querySelector('a[href*="/auth/login"], [data-testid="login-button"]');
      const text = document.body ? document.body.innerText : '';
      const isLoggedOut = Boolean(loginBtn) || (text.includes('Log in') && !document.querySelector('.ProseMirror, [contenteditable="true"]'));
      return {
        url: window.location.href,
        isLoggedOut,
        hasUser: Boolean(!isLoggedOut && document.querySelector('.ProseMirror, [contenteditable="true"]')),
        title: document.title
      };
    })()`,
    returnByValue: true
  });
  console.log('[ChatGPT Test] Auth State:', authCheck.result?.value);

  if (authCheck.result?.value?.isLoggedOut) {
    console.error('[ChatGPT Test] FAILED: User is not authenticated on chatgpt.com.');
    await send('Target.closeTarget', { targetId: target.targetId });
    ws.close();
    process.exit(1);
  }

  // Type prompt into composer and submit
  const testPrompt = `Fix this bug in calc.js: function add(a, b) { return a - b; }. Output your answer as a JSON block with { "path": "calc.js", "fixed_code": "..." } only.`;
  console.log('[ChatGPT Test] Inserting prompt into composer...');

  const insertRes = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const composer = document.querySelector('#prompt-textarea') || document.querySelector('.ProseMirror') || document.querySelector('[contenteditable="true"]');
      if (!composer) return { ok: false, error: 'Composer not found' };
      
      composer.focus();
      if ('value' in composer) {
        composer.value = ${JSON.stringify(testPrompt)};
      } else {
        composer.innerText = ${JSON.stringify(testPrompt)};
      }
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, composerTag: composer.tagName };
    })()`,
    returnByValue: true
  });
  console.log('[ChatGPT Test] Insert result:', insertRes.result?.value);

  await new Promise((r) => setTimeout(r, 1000));

  // Click send button
  console.log('[ChatGPT Test] Clicking send button...');
  const sendRes = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const btn = document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[aria-label*="Send"]');
      if (!btn) return { ok: false, error: 'Send button not found' };
      btn.click();
      return { ok: true, disabled: btn.disabled };
    })()`,
    returnByValue: true
  });
  console.log('[ChatGPT Test] Send button click result:', sendRes.result?.value);

  // Wait for response to stream and finish (poll for up to 25 seconds)
  console.log('[ChatGPT Test] Waiting for ChatGPT assistant response...');
  let responseText = '';
  let complete = false;

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const pollRes = await sendSession('Runtime.evaluate', {
      expression: `(() => {
        const stopBtn = document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop streaming"]');
        const assistantElems = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], .agent-turn, article[data-testid^="conversation-turn-"]'));
        const lastAssistant = assistantElems[assistantElems.length - 1];
        const text = lastAssistant ? lastAssistant.innerText : '';
        return {
          isStreaming: Boolean(stopBtn),
          hasAssistant: Boolean(lastAssistant),
          textLength: text.length,
          snippet: text.slice(0, 300)
        };
      })()`,
      returnByValue: true
    });

    const status = pollRes.result?.value;
    console.log(`[ChatGPT Test] Poll ${i + 1}/25: hasAssistant=${status?.hasAssistant}, isStreaming=${status?.isStreaming}, len=${status?.textLength}`);

    if (status?.hasAssistant && !status?.isStreaming && status?.textLength > 20) {
      complete = true;
      responseText = status.snippet;
      break;
    }
  }

  console.log('[ChatGPT Test] Final response complete:', complete);
  console.log('[ChatGPT Test] Response text snippet:\n', responseText);

  await send('Target.closeTarget', { targetId: target.targetId });
  ws.close();

  if (!complete) {
    console.error('[ChatGPT Test] TIMEOUT / INCOMPLETE response from ChatGPT.');
    process.exit(1);
  } else {
    console.log('=== ChatGPT Live Provider Test PASSED ===');
    process.exit(0);
  }
}

main().catch(console.error);
