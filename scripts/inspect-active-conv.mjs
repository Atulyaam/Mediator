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
  const chatgptTarget = targets.find((t) => t.url.includes('chatgpt.com'));
  if (!chatgptTarget) {
    console.log('No chatgpt target found among:', targets.map(t => t.url));
    ws.close();
    return;
  }
  console.log('Attaching to target:', chatgptTarget.url);
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

  const evalRes = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const main = document.querySelector('main');
      return {
        url: window.location.href,
        mainText: main ? main.innerText : 'NO MAIN',
        articles: Array.from(document.querySelectorAll('article')).map(a => a.innerText.slice(0, 100)),
        pres: Array.from(document.querySelectorAll('pre')).map(p => p.innerText.slice(0, 200)),
      };
    })()`,
    returnByValue: true
  });
  console.log('DOM in tab:', JSON.stringify(evalRes.result?.value, null, 2));
  ws.close();
}

main().catch(console.error);
