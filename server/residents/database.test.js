// Unit tests for the SQLite opener (database.js): schema migration to the
// latest user_version, the v1 → v2 name-to-id rebuild, reopening an
// already-migrated file, and refusing a database written by a newer app
// version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS, openDatabase } from './database.js';

test('database: openDatabase migrates a fresh database to the latest schema', () => {
  const database = openDatabase({ location: ':memory:' });
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ['cards', 'meta', 'reports', 'residents', 'session_bindings', 'teams']);

  // The default team is seeded by v2 and renamed/sized by v3.
  const team = database.prepare('SELECT id, name, seat_count FROM teams').get();
  assert.equal(team.id, 'default');
  assert.equal(team.name, '常駐チーム');
  assert.equal(team.seat_count, 6);

  database
    .prepare(
      `INSERT INTO residents (id, team_id, name, display_name, cli, mode, seat, working_directory, "trigger", created_at, updated_at)
       VALUES ('r1', 'default', 'task-runner', 'タスク', 'claude', 'edit', 0, '~', '{"type":"interval","minutes":10}', 1000, 1000)`
    )
    .run();
  database
    .prepare('INSERT INTO reports (id, resident_id, title, created_at) VALUES (?, ?, ?, ?)')
    .run('rep1', 'r1', '報告', 1_000_000);
  const row = database.prepare('SELECT * FROM reports WHERE id = ?').get('rep1');
  assert.equal(row.level, 'info');
  assert.equal(row.read, 0);
  assert.equal(row.archived_at, null);

  // Foreign keys are enforced after migration: a dangling resident_id throws.
  assert.throws(() =>
    database
      .prepare('INSERT INTO reports (id, resident_id, title, created_at) VALUES (?, ?, ?, ?)')
      .run('rep2', 'no-such-resident', 'x', 1)
  );
  database.close();
});

test('database: v1 data migrates to v2 with names copied into the id columns', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-db-'));
  const location = path.join(directory, 'office.db');
  try {
    // Build a version-1 database the way the released v1 opener left it.
    const v1 = new DatabaseSync(location);
    v1.exec('PRAGMA foreign_keys = OFF');
    v1.exec(MIGRATIONS[0]);
    v1.exec('PRAGMA user_version = 1');
    v1.prepare(
      `INSERT INTO cards (id, title, assignee, origin, body, position, created_at, updated_at)
       VALUES ('c1', '人間のカード', 'user', 'user', '', 0, 1000, 1000),
              ('c2', 'アリスのカード', 'alice', 'user', '', 0, 2000, 2000)`
    ).run();
    v1.prepare(
      `INSERT INTO reports (id, resident, title, created_at) VALUES ('rep1', 'alice', '報告', 3000)`
    ).run();
    v1.close();

    const database = openDatabase({ location });
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    const cards = database.prepare('SELECT id, assignee_id, origin_id FROM cards ORDER BY id').all();
    assert.deepEqual(
      cards.map((card) => ({ id: card.id, assignee_id: card.assignee_id, origin_id: card.origin_id })),
      [
        { id: 'c1', assignee_id: null, origin_id: null },
        { id: 'c2', assignee_id: 'alice', origin_id: null },
      ]
    );
    assert.equal(database.prepare('SELECT resident_id FROM reports').get().resident_id, 'alice');
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM teams').get().n, 1);
    database.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('database: reopening a migrated file keeps the data and re-runs nothing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-db-'));
  const location = path.join(directory, 'office.db');
  try {
    const first = openDatabase({ location });
    first
      .prepare('INSERT INTO cards (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('c1', 'タスク', 1_000_000, 1_000_000);
    first.close();

    const second = openDatabase({ location });
    assert.equal(second.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
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
