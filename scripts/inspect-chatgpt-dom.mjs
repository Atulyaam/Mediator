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

  console.log('[Inspect] Opening https://chatgpt.com...');
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
      const promptTextarea = document.querySelector('#prompt-textarea');
      const sendBtn = document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[aria-label*="Send"]');
      const userProfile = document.querySelector('[data-testid="profile-button"]') || document.querySelector('[aria-label*="profile"]');
      const text = document.body ? document.body.innerText.slice(0, 300).replace(/\\s+/g, ' ') : '';
      return {
        url: window.location.href,
        hasPromptTextarea: Boolean(promptTextarea),
        promptTag: promptTextarea ? promptTextarea.tagName : null,
        hasSendBtn: Boolean(sendBtn),
        textSnippet: text
      };
    })()`,
    returnByValue: true
  });
  console.log('[Inspect] DOM Details:', evalRes.result?.value);

  await send('Target.closeTarget', { targetId: target.targetId });
  ws.close();
}

main().catch(console.error);
