// Unit tests for the resident trigger timing (scheduler.js). All functions
// take the current time as an argument, so the tests pin exact local-time
// timestamps instead of relying on a real clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MISSED_RUN_GRACE_MS,
  isDue,
  isWithinActiveWindow,
  latestScheduledBefore,
  nextRunAt,
  nextScheduledAfter,
  parseTimeOfDay,
} from './scheduler.js';

// Monday 2026-08-17 10:00 local time.
const MONDAY_10_00 = new Date(2026, 7, 17, 10, 0, 0, 0).getTime();
const HOUR_MS = 60 * 60_000;

const MONDAY_9_SCHEDULE = { type: 'schedule', days: ['mon'], times: ['09:00'] };

test('parseTimeOfDay accepts HH:MM and rejects garbage', () => {
  assert.deepEqual(parseTimeOfDay('09:30'), { hours: 9, minutes: 30 });
  assert.equal(parseTimeOfDay('25:00'), null);
  assert.equal(parseTimeOfDay('mon'), null);
});

test('latestScheduledBefore / nextScheduledAfter find the surrounding occurrences', () => {
  const previous = latestScheduledBefore(MONDAY_9_SCHEDULE, MONDAY_10_00);
  assert.equal(previous, MONDAY_10_00 - HOUR_MS);
  const next = nextScheduledAfter(MONDAY_9_SCHEDULE, MONDAY_10_00);
  assert.equal(next, MONDAY_10_00 - HOUR_MS + 7 * 24 * HOUR_MS);
});

test('schedule: due shortly after the slot, not after the grace period', () => {
  const justAfterSlot = MONDAY_10_00 - HOUR_MS + 60_000;
  assert.equal(isDue(MONDAY_9_SCHEDULE, null, justAfterSlot), true);
  // 10:00 is beyond the one-hour grace for the 09:00 slot.
  assert.equal(MONDAY_10_00 - (MONDAY_10_00 - HOUR_MS) > MISSED_RUN_GRACE_MS, false);
  const wellPast = MONDAY_10_00 + HOUR_MS;
  assert.equal(isDue(MONDAY_9_SCHEDULE, null, wellPast), false);
});

test('schedule: an already-consumed occurrence does not fire again', () => {
  const slot = MONDAY_10_00 - HOUR_MS;
  assert.equal(isDue(MONDAY_9_SCHEDULE, slot, slot + 60_000), false);
  // The following week's slot fires even though last week's was consumed.
  const nextWeekSlot = slot + 7 * 24 * HOUR_MS;
  assert.equal(isDue(MONDAY_9_SCHEDULE, slot, nextWeekSlot + 60_000), true);
});

const OFFICE_HOURS_INTERVAL = {
  type: 'interval',
  minutes: 30,
  activeDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  activeHours: { start: '09:00', end: '19:00' },
};

test('interval: fires when elapsed and inside the active window', () => {
  assert.equal(isDue(OFFICE_HOURS_INTERVAL, null, MONDAY_10_00), true);
  assert.equal(isDue(OFFICE_HOURS_INTERVAL, MONDAY_10_00 - 29 * 60_000, MONDAY_10_00), false);
  assert.equal(isDue(OFFICE_HOURS_INTERVAL, MONDAY_10_00 - 31 * 60_000, MONDAY_10_00), true);
});

test('interval: sleeps outside active hours and days', () => {
  const monday20 = MONDAY_10_00 + 10 * HOUR_MS;
  assert.equal(isWithinActiveWindow(OFFICE_HOURS_INTERVAL, monday20), false);
  assert.equal(isDue(OFFICE_HOURS_INTERVAL, null, monday20), false);
  const sunday10 = MONDAY_10_00 - 24 * HOUR_MS;
  assert.equal(isDue(OFFICE_HOURS_INTERVAL, null, sunday10), false);
});

test('interval: overnight active hours wrap past midnight', () => {
  const nightShift = { type: 'interval', minutes: 10, activeHours: { start: '22:00', end: '06:00' } };
  const monday23 = MONDAY_10_00 + 13 * HOUR_MS;
  const monday12 = MONDAY_10_00 + 2 * HOUR_MS;
  assert.equal(isWithinActiveWindow(nightShift, monday23), true);
  assert.equal(isWithinActiveWindow(nightShift, monday12), false);
});

test('nextRunAt: interval waits out the remaining cooldown, schedule returns the next slot', () => {
  const lastRun = MONDAY_10_00 - 10 * 60_000;
  assert.equal(nextRunAt(OFFICE_HOURS_INTERVAL, lastRun, MONDAY_10_00), lastRun + 30 * 60_000);
  assert.equal(
    nextRunAt(MONDAY_9_SCHEDULE, MONDAY_10_00 - HOUR_MS, MONDAY_10_00),
    MONDAY_10_00 - HOUR_MS + 7 * 24 * HOUR_MS
  );
  assert.equal(nextRunAt({ type: 'nope' }, null, MONDAY_10_00), null);
});

test('nextRunAt: an interval outside its window advances to the window start', () => {
  const monday20 = MONDAY_10_00 + 10 * HOUR_MS;
  const next = nextRunAt(OFFICE_HOURS_INTERVAL, monday20 - HOUR_MS, monday20);
  const nextDate = new Date(next);
  assert.equal(nextDate.getDay(), 2); // Tuesday
  assert.equal(nextDate.getHours(), 9);
});
