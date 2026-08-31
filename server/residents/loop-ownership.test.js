// Unit tests for the resident-loop cross-instance guard (loop-ownership.js):
// claiming, backing off to a fresh heartbeat, taking over stale or released
// or malformed slots, and release being owner-guarded, over an in-memory
// SQLite database with an injected clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from './database.js';
import { createLoopOwnership, STALE_OWNER_MS } from './loop-ownership.js';

// Pinned so GC cannot finalize a fixture database's statements mid-test:
// node:sqlite finalizes them once the DatabaseSync object is collected, and
// tests destructuring only the guards would otherwise drop the last reference.
const openedDatabases = [];

function ownershipPairWith() {
  const database = openDatabase({ location: ':memory:' });
  openedDatabases.push(database);
  let currentTime = 1_000_000;
  const now = () => currentTime;
  return {
    database,
    advanceClock: (milliseconds) => {
      currentTime += milliseconds;
    },
    first: createLoopOwnership({ database, processId: 101, now }),
    second: createLoopOwnership({ database, processId: 202, now }),
  };
}

test('loop ownership: the first instance claims and keeps the loop', () => {
  const { first } = ownershipPairWith();
  assert.equal(first.acquire(), true);
  assert.equal(first.acquire(), true);
});

test('loop ownership: a second instance backs off while the heartbeat is fresh', () => {
  const { first, second, advanceClock } = ownershipPairWith();
  assert.equal(first.acquire(), true);
  advanceClock(STALE_OWNER_MS - 1);
  assert.equal(second.acquire(), false);
  assert.equal(first.acquire(), true);
});

test('loop ownership: a stale heartbeat is taken over on the next acquire', () => {
  const { first, second, advanceClock } = ownershipPairWith();
  assert.equal(first.acquire(), true);
  advanceClock(STALE_OWNER_MS);
  assert.equal(second.acquire(), true);
  assert.equal(second.acquire(), true);
  assert.equal(first.acquire(), false);
});

test('loop ownership: acquiring refreshes the heartbeat, not just the first claim', () => {
  const { first, second, advanceClock } = ownershipPairWith();
  assert.equal(first.acquire(), true);
  advanceClock(STALE_OWNER_MS - 1);
  assert.equal(first.acquire(), true);
  advanceClock(STALE_OWNER_MS - 1);
  assert.equal(second.acquire(), false);
});

test('loop ownership: release hands the loop to the other instance immediately', () => {
  const { first, second } = ownershipPairWith();
  assert.equal(first.acquire(), true);
  first.release();
  assert.equal(second.acquire(), true);
  assert.equal(first.acquire(), false);
});

test('loop ownership: a non-owner releasing does not steal the loop', () => {
  const { first, second } = ownershipPairWith();
  assert.equal(first.acquire(), true);
  second.release();
  assert.equal(first.acquire(), true);
  assert.equal(second.acquire(), false);
});

test('loop ownership: a malformed leftover slot is treated as stale', () => {
  const { database, first } = ownershipPairWith();
  database
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
    .run('resident_loop_owner', 'not-a-heartbeat');
  assert.equal(first.acquire(), true);
});
