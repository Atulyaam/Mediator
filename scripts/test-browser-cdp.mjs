import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-cdp-'));
const debugPort = 9222;

const edgeProc = spawn(EDGE_PATH, [
  '--headless',
  '--disable-gpu',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${userDataDir}`,
  'about:blank',
], { stdio: 'ignore' });

async function waitForCdp() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json`);
      if (res.ok) {
        const tabs = await res.json();
        if (tabs && tabs.length > 0) return tabs[0];
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('CDP timed out waiting for Edge');
}

(async () => {
  try {
    const tab = await waitForCdp();
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    let msgId = 1;
    const pending = new Map();

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      } else if (msg.method) {
        if (msg.method === 'Runtime.consoleAPICalled') {
          console.log('[BROWSER CONSOLE]', msg.params.type, msg.params.args.map(a => a.value || a.description).join(' '));
        } else if (msg.method === 'Runtime.exceptionThrown') {
          console.error('[BROWSER EXCEPTION]', msg.params.exceptionDetails.text, msg.params.exceptionDetails.exception?.description);
        } else if (msg.method === 'Network.responseReceived') {
          console.log('[BROWSER NETWORK RESPONSE]', msg.params.response.url, msg.params.response.status, msg.params.response.mimeType);
        }
      }
    });

    await new Promise(r => ws.on('open', r));

    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await send('Page.enable');
    await send('Network.enable');
    await send('Runtime.enable');

    console.log(`\n=== TEST: Submitting INVALID workspace path ===`);
    await send('Page.navigate', { url: 'http://127.0.0.1:5500/apps/standalone-ui/index.html' });
    await new Promise(r => setTimeout(r, 2000));

    // Click Switch Workspace and enter non-existent path
    await send('Runtime.evaluate', {
      expression: `document.getElementById('btn-change-workspace')?.click()`,
    });
    await new Promise(r => setTimeout(r, 300));

    await send('Runtime.evaluate', {
      expression: `(() => {
        const input = document.getElementById('ws-input-path');
        if (input) input.value = 'C:\\\\NonExistentDirectory_999999';
        document.getElementById('btn-confirm-ws-modal')?.click();
      })()`,
    });
    await new Promise(r => setTimeout(r, 1000));

    const afterInvalid = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        modalVisible: !document.getElementById('ws-modal')?.classList.contains('hidden'),
        toasts: Array.from(document.querySelectorAll('.toast-msg')).map(t => t.innerText),
        buttonDisabled: document.getElementById('btn-confirm-ws-modal')?.disabled,
      })`,
    });
    console.log('UI after invalid submit:', afterInvalid.result?.value);

    // Test UI recovery: Enter valid workspace path
    console.log(`\n=== TEST: UI Recovery — Submitting VALID workspace path after error ===`);
    await send('Runtime.evaluate', {
      expression: `(() => {
        const input = document.getElementById('ws-input-path');
        if (input) input.value = 'C:\\\\Users\\\\Atul2\\\\OneDrive\\\\Desktop\\\\Mediator';
        document.getElementById('btn-confirm-ws-modal')?.click();
      })()`,
    });
    await new Promise(r => setTimeout(r, 1500));

    const afterRecovery = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        modalVisible: !document.getElementById('ws-modal')?.classList.contains('hidden'),
        wsPath: document.getElementById('ws-path-display')?.innerText,
        toasts: Array.from(document.querySelectorAll('.toast-msg')).map(t => t.innerText),
      })`,
    });
    console.log('UI after recovery submit:', afterRecovery.result?.value);

    ws.close();
  } finally {
    edgeProc.kill();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
})();
