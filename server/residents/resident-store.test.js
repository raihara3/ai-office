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
    model: null,
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
  assert.ok(validateResident(validConfiguration({ seat: 12 })).length > 0);
  assert.ok(validateResident(validConfiguration({ cli: 'gpt' })).length > 0);
  assert.ok(validateResident(validConfiguration({ mode: 'yolo' })).length > 0);
  assert.ok(validateResident(validConfiguration({ model: '--help' })).length > 0);
  assert.ok(validateResident(validConfiguration({ model: 'model with spaces' })).length > 0);
  assert.ok(validateResident(validConfiguration({ model: 'm'.repeat(201) })).length > 0);
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

// Pinned so GC cannot finalize a fixture database's statements mid-test:
// node:sqlite finalizes them once the DatabaseSync object is collected, and
// tests destructuring only the store would otherwise drop the last reference.
const openedDatabases = [];

function storeWith(nowValue = 1000) {
  const database = openDatabase({ location: ':memory:' });
  openedDatabases.push(database);
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
  assert.equal(entry.configuration.model, null);
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
    configuration: validConfiguration({ displayName: '改名後', model: 'claude-fable-5' }),
    instructions: 'v2',
  });
  const after = database.prepare('SELECT id, created_at FROM residents WHERE name = ?').get('log-analyst');
  assert.equal(after.id, before.id);
  assert.equal(after.created_at, before.created_at);
  assert.equal(store.read('log-analyst').configuration.displayName, '改名後');
  assert.equal(store.read('log-analyst').configuration.model, 'claude-fable-5');
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
  assert.deepEqual(store.listTeams(), [{ id: 'default', name: '常駐チーム', seatCount: 6 }]);
});

test('team store: create, rename, resize and validation', () => {
  const { store } = storeWith();
  const id = store.saveTeam({ name: '研究チーム', seatCount: 3 });
  assert.deepEqual(
    store.listTeams().map((team) => team.name),
    ['常駐チーム', '研究チーム']
  );

  // Partial updates merge onto existing values.
  store.saveTeam({ id, seatCount: 9 });
  store.saveTeam({ id, name: '開発チーム' });
  const team = store.listTeams().find((entry) => entry.id === id);
  assert.equal(team.name, '開発チーム');
  assert.equal(team.seatCount, 9);

  assert.throws(() => store.saveTeam({ name: '   ' }), /team name is required/);
  assert.throws(() => store.saveTeam({ name: '常駐チーム', seatCount: 6 }), /already in use/);
  assert.throws(() => store.saveTeam({ name: 'x', seatCount: 0 }), /seatCount must be/);
  assert.throws(() => store.saveTeam({ name: 'x', seatCount: 13 }), /seatCount must be/);
  assert.throws(() => store.saveTeam({ id: 'no-such-team', name: 'x' }), /unknown team/);
});

test('team store: shrink is refused while a resident sits beyond the new count', () => {
  const { store } = storeWith();
  const id = store.saveTeam({ name: '研究チーム', seatCount: 6 });
  store.save('dweller', {
    configuration: validConfiguration({ seat: 4 }),
    instructions: '',
    teamId: id,
  });
  assert.throws(() => store.saveTeam({ id, seatCount: 3 }), /cannot shrink to 3 seats: dweller/);
  store.saveTeam({ id, seatCount: 5 }); // seat 4 still fits
});

test('team store: delete refuses residents and the last team, then archives', () => {
  const { database, store } = storeWith(7000);
  const id = store.saveTeam({ name: '研究チーム', seatCount: 3 });
  store.save('dweller', { configuration: validConfiguration(), instructions: '', teamId: id });
  assert.throws(() => store.deleteTeam(id), /still has 1 resident/);
  store.remove('dweller');
  store.deleteTeam(id);
  assert.equal(store.listTeams().length, 1);
  assert.equal(database.prepare('SELECT archived_at FROM teams WHERE id = ?').get(id).archived_at, 7000);
  assert.throws(() => store.deleteTeam('default'), /cannot delete the last team/);
  assert.throws(() => store.deleteTeam(id), /unknown team/);
});

test('resident store: seats are scoped per team and residents can move teams', () => {
  const { store } = storeWith();
  const teamId = store.saveTeam({ name: '研究チーム', seatCount: 3 });
  store.save('alpha', { configuration: validConfiguration({ seat: 0 }), instructions: '' });
  // Same seat number in another team coexists.
  store.save('beta', { configuration: validConfiguration({ seat: 0 }), instructions: '', teamId });
  // Conflict within one team still throws.
  assert.throws(
    () => store.save('gamma', { configuration: validConfiguration({ seat: 0 }), instructions: '', teamId }),
    /seat 0 is already taken by beta/
  );
  // A seat beyond the team's count is refused even though it passes the static check.
  assert.throws(
    () => store.save('gamma', { configuration: validConfiguration({ seat: 3 }), instructions: '', teamId }),
    /seat must be an integer 0..2/
  );
  assert.throws(
    () => store.save('gamma', { configuration: validConfiguration(), instructions: '', teamId: 'nope' }),
    /unknown team/
  );
  // Editing without teamId keeps the team; an explicit teamId moves it.
  store.save('alpha', { configuration: validConfiguration({ seat: 1 }), instructions: '' });
  assert.equal(store.read('alpha').teamId, 'default');
  store.save('alpha', { configuration: validConfiguration({ seat: 1 }), instructions: '', teamId });
  assert.equal(store.read('alpha').teamId, teamId);
});
