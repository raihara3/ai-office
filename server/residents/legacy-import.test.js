// Unit tests for the one-time legacy Markdown import (legacy-import.js):
// frontmatter parsing, importing reports/cards with sidecar state into
// office.db, source-file cleanup, and the meta marker making a second run a
// no-op — over an in-memory filesystem stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { openDatabase } from './database.js';
import { importLegacyData, parseFrontmatter } from './legacy-import.js';

test('parseFrontmatter splits attributes from the body', () => {
  const { attributes, body } = parseFrontmatter(
    ['---', 'title: 昨日の報告', 'level: review-needed', 'createdAt: 1234', '---', '', '本文です', ''].join('\n')
  );
  assert.equal(attributes.title, '昨日の報告');
  assert.equal(attributes.level, 'review-needed');
  assert.equal(attributes.createdAt, '1234');
  assert.equal(body.trim(), '本文です');
});

test('parseFrontmatter leaves plain text untouched', () => {
  const text = 'ただのテキスト\n---\n区切りに見える行\n';
  const parsed = parseFrontmatter(text);
  assert.deepEqual(parsed.attributes, {});
  assert.equal(parsed.body, text);
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
    existsSync(filePath) {
      return files.has(filePath);
    },
    unlinkSync(filePath) {
      if (!files.delete(filePath)) throw new Error(`ENOENT: ${filePath}`);
    },
    rmdirSync(directory) {
      for (const filePath of files.keys()) {
        if (filePath.startsWith(directory + path.sep)) throw new Error(`ENOTEMPTY: ${directory}`);
      }
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
        return list.map((name) => ({
          name,
          isDirectory: () =>
            [...files.keys()].some((filePath) =>
              filePath.startsWith(path.join(directory, name) + path.sep)
            ),
        }));
      }
      return list;
    },
  };
}

function legacyReport({ title, level = 'info', task = null, createdAt }, body) {
  return [
    '---',
    `title: ${title}`,
    `level: ${level}`,
    ...(task ? [`task: ${task}`] : []),
    `createdAt: ${createdAt}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

function legacyCard({ title, assignee, origin, createdAt }, body) {
  return [
    '---',
    `title: ${title}`,
    `assignee: ${assignee}`,
    `origin: ${origin}`,
    `createdAt: ${createdAt}`,
    `updatedAt: ${createdAt}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

test('legacy import: moves reports and cards into the database, then cleans up', () => {
  const fileSystem = memoryFileSystem();
  const outbox = '/data/residents/task-runner/outbox';
  fileSystem.writeFileSync(
    path.join(outbox, 'r1.md'),
    legacyReport({ title: '報告1', level: 'review-needed', task: 'c2.md', createdAt: 2000 }, '要確認です')
  );
  fileSystem.writeFileSync(
    path.join(outbox, '.archived', 'r0.md'),
    legacyReport({ title: '古い報告', createdAt: 1000 }, '済み')
  );
  fileSystem.writeFileSync(
    '/data/whiteboard-state.json',
    JSON.stringify({ readIds: ['task-runner/r1.md'], favoriteIds: ['task-runner/r1.md'] })
  );
  fileSystem.writeFileSync(
    '/data/board/c1.md',
    legacyCard({ title: 'タスク1', assignee: 'task-runner', origin: 'user', createdAt: 1000 }, '本文1')
  );
  fileSystem.writeFileSync(
    '/data/board/c2.md',
    legacyCard({ title: 'タスク2', assignee: 'task-runner', origin: 'user', createdAt: 2000 }, '本文2')
  );
  fileSystem.writeFileSync(
    '/data/board-state.json',
    // The sidecar puts the newer card on top; import must keep that order.
    JSON.stringify({ order: { 'task-runner': ['c2.md', 'c1.md'] } })
  );

  const database = openDatabase({ location: ':memory:' });
  const imported = importLegacyData(database, {
    dataDirectory: '/data',
    fileSystem,
    now: () => 5000,
  });
  assert.deepEqual(imported, { reports: 2, cards: 2 });

  const report = database.prepare('SELECT * FROM reports WHERE id = ?').get('task-runner/r1.md');
  assert.equal(report.title, '報告1');
  assert.equal(report.level, 'review-needed');
  assert.equal(report.task, 'c2.md');
  assert.equal(report.read, 1);
  assert.equal(report.favorite, 1);
  assert.equal(report.archived_at, null);
  const archivedReport = database.prepare('SELECT * FROM reports WHERE id = ?').get('task-runner/r0.md');
  assert.equal(archivedReport.archived_at, 5000);

  const cards = database.prepare('SELECT id, position FROM cards ORDER BY position').all();
  assert.deepEqual(
    cards.map((card) => ({ id: card.id, position: card.position })),
    [
      { id: 'c2.md', position: 0 },
      { id: 'c1.md', position: 1 },
    ]
  );

  // Sources and sidecars are gone; only resident configuration would remain.
  assert.deepEqual([...fileSystem.files.keys()], []);

  // The marker, not table contents, blocks a second run.
  assert.deepEqual(
    importLegacyData(database, { dataDirectory: '/data', fileSystem, now: () => 6000 }),
    { reports: 0, cards: 0 }
  );
  database.close();
});

test('legacy import: a fresh install with no legacy files is a quiet no-op', () => {
  const database = openDatabase({ location: ':memory:' });
  const imported = importLegacyData(database, {
    dataDirectory: '/data',
    fileSystem: memoryFileSystem(),
    now: () => 5000,
  });
  assert.deepEqual(imported, { reports: 0, cards: 0 });
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0);
  database.close();
});
