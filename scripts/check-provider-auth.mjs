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

  for (const site of ['https://gemini.google.com', 'https://chatgpt.com', 'https://chat.deepseek.com']) {
    console.log(`Checking site: ${site}...`);
    const target = await send('Target.createTarget', { url: site });
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
      expression: `JSON.stringify({
        url: window.location.href,
        title: document.title,
        hasSignIn: Boolean(document.querySelector('a[href*="accounts.google.com"], [data-action="sign-in"], button[data-testid="login-button"], a[href*="login"]')),
        bodyLength: document.body ? document.body.innerText.length : 0,
        textStart: document.body ? document.body.innerText.slice(0, 200).replace(/\\s+/g, ' ') : ''
      })`,
      returnByValue: true
    });
    console.log(`Report for ${site}:`, evalRes.result?.value);
    await send('Target.closeTarget', { targetId: target.targetId });
  }

  ws.close();
}

main().catch(console.error);
