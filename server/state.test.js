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

test('waitingForUser posts a single @社長 attention message; task/turn stay silent', () => {
  const ctx = withClock();

  // A new task and its activity/turn-completion drive the office view but post
  // no message — the #general chat is no longer rendered.
  ctx.state.reportEvent('claude', '/log/c.jsonl', {
    project: 'demo',
    task: 'fix the bug',
    timestamp: ctx.value,
  });
  ctx.advance(1000);
  ctx.state.reportEvent('claude', '/log/c.jsonl', {
    activity: 'Thinking',
    activityKind: 'thinking',
    timestamp: ctx.value,
  });
  ctx.advance(1000);
  ctx.state.reportEvent('claude', '/log/c.jsonl', {
    turnComplete: true,
    timestamp: ctx.value,
  });
  assert.equal(ctx.state.snapshot().messages.length, 0);

  // waitingForUser -> the only message: a @社長 mention that rings the chime.
  ctx.advance(1000);
  ctx.state.reportEvent('claude', '/log/c.jsonl', {
    waitingForUser: true,
    timestamp: ctx.value,
  });
  const messages = ctx.state.snapshot().messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].authorKind, 'agent');
  assert.equal(messages[0].authorName, 'Claude (demo)');
  assert.equal(messages[0].text, '@社長 確認をお願いします');
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
    waitingForUser: true,
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

test('activityLog stocks the flow of a turn, resets on a new task, empties on break', () => {
  const ctx = withClock();
  const key = 'claude:/log/f.jsonl';

  ctx.state.reportEvent('claude', '/log/f.jsonl', {
    task: 'first task',
    activity: null,
    activityKind: 'think',
    timestamp: ctx.value,
  });
  ctx.state.reportEvent('claude', '/log/f.jsonl', {
    activity: 'Read: a.js',
    activityKind: 'inspect',
    timestamp: ctx.value,
  });
  ctx.state.reportEvent('claude', '/log/f.jsonl', {
    activity: 'Edit: a.js',
    activityKind: 'work',
    timestamp: ctx.value,
  });

  // Both steps are stocked in order; the null-activity task line adds nothing.
  let employee = employeeFor(ctx.state, key);
  assert.deepEqual(employee.activityLog, [
    { activity: 'Read: a.js', activityKind: 'inspect' },
    { activity: 'Edit: a.js', activityKind: 'work' },
  ]);

  // A fresh instruction starts a new flow.
  ctx.state.reportEvent('claude', '/log/f.jsonl', {
    task: 'second task',
    activity: null,
    activityKind: 'think',
    timestamp: ctx.value,
  });
  employee = employeeFor(ctx.state, key);
  assert.deepEqual(employee.activityLog, []);

  // On break the snapshot exposes an empty log, like task/activity.
  ctx.state.reportEvent('claude', '/log/f.jsonl', {
    activity: 'Bash: run tests',
    activityKind: 'work',
    timestamp: ctx.value,
  });
  ctx.state.reportEvent('claude', '/log/f.jsonl', { turnComplete: true, timestamp: ctx.value });
  ctx.advance(WORKING_IDLE_TIMEOUT_MS + 1);
  employee = employeeFor(ctx.state, key);
  assert.equal(employee.status, 'break');
  assert.deepEqual(employee.activityLog, []);
});
