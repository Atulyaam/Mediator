import WebSocket from 'ws';

async function main() {
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

  console.log('[ChatGPT ProseMirror] Creating target...');
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

  // Focus the ProseMirror composer
  console.log('[ChatGPT ProseMirror] Focusing composer...');
  const focusRes = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const composer = document.querySelector('.ProseMirror') || document.querySelector('[contenteditable="true"]') || document.querySelector('#prompt-textarea');
      if (composer) {
        composer.focus();
        return { ok: true, tag: composer.tagName, className: composer.className };
      }
      return { ok: false, error: 'Composer not found' };
    })()`,
    returnByValue: true
  });
  console.log('[ChatGPT ProseMirror] Focus result:', focusRes.result?.value);

  // Type real text via CDP Input.insertText
  const promptText = 'Hello! Please reply with exactly the word PONG.';
  console.log('[ChatGPT ProseMirror] Typing text via Input.insertText...');
  await sendSession('Input.insertText', { text: promptText });
  await new Promise((r) => setTimeout(r, 1000));

  // Check composer content
  const checkText = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const composer = document.querySelector('.ProseMirror') || document.querySelector('[contenteditable="true"]');
      const sendBtn = document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[aria-label*="Send"]');
      return {
        composerText: composer ? composer.innerText : null,
        sendBtnDisabled: sendBtn ? sendBtn.disabled : null
      };
    })()`,
    returnByValue: true
  });
  console.log('[ChatGPT ProseMirror] After typing:', checkText.result?.value);

  // Click Send button or send Enter key
  console.log('[ChatGPT ProseMirror] Pressing Enter key...');
  await sendSession('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
  await sendSession('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 500));

  // Also try clicking the send button if not sent
  await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const sendBtn = document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[aria-label*="Send"]');
      if (sendBtn && !sendBtn.disabled) sendBtn.click();
    })()`
  });

  // Watch for assistant turn
  console.log('[ChatGPT ProseMirror] Watching for response...');
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await sendSession('Runtime.evaluate', {
      expression: `(() => {
        const assistant = document.querySelector('[data-message-author-role="assistant"], .agent-turn, article[data-testid^="conversation-turn-"]');
        return {
          hasAssistant: Boolean(assistant),
          text: assistant ? assistant.innerText : ''
        };
      })()`,
      returnByValue: true
    });
    console.log(`[ChatGPT ProseMirror] Poll ${i + 1}: hasAssistant=${res.result?.value?.hasAssistant}, text=${JSON.stringify(res.result?.value?.text)}`);
    if (res.result?.value?.text && res.result?.value?.text.length > 2) {
      console.log('SUCCESS! Got ChatGPT response:', res.result?.value?.text);
      break;
    }
  }

  await send('Target.closeTarget', { targetId: target.targetId });
  ws.close();
}

main().catch(console.error);
