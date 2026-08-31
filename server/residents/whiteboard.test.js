// Unit tests for the whiteboard report store (whiteboard.js): listing, read
// state and unread counts, archiving and the favorite pin, over an in-memory
// SQLite database with resident fixtures created through the resident store.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from './database.js';
import { createResidentStore } from './resident-store.js';
import { createWhiteboard } from './whiteboard.js';

// Pinned so GC cannot finalize a fixture database's statements mid-test:
// node:sqlite finalizes them once the DatabaseSync object is collected, and
// tests destructuring only the store would otherwise drop the last reference.
const openedDatabases = [];

function whiteboardWith(nowValue = 10_000_000) {
  const database = openDatabase({ location: ':memory:' });
  openedDatabases.push(database);
  const residentStore = createResidentStore({ database, now: () => nowValue });
  for (const [index, name] of ['log-analyst', 'issue-watcher'].entries()) {
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
  return { database, residentStore, whiteboard: createWhiteboard({ database, now: () => nowValue }) };
}

test('whiteboard: save → list → markRead → counts', () => {
  const { whiteboard } = whiteboardWith();

  const firstId = whiteboard.saveReport('log-analyst', {
    title: 'レポート1',
    level: 'info',
    body: '本文1',
    createdAt: 1_000_000,
  });
  whiteboard.saveReport('issue-watcher', {
    title: 'レポート2',
    level: 'review-needed',
    body: '本文2',
    createdAt: 2_000_000,
  });

  const reports = whiteboard.listReports();
  assert.equal(reports.length, 2);
  // Newest first.
  assert.equal(reports[0].title, 'レポート2');
  assert.equal(reports[0].level, 'review-needed');
  assert.equal(reports[0].resident, 'issue-watcher');
  assert.equal(reports[0].task, null);
  assert.equal(reports[1].id, firstId);
  assert.deepEqual(whiteboard.counts(), { total: 2, unread: 2, reviewNeeded: 1 });

  assert.equal(whiteboard.markRead(firstId), true);
  assert.deepEqual(whiteboard.counts(), { total: 2, unread: 1, reviewNeeded: 1 });
  assert.equal(whiteboard.listReports().find((r) => r.id === firstId).read, true);
  // Marking an already-read report stays true; an unknown id is refused.
  assert.equal(whiteboard.markRead(firstId), true);
  assert.equal(whiteboard.markRead('no-such-report'), false);

  assert.throws(() => whiteboard.saveReport('nobody', { title: 'x', level: 'info', body: '', createdAt: 1 }), /unknown resident/);
});

test('whiteboard: archiveReport takes the report off the board but keeps the row', () => {
  const { database, whiteboard } = whiteboardWith(5_000_000);
  const id = whiteboard.saveReport('log-analyst', {
    title: 'レポート',
    level: 'info',
    body: '本文',
    createdAt: 1_000_000,
  });
  whiteboard.markRead(id);

  assert.equal(whiteboard.archiveReport(id), true);
  assert.equal(whiteboard.listReports().length, 0);
  assert.deepEqual(whiteboard.counts(), { total: 0, unread: 0, reviewNeeded: 0 });
  // The row still exists, flagged archived with its read state cleared.
  const row = database.prepare('SELECT archived_at, "read" FROM reports WHERE id = ?').get(id);
  assert.equal(row.archived_at, 5_000_000);
  assert.equal(row.read, 0);

  assert.equal(whiteboard.archiveReport(id), false); // already gone
  assert.equal(whiteboard.archiveReport('no-such-report'), false);
});

test('whiteboard: a favorited report is pinned and cannot be archived', () => {
  const { whiteboard } = whiteboardWith();
  const id = whiteboard.saveReport('log-analyst', {
    title: 'レポート',
    level: 'info',
    body: '本文',
    createdAt: 1_000_000,
  });

  // Favoriting flips the flag and reflects in the listing.
  assert.equal(whiteboard.toggleFavorite(id), true);
  assert.equal(whiteboard.listReports().find((r) => r.id === id).favorite, true);
  // While favorited, archiving is refused and the report stays on the board.
  assert.equal(whiteboard.archiveReport(id), false);
  assert.equal(whiteboard.listReports().length, 1);

  // Unfavoriting lets it be archived again.
  assert.equal(whiteboard.toggleFavorite(id), false);
  assert.equal(whiteboard.listReports().find((r) => r.id === id).favorite, false);
  assert.equal(whiteboard.archiveReport(id), true);
  assert.equal(whiteboard.listReports().length, 0);

  assert.equal(whiteboard.toggleFavorite('no-such-report'), null);
});

test('whiteboard: archiveReportsForTask takes a card\'s reports off the board, keeping pinned ones', () => {
  const { database, whiteboard } = whiteboardWith(7_000_000);
  const linked = whiteboard.saveReport('log-analyst', {
    title: '紐づく報告',
    level: 'info',
    body: '本文',
    createdAt: 1_000_000,
    task: 'card-1',
  });
  const pinned = whiteboard.saveReport('log-analyst', {
    title: 'ピン留めの報告',
    level: 'info',
    body: '本文',
    createdAt: 1_500_000,
    task: 'card-1',
  });
  whiteboard.toggleFavorite(pinned);
  const other = whiteboard.saveReport('issue-watcher', {
    title: '別タスクの報告',
    level: 'info',
    body: '本文',
    createdAt: 2_000_000,
    task: 'card-2',
  });

  // Only the un-pinned report for card-1 comes off the board.
  assert.equal(whiteboard.archiveReportsForTask('card-1'), 1);
  const remaining = whiteboard.listReports().map((r) => r.id);
  assert.deepEqual(remaining.sort(), [other, pinned].sort());
  // The archived row is kept, flagged archived with its read state cleared.
  const row = database.prepare('SELECT archived_at, "read" FROM reports WHERE id = ?').get(linked);
  assert.equal(row.archived_at, 7_000_000);

  // A task with no un-pinned reports left archives nothing.
  assert.equal(whiteboard.archiveReportsForTask('card-1'), 0);
});

test('whiteboard: reports keep their author name after the resident is archived', () => {
  const { whiteboard, residentStore } = whiteboardWith();
  whiteboard.saveReport('log-analyst', {
    title: '最後の報告',
    level: 'info',
    body: '本文',
    createdAt: 1_000_000,
  });
  residentStore.remove('log-analyst');
  assert.equal(whiteboard.listReports()[0].resident, 'log-analyst');
  // A run that finishes just after its resident was unassigned still reports.
  whiteboard.saveReport('log-analyst', {
    title: '滑り込みの報告',
    level: 'info',
    body: '',
    createdAt: 2_000_000,
  });
  assert.equal(whiteboard.listReports().length, 2);
});
