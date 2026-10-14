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

  const convUrl = 'https://chatgpt.com/c/6ace8017-ab40-83ec-9a3c-04cde4c6d1c1';
  const target = await send('Target.createTarget', { url: convUrl });
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

  const res = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const pre = document.querySelector('pre');
      const main = document.querySelector('main');
      return {
        url: window.location.href,
        preText: pre ? pre.innerText : null,
        mainSnippet: main ? main.innerText.slice(0, 400) : null
      };
    })()`,
    returnByValue: true
  });

  console.log('Result from saved conversation:\n', JSON.stringify(res.result?.value, null, 2));
  await send('Target.closeTarget', { targetId: target.targetId });
  ws.close();
}

main().catch(console.error);
