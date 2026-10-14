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
  console.log(`Inspecting ${convUrl}...`);
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
      const turns = Array.from(document.querySelectorAll('article, [data-message-author-role], .text-message')).map(el => ({
        role: el.getAttribute('data-message-author-role') || el.className,
        text: el.innerText
      }));
      return {
        url: window.location.href,
        title: document.title,
        bodySnippet: document.body ? document.body.innerText.slice(0, 500).replace(/\\s+/g, ' ') : '',
        turns
      };
    })()`,
    returnByValue: true
  });
  console.log('Conversation Content:', JSON.stringify(content.result?.value, null, 2));

  await send('Target.closeTarget', { targetId: target.targetId });
  ws.close();
}

main().catch(console.error);
