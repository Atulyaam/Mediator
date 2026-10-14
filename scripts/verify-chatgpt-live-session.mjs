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

  console.log('[ChatGPT Live] Opening https://chatgpt.com...');
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

  const auth = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body ? document.body.innerText : '';
      const loginBtn = document.querySelector('a[href*="/auth/login"], [data-testid="login-button"]');
      return {
        url: window.location.href,
        hasUser: Boolean(!loginBtn && (document.querySelector('nav') || document.querySelector('.ProseMirror, [contenteditable="true"]'))),
        hasLogin: Boolean(loginBtn),
        title: document.title
      };
    })()`,
    returnByValue: true
  });
  console.log('[ChatGPT Live] Session status:', auth.result?.value);

  await send('Target.closeTarget', { targetId: target.targetId });
  ws.close();
}

main().catch(console.error);
