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
  const pageTargets = targetsRes.targetInfos.filter(t => t.type === 'page');
  console.log('Open Page Targets:');
  for (const t of pageTargets) {
    console.log(`- ID: ${t.targetId} | URL: ${t.url} | Title: ${t.title}`);
  }

  // Probe Gemini target
  const geminiTarget = pageTargets.find(t => t.url.includes('gemini.google.com'));
  if (geminiTarget) {
    console.log('\n--- Probing Gemini Target ---');
    const { sessionId } = await send('Target.attachToTarget', { targetId: geminiTarget.targetId, flatten: true });
    const res = await send('Runtime.evaluate', {
      expression: `(() => {
        const composer = document.querySelector('rich-textarea p, rich-textarea div[contenteditable="true"], .ql-editor, div[contenteditable="true"]');
        const sendBtn = document.querySelector('button[aria-label*="Send message"], button[aria-label*="Send"], .send-button');
        const accountBtn = document.querySelector('button[aria-label*="Google Account"], a[href*="SignOutOptions"], [aria-label*="Account"]');
        const responses = Array.from(document.querySelectorAll('message-content, .model-response-text, .response-container')).map(el => el.innerText.slice(0, 100));
        return {
          title: document.title,
          url: window.location.href,
          hasComposer: !!composer,
          composerSelector: composer ? composer.tagName + (composer.className ? '.' + composer.className.split(' ').join('.') : '') : null,
          hasSendBtn: !!sendBtn,
          sendBtnDisabled: sendBtn ? sendBtn.disabled : null,
          hasAccount: !!accountBtn,
          accountLabel: accountBtn ? accountBtn.getAttribute('aria-label') : null,
          responseCount: responses.length,
          lastResponseSnippet: responses.length ? responses[responses.length - 1] : null
        };
      })()`,
      returnByValue: true,
    }, sessionId);
    console.log('Gemini probe result:', res.result.value);
  } else {
    console.log('\nNo Gemini tab found.');
  }

  // Probe DeepSeek target
  const deepseekTarget = pageTargets.find(t => t.url.includes('deepseek.com'));
  if (deepseekTarget) {
    console.log('\n--- Probing DeepSeek Target ---');
    const { sessionId } = await send('Target.attachToTarget', { targetId: deepseekTarget.targetId, flatten: true });
    const res = await send('Runtime.evaluate', {
      expression: `(() => {
        const textarea = document.querySelector('textarea#chat-input, textarea');
        const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
          text: b.innerText.trim(),
          aria: b.getAttribute('aria-label'),
          cls: b.className
        }));
        const userElements = Array.from(document.querySelectorAll('[class*="user"], [class*="avatar"], [class*="profile"], [class*="login"]')).map(el => el.innerText.trim());
        return {
          title: document.title,
          url: window.location.href,
          hasTextarea: !!textarea,
          textareaId: textarea ? textarea.id : null,
          textareaPlaceholder: textarea ? textarea.placeholder : null,
          buttons: buttons.slice(0, 10),
          userElements: userElements.filter(Boolean).slice(0, 5)
        };
      })()`,
      returnByValue: true,
    }, sessionId);
    console.log('DeepSeek probe result:', res.result.value);
  } else {
    console.log('\nNo DeepSeek tab found.');
  }

  ws.close();
}

main().catch(console.error);
