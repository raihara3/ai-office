// Unit tests for the session state store (state.js).
// Uses an injectable clock so status derivation (which depends on elapsed
// time) is fully deterministic without real timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createState, deriveStatus, CLI_INFO } from './state.js';

const WORKING_IDLE_TIMEOUT_MS = 90_000;
const TURN_COMPLETE_GRACE_MS = 5_000;

// Build a minimal session shell for the pure deriveStatus tests.
function makeSession(overrides = {}) {
  return {
    lastEventAt: null,
    waitingForUser: false,
    pendingTool: false,
    turnCompletedAt: null,
    ...overrides,
  };
}

test('deriveStatus: lastEventAt null -> break', () => {
  assert.equal(deriveStatus(makeSession({ lastEventAt: null }), 1000), 'break');
});

test('deriveStatus: waitingForUser -> waiting (ignores idle timeout)', () => {
  const session = makeSession({ lastEventAt: 0, waitingForUser: true });
  // Far past the idle timeout, yet still 'waiting'.
  assert.equal(deriveStatus(session, WORKING_IDLE_TIMEOUT_MS + 1_000_000), 'waiting');
});

test('deriveStatus: idle > timeout with pendingTool -> blocked', () => {
  const session = makeSession({ lastEventAt: 0, pendingTool: true });
  assert.equal(deriveStatus(session, WORKING_IDLE_TIMEOUT_MS + 1), 'blocked');
});

test('deriveStatus: idle > timeout without pendingTool -> break', () => {
  const session = makeSession({ lastEventAt: 0, pendingTool: false });
  assert.equal(deriveStatus(session, WORKING_IDLE_TIMEOUT_MS + 1), 'break');
});

test('deriveStatus: turnCompletedAt older than grace -> break', () => {
  const session = makeSession({ lastEventAt: 0, turnCompletedAt: 0 });
  assert.equal(deriveStatus(session, TURN_COMPLETE_GRACE_MS + 1), 'break');
});

test('deriveStatus: recent activity, no completed turn -> working', () => {
  const session = makeSession({ lastEventAt: 0 });
  assert.equal(deriveStatus(session, 1000), 'working');
});

test('deriveStatus: turn completed within grace -> still working', () => {
  const session = makeSession({ lastEventAt: 0, turnCompletedAt: 0 });
  assert.equal(deriveStatus(session, TURN_COMPLETE_GRACE_MS - 1), 'working');
});

test('CLI_INFO exposes the three supported CLIs', () => {
  assert.deepEqual(Object.keys(CLI_INFO).sort(), ['claude', 'codex', 'gemini']);
  assert.equal(CLI_INFO.claude.mention, 'Claude');
});

// A controllable clock shared by the integration-style tests below.
function withClock() {
  let clock = 0;
  const state = createState({ now: () => clock });
  return {
    state,
    advance(ms) {
      clock += ms;
    },
    set(ms) {
      clock = ms;
    },
    get value() {
      return clock;
    },
  };
}

function employeeFor(state, key) {
  return state.snapshot().employees.find((e) => e.key === key);
}

test('reportEvent + snapshot: work tool -> working, then blocked, empty liveness keeps pendingTool', () => {
  const ctx = withClock();
  const key = 'claude:/log/a.jsonl';

  // A fresh work observation: a tool activity mid-turn.
  ctx.state.reportEvent('claude', '/log/a.jsonl', {
    project: 'demo',
    task: 'build the thing',
    activity: 'Editing file',
    activityKind: 'tool',
    timestamp: ctx.value,
  });

  let employee = employeeFor(ctx.state, key);
  assert.equal(employee.status, 'working');

  // Advance past the idle timeout: the still-pending tool makes it 'blocked'.
  ctx.advance(WORKING_IDLE_TIMEOUT_MS + 1);
  employee = employeeFor(ctx.state, key);
  assert.equal(employee.status, 'blocked');

  // Regression guard: an EMPTY liveness observation (a tool_result / meta line
  // with no activityKind and no turnComplete) must NOT clear pendingTool. Such
  // a line refreshes lastEventAt (so the session is momentarily 'working'
  // again), but once it idles out it must fall back to 'blocked', never
  // 'break' — proving pendingTool survived the liveness line.
  ctx.state.reportEvent('claude', '/log/a.jsonl', { timestamp: ctx.value });
  ctx.advance(WORKING_IDLE_TIMEOUT_MS + 1);
  employee = employeeFor(ctx.state, key);
  assert.equal(employee.status, 'blocked', 'empty liveness must not clear pendingTool');
});

