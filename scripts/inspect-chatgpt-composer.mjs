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

  const evalRes = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const editables = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, div[role="textbox"]')).map(el => ({
        tag: el.tagName,
        id: el.id,
        className: el.className,
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        placeholder: el.getAttribute('placeholder') || el.innerText
      }));
      const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
        testid: b.getAttribute('data-testid'),
        ariaLabel: b.getAttribute('aria-label'),
        text: b.innerText
      })).filter(b => b.testid || b.ariaLabel);

      return { editables, buttons };
    })()`,
    returnByValue: true
  });
  console.log('[Composer Details]:', JSON.stringify(evalRes.result?.value, null, 2));

  await send('Target.closeTarget', { targetId: target.targetId });
  ws.close();
}

main().catch(console.error);
