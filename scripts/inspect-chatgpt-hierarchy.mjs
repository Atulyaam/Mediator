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

  const convUrl = 'https://chatgpt.com/c/6ace7d90-e6a4-83ee-8564-1cdf0e3ee3f2';
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

  const content = await sendSession('Runtime.evaluate', {
    expression: `(() => {
      const main = document.querySelector('main');
      if (!main) return null;
      const elements = Array.from(main.querySelectorAll('*')).filter(el => {
        return el.innerText && el.innerText.includes('HELLO_WORLD') && el.children.length === 0;
      }).map(el => {
        let path = [];
        let cur = el;
        while (cur && cur !== main) {
          path.unshift(cur.tagName + (cur.className ? '.' + cur.className.split(' ').join('.') : '') + (cur.getAttribute('data-message-author-role') ? '[role=' + cur.getAttribute('data-message-author-role') + ']' : ''));
          cur = cur.parentElement;
        }
        return {
          tag: el.tagName,
          text: el.innerText,
          path: path.join(' > ')
        };
      });
      return elements;
    })()`,
    returnByValue: true
  });
  console.log('Hierarchy for response:', JSON.stringify(content.result?.value, null, 2));

  await send('Target.closeTarget', { targetId: target.targetId });
  ws.close();
}

main().catch(console.error);
