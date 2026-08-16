// Unit tests for the HR cleanup retirement logic. All OS-inspection
// dependencies (ps/lsof/fs/trash) are injected as stubs so the tests exercise
// the pure retirement heuristic without touching real processes or files.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCleanup, cwdMatchesProject } from './cleanup.js';

// Build a session object with sensible defaults; overrides win.
function makeSession(overrides = {}) {
  return {
    key: 'k1',
    filePath: '/logs/k1.jsonl',
    cli: 'claude',
    clientKind: 'cli',
    cwd: '/home/user/project',
    project: 'project',
    status: 'break',
    isSubagent: false,
    lastEventAt: 0,
    ...overrides,
  };
}

// Hand-written state stub: full control over listSessions() output plus spies
// for dismissSession()/postMessage().
function makeState(sessions = []) {
  const dismissed = [];
  const posted = [];
  return {
    listSessions: () => sessions,
    dismissSession: (key) => dismissed.push(key),
    postMessage: (message) => posted.push(message),
    dismissed,
    posted,
  };
}

// Turn { pid: args } into a `ps -axo pid=,args=` style multi-line string.
function makePs(entries) {
  return Object.entries(entries)
    .map(([pid, args]) => `  ${pid} ${args}`)
    .join('\n');
}

// Turn { pid: cwd } into an `lsof -F n` style string.
function makeLsof(entries) {
  return Object.entries(entries)
    .flatMap(([pid, cwd]) => [`p${pid}`, `n${cwd}`])
    .join('\n');
}

// A cleanup wired to fixed fake OS output. Defaults: no processes, all logs
// present, trash is a no-op spy.
function setup({
  sessions = [],
  ps = '',
  lsof = '',
  fileExists = () => true,
  moveToTrash,
} = {}) {
  const state = makeState(sessions);
  const trashCalls = [];
  const trash =
    moveToTrash ??
    ((filePath) => {
      trashCalls.push(filePath);
    });
  const cleanup = createCleanup({
    state,
    runProcessList: () => ps,
    runOpenFiles: () => lsof,
    fileExists,
    moveToTrash: trash,
    now: () => 12345,
  });
  return { cleanup, state, trashCalls };
}

function keysOf(sessions) {
  return sessions.map((session) => session.key).sort();
}

// --- cwdMatchesProject ---------------------------------------------------

test('cwdMatchesProject matches a path segment ignoring leading dots', () => {
  assert.equal(cwdMatchesProject('/a/.ai-organization/b', 'ai-organization'), true);
  assert.equal(cwdMatchesProject('/a/ai-organization/b', 'ai-organization'), true);
});

test('cwdMatchesProject rejects unrelated paths and partial matches', () => {
  assert.equal(cwdMatchesProject('/a/other/b', 'ai-organization'), false);
  assert.equal(cwdMatchesProject('/a/ai-organization-extra/b', 'ai-organization'), false);
});

// --- cli sessions, cwd-based liveness ------------------------------------

test('cli session with no live process (empty ps/lsof) and idle is retirable', () => {
  const session = makeSession({ key: 'idle', status: 'break' });
  const { cleanup } = setup({ sessions: [session] });
  assert.deepEqual(keysOf(cleanup.findRetirableSessions()), ['idle']);
});

test('cli session with a matching live process (a seat) is not retirable', () => {
  const session = makeSession({ key: 'seated', cwd: '/home/user/project', status: 'break' });
  const { cleanup } = setup({
    sessions: [session],
    ps: makePs({ 100: '/usr/bin/claude' }),
    lsof: makeLsof({ 100: '/home/user/project' }),
  });
  assert.deepEqual(cleanup.findRetirableSessions(), []);
});

// --- app-owned sessions (the recent fix) ---------------------------------

test('app session is kept while working when the app host runs', () => {
  const session = makeSession({
    key: 'app-working',
    clientKind: 'app',
    cli: 'codex',
    status: 'working',
  });
  const { cleanup } = setup({
    sessions: [session],
    ps: makePs({ 200: 'codex --stdio app-server' }),
  });
  assert.deepEqual(cleanup.findRetirableSessions(), []);
});

test('app session is kept while blocked when the app host runs', () => {
  const session = makeSession({
    key: 'app-blocked',
    clientKind: 'app',
    cli: 'codex',
    status: 'blocked',
  });
  const { cleanup } = setup({
    sessions: [session],
    ps: makePs({ 200: 'codex --stdio app-server' }),
  });
  assert.deepEqual(cleanup.findRetirableSessions(), []);
});

test('app session on break is retirable even when the app host runs', () => {
  const session = makeSession({
    key: 'app-break',
    clientKind: 'app',
    cli: 'codex',
    status: 'break',
  });
  const { cleanup } = setup({
    sessions: [session],
    ps: makePs({ 200: 'codex --stdio app-server' }),
  });
  assert.deepEqual(keysOf(cleanup.findRetirableSessions()), ['app-break']);
});

