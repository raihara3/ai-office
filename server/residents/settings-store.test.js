// Unit tests for the office settings store (settings-store.js): the office
// name default, persistence, trimming and the 10-character cap, over an
// in-memory SQLite database.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from './database.js';
import {
  createSettingsStore,
  DEFAULT_OFFICE_NAME,
  MAX_OFFICE_NAME_LENGTH,
  MAX_BOARD_COLUMN_KEYS,
} from './settings-store.js';

// Pinned so GC cannot finalize a fixture database's statements mid-test:
// node:sqlite finalizes them once the DatabaseSync object is collected, and
// tests destructuring only the store would otherwise drop the last reference.
const openedDatabases = [];

function storeWith() {
  const database = openDatabase({ location: ':memory:' });
  openedDatabases.push(database);
  return { database, settings: createSettingsStore({ database }) };
}

test('settings: office name defaults until one is saved', () => {
  const { settings } = storeWith();
  assert.equal(settings.getOfficeName(), DEFAULT_OFFICE_NAME);
});

test('settings: saving an office name persists and round-trips', () => {
  const { settings } = storeWith();
  assert.equal(settings.setOfficeName('サンプル社'), 'サンプル社');
  assert.equal(settings.getOfficeName(), 'サンプル社');
});

test('settings: saving again overwrites the previous name', () => {
  const { settings } = storeWith();
  settings.setOfficeName('First');
  settings.setOfficeName('Second');
  assert.equal(settings.getOfficeName(), 'Second');
});

test('settings: surrounding whitespace is trimmed', () => {
  const { settings } = storeWith();
  assert.equal(settings.setOfficeName('  Acme  '), 'Acme');
  assert.equal(settings.getOfficeName(), 'Acme');
});

test('settings: an empty or whitespace-only name is refused', () => {
  const { settings } = storeWith();
  assert.throws(() => settings.setOfficeName('   '), /office name is required/);
  assert.throws(() => settings.setOfficeName(null), /office name is required/);
});

test('settings: a name over the cap is refused, at the cap is accepted', () => {
  const { settings } = storeWith();
  const tooLong = 'あ'.repeat(MAX_OFFICE_NAME_LENGTH + 1);
  assert.throws(() => settings.setOfficeName(tooLong), /10 characters or fewer/);
  const atCap = 'あ'.repeat(MAX_OFFICE_NAME_LENGTH);
  assert.equal(settings.setOfficeName(atCap), atCap);
});

test('settings: board column order defaults to empty until one is saved', () => {
  const { settings } = storeWith();
  assert.deepEqual(settings.getBoardColumnOrder(), []);
});

test('settings: saving a column order persists and round-trips', () => {
  const { settings } = storeWith();
  const order = ['done', 'team:abc', 'user'];
  assert.deepEqual(settings.setBoardColumnOrder(order), order);
  assert.deepEqual(settings.getBoardColumnOrder(), order);
});

test('settings: column order trims, drops blanks and deduplicates keeping first', () => {
  const { settings } = storeWith();
  assert.deepEqual(
    settings.setBoardColumnOrder(['  user  ', '', 'user', 'done']),
    ['user', 'done']
  );
});

test('settings: a non-array column order is refused', () => {
  const { settings } = storeWith();
  assert.throws(() => settings.setBoardColumnOrder('user'), /must be an array/);
  assert.throws(() => settings.setBoardColumnOrder([1, 2]), /must be strings/);
});

test('settings: a column order over the cap is refused', () => {
  const { settings } = storeWith();
  const tooMany = Array.from({ length: MAX_BOARD_COLUMN_KEYS + 1 }, (_, i) => `team:${i}`);
  assert.throws(() => settings.setBoardColumnOrder(tooMany), /keys or fewer/);
});
