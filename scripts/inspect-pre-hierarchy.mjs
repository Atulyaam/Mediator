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

  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const chatgptTarget = targets.find((t) => t.url.includes('chatgpt.com/c/6ace8017'));
  if (!chatgptTarget) {
    console.log('Target not found');
    ws.close();
    return;
  }

  const attach = await send('Target.attachToTarget', { targetId: chatgptTarget.id, flatten: true });
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

  const res = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const pre = document.querySelector('pre');
      let cur = pre;
      const parents = [];
      while (cur && cur.tagName !== 'BODY') {
        parents.push({
          tag: cur.tagName,
          className: cur.className,
          id: cur.id,
          testId: cur.getAttribute('data-testid'),
          role: cur.getAttribute('data-message-author-role') || cur.getAttribute('role'),
        });
        cur = cur.parentElement;
      }
      return { parents };
    })()`,
    returnByValue: true
  });

  console.log('Hierarchy above pre code:', JSON.stringify(res.result?.value, null, 2));
  ws.close();
}

main().catch(console.error);