// --- ghost sessions (log file gone) --------------------------------------

test('session whose log file is gone and idle is retirable', () => {
  const session = makeSession({ key: 'ghost', status: 'break' });
  const { cleanup } = setup({ sessions: [session], fileExists: () => false });
  assert.deepEqual(keysOf(cleanup.findRetirableSessions()), ['ghost']);
});

// --- subagent sessions ---------------------------------------------------

test('idle subagent session is retirable regardless of the parent', () => {
  const session = makeSession({ key: 'sub', isSubagent: true, status: 'break' });
  // Parent process for the same cwd is alive, but subagents never claim seats.
  const { cleanup } = setup({
    sessions: [session],
    ps: makePs({ 100: '/usr/bin/claude' }),
    lsof: makeLsof({ 100: '/home/user/project' }),
  });
  assert.deepEqual(keysOf(cleanup.findRetirableSessions()), ['sub']);
});

// --- working sessions are never retirable --------------------------------

test('working sessions are never retirable across every branch', () => {
  const sessions = [
    makeSession({ key: 'ghost-working', status: 'working' }),
    makeSession({ key: 'sub-working', isSubagent: true, status: 'working' }),
    makeSession({ key: 'cwd-working', status: 'working' }),
    makeSession({
      key: 'unknown-working',
      status: 'working',
      cwd: null,
      project: null,
    }),
  ];
  // ghost has no log file; the rest have no live process at all.
  const fileExists = (filePath) => filePath !== '/logs/ghost.jsonl';
  const withPaths = sessions.map((session) => ({
    ...session,
    filePath: `/logs/${session.key}.jsonl`,
  }));
  const { cleanup } = setup({ sessions: withPaths, fileExists });
  assert.deepEqual(cleanup.findRetirableSessions(), []);
});

// --- NON_INTERACTIVE_ARGS / app-host routing -----------------------------

test('mcp-server processes do not grant a seat', () => {
  const session = makeSession({ key: 'mcp-idle', status: 'break' });
  const { cleanup } = setup({
    sessions: [session],
    // A codex mcp-server is running in the session's cwd, but must not keep it alive.
    ps: makePs({ 300: 'codex mcp-server' }),
    lsof: makeLsof({ 300: '/home/user/project' }),
  });
  assert.deepEqual(keysOf(cleanup.findRetirableSessions()), ['mcp-idle']);
});

// --- retireSessions ------------------------------------------------------

test('retireSessions retires only confirmed keys and reports headcount', () => {
  const sessions = [
    makeSession({ key: 'a', filePath: '/logs/a.jsonl', status: 'break' }),
    makeSession({ key: 'b', filePath: '/logs/b.jsonl', status: 'break' }),
  ];
  const { cleanup, state, trashCalls } = setup({ sessions });
  const result = cleanup.retireSessions(['a']);

  assert.deepEqual(keysOf(result.retired), ['a']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(trashCalls, ['/logs/a.jsonl']);
  assert.deepEqual(state.dismissed, ['a']);
  assert.equal(state.posted.length, 1);
  assert.equal(state.posted[0].authorKind, 'hr');
  assert.equal(state.posted[0].text, '@社長 1人退勤しました');
  assert.equal(state.posted[0].at, 12345);
});

test('retireSessions posts the no-one-slacking message when nothing retires', () => {
  const session = makeSession({ key: 'seated', status: 'break' });
  const { cleanup, state } = setup({
    sessions: [session],
    ps: makePs({ 100: '/usr/bin/claude' }),
    lsof: makeLsof({ 100: '/home/user/project' }),
  });
  const result = cleanup.retireSessions();

  assert.deepEqual(result.retired, []);
  assert.equal(state.posted[0].text, '@社長 サボっている人はいませんでした');
});

test('a moveToTrash failure lands the key in failed, not retired', () => {
  const sessions = [
    makeSession({ key: 'ok', filePath: '/logs/ok.jsonl', status: 'break' }),
    makeSession({ key: 'boom', filePath: '/logs/boom.jsonl', status: 'break' }),
  ];
  const { cleanup, state } = setup({
    sessions,
    moveToTrash: (filePath) => {
      if (filePath === '/logs/boom.jsonl') throw new Error('EACCES');
    },
  });
  const result = cleanup.retireSessions(['ok', 'boom']);

  assert.deepEqual(keysOf(result.retired), ['ok']);
  assert.deepEqual(
    result.failed.map((entry) => entry.key),
    ['boom']
  );
  assert.equal(result.failed[0].error, 'EACCES');
  // The failed session must not be dismissed from state.
  assert.deepEqual(state.dismissed, ['ok']);
});
