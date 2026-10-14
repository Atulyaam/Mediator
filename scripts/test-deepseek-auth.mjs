import WebSocket from 'ws';
import fs from 'fs';

async function main() {
  const versionRes = await fetch('http://127.0.0.1:9222/json/version');
  const { webSocketDebuggerUrl } = await versionRes.json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  let id = 1;
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const curId = id++;
    const onMsg = (msg) => {
      const data = JSON.parse(msg.toString());
      if (data.id === curId) {
        ws.off('message', onMsg);
        if (data.error) reject(new Error(JSON.stringify(data.error)));
        else resolve(data.result);
      }
    };
    ws.on('message', onMsg);
    const payload = { id: curId, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
  });

  const targetsRes = await send('Target.getTargets');
  const deepseek = targetsRes.targetInfos.find(t => t.url.includes('deepseek.com'));
  const { sessionId } = await send('Target.attachToTarget', { targetId: deepseek.targetId, flatten: true });
  
  // Focus textarea and enter text via CDP
  const evalFocus = await send('Runtime.evaluate', {
    expression: `(() => {
      const ta = document.querySelector('textarea');
      if (ta) {
        ta.focus();
        return true;
      }
      return false;
    })()`,
    returnByValue: true
  }, sessionId);

  if (evalFocus.result.value) {
    await send('Input.insertText', { text: 'Hello DeepSeek' }, sessionId);
    await new Promise(r => setTimeout(r, 1000));
    
    // Check if send button enabled
    const clickRes = await send('Runtime.evaluate', {
      expression: `(() => {
        const buttons = Array.from(document.querySelectorAll('div[role="button"], button'));
        for (const b of buttons) {
          if (b.querySelector('svg') && b.closest('.chat-input, [class*="input"]')) {
            b.click();
            return { clicked: true, tag: b.tagName, cls: b.className };
          }
        }
        // Fallback: click last button with svg
        const svgBtns = buttons.filter(b => b.querySelector('svg'));
        if (svgBtns.length) {
          const last = svgBtns[svgBtns.length - 1];
          last.click();
          return { clicked: true, fallback: true, tag: last.tagName };
        }
        return { clicked: false };
      })()`,
      returnByValue: true
    }, sessionId);
    console.log('Click result:', clickRes.result.value);
    await new Promise(r => setTimeout(r, 3000));
  }

  const ss = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync('C:/Users/Atul2/.gemini/antigravity-ide/brain/3dd0480a-7b48-4503-b4d3-a72f83b06237/deepseek_after_send.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved deepseek_after_send.png');

  const checkModal = await send('Runtime.evaluate', {
    expression: `(() => {
      return {
        bodySnippet: document.body.innerText.slice(0, 400),
        hasModal: !!document.querySelector('.modal, [role="dialog"], [class*="modal"], [class*="login"], [class*="auth"]')
      };
    })()`,
    returnByValue: true
  }, sessionId);
  console.log('DeepSeek state after send:', checkModal.result.value);

  ws.close();
}

main().catch(console.error);
