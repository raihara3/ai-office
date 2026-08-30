// Unit tests for the one-time resident-file import (resident-import.js):
// disk residents become rows with id = legacy name, invalid directories are
// skipped and left on disk, dangling card/report names get archived ghosts,
// session-registry bindings move into session_bindings, and the meta marker
// makes a second run a no-op — over an in-memory filesystem stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { openDatabase } from './database.js';
import { ensureResidentId, importResidents } from './resident-import.js';

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

const VALID_CONFIGURATION = {
  displayName: 'タスク係',
  seat: 2,
  cli: 'claude',
  mode: 'edit',
  workingDirectory: '~/dev/',
  trigger: { type: 'interval', minutes: 10 },
  precheck: null,
  enabled: true,
};

test('resident import: disk residents become rows with id = name, files cleaned up', () => {
  const fileSystem = memoryFileSystem();
  fileSystem.writeFileSync('/data/residents/task-runner/resident.json', JSON.stringify(VALID_CONFIGURATION));
  fileSystem.writeFileSync('/data/residents/task-runner/INSTRUCTIONS.md', 'タスクをこなす');
  fileSystem.writeFileSync(
    '/data/residents/task-runner/state.json',
    JSON.stringify({ lastRunAt: 1000, lastOutcome: 'ok', lastFinishedAt: 2000 })
  );
  fileSystem.writeFileSync(
    '/data/session-registry.json',
    JSON.stringify({
      bindings: [
        { resident: 'task-runner', fragment: 'aaaa-bbbb', at: 1500 },
        { resident: 'long-gone', fragment: '/tmp/x.jsonl', at: 1600 },
      ],
    })
  );

  const database = openDatabase({ location: ':memory:' });
  const imported = importResidents(database, {
    dataDirectory: '/data',
    fileSystem,
    now: () => 5000,
  });
  assert.deepEqual(imported, { residents: 1, ghosts: 0, bindings: 1 });

  const row = database.prepare('SELECT * FROM residents WHERE name = ?').get('task-runner');
  assert.equal(row.id, 'task-runner'); // legacy slug becomes the id
  assert.equal(row.team_id, 'default');
  assert.equal(row.display_name, 'タスク係');
  assert.equal(row.instructions, 'タスクをこなす');
  assert.equal(JSON.parse(row.trigger).minutes, 10);
  assert.equal(row.last_run_at, 1000);
  assert.equal(row.last_outcome, 'ok');
  assert.equal(row.archived_at, null);

  const binding = database.prepare('SELECT * FROM session_bindings').get();
  assert.equal(binding.fragment, 'aaaa-bbbb');
  assert.equal(binding.resident_id, 'task-runner');
  // The unknown resident's binding was dropped, and all files are gone.
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM session_bindings').get().n, 1);
  assert.deepEqual([...fileSystem.files.keys()], []);

  // The marker, not table contents, blocks a second run.
  assert.deepEqual(
    importResidents(database, { dataDirectory: '/data', fileSystem, now: () => 6000 }),
    { residents: 0, ghosts: 0, bindings: 0 }
  );
  database.close();
});

test('resident import: an invalid directory is skipped and its files stay', () => {
  const fileSystem = memoryFileSystem();
  fileSystem.writeFileSync('/data/residents/broken/resident.json', '{"displayName": ""}');
  fileSystem.writeFileSync('/data/residents/ok/resident.json', JSON.stringify(VALID_CONFIGURATION));

  const database = openDatabase({ location: ':memory:' });
  const imported = importResidents(database, {
    dataDirectory: '/data',
    fileSystem,
    now: () => 5000,
  });
  assert.equal(imported.residents, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM residents').get().n, 1);
  // The broken resident's file is untouched; the imported one is gone.
  assert.deepEqual([...fileSystem.files.keys()], ['/data/residents/broken/resident.json']);
  database.close();
});

test('resident import: dangling card/report names get archived ghosts', () => {
  const database = openDatabase({ location: ':memory:' });
  // Rows as the v2 migration leaves them: verbatim names in the id columns.
  database.exec('PRAGMA foreign_keys = OFF');
  database
    .prepare(
      'INSERT INTO cards (id, title, assignee_id, origin_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run('c1', 'カード', 'vanished', null, 1000, 1000);
  database.exec('PRAGMA foreign_keys = ON');

  const imported = importResidents(database, {
    dataDirectory: '/data',
    fileSystem: memoryFileSystem(),
    now: () => 5000,
  });
  assert.equal(imported.ghosts, 1);
  const ghost = database.prepare('SELECT * FROM residents WHERE id = ?').get('vanished');
  assert.equal(ghost.name, 'vanished');
  assert.notEqual(ghost.archived_at, null);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
});

test('ensureResidentId prefers the active resident and creates ghosts once', () => {
  const database = openDatabase({ location: ':memory:' });
  const first = ensureResidentId(database, 'someone', () => 1000);
  assert.equal(first, 'someone'); // ghost created
  assert.equal(ensureResidentId(database, 'someone', () => 2000), 'someone'); // reused
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM residents').get().n, 1);
  database.close();
});
