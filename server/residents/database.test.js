// Unit tests for the SQLite opener (database.js): schema migration to the
// latest user_version, reopening an already-migrated file, and refusing a
// database written by a newer app version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from './database.js';

test('database: openDatabase migrates a fresh database to the latest schema', () => {
  const database = openDatabase({ location: ':memory:' });
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ['cards', 'meta', 'reports']);

  database
    .prepare('INSERT INTO reports (id, resident, title, created_at) VALUES (?, ?, ?, ?)')
    .run('r1', 'task-runner', '報告', 1_000_000);
  const row = database.prepare('SELECT * FROM reports WHERE id = ?').get('r1');
  assert.equal(row.level, 'info');
  assert.equal(row.read, 0);
  assert.equal(row.favorite, 0);
  assert.equal(row.archived_at, null);
  database.close();
});

test('database: reopening a migrated file keeps the data and re-runs nothing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-db-'));
  const location = path.join(directory, 'office.db');
  try {
    const first = openDatabase({ location });
    first
      .prepare('INSERT INTO cards (id, title, assignee, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('c1', 'タスク', 'user', 'user', 1_000_000, 1_000_000);
    first.close();

    const second = openDatabase({ location });
    assert.equal(second.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(second.prepare('SELECT title FROM cards WHERE id = ?').get('c1').title, 'タスク');
    second.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('database: a database from a newer app version is refused', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-db-'));
  const location = path.join(directory, 'office.db');
  try {
    const future = new DatabaseSync(location);
    future.exec('PRAGMA user_version = 99');
    future.close();

    assert.throws(() => openDatabase({ location }), /newer than this app understands/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
