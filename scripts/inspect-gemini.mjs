import WebSocket from 'ws';

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
  const gemini = targetsRes.targetInfos.find(t => t.url.includes('gemini.google.com'));
  const { sessionId } = await send('Target.attachToTarget', { targetId: gemini.targetId, flatten: true });

  const evalRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const rta = document.querySelector('rich-textarea');
      const container = rta ? (rta.closest('.input-area, .chat-input, form, [class*="input"]') || rta.parentElement.parentElement) : null;
      const allButtons = Array.from(document.querySelectorAll('button, div[role="button"]')).map(b => ({
        tag: b.tagName,
        aria: b.getAttribute('aria-label'),
        cls: b.className,
        innerText: b.innerText.slice(0, 30)
      })).filter(b => b.aria || b.innerText);
      return {
        containerClass: container ? container.className : null,
        buttons: allButtons.slice(-15) // Look at bottom buttons
      };
    })()`,
    returnByValue: true
  }, sessionId);

  console.log('Gemini composer inspection:', JSON.stringify(evalRes.result.value, null, 2));
  ws.close();
}

main().catch(console.error);
