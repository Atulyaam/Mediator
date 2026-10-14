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

  const res = await send('Runtime.evaluate', {
    expression: `(() => {
      const responses = Array.from(document.querySelectorAll('message-content, .model-response-text, .response-container')).map(el => el.innerText);
      const isGenerating = !!document.querySelector('.generating, [aria-label*="Stop response"], mat-progress-bar');
      return { count: responses.length, isGenerating, last: responses[responses.length - 1] };
    })()`,
    returnByValue: true
  }, sessionId);
  console.log('Gemini responses:', res.result.value);

  const ss = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync('C:/Users/Atul2/.gemini/antigravity-ide/brain/3dd0480a-7b48-4503-b4d3-a72f83b06237/gemini_response_check.png', Buffer.from(ss.data, 'base64'));
  console.log('Saved gemini_response_check.png');
  ws.close();
}

main().catch(console.error);
