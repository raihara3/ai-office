// Trigger timing for resident team members: pure functions that decide when a
// resident is due to run. Two trigger shapes are supported:
//
//   { type: 'schedule', days: ['mon'], times: ['09:00'] }
//     — fire at fixed weekday/time combinations (local time).
//   { type: 'interval', minutes: 30, activeDays?: [...], activeHours?: {start, end} }
//     — fire every N minutes, optionally only inside an active window.
//
// Everything takes the current time as an argument, so the tick loop in
// residents.js can drive it with a real clock while tests use a fixed one.

export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// A scheduled occurrence still fires this long after its slot (e.g. the
// server was asleep at 09:00); anything older is skipped, not caught up.
export const MISSED_RUN_GRACE_MS = 60 * 60_000;

export function parseTimeOfDay(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

// The occurrence of `timeOfDay` on the day `dayOffset` days away from `now`,
// as a local-time epoch timestamp. On a DST spring-forward day a slot inside
// the skipped hour normalizes forward (02:30 → 03:30), which may shift or
// skip that one occurrence — accepted for a local single-user tool.
function occurrenceAt(now, dayOffset, timeOfDay) {
  const date = new Date(now);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(timeOfDay.hours, timeOfDay.minutes, 0, 0);
  return date.getTime();
}

function scheduledOccurrences(trigger, now, dayOffsets) {
  const occurrences = [];
  for (const dayOffset of dayOffsets) {
    const date = new Date(now);
    date.setDate(date.getDate() + dayOffset);
    if (!trigger.days.includes(WEEKDAY_KEYS[date.getDay()])) continue;
    for (const timeText of trigger.times) {
      const timeOfDay = parseTimeOfDay(timeText);
      if (timeOfDay !== null) occurrences.push(occurrenceAt(now, dayOffset, timeOfDay));
    }
  }
  return occurrences;
}

const PAST_WEEK = [-7, -6, -5, -4, -3, -2, -1, 0];
const COMING_WEEK = [0, 1, 2, 3, 4, 5, 6, 7];

// The most recent scheduled occurrence at or before `now`, or null.
export function latestScheduledBefore(trigger, now) {
  const past = scheduledOccurrences(trigger, now, PAST_WEEK).filter((at) => at <= now);
  return past.length > 0 ? Math.max(...past) : null;
}

// The earliest scheduled occurrence after `now`, or null.
export function nextScheduledAfter(trigger, now) {
  const coming = scheduledOccurrences(trigger, now, COMING_WEEK).filter((at) => at > now);
  return coming.length > 0 ? Math.min(...coming) : null;
}

// Whether `now` falls inside an interval trigger's active window. Days and
// hours are both optional; an end before the start wraps past midnight
// (e.g. 22:00–06:00).
export function isWithinActiveWindow(trigger, now) {
  const date = new Date(now);
  if (Array.isArray(trigger.activeDays) && trigger.activeDays.length > 0) {
    if (!trigger.activeDays.includes(WEEKDAY_KEYS[date.getDay()])) return false;
  }
  const hours = trigger.activeHours;
  if (!hours) return true;
  const start = parseTimeOfDay(hours.start);
  const end = parseTimeOfDay(hours.end);
  if (start === null || end === null) return true;
  const minuteOfDay = date.getHours() * 60 + date.getMinutes();
  const startMinute = start.hours * 60 + start.minutes;
  const endMinute = end.hours * 60 + end.minutes;
  if (startMinute <= endMinute) return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  return minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

// Whether the resident should run now, given when it last started a run.
export function isDue(trigger, lastRunAt, now) {
  if (trigger?.type === 'schedule') {
    const occurrence = latestScheduledBefore(trigger, now);
    if (occurrence === null) return false;
    if (now - occurrence > MISSED_RUN_GRACE_MS) return false;
    return lastRunAt === null || occurrence > lastRunAt;
  }
  if (trigger?.type === 'interval') {
    if (!isWithinActiveWindow(trigger, now)) return false;
    return lastRunAt === null || now - lastRunAt >= trigger.minutes * 60_000;
  }
  return false;
}

// The next moment a run may start, for display in the resident panel.
// Returns null when the trigger is malformed.
export function nextRunAt(trigger, lastRunAt, now) {
  if (trigger?.type === 'schedule') {
    if (isDue(trigger, lastRunAt, now)) return now;
    return nextScheduledAfter(trigger, now);
  }
  if (trigger?.type === 'interval') {
    let candidate = lastRunAt === null ? now : lastRunAt + trigger.minutes * 60_000;
    if (candidate < now) candidate = now;
    // Walk forward in minute steps until inside the active window; the window
    // repeats weekly, so a bounded scan always terminates.
    const LIMIT = 8 * 24 * 60;
    for (let step = 0; step < LIMIT; step += 1) {
      const at = candidate + step * 60_000;
      if (isWithinActiveWindow(trigger, at)) return at;
    }
    return null;
  }
  return null;
}
