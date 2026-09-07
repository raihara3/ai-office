// Unit tests for the OS-notification adapter (notifications.js): edge
// detection over injected snapshots, the seeded-baseline first snapshot,
// resident/subagent filtering and the attention badge count. Delivery is a
// spy — no Electron, no osascript.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNotificationWatcher } from './notifications.js';

function makeWatcher() {
  let listener = null;
  const notifications = [];
  const badges = [];
  const unsubscribe = createNotificationWatcher({
    subscribe: (subscriber) => {
      listener = subscriber;
      return () => {};
    },
    notify: (payload) => notifications.push(payload),
    updateBadge: (count) => badges.push(count),
  });
  return { push: (snapshot) => listener(snapshot), notifications, badges, unsubscribe };
}

function employee(overrides = {}) {
  return {
    key: 'claude:/log/a.jsonl',
    name: 'Claude Code',
    project: 'my-repo',
    status: 'working',
    resident: null,
    isSubagent: false,
    ...overrides,
  };
}

function snapshotWith(employees, { reviewNeeded = 0, officeName = 'AI OFFICE' } = {}) {
  return { employees, whiteboard: { reviewNeeded }, officeName };
}

test('notifications: first snapshot only seeds the baseline', () => {
  const watcher = makeWatcher();
  watcher.push(snapshotWith([employee({ status: 'waiting' })], { reviewNeeded: 2 }));
  assert.deepEqual(watcher.notifications, []);
  // The badge still reflects reality right away.
  assert.deepEqual(watcher.badges, [3]);
});

test('notifications: edge into waiting notifies once, waiting↔blocked stays quiet', () => {
  const watcher = makeWatcher();
  watcher.push(snapshotWith([employee()]));
  watcher.push(snapshotWith([employee({ status: 'waiting' })]));
  assert.equal(watcher.notifications.length, 1);
  assert.equal(watcher.notifications[0].title, 'AI OFFICE');
  assert.match(watcher.notifications[0].body, /Claude Code \(my-repo\)/);

  // Staying waiting, or flipping between the two stuck statuses, is the same
  // episode — no re-notification.
  watcher.push(snapshotWith([employee({ status: 'waiting' })]));
  watcher.push(snapshotWith([employee({ status: 'blocked' })]));
  assert.equal(watcher.notifications.length, 1);

  // Resolving and getting stuck again is a fresh episode.
  watcher.push(snapshotWith([employee()]));
  watcher.push(snapshotWith([employee({ status: 'blocked' })]));
  assert.equal(watcher.notifications.length, 2);
});

test('notifications: resident and subagent sessions never notify or count', () => {
  const watcher = makeWatcher();
  watcher.push(snapshotWith([employee()]));
  watcher.push(
    snapshotWith([
      employee({ key: 'claude:/log/r.jsonl', status: 'blocked', resident: 'log-analyst' }),
      employee({ key: 'claude:/log/s.jsonl', status: 'waiting', isSubagent: true }),
    ])
  );
  assert.deepEqual(watcher.notifications, []);
  assert.deepEqual(watcher.badges, [0]);
});

test('notifications: a review-needed report notifies on increase only', () => {
  const watcher = makeWatcher();
  watcher.push(snapshotWith([], { reviewNeeded: 1 }));
  watcher.push(snapshotWith([], { reviewNeeded: 2 }));
  assert.equal(watcher.notifications.length, 1);
  // Reading a report (count decreasing) or holding steady stays quiet.
  watcher.push(snapshotWith([], { reviewNeeded: 1 }));
  watcher.push(snapshotWith([], { reviewNeeded: 1 }));
  assert.equal(watcher.notifications.length, 1);
});

test('notifications: badge updates only when the attention count changes', () => {
  const watcher = makeWatcher();
  watcher.push(snapshotWith([employee()]));
  watcher.push(snapshotWith([employee({ status: 'waiting' })], { reviewNeeded: 1 }));
  watcher.push(snapshotWith([employee({ status: 'waiting' })], { reviewNeeded: 1 }));
  watcher.push(snapshotWith([employee()]));
  assert.deepEqual(watcher.badges, [0, 2, 0]);
});

test('notifications: a throwing delivery never escapes into the broadcast loop', () => {
  let listener = null;
  createNotificationWatcher({
    subscribe: (subscriber) => {
      listener = subscriber;
      return () => {};
    },
    notify: () => {
      throw new Error('delivery down');
    },
    updateBadge: () => {
      throw new Error('badge down');
    },
  });
  listener(snapshotWith([employee()]));
  // Both deliveries throw; neither may propagate.
  listener(snapshotWith([employee({ status: 'waiting' })], { reviewNeeded: 1 }));
});
