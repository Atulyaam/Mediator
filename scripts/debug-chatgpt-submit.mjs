import WebSocket from 'ws';
import fs from 'node:fs';

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

  const target = await send('Target.createTarget', { url: 'https://chatgpt.com' });
  const attach = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sId = attach.sessionId;
  
  const sendSession = (method, params = {}) => new Promise((resolve) => {
    const curId = id++;
    const handler = (msg) => {
      const data = JSON.parse(msg.toString());
      if (data.id === curId && data.sessionId === sId) {
        ws.off('message', handler);
        resolve(data.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id: curId, sessionId: sId, method, params }));
  });

  await sendSession('Page.enable');
  await sendSession('Runtime.enable');
  await new Promise((r) => setTimeout(r, 6000));

  // Focus and type
  await sendSession('Runtime.evaluate', {
    expression: `document.querySelector('.ProseMirror')?.focus()`
  });
  await sendSession('Input.insertText', { text: 'Hello! Please reply with PONG.' });
  await new Promise((r) => setTimeout(r, 1000));

  // Check send button attributes
  const btnInfo = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const btn = document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[aria-label*="Send"]');
      if (!btn) return { hasBtn: false };
      return {
        hasBtn: true,
        disabled: btn.disabled,
        ariaDisabled: btn.getAttribute('aria-disabled'),
        outerHTML: btn.outerHTML,
        rect: btn.getBoundingClientRect()
      };
    })()`,
    returnByValue: true
  });
  console.log('Send Button Info:', btnInfo.result?.value);

  // Take screenshot
  const ss = await sendSession('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('C:/Users/Atul2/.gemini/antigravity-ide/brain/3dd0480a-7b48-4503-b4d3-a72f83b06237/chatgpt_composer_debug.png', Buffer.from(ss.data, 'base64'));
  console.log('Screenshot saved to chatgpt_composer_debug.png');

  await send('Target.closeTarget', { targetId: target.targetId });
  ws.close();
}

main().catch(console.error);
