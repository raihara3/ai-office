// HTTP/SSE transport adapter over the application core: serves the office UI,
// streams state snapshots over Server-Sent Events, and exposes the HR cleanup
// endpoints. All domain logic lives in the core; this file is only plumbing.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// SSE keep-alive comments so proxies and browsers keep the stream open.
const KEEP_ALIVE_INTERVAL_MS = 15_000;

function writeToClient(client, frame, sseClients) {
  try {
    client.write(frame);
  } catch {
    sseClients.delete(client);
    client.destroy();
  }
}

// CSRF guard for state-changing requests: browsers send Origin on cross-site
// requests, and the Host check alone does not stop a malicious website from
// firing them.
function isForbiddenOrigin(request) {
  const origin = request.headers.origin;
  return Boolean(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

function readJsonBody(request, maxBytes, onDone) {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > maxBytes) request.destroy();
  });
  request.on('end', () => {
    // Parse separately from the handler call: a handler exception must not be
    // misreported as a malformed body (onDone(null)).
    let parsed = null;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      // parsed stays null, signalling a malformed body.
    }
    onDone(parsed);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function serveStatic(request, response, publicDirectory) {
  const urlPath = new URL(request.url, 'http://localhost').pathname;
  const relativePath = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = path.normalize(path.join(publicDirectory, relativePath));
  if (!filePath.startsWith(publicDirectory + path.sep)) {
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

export function createHttpServer(core, { publicDirectory }) {
  const sseClients = new Set();

  const unsubscribe = core.subscribe((snap) => {
    const frame = `data: ${JSON.stringify(snap)}\n\n`;
    for (const client of sseClients) writeToClient(client, frame, sseClients);
  });

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
      response.write(`data: ${JSON.stringify(core.getSnapshot())}\n\n`);
      sseClients.add(response);
      response.on('error', () => sseClients.delete(response));
      request.on('close', () => sseClients.delete(response));
      return;
    }

    if (urlPath === '/api/cleanup/preview') {
      const candidates = core.previewCleanup().map((session) => ({
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
      if (isForbiddenOrigin(request)) {
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
        let userText = '@here 仕事がない人は退勤してください';
        try {
          const parsed = JSON.parse(body || '{}');
          if (Array.isArray(parsed.keys)) selectedKeys = parsed.keys;
          if (typeof parsed.text === 'string' && parsed.text.length <= 200) {
            userText = parsed.text;
          }
        } catch {
          // An empty or malformed body falls back to all retirable sessions.
        }
        // The user's directive shows up in #general, then HR replies.
        core.postMessage({ authorKind: 'user', authorName: '社長', text: userText, at: Date.now() });
        const result = core.runCleanup(selectedKeys);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(result));
      });
      return;
    }

    // Team management: list/create, and rename/resize/delete per id.
    if (urlPath === '/api/teams') {
      if (request.method === 'GET') {
        sendJson(response, 200, { teams: core.listTeams() });
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      if (isForbiddenOrigin(request)) {
        response.writeHead(403).end();
        return;
      }
      readJsonBody(request, 16 * 1024, (parsed) => {
        if (parsed === null) {
          sendJson(response, 400, { error: 'invalid JSON body' });
          return;
        }
        try {
          const id = core.saveTeam({ name: parsed.name, seatCount: parsed.seatCount });
          sendJson(response, 200, { ok: true, id });
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
      });
      return;
    }
    const teamMatch = urlPath.match(/^\/api\/teams\/([A-Za-z0-9-]{1,64})$/);
    if (teamMatch) {
      const [, teamId] = teamMatch;
      if (isForbiddenOrigin(request)) {
        response.writeHead(403).end();
        return;
      }
      if (request.method === 'PUT') {
        readJsonBody(request, 16 * 1024, (parsed) => {
          if (parsed === null) {
            sendJson(response, 400, { error: 'invalid JSON body' });
            return;
          }
          try {
            core.saveTeam({ id: teamId, name: parsed.name, seatCount: parsed.seatCount });
            sendJson(response, 200, { ok: true });
          } catch (error) {
            sendJson(response, 400, { error: error.message });
          }
        });
      } else if (request.method === 'DELETE') {
        try {
          core.deleteTeam(teamId);
          sendJson(response, 200, { ok: true });
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
      } else {
        response.writeHead(405).end();
      }
      return;
    }

    // Resident team management: list/save/unassign/run. The rows in office.db
    // are the source of truth; these endpoints only read and write them
    // through the core.
    const residentMatch = urlPath.match(/^\/api\/residents(?:\/([a-z0-9][a-z0-9-]{0,63})(\/run)?)?$/);
    if (residentMatch) {
      const [, residentName, runSuffix] = residentMatch;
      if (request.method !== 'GET' && isForbiddenOrigin(request)) {
        response.writeHead(403).end();
        return;
      }
      if (request.method === 'GET' && !residentName) {
        sendJson(response, 200, { residents: core.listResidents() });
      } else if (request.method === 'PUT' && residentName && !runSuffix) {
        readJsonBody(request, 256 * 1024, (parsed) => {
          if (parsed === null) {
            sendJson(response, 400, { error: 'invalid JSON body' });
            return;
          }
          try {
            core.saveResident(residentName, {
              configuration: parsed.configuration,
              instructions: parsed.instructions,
              teamId: parsed.teamId,
            });
            sendJson(response, 200, { ok: true });
          } catch (error) {
            sendJson(response, 400, { error: error.message });
          }
        });
      } else if (request.method === 'DELETE' && residentName && !runSuffix) {
        try {
          core.deleteResident(residentName);
          sendJson(response, 200, { ok: true });
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
      } else if (request.method === 'POST' && residentName && runSuffix) {
        try {
          core.runResident(residentName);
          sendJson(response, 200, { ok: true });
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
      } else {
        response.writeHead(405).end();
      }
      return;
    }

    // The whiteboard: reports from residents to the human, plus read state.
    if (urlPath === '/api/whiteboard') {
      sendJson(response, 200, { reports: core.listReports() });
      return;
    }
    if (urlPath === '/api/whiteboard/read' || urlPath === '/api/whiteboard/archive') {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      if (isForbiddenOrigin(request)) {
        response.writeHead(403).end();
        return;
      }
      const applyToReport =
        urlPath === '/api/whiteboard/archive' ? core.archiveReport : core.markReportRead;
      readJsonBody(request, 4 * 1024, (parsed) => {
        if (parsed === null || typeof parsed.id !== 'string') {
          sendJson(response, 400, { error: 'invalid JSON body' });
          return;
        }
        sendJson(response, 200, { ok: applyToReport(parsed.id) });
      });
      return;
    }
    // Pinning a report favorites it, protecting it from archiving. The
    // response carries the resulting favorite flag so the panel can reflect it.
    if (urlPath === '/api/whiteboard/favorite') {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      if (isForbiddenOrigin(request)) {
        response.writeHead(403).end();
        return;
      }
      readJsonBody(request, 4 * 1024, (parsed) => {
        if (parsed === null || typeof parsed.id !== 'string') {
          sendJson(response, 400, { error: 'invalid JSON body' });
          return;
        }
        sendJson(response, 200, { favorite: core.toggleReportFavorite(parsed.id) });
      });
      return;
    }

    // The kanban board: task cards, drag ordering, archiving and follow-up
    // notes.
    if (urlPath === '/api/board') {
      sendJson(response, 200, { cards: core.listBoard() });
      return;
    }
    const boardAction = urlPath.match(/^\/api\/board\/(create|move|archive|note)$/)?.[1];
    if (boardAction) {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      if (isForbiddenOrigin(request)) {
        response.writeHead(403).end();
        return;
      }
      readJsonBody(request, 64 * 1024, (parsed) => {
        if (parsed === null) {
          sendJson(response, 400, { error: 'invalid JSON body' });
          return;
        }
        try {
          if (boardAction === 'create') {
            if (
              typeof parsed.title !== 'string' ||
              parsed.title.trim() === '' ||
              typeof parsed.assignee !== 'string'
            ) {
              sendJson(response, 400, { error: 'title and assignee are required' });
              return;
            }
            const id = core.createBoardCard({
              title: parsed.title,
              body: typeof parsed.body === 'string' ? parsed.body : '',
              assignee: parsed.assignee,
            });
            sendJson(response, 200, { ok: true, id });
            return;
          }
          if (typeof parsed.id !== 'string') {
            sendJson(response, 400, { error: 'id is required' });
            return;
          }
          if (boardAction === 'move') {
            sendJson(response, 200, {
              ok: core.moveBoardCard(parsed.id, {
                assignee: typeof parsed.assignee === 'string' ? parsed.assignee : undefined,
                index: Number.isInteger(parsed.index) ? parsed.index : undefined,
              }),
            });
          } else if (boardAction === 'archive') {
            sendJson(response, 200, { ok: core.archiveBoardCard(parsed.id) });
          } else {
            if (typeof parsed.text !== 'string' || parsed.text.trim() === '') {
              sendJson(response, 400, { error: 'text is required' });
              return;
            }
            sendJson(response, 200, { ok: core.appendBoardNote(parsed.id, parsed.text) });
          }
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
      });
      return;
    }

    if (urlPath === '/api/state') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(core.getSnapshot(), null, 2));
      return;
    }

    serveStatic(request, response, publicDirectory);
  });

  const keepAlive = setInterval(() => {
    for (const client of sseClients) writeToClient(client, ': keep-alive\n\n', sseClients);
  }, KEEP_ALIVE_INTERVAL_MS);
  keepAlive.unref?.();

  server.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
    for (const client of sseClients) client.end();
    sseClients.clear();
  });

  return server;
}