test('turnComplete clears pendingTool -> becomes break after grace, not blocked', () => {
  const ctx = withClock();
  const key = 'claude:/log/b.jsonl';

  ctx.state.reportEvent('claude', '/log/b.jsonl', {
    project: 'demo',
    task: 'do work',
    activityKind: 'tool',
    timestamp: ctx.value,
  });
  assert.equal(employeeFor(ctx.state, key).status, 'working');

  // Turn completes: pendingTool cleared.
  ctx.advance(1000);
  ctx.state.reportEvent('claude', '/log/b.jsonl', {
    turnComplete: true,
    timestamp: ctx.value,
  });

  // Past the idle timeout: with pendingTool cleared it rests, not blocked.
  ctx.advance(WORKING_IDLE_TIMEOUT_MS + 1);
  assert.equal(employeeFor(ctx.state, key).status, 'break');
});

test('#general: task posts 社長 message, activity adds 🫡, turnComplete + waitingForUser post agent replies', () => {
  const ctx = withClock();

  // New task -> a 社長 user message '@<display> <task>'.
  ctx.state.reportEvent('claude', '/log/c.jsonl', {
    project: 'demo',
    task: 'fix the bug',
    timestamp: ctx.value,
  });

  let messages = ctx.state.snapshot().messages;
  assert.equal(messages.length, 1);
  const taskMessage = messages[0];
  assert.equal(taskMessage.authorKind, 'user');
  assert.equal(taskMessage.authorName, '社長');
  assert.equal(taskMessage.text, '@Claude (demo) fix the bug');
  assert.deepEqual(taskMessage.reactions, []);

  // A following activity counts as pickup -> 🫡 reaction on that message.
  ctx.advance(1000);
  ctx.state.reportEvent('claude', '/log/c.jsonl', {
    activity: 'Thinking',
    activityKind: 'thinking',
    timestamp: ctx.value,
  });
  messages = ctx.state.snapshot().messages;
  const reacted = messages.find((m) => m.id === taskMessage.id);
  assert.deepEqual(reacted.reactions, ['🫡']);

  // turnComplete -> agent posts a completion reply.
  ctx.advance(1000);
  ctx.state.reportEvent('claude', '/log/c.jsonl', {
    turnComplete: true,
    timestamp: ctx.value,
  });
  messages = ctx.state.snapshot().messages;
  const completion = messages.find(
    (m) => m.authorKind === 'agent' && m.text === '@社長 作業が完了しました'
  );
  assert.ok(completion, 'expected a completion reply');
  assert.equal(completion.authorName, 'Claude (demo)');

  // waitingForUser -> agent posts a confirmation-request reply.
  ctx.advance(1000);
  ctx.state.reportEvent('claude', '/log/c.jsonl', {
    waitingForUser: true,
    timestamp: ctx.value,
  });
  messages = ctx.state.snapshot().messages;
  const confirm = messages.find(
    (m) => m.authorKind === 'agent' && m.text === '@社長 確認をお願いします'
  );
  assert.ok(confirm, 'expected a confirmation-request reply');
  assert.equal(confirm.authorName, 'Claude (demo)');
});

test('subagent sessions post no #general messages', () => {
  const ctx = withClock();

  ctx.state.reportEvent('claude', '/log/sub.jsonl', {
    project: 'demo',
    task: 'internal work',
    isSubagent: true,
    timestamp: ctx.value,
  });
  ctx.advance(1000);
  ctx.state.reportEvent('claude', '/log/sub.jsonl', {
    turnComplete: true,
    isSubagent: true,
    timestamp: ctx.value,
  });

  assert.equal(ctx.state.snapshot().messages.length, 0);
});

test('snapshot nulls task/activity/activityKind on break, keeps them on working/blocked', () => {
  const ctx = withClock();
  const key = 'claude:/log/d.jsonl';

  ctx.state.reportEvent('claude', '/log/d.jsonl', {
    project: 'demo',
    task: 'a task',
    activity: 'Editing',
    activityKind: 'tool',
    timestamp: ctx.value,
  });

  // Working: fields present.
  let employee = employeeFor(ctx.state, key);
  assert.equal(employee.status, 'working');
  assert.equal(employee.task, 'a task');
  assert.equal(employee.activity, 'Editing');
  assert.equal(employee.activityKind, 'tool');

  // Blocked (idle + pendingTool): fields still present.
  ctx.advance(WORKING_IDLE_TIMEOUT_MS + 1);
  employee = employeeFor(ctx.state, key);
  assert.equal(employee.status, 'blocked');
  assert.equal(employee.task, 'a task');
  assert.equal(employee.activity, 'Editing');
  assert.equal(employee.activityKind, 'tool');

  // Break: complete the turn to clear pendingTool, then idle out.
  ctx.state.reportEvent('claude', '/log/d.jsonl', {
    turnComplete: true,
    timestamp: ctx.value,
  });
  ctx.advance(WORKING_IDLE_TIMEOUT_MS + 1);
  employee = employeeFor(ctx.state, key);
  assert.equal(employee.status, 'break');
  assert.equal(employee.task, null);
  assert.equal(employee.activity, null);
  assert.equal(employee.activityKind, null);
});

