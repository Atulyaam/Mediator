import WebSocket from 'ws';
import fs from 'fs';

async function main() {
  const versionRes = await fetch('http://127.0.0.1:9222/json/version');
  const { webSocketDebuggerUrl } = await versionRes.json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  let id = 1;
  const send = (method, params = {}, options = {}) => new Promise((resolve, reject) => {
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
    if (typeof options === 'string') payload.sessionId = options;
    else if (options && options.sessionId) payload.sessionId = options.sessionId;
    ws.send(JSON.stringify(payload));
  });

  const targetsRes = await send('Target.getTargets');
  const gemini = targetsRes.targetInfos.find(t => t.url.includes('gemini.google.com'));
  const { sessionId } = await send('Target.attachToTarget', { targetId: gemini.targetId, flatten: true });

  console.log('Focusing Gemini composer...');
  const focusRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const editor = document.querySelector('rich-textarea [contenteditable="true"], rich-textarea p, .ql-editor');
      if (editor) {
        editor.focus();
        return { focused: true, tag: editor.tagName, text: editor.innerText };
      }
      return { focused: false };
    })()`,
    returnByValue: true
  }, sessionId);
  console.log('Focus res:', focusRes.result.value);

  // Type a small test prompt
  await send('Input.insertText', { text: 'Test connection: respond with {"status": "ok"}' }, sessionId);
  await new Promise(r => setTimeout(r, 1000));

  // Inspect all buttons that have an svg or mat-icon or aria-label
  const btnsRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = Array.from(document.querySelectorAll('button, div[role="button"]')).map(b => ({
        tag: b.tagName,
        aria: b.getAttribute('aria-label'),
        cls: b.className,
        hasSvg: !!b.querySelector('svg'),
        matIcon: b.querySelector('mat-icon')?.innerText,
        rect: b.getBoundingClientRect()
      })).filter(b => b.hasSvg || b.matIcon || b.aria);
      return btns.filter(b => b.rect.width > 0 && b.rect.y > 600); // Only bottom bar buttons
    })()`,
    returnByValue: true
  }, sessionId);
  console.log('Bottom buttons:', JSON.stringify(btnsRes.result.value, null, 2));

  // Click the send button or press Enter
  const clickRes = await send('Runtime.evaluate', {
    expression: `(() => {
      // Find the button at the right of the input bar
      const sendCandidate = document.querySelector('button[aria-label*="Send message"], button[aria-label*="Send"], .send-button, [aria-label*="Submit"]');
      if (sendCandidate) {
        sendCandidate.click();
        return { method: 'aria-send', clicked: true };
      }
      // Or find the last button in the bottom input container
      const bottomBtns = Array.from(document.querySelectorAll('button')).filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.y > 600 && (b.querySelector('svg') || b.querySelector('mat-icon'));
      });
      if (bottomBtns.length) {
        const lastBtn = bottomBtns[bottomBtns.length - 1];
        lastBtn.click();
        return { method: 'bottom-last-btn', aria: lastBtn.getAttribute('aria-label'), clicked: true };
      }
      return { clicked: false };
    })()`,
    returnByValue: true
  }, sessionId);
  console.log('Click result:', clickRes.result.value);

  // Take screenshot
  const ss = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync('C:/Users/Atul2/.gemini/antigravity-ide/brain/3dd0480a-7b48-4503-b4d3-a72f83b06237/gemini_composer_after_typing.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved gemini_composer_after_typing.png');

  ws.close();
}

main().catch(console.error);
