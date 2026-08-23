// Unit tests for the kanban card store (board.js): frontmatter round-trip,
// column ordering via the sidecar, moving/archiving cards and follow-up
// notes, over an in-memory filesystem stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createBoard, formatCard } from './board.js';
import { parseFrontmatter } from './whiteboard.js';

test('parseFrontmatter round-trips what formatCard writes', () => {
  const text = formatCard(
    { title: 'READMEを更新', assignee: 'task-runner', origin: 'user', createdAt: 1234, updatedAt: 5678 },
    '手順は https://example.com を参照'
  );
  const { attributes, body } = parseFrontmatter(text);
  assert.equal(attributes.title, 'READMEを更新');
  assert.equal(attributes.assignee, 'task-runner');
  assert.equal(attributes.origin, 'user');
  assert.equal(attributes.createdAt, '1234');
  assert.equal(attributes.updatedAt, '5678');
  assert.equal(body.trim(), '手順は https://example.com を参照');
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
    readdirSync(directory) {
      const names = new Set();
      for (const filePath of files.keys()) {
        if (filePath.startsWith(directory + path.sep)) {
          names.add(filePath.slice(directory.length + 1).split(path.sep)[0]);
        }
      }
      if (names.size === 0) throw new Error(`ENOENT: ${directory}`);
      return [...names];
    },
  };
}

function boardWith(nowValue = 10_000_000) {
  return createBoard({
    dataDirectory: '/data',
    fileSystem: memoryFileSystem(),
    now: () => nowValue,
  });
}

test('board: create → list keeps filing order, new cards at the bottom', () => {
  const board = boardWith();
  const first = board.createCard({
    title: 'タスク1',
    body: '本文1',
    assignee: 'task-runner',
    origin: 'user',
    createdAt: 1_000_000,
  });
  const second = board.createCard({
    title: 'タスク2',
    body: '本文2',
    assignee: 'task-runner',
    origin: 'user',
    createdAt: 2_000_000,
  });
  board.createCard({
    title: '確認して',
    body: '',
    assignee: 'user',
    origin: 'log-analyst',
    createdAt: 3_000_000,
  });

  const column = board.listCards().filter((card) => card.assignee === 'task-runner');
  assert.deepEqual(column.map((card) => card.id), [first, second]);
  assert.equal(column[0].title, 'タスク1');
  assert.equal(board.topCardFor('task-runner').id, first);
  assert.deepEqual(board.counts(), { total: 3, user: 1 });
});

test('board: same-second createdAt yields distinct card ids', () => {
  const board = boardWith();
  const payload = { title: 'A', body: '', assignee: 'user', origin: 'user', createdAt: 1_000_000 };
  const first = board.createCard(payload);
  const second = board.createCard(payload);
  assert.notEqual(first, second);
  assert.equal(board.listCards().length, 2);
});

test('board: moveCard reorders within a column and reassigns across columns', () => {
  const nowValue = 9_000_000;
  const board = createBoard({
    dataDirectory: '/data',
    fileSystem: memoryFileSystem(),
    now: () => nowValue,
  });
  const first = board.createCard({
    title: '1',
    body: '',
    assignee: 'task-runner',
    origin: 'user',
    createdAt: 1_000_000,
  });
  const second = board.createCard({
    title: '2',
    body: '',
    assignee: 'task-runner',
    origin: 'user',
    createdAt: 2_000_000,
  });

  // Drag the newer card to the top of its own column.
  assert.equal(board.moveCard(second, { index: 0 }), true);
  assert.equal(board.topCardFor('task-runner').id, second);

  // Drag it across to another resident's column.
  assert.equal(board.moveCard(second, { assignee: 'issue-watcher', index: 0 }), true);
  const moved = board.listCards().find((card) => card.id === second);
  assert.equal(moved.assignee, 'issue-watcher');
  assert.equal(moved.updatedAt, nowValue);
  assert.equal(board.topCardFor('task-runner').id, first);

  assert.equal(board.moveCard('../etc/passwd.md', { assignee: 'user' }), false);
  assert.equal(board.moveCard('missing.md', { assignee: 'user' }), false);
});

test('board: archiveCard takes the card off the board but keeps the file', () => {
  const fileSystem = memoryFileSystem();
  const board = createBoard({ dataDirectory: '/data', fileSystem, now: () => 5_000_000 });
  const id = board.createCard({
    title: 'タスク',
    body: '本文',
    assignee: 'task-runner',
    origin: 'user',
    createdAt: 1_000_000,
  });
  board.moveCard(id, { index: 0 });

  assert.equal(board.archiveCard(id), true);
  assert.equal(board.listCards().length, 0);
  assert.deepEqual(board.counts(), { total: 0, user: 0 });
  assert.ok([...fileSystem.files.keys()].some((filePath) => filePath.includes('/.archived/')));
  assert.ok(!fileSystem.files.get('/data/board-state.json').includes(id));

  assert.equal(board.archiveCard(id), false); // already gone
  assert.equal(board.archiveCard('../etc/passwd.md'), false);
});

test('board: appendNote accumulates 追記 sections in the body', () => {
  const board = boardWith();
  const id = board.createCard({
    title: 'タスク',
    body: '最初の依頼',
    assignee: 'task-runner',
    origin: 'user',
    createdAt: 1_000_000,
  });

  assert.equal(board.appendNote(id, 'ここを直してほしい'), true);
  const card = board.listCards().find((c) => c.id === id);
  assert.ok(card.body.startsWith('最初の依頼'));
  assert.ok(card.body.includes('## 追記'));
  assert.ok(card.body.endsWith('ここを直してほしい'));

  assert.equal(board.appendNote(id, '   '), false);
  assert.equal(board.appendNote('missing.md', 'x'), false);
});
