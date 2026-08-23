// Unit tests for the resident manifest store (manifest.js), driven through an
// in-memory filesystem stub so no real files are touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createManifestStore, validateResident } from './manifest.js';

function validConfiguration(overrides = {}) {
  return {
    displayName: 'アナリスト',
    seat: 0,
    cli: 'claude',
    mode: 'read-only',
    workingDirectory: '/tmp/repo',
    trigger: { type: 'schedule', days: ['mon'], times: ['09:00'] },
    precheck: null,
    enabled: true,
    ...overrides,
  };
}

test('validateResident accepts a complete configuration', () => {
  assert.deepEqual(validateResident(validConfiguration()), []);
});

test('validateResident rejects bad seat, cli, mode and trigger', () => {
  assert.ok(validateResident(validConfiguration({ seat: 6 })).length > 0);
  assert.ok(validateResident(validConfiguration({ cli: 'gpt' })).length > 0);
  assert.ok(validateResident(validConfiguration({ mode: 'yolo' })).length > 0);
  assert.ok(
    validateResident(validConfiguration({ trigger: { type: 'schedule', days: [], times: ['09:00'] } }))
      .length > 0
  );
  assert.ok(
    validateResident(validConfiguration({ trigger: { type: 'interval', minutes: 0 } })).length > 0
  );
  assert.deepEqual(
    validateResident(
      validConfiguration({
        trigger: {
          type: 'interval',
          minutes: 30,
          activeDays: ['mon'],
          activeHours: { start: '09:00', end: '19:00' },
        },
      })
    ),
    []
  );
});

// A minimal in-memory stand-in for the fs surface the store uses.
function memoryFileSystem() {
  const files = new Map();
  const directories = new Set();
  return {
    files,
    readFileSync(filePath) {
      if (!files.has(filePath)) throw new Error(`ENOENT: ${filePath}`);
      return files.get(filePath);
    },
    writeFileSync(filePath, content) {
      files.set(filePath, String(content));
    },
    mkdirSync(directory) {
      directories.add(directory);
    },
    readdirSync(directory) {
      const names = new Set();
      for (const filePath of files.keys()) {
        if (filePath.startsWith(directory + path.sep)) {
          names.add(filePath.slice(directory.length + 1).split(path.sep)[0]);
        }
      }
      if (names.size === 0) throw new Error(`ENOENT: ${directory}`);
      return [...names].map((name) => ({ name, isDirectory: () => !name.includes('.') }));
    },
    renameSync(from, to) {
      for (const [filePath, content] of [...files]) {
        if (filePath.startsWith(from + path.sep)) {
          files.delete(filePath);
          files.set(to + filePath.slice(from.length), content);
        }
      }
    },
  };
}

test('manifest store round-trips save/read/list and validates on save', () => {
  const fileSystem = memoryFileSystem();
  const store = createManifestStore({ dataDirectory: '/data', fileSystem, now: () => 1000 });

  store.save('log-analyst', {
    configuration: validConfiguration(),
    instructions: '# 役割\n週次レポートを書く',
  });
  const entry = store.read('log-analyst');
  assert.equal(entry.configuration.displayName, 'アナリスト');
  assert.equal(entry.instructions, '# 役割\n週次レポートを書く');
  assert.deepEqual(entry.state, {});

  store.saveState('log-analyst', { lastRunAt: 42 });
  assert.equal(store.read('log-analyst').state.lastRunAt, 42);

  assert.equal(store.list().length, 1);
  assert.throws(() => store.save('log-analyst', { configuration: validConfiguration({ seat: 9 }) }));
  assert.throws(() => store.save('../escape', { configuration: validConfiguration() }));
});

test('manifest store remove archives the directory instead of deleting it', () => {
  const fileSystem = memoryFileSystem();
  const store = createManifestStore({ dataDirectory: '/data', fileSystem, now: () => 1000 });
  store.save('issue-watcher', { configuration: validConfiguration(), instructions: 'x' });
  store.remove('issue-watcher');
  assert.equal(store.read('issue-watcher'), null);
  assert.equal(store.list().length, 0);
  const archived = [...fileSystem.files.keys()].filter((p) => p.includes('.removed'));
  assert.ok(archived.length > 0);
});
