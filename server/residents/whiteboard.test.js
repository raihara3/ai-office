// Unit tests for the whiteboard report store (whiteboard.js): frontmatter
// round-trip, listing, read state and unread counts, over an in-memory
// filesystem stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createWhiteboard, formatReport, parseFrontmatter } from './whiteboard.js';

test('parseFrontmatter round-trips what formatReport writes', () => {
  const text = formatReport(
    { title: '週次レポート', level: 'review-needed', resident: 'log-analyst', createdAt: 1234 },
    'PR: https://example.com/pr/1'
  );
  const { attributes, body } = parseFrontmatter(text);
  assert.equal(attributes.title, '週次レポート');
  assert.equal(attributes.level, 'review-needed');
  assert.equal(attributes.createdAt, '1234');
  assert.equal(body.trim(), 'PR: https://example.com/pr/1');
});

test('parseFrontmatter leaves plain text untouched', () => {
  const { attributes, body } = parseFrontmatter('ただの本文');
  assert.deepEqual(attributes, {});
  assert.equal(body, 'ただの本文');
});

function memoryFileSystem() {
  const files = new Map();
  return {
    files,
    readFileSync(filePath) {
      if (!files.has(filePath)) throw new Error(`ENOENT: ${filePath}`);
      return files.get(filePath);
    },
    writeFileSync(filePath, content) {
      files.set(filePath, String(content));
    },
    mkdirSync() {},
    existsSync(filePath) {
      return files.has(filePath);
    },
    renameSync(from, to) {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    readdirSync(directory, options) {
      const names = new Set();
      for (const filePath of files.keys()) {
        if (filePath.startsWith(directory + path.sep)) {
          names.add(filePath.slice(directory.length + 1).split(path.sep)[0]);
        }
      }
      if (names.size === 0) throw new Error(`ENOENT: ${directory}`);
      const list = [...names];
      if (options?.withFileTypes) {
        return list.map((name) => ({ name, isDirectory: () => !name.includes('.') }));
      }
      return list;
    },
  };
}

test('whiteboard: save → list → markRead → counts', () => {
  const board = createWhiteboard({ dataDirectory: '/data', fileSystem: memoryFileSystem() });

  const firstId = board.saveReport('log-analyst', {
    title: 'レポート1',
    level: 'info',
    body: '本文1',
    createdAt: 1_000_000,
  });
  board.saveReport('issue-watcher', {
    title: 'レポート2',
    level: 'review-needed',
    body: '本文2',
    createdAt: 2_000_000,
  });

  const reports = board.listReports();
  assert.equal(reports.length, 2);
  // Newest first.
  assert.equal(reports[0].title, 'レポート2');
  assert.equal(reports[0].level, 'review-needed');
  assert.equal(reports[1].id, firstId);
  assert.deepEqual(board.counts(), { total: 2, unread: 2, reviewNeeded: 1 });

  assert.equal(board.markRead(firstId), true);
  assert.deepEqual(board.counts(), { total: 2, unread: 1, reviewNeeded: 1 });
  assert.equal(board.listReports().find((r) => r.id === firstId).read, true);

  // Traversal-looking ids are rejected outright.
  assert.equal(board.markRead('../etc/passwd.md'), false);
});

test('whiteboard: archiveReport takes the report off the board but keeps the file', () => {
  const fileSystem = memoryFileSystem();
  const board = createWhiteboard({ dataDirectory: '/data', fileSystem });
  const id = board.saveReport('log-analyst', {
    title: 'レポート',
    level: 'info',
    body: '本文',
    createdAt: 1_000_000,
  });
  board.markRead(id);

  assert.equal(board.archiveReport(id), true);
  assert.equal(board.listReports().length, 0);
  assert.deepEqual(board.counts(), { total: 0, unread: 0, reviewNeeded: 0 });
  // The file still exists, under outbox/.archived/.
  assert.ok([...fileSystem.files.keys()].some((p) => p.includes('/.archived/')));
  // The read sidecar no longer tracks the archived id.
  assert.ok(!fileSystem.files.get('/data/whiteboard-state.json').includes(id));

  assert.equal(board.archiveReport(id), false); // already gone
  assert.equal(board.archiveReport('../etc/passwd.md'), false);
});
