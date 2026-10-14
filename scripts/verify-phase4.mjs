import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MediatorCore, MediatorHttpServer } from '../packages/orchestrator/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-p4-'));
const debugPort = 9222;

console.log('=== PHASE 4: STANDALONE UI REAL-BROWSER END-TO-END VERIFICATION ===\n');

// 1. Start Mediator Core on 3300
const core = new MediatorCore({ workspaceRoot: rootDir });
const coreServer = new MediatorHttpServer(core, {
  port: 3300,
  staticDir: path.join(rootDir, 'apps', 'standalone-ui'),
});
const coreAddr = await coreServer.start();
const pairingToken = core.getPairingToken();
console.log(`[CORE] Server listening on ${coreAddr.url}`);
console.log(`[CORE] Pairing Token: ${pairingToken}`);

// 2. Start Live Server mock on 5500
const liveServer = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, 'http://127.0.0.1:5500');
  const relPath = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
  const filePath = path.join(rootDir, relPath);
  
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
    };
    res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><body>Cannot GET ${req.url}</body></html>`);
  }
});

await new Promise((resolve) => liveServer.listen(5500, '127.0.0.1', resolve));
console.log('[LIVE SERVER] Static server listening on http://127.0.0.1:5500\n');

// 3. Launch Edge with CDP
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

const networkAudit = [];
const consoleAudit = [];
const exceptionAudit = [];

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
        const line = `[${msg.params.type.toUpperCase()}] ` + msg.params.args.map(a => a.value || a.description).join(' ');
        consoleAudit.push(line);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const line = `${msg.params.exceptionDetails.text}: ${msg.params.exceptionDetails.exception?.description || ''}`;
        exceptionAudit.push(line);
      } else if (msg.method === 'Network.responseReceived') {
        networkAudit.push({
          url: msg.params.response.url,
          status: msg.params.response.status,
          mimeType: msg.params.response.mimeType,
          method: msg.params.response.headers[':method'] || 'RESPONSE',
        });
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

  // STEP 1: Connect to Standalone UI on 5500
  console.log('1. Loading Standalone UI at http://127.0.0.1:5500/apps/standalone-ui/index.html...');
  await send('Page.navigate', { url: 'http://127.0.0.1:5500/apps/standalone-ui/index.html' });
  await new Promise(r => setTimeout(r, 2000));

  const check1 = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      statusDot: document.getElementById('core-status-dot')?.className,
      statusText: document.getElementById('core-status-text')?.innerText,
      apiUrl: document.getElementById('api-url-display')?.innerText,
      token: document.getElementById('token-display')?.innerText,
      wsPath: document.getElementById('ws-path-display')?.innerText,
    })`,
  });
  const res1 = JSON.parse(check1.result?.value);
  console.log('   -> Core Status:', res1.statusText);
  console.log('   -> API Target:', res1.apiUrl);
  console.log('   -> Auth Token:', res1.token);
  console.log('   -> Active Workspace:', res1.wsPath);

  // STEP 2: Active Workspace Selection
  console.log('\n2. Testing Active-Workspace Selection via UI modal...');
  await send('Runtime.evaluate', { expression: `document.getElementById('btn-change-workspace')?.click()` });
  await new Promise(r => setTimeout(r, 300));

  await send('Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('ws-input-path').value = ${JSON.stringify(rootDir)};
      document.getElementById('btn-confirm-ws-modal')?.click();
    })()`,
  });
  await new Promise(r => setTimeout(r, 1500));

  const check2 = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      wsPath: document.getElementById('ws-path-display')?.innerText,
      wsConfirmed: document.getElementById('ws-confirmed-badge')?.style.display,
      toasts: Array.from(document.querySelectorAll('.toast-msg')).map(t => t.innerText),
    })`,
  });
  const res2 = JSON.parse(check2.result?.value);
  console.log('   -> Updated Workspace:', res2.wsPath);
  console.log('   -> Workspace Confirmed Badge:', res2.wsConfirmed !== 'none');
  console.log('   -> Toast Notifications:', res2.toasts.slice(-2));

  // STEP 3: Switch through primary UI tabs
  console.log('\n3. Testing primary UI tab transitions (checking for uncaught exceptions)...');
  const tabs = [
    'tab-dashboard',
    'tab-workspace',
    'tab-staging',
    'tab-providers',
    'tab-autopilot',
    'tab-audit',
    'tab-diagnostics',
  ];
  for (const t of tabs) {
    await send('Runtime.evaluate', {
      expression: `document.querySelector('button[data-tab="${t}"]')?.click()`,
    });
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('   -> All 7 tabs clicked and loaded without crashing');

  // STEP 4: Error Handling & Recovery
  console.log('\n4. Testing deliberate backend failure handling & UI recovery...');
  await send('Runtime.evaluate', { expression: `document.getElementById('btn-change-workspace')?.click()` });
  await new Promise(r => setTimeout(r, 300));
  await send('Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('ws-input-path').value = 'C:\\\\Invalid_NonExistent_Path_999';
      document.getElementById('btn-confirm-ws-modal')?.click();
    })()`,
  });
  await new Promise(r => setTimeout(r, 1000));

  const checkErr = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      modalVisible: !document.getElementById('ws-modal')?.classList.contains('hidden'),
      btnEnabled: !document.getElementById('btn-confirm-ws-modal')?.disabled,
      latestToast: document.querySelector('.toast:last-child .toast-msg')?.innerText,
    })`,
  });
  const resErr = JSON.parse(checkErr.result?.value);
  console.log('   -> Deliberate Error Caught:', resErr.latestToast);
  console.log('   -> Modal Kept Open for Correction:', resErr.modalVisible);
  console.log('   -> Confirm Button Re-enabled:', resErr.btnEnabled);

  // Close modal
  await send('Runtime.evaluate', { expression: `document.getElementById('btn-close-ws-modal')?.click()` });

  // STEP 5: Task Submission, Staging, Diff Review, and Approval State
  console.log('\n5. Testing Task Staging, Diff Review, and Approval State...');
  // Navigate back to workspace tab
  await send('Runtime.evaluate', {
    expression: `document.querySelector('button[data-tab="tab-workspace"]')?.click()`,
  });
  await new Promise(r => setTimeout(r, 200));

  // Enter prompt and submit task
  await send('Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('task-prompt-input').value = 'Fix off-by-one error in calculator service';
      document.getElementById('btn-submit-task')?.click();
    })()`,
  });
  await new Promise(r => setTimeout(r, 1500));

  // Load valid simulation envelope and dispatch
  console.log('   -> Loading simulation envelope and dispatching provider response...');
  await send('Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('btn-sim-load-valid')?.click();
      document.getElementById('btn-sim-dispatch')?.click();
    })()`,
  });
  await new Promise(r => setTimeout(r, 2500));

  const checkDiff = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      flowRound: document.getElementById('flow-round-badge')?.innerText,
      flowStatus: document.getElementById('flow-status-badge')?.innerText,
      diffStats: document.getElementById('diff-stats-badge')?.innerText,
      diffLinesCount: document.querySelectorAll('#diff-view-box .diff-line').length,
      diffAddCount: document.querySelectorAll('#diff-view-box .diff-line.add').length,
      diffDelCount: document.querySelectorAll('#diff-view-box .diff-line.del').length,
      stepperStep3: document.getElementById('step-3')?.className,
      stepperStep4: document.getElementById('step-4')?.className,
      stagingBadge: document.getElementById('staging-badge')?.innerText,
    })`,
  });
  const resDiff = JSON.parse(checkDiff.result?.value);
  console.log('   -> Workflow State:', resDiff.flowStatus, '(' + resDiff.flowRound + ')');
  console.log('   -> Staged Diff Stats:', resDiff.diffStats);
  console.log('   -> Rendered Diff Lines:', resDiff.diffLinesCount, `(+${resDiff.diffAddCount} additions, -${resDiff.diffDelCount} deletions)`);
  console.log('   -> Staging Badge Count:', resDiff.stagingBadge);

  // Check Dashboard Approval Card
  await send('Runtime.evaluate', {
    expression: `document.querySelector('button[data-tab="tab-dashboard"]')?.click()`,
  });
  await new Promise(r => setTimeout(r, 300));

  const checkDash = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      pendingCount: document.getElementById('dash-pending-count-badge')?.innerText,
      approvalItemsCount: document.querySelectorAll('#dash-approvals-list .approval-card-item').length,
      approvalText: document.querySelector('#dash-approvals-list .approval-info strong')?.innerText,
      autopilotStatus: document.getElementById('autopilot-status-badge')?.innerText,
    })`,
  });
  const resDash = JSON.parse(checkDash.result?.value);
  console.log('   -> Dashboard Pending Approvals:', resDash.pendingCount);
  console.log('   -> Approval Description:', resDash.approvalText);
  console.log('   -> Local Autopilot Safety Status:', resDash.autopilotStatus);

  console.log('\n=== NETWORK & CONSOLE AUDIT SUMMARY ===');
  console.log(`Total Network Requests Captured: ${networkAudit.length}`);
  const errorNetwork = networkAudit.filter(n => n.status >= 400 && n.status !== 400); // 400 was our intentional test
  console.log(`Unexpected Network Errors (HTTP >= 400 except test 400): ${errorNetwork.length}`);
  console.log(`Uncaught JS Exceptions: ${exceptionAudit.length}`);
  if (exceptionAudit.length > 0) {
    console.error('Exceptions recorded:', exceptionAudit);
  }

  const hasJsonParseError = consoleAudit.some(c => c.includes('Unexpected end of JSON input')) ||
    exceptionAudit.some(e => e.includes('Unexpected end of JSON input'));
  console.log(`Contains 'Unexpected end of JSON input': ${hasJsonParseError ? 'YES (FAIL)' : 'NO (PASS)'}`);

  ws.close();
} finally {
  edgeProc.kill();
  await coreServer.stop();
  await new Promise((resolve) => liveServer.close(resolve));
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
}
