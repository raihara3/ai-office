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
} from './settings-store.js';

function storeWith() {
  const database = openDatabase({ location: ':memory:' });
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
