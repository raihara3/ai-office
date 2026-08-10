// ai-office server: serves the office UI and streams employee state over SSE.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onChange, snapshot } from './state.js';
import { findRetirableSessions, retireSessions } from './cleanup.js';
import { startClaudeWatcher } from './watchers/claude.js';
import { startCodexWatcher } from './watchers/codex.js';
import { startGeminiWatcher } from './watchers/gemini.js';

const PORT = Number(process.env.PORT ?? 4680);
const PUBLIC_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public'
);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const sseClients = new Set();

onChange((snap) => {
  const frame = `data: ${JSON.stringify(snap)}\n\n`;
  for (const client of sseClients) writeToClient(client, frame);
});

function serveStatic(request, response) {
  const urlPath = new URL(request.url, 'http://localhost').pathname;
  const relativePath = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = path.normalize(path.join(PUBLIC_DIRECTORY, relativePath));
  if (!filePath.startsWith(PUBLIC_DIRECTORY + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404).end('Not Found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
    });
    response.end(data);
  });
}

function writeToClient(client, frame) {
  try {
    client.write(frame);
  } catch {
    sseClients.delete(client);
    client.destroy();
  }
}

const server = http.createServer((request, response) => {
  // Reject non-local Host headers to prevent DNS rebinding attacks.
  const host = request.headers.host ?? '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
    response.writeHead(403).end();
    return;
  }
  const urlPath = new URL(request.url, 'http://localhost').pathname;

  if (urlPath === '/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.add(response);
    response.on('error', () => sseClients.delete(response));
    request.on('close', () => sseClients.delete(response));
    return;
  }

  if (urlPath === '/api/cleanup/preview') {
    const candidates = findRetirableSessions().map((session) => ({
      key: session.key,
      cli: session.cli,
      project: session.project,
      lastEventAt: session.lastEventAt,
    }));
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ candidates }));
    return;
  }

  if (urlPath === '/api/cleanup') {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    // CSRF guard: browsers send Origin on cross-site POSTs. The Host check
    // above does not stop a malicious website from firing this request.
    const origin = request.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
      response.writeHead(403).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) request.destroy();
    });
    request.on('end', () => {
      let selectedKeys = null;
      try {
        const parsed = JSON.parse(body || '{}');
        if (Array.isArray(parsed.keys)) selectedKeys = parsed.keys;
      } catch {
        // An empty or malformed body falls back to all retirable sessions.
      }
      const result = retireSessions(selectedKeys);
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(result));
    });
    return;
  }

  if (urlPath === '/api/state') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(snapshot(), null, 2));
    return;
  }

  serveStatic(request, response);
});

// SSE keep-alive comments so proxies and browsers keep the stream open.
setInterval(() => {
  for (const client of sseClients) writeToClient(client, ': keep-alive\n\n');
}, 15_000).unref();

startClaudeWatcher();
startCodexWatcher();
startGeminiWatcher();

// Bind to loopback only: the streamed session logs contain prompts and
// commands that must not be exposed to the local network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`ai-office running at http://localhost:${PORT}`);
});
