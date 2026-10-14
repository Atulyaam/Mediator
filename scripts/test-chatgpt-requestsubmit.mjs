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

  console.log('[Test Submit] Creating target...');
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

  // Focus and type prompt
  await sendSession('Runtime.evaluate', {
    expression: `document.querySelector('.ProseMirror')?.focus()`
  });
  const prompt = 'Please reply with the exact word HELLO_WORLD and nothing else.';
  await sendSession('Input.insertText', { text: prompt });
  await new Promise((r) => setTimeout(r, 1000));

  // Submit via button or form
  console.log('[Test Submit] Triggering form submit...');
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
  console.log('[Test Submit] Submit invocation result:', submitRes.result?.value);

  // Monitor assistant response for 20 seconds
  console.log('[Test Submit] Waiting for response...');
  let responseFound = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const check = await sendSession('Runtime.evaluate', {
      expression: `(() => {
        const assistants = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], .agent-turn, article[data-testid^="conversation-turn-"]'));
        const last = assistants[assistants.length - 1];
        const isStreaming = Boolean(document.querySelector('button[aria-label="Stop streaming"], button[data-testid="stop-button"]'));
        return {
          count: assistants.length,
          isStreaming,
          text: last ? last.innerText : '',
          url: window.location.href
        };
      })()`,
      returnByValue: true
    });
    const info = check.result?.value;
    console.log(`Poll ${i+1}: count=${info?.count}, streaming=${info?.isStreaming}, url=${info?.url}, text=${JSON.stringify(info?.text)}`);
    if (info?.text && !info?.isStreaming && info?.text.length > 0) {
      responseFound = true;
      console.log('SUCCESS! Real assistant reply received:', info?.text);
      break;
    }
  }

  await send('Target.closeTarget', { targetId: target.targetId });
  ws.close();
}

main().catch(console.error);