test('dismissSession removes the session; the cutoff tombstone rejects replays', () => {
  const ctx = withClock();
  const key = 'claude:/log/e.jsonl';

  ctx.advance(1000);
  const clockOutAt = ctx.value;
  ctx.state.reportEvent('claude', '/log/e.jsonl', {
    project: 'demo',
    task: 'work',
    activityKind: 'tool',
    timestamp: clockOutAt,
  });
  assert.ok(employeeFor(ctx.state, key), 'session should exist');

  ctx.state.dismissSession(key);
  assert.equal(employeeFor(ctx.state, key), undefined, 'session should be gone');

  // A replayed log line at or before the clock-out cutoff is rejected, however
  // much wall-clock time has passed since (the file stays on disk now).
  ctx.advance(20 * 60_000);
  ctx.state.reportEvent('claude', '/log/e.jsonl', {
    project: 'demo',
    task: 'replayed line',
    activityKind: 'tool',
    timestamp: clockOutAt,
  });
  assert.equal(employeeFor(ctx.state, key), undefined, 'cutoff should reject replays');

  // A genuinely newer event means the CLI resumed writing: the member returns.
  ctx.state.reportEvent('claude', '/log/e.jsonl', {
    project: 'demo',
    task: 'back to work',
    activityKind: 'tool',
    timestamp: clockOutAt + 1,
  });
  assert.ok(employeeFor(ctx.state, key), 'newer activity should bring the session back');
});

function memoryFileSystem() {
  const files = new Map();
  return {
    files,
    readFileSync(filePath) {
      if (!files.has(filePath)) throw new Error(`ENOENT: ${filePath}`);
      return files.get(filePath);
    },
    writeFileSync(filePath, content) {
      files.set(filePath, String(content));
    },
    mkdirSync() {},
  };
}

test('clock-out tombstones persist across a restart', () => {
  const fileSystem = memoryFileSystem();
  const key = 'claude:/log/e.jsonl';
  const clockOutAt = 1000;

  const first = createState({ now: () => clockOutAt, dataDirectory: '/data', fileSystem });
  first.reportEvent('claude', '/log/e.jsonl', {
    project: 'demo',
    task: 'work',
    activityKind: 'tool',
    timestamp: clockOutAt,
  });
  first.dismissSession(key);

  // A fresh instance (simulating a server restart) reloads the tombstone from
  // disk, so a replayed log line at or before the cutoff stays clocked out.
  const restarted = createState({
    now: () => clockOutAt + 20 * 60_000,
    dataDirectory: '/data',
    fileSystem,
  });
  restarted.reportEvent('claude', '/log/e.jsonl', {
    project: 'demo',
    task: 'replayed line',
    activityKind: 'tool',
    timestamp: clockOutAt,
  });
  assert.equal(
    restarted.snapshot().employees.find((e) => e.key === key),
    undefined,
    'restart should keep the dismissed session clocked out'
  );

  // A genuinely newer event still brings the member back after a restart.
  restarted.reportEvent('claude', '/log/e.jsonl', {
    project: 'demo',
    task: 'back to work',
    activityKind: 'tool',
    timestamp: clockOutAt + 1,
  });
  assert.ok(
    restarted.snapshot().employees.find((e) => e.key === key),
    'newer activity should still resurrect the session after a restart'
  );
});

test('tombstones older than the session lifetime are pruned on load', () => {
  const fileSystem = memoryFileSystem();
  const SESSION_EXPIRE_MS = 3 * 24 * 60 * 60_000;
  fileSystem.writeFileSync(
    '/data/dismissed-sessions.json',
    JSON.stringify({ 'claude:/log/old.jsonl': 1000 })
  );

  const state = createState({
    now: () => 1000 + SESSION_EXPIRE_MS + 1,
    dataDirectory: '/data',
    fileSystem,
  });
  // The stale cutoff was dropped, so a fresh event is accepted normally.
  state.reportEvent('claude', '/log/old.jsonl', {
    project: 'demo',
    task: 'new run',
    activityKind: 'tool',
    timestamp: 1000 + SESSION_EXPIRE_MS + 1,
  });
  assert.ok(
    state.snapshot().employees.find((e) => e.key === 'claude:/log/old.jsonl'),
    'a stale tombstone should not gate a brand-new event'
  );
});
