// Unit tests for the resident store (resident-store.js): configuration
// validation, save/read/list round-trips, seat conflicts, run-state updates
// and archive-on-remove, over an in-memory SQLite database.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from './database.js';
import { createResidentStore, validateResident } from './resident-store.js';

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

function storeWith(nowValue = 1000) {
  const database = openDatabase({ location: ':memory:' });
  return { database, store: createResidentStore({ database, now: () => nowValue }) };
}

test('resident store round-trips save/read/list and validates on save', () => {
  const { store } = storeWith();

  store.save('log-analyst', {
    configuration: validConfiguration(),
    instructions: '# 役割\n週次レポートを書く',
  });
  const entry = store.read('log-analyst');
  assert.equal(entry.configuration.displayName, 'アナリスト');
  assert.deepEqual(entry.configuration.trigger, { type: 'schedule', days: ['mon'], times: ['09:00'] });
  assert.equal(entry.instructions, '# 役割\n週次レポートを書く');
  assert.equal(entry.teamId, 'default');
  assert.equal(entry.state.lastRunAt, null);

  store.saveState('log-analyst', { lastRunAt: 42 });
  assert.equal(store.read('log-analyst').state.lastRunAt, 42);

  assert.equal(store.list().length, 1);
  assert.equal(store.list({ withInstructions: false })[0].instructions, '');
  assert.throws(() => store.save('log-analyst', { configuration: validConfiguration({ seat: 9 }) }));
  assert.throws(() => store.save('../escape', { configuration: validConfiguration() }));
  // 'user' is the kanban sentinel for the human's column — a resident with
  // that name would pick up the human's cards and run them headlessly.
  assert.throws(
    () => store.save('user', { configuration: validConfiguration({ seat: 5 }), instructions: '' }),
    /reserved for the human/
  );
});

test('resident store: editing preserves id, team and creation time', () => {
  const { database, store } = storeWith();
  store.save('log-analyst', { configuration: validConfiguration(), instructions: 'v1' });
  const before = database.prepare('SELECT id, created_at FROM residents WHERE name = ?').get('log-analyst');

  store.save('log-analyst', {
    configuration: validConfiguration({ displayName: '改名後' }),
    instructions: 'v2',
  });
  const after = database.prepare('SELECT id, created_at FROM residents WHERE name = ?').get('log-analyst');
  assert.equal(after.id, before.id);
  assert.equal(after.created_at, before.created_at);
  assert.equal(store.read('log-analyst').configuration.displayName, '改名後');
  assert.equal(store.list().length, 1);
});

test('resident store: a seat can only hold one active resident', () => {
  const { store } = storeWith();
  store.save('first', { configuration: validConfiguration({ seat: 3 }), instructions: '' });
  assert.throws(
    () => store.save('second', { configuration: validConfiguration({ seat: 3 }), instructions: '' }),
    /seat 3 is already taken by first/
  );
  // The holder itself can keep saving into its own seat.
  store.save('first', { configuration: validConfiguration({ seat: 3 }), instructions: 'x' });
  // Archiving frees the seat.
  store.remove('first');
  store.save('second', { configuration: validConfiguration({ seat: 3 }), instructions: '' });
});

test('resident store: remove archives the row instead of deleting it', () => {
  const { database, store } = storeWith(7000);
  store.save('issue-watcher', { configuration: validConfiguration(), instructions: 'x' });
  store.remove('issue-watcher');
  assert.equal(store.read('issue-watcher'), null);
  assert.equal(store.list().length, 0);
  const row = database.prepare('SELECT archived_at FROM residents WHERE name = ?').get('issue-watcher');
  assert.equal(row.archived_at, 7000);
  assert.throws(() => store.remove('issue-watcher'), /unknown resident/);

  // The name can be reused; the successor is a fresh row with a fresh id.
  store.save('issue-watcher', { configuration: validConfiguration(), instructions: 'y' });
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM residents').get().n, 2);
  assert.notEqual(
    database.prepare('SELECT id FROM residents WHERE name = ? AND archived_at IS NULL').get('issue-watcher').id,
    'issue-watcher'
  );
});

test('resident store: listTeams returns the seeded default team', () => {
  const { store } = storeWith();
  assert.deepEqual(store.listTeams(), [{ id: 'default', name: 'office' }]);
});
