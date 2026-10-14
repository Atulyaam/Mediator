import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediatorCore, MediatorHttpServer } from '../packages/orchestrator/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// 1. Start Mediator Core on 3300
const core = new MediatorCore({ workspaceRoot: rootDir });
const coreServer = new MediatorHttpServer(core, {
  port: 3300,
  staticDir: path.join(rootDir, 'apps', 'standalone-ui'),
});
await coreServer.start();
console.log('[CORE] Mediator Core HTTP server running at http://127.0.0.1:3300');
console.log('[CORE] Pairing Token:', core.getPairingToken());

// 2. Start Live Server mock on 5500
const staticServer = http.createServer((req, res) => {
  console.log(`[5500] ${req.method} ${req.url}`);
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
    console.log(`[5500 404] Not found: ${filePath}`);
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><body>Cannot GET ${req.url}</body></html>`);
  }
});

staticServer.listen(5500, '127.0.0.1', () => {
  console.log('[STATIC] Live Server running at http://127.0.0.1:5500');
});
