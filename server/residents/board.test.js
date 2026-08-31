// Unit tests for the kanban card store (board.js): column ordering, moving
// and archiving cards and follow-up notes, over an in-memory SQLite database
// with resident fixtures created through the resident store.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from './database.js';
import { createBoard } from './board.js';
import { createResidentStore } from './resident-store.js';

// Pinned so GC cannot finalize a fixture database's statements mid-test:
// node:sqlite finalizes them once the DatabaseSync object is collected, and
// tests destructuring only the store would otherwise drop the last reference.
const openedDatabases = [];

function boardWith(nowValue = 10_000_000) {
  const database = openDatabase({ location: ':memory:' });
  openedDatabases.push(database);
  const residentStore = createResidentStore({ database, now: () => nowValue });
  for (const [index, name] of ['task-runner', 'issue-watcher', 'log-analyst'].entries()) {
    residentStore.save(name, {
      configuration: {
        displayName: name,
        seat: index,
        cli: 'claude',
        mode: 'read-only',
        workingDirectory: '~',
        trigger: { type: 'interval', minutes: 10 },
        precheck: null,
        enabled: true,
      },
      instructions: '',
    });
  }
  return { database, residentStore, board: createBoard({ database, now: () => nowValue }) };
}

test('board: create → list keeps filing order, new cards at the bottom', () => {
  const { board } = boardWith();
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
  const userCard = board.listCards().find((card) => card.assignee === 'user');
  assert.equal(userCard.origin, 'log-analyst');
  assert.deepEqual(board.counts(), { total: 3, user: 1 });

  assert.throws(() => board.createCard({
    title: 'x',
    body: '',
    assignee: 'nobody',
    origin: 'user',
    createdAt: 1,
  }), /unknown assignee/);
});

test('board: same-second createdAt yields distinct card ids', () => {
  const { board } = boardWith();
  const payload = { title: 'A', body: '', assignee: 'user', origin: 'user', createdAt: 1_000_000 };
  const first = board.createCard(payload);
  const second = board.createCard(payload);
  assert.notEqual(first, second);
  assert.equal(board.listCards().length, 2);
});

test('board: moveCard reorders within a column and reassigns across columns', () => {
  const nowValue = 9_000_000;
  const { board } = boardWith(nowValue);
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

  // And into the user column, then back out by index only.
  assert.equal(board.moveCard(second, { assignee: 'user', index: 0 }), true);
  assert.equal(board.listCards().find((card) => card.id === second).assignee, 'user');
  assert.equal(board.moveCard(second, { index: 0 }), true);

  assert.equal(board.moveCard('no-such-card', { assignee: 'user' }), false);
});

test('board: archiveCard takes the card off the board but keeps the row', () => {
  const { database, board } = boardWith(5_000_000);
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
  // The row still exists, flagged archived.
  assert.equal(database.prepare('SELECT archived_at FROM cards WHERE id = ?').get(id).archived_at, 5_000_000);

  assert.equal(board.archiveCard(id), false); // already gone
  assert.equal(board.archiveCard('no-such-card'), false);
});

test('board: markCardDone keeps the card on the board but out of the work queue', () => {
  const { board } = boardWith(5_000_000);
  const first = board.createCard({
    title: 'タスク1',
    body: '',
    assignee: 'task-runner',
    origin: 'user',
    createdAt: 1_000_000,
  });
  const second = board.createCard({
    title: 'タスク2',
    body: '',
    assignee: 'task-runner',
    origin: 'user',
    createdAt: 2_000_000,
  });

  assert.equal(board.markCardDone(first), true);
  const doneCard = board.listCards().find((card) => card.id === first);
  assert.equal(doneCard.done, true); // still listed, now in the 完了 column
  assert.equal(doneCard.doneAt, 5_000_000); // completion time, so the 完了 column can order by it
  assert.deepEqual(board.counts(), { total: 1, user: 0 }); // done cards drop out of the count
  // The next card is worked, never the done one.
  assert.equal(board.topCardFor('task-runner').id, second);
  assert.equal(board.markCardDone(first), false); // already done

  // Moving a done card back onto a column clears the done state.
  assert.equal(board.moveCard(first, { assignee: 'issue-watcher', index: 0 }), true);
  assert.equal(board.listCards().find((card) => card.id === first).done, false);
  assert.equal(board.topCardFor('issue-watcher').id, first);
});

test('board: appendNote accumulates 追記 sections in the body', () => {
  const { board } = boardWith();
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
  assert.equal(board.appendNote('no-such-card', 'x'), false);
});

test('board: updateCard rewrites the title and body, collapsing title newlines', () => {
  const { board } = boardWith();
  const id = board.createCard({
    title: 'もとの件名',
    body: 'もとの本文',
    assignee: 'task-runner',
    origin: 'user',
    createdAt: 1_000_000,
  });

  assert.equal(board.updateCard(id, { title: '新しい\n件名', body: '新しい本文' }), true);
  const card = board.listCards().find((c) => c.id === id);
  assert.equal(card.title, '新しい 件名');
  assert.equal(card.body, '新しい本文');

  assert.equal(board.updateCard(id, { title: '   ' }), false);
  assert.equal(board.updateCard('no-such-card', { title: 'x' }), false);
});

test('board: an archived resident keeps naming its leftover cards but never works them', () => {
  const { board, residentStore } = boardWith();
  const id = board.createCard({
    title: '残タスク',
    body: '',
    assignee: 'task-runner',
    origin: 'user',
    createdAt: 1_000_000,
  });
  residentStore.remove('task-runner');

  // The listing still resolves the archived resident's name (the frontend
  // folds unknown assignees into the user column with an orphaned badge)...
  assert.equal(board.listCards().find((card) => card.id === id).assignee, 'task-runner');
  // ...but the name no longer resolves for work or new assignments.
  assert.equal(board.topCardFor('task-runner'), null);
  assert.throws(() => board.moveCard(id, { assignee: 'task-runner' }), /unknown assignee/);

  // Origin resolution stays lenient: a run finishing just after its resident
  // was unassigned still files its review card without crashing.
  const filed = board.createCard({
    title: '滑り込み起票',
    body: '',
    assignee: 'user',
    origin: 'task-runner',
    createdAt: 2_000_000,
  });
  assert.equal(board.listCards().find((card) => card.id === filed).origin, 'task-runner');
});
