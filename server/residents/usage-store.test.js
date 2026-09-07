// Unit tests for the run-usage store (usage-store.js): recording per-run
// token usage and the per-resident totals feeding the labor-cost panel, over
// an in-memory SQLite database with resident fixtures created through the
// resident store.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from './database.js';
import { createResidentStore } from './resident-store.js';
import { createUsageStore } from './usage-store.js';

const DAY_MS = 24 * 60 * 60_000;

// Pinned so GC cannot finalize a fixture database's statements mid-test:
// node:sqlite finalizes them once the DatabaseSync object is collected, and
// tests destructuring only the store would otherwise drop the last reference.
const openedDatabases = [];

function usageStoreWith(nowValue = 100 * DAY_MS) {
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
  return {
    database,
    residentStore,
    usageStore: createUsageStore({ database, now: () => nowValue }),
    nowValue,
  };
}

test('usage store: recordRun → totals split cumulative and recent windows', () => {
  const { usageStore, nowValue } = usageStoreWith();

  // An old run outside the 30-day window and two recent ones.
  usageStore.recordRun('log-analyst', {
    startedAt: nowValue - 40 * DAY_MS,
    finishedAt: nowValue - 40 * DAY_MS + 60_000,
    inputTokens: 1_000,
    outputTokens: 100,
  });
  usageStore.recordRun('log-analyst', {
    startedAt: nowValue - DAY_MS,
    finishedAt: nowValue - DAY_MS + 60_000,
    inputTokens: 200,
    outputTokens: 20,
  });
  usageStore.recordRun('log-analyst', {
    startedAt: nowValue,
    finishedAt: nowValue,
    inputTokens: 50,
    outputTokens: 5,
  });

  const totals = usageStore.totals();
  // One row per active resident, roster order (same team, seat order), with
  // zeroes for the resident that never ran.
  assert.deepEqual(totals, [
    {
      resident: 'log-analyst',
      runCount: 3,
      inputTokens: 1_250,
      outputTokens: 125,
      recentInputTokens: 250,
      recentOutputTokens: 25,
    },
    {
      resident: 'issue-watcher',
      runCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      recentInputTokens: 0,
      recentOutputTokens: 0,
    },
  ]);
});

test('usage store: unknown resident is refused, archived resident keeps rows but leaves totals', () => {
  const { usageStore, residentStore, nowValue } = usageStoreWith();

  assert.throws(
    () => usageStore.recordRun('no-such-resident', {
      startedAt: nowValue,
      finishedAt: nowValue,
      inputTokens: 1,
      outputTokens: 1,
    }),
    /unknown resident/
  );

  // A resident archived after its runs drops out of the roster listing; the
  // rows stay behind (append-only) for when it returns.
  usageStore.recordRun('issue-watcher', {
    startedAt: nowValue,
    finishedAt: nowValue,
    inputTokens: 10,
    outputTokens: 1,
  });
  residentStore.remove('issue-watcher');
  assert.deepEqual(
    usageStore.totals().map((entry) => entry.resident),
    ['log-analyst']
  );
});
