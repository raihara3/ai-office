// Unit tests for the session registry (registry.js): fragment matching rules
// (exact for paths, substring for session ids), newest-first precedence, the
// binding cap, and behavior around unknown or archived residents — over an
// in-memory SQLite database.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from './database.js';
import { createResidentStore } from './resident-store.js';
import { createSessionRegistry } from './registry.js';

function registryWith() {
  const database = openDatabase({ location: ':memory:' });
  const store = createResidentStore({ database, now: () => 1000 });
  let tick = 0;
  const registry = createSessionRegistry({ database, now: () => (tick += 1) });
  const addResident = (name, seat) =>
    store.save(name, {
      configuration: {
        displayName: name,
        seat,
        cli: 'claude',
        mode: 'read-only',
        workingDirectory: '~',
        trigger: { type: 'interval', minutes: 10 },
        precheck: null,
        enabled: true,
      },
      instructions: '',
    });
  return { database, store, registry, addResident };
}

test('registry: uuid fragments match as substring, path fragments exactly', () => {
  const { registry, addResident } = registryWith();
  addResident('claude-one', 0);
  addResident('gemini-one', 1);
  registry.bind('claude-one', '0961c458-6ee3-4e1d-8146-460251a008f8');
  registry.bind('gemini-one', '/Users/x/.gemini/tmp/chats/session-1.jsonl');

  assert.equal(
    registry.residentForFile('/Users/x/.claude/projects/p/0961c458-6ee3-4e1d-8146-460251a008f8.jsonl'),
    'claude-one'
  );
  assert.equal(registry.residentForFile('/Users/x/.gemini/tmp/chats/session-1.jsonl'), 'gemini-one');
  // A path that merely contains another path fragment must not match.
  assert.equal(registry.residentForFile('/Users/x/.gemini/tmp/chats/session-1.jsonl.bak'), null);
  assert.equal(registry.residentForFile('/somewhere/else.jsonl'), null);
});

test('registry: the newest binding wins', () => {
  const { registry, addResident } = registryWith();
  addResident('first', 0);
  addResident('second', 1);
  registry.bind('first', 'aaaa-bbbb-cccc');
  registry.bind('second', '/logs/aaaa-bbbb-cccc.jsonl');
  // The path binding is newer; for that exact path it takes precedence over
  // the older uuid substring match.
  assert.equal(registry.residentForFile('/logs/aaaa-bbbb-cccc.jsonl'), 'second');
});

test('registry: unknown residents are not bound', () => {
  const { database, registry } = registryWith();
  registry.bind('nobody', 'some-fragment');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM session_bindings').get().n, 0);
  assert.equal(registry.residentForFile('/x/some-fragment.jsonl'), null);
});

test('registry: a resident archived mid-run still resolves', () => {
  const { registry, store, addResident } = registryWith();
  addResident('leaving', 0);
  registry.bind('leaving', 'dddd-eeee-ffff');
  store.remove('leaving');
  assert.equal(registry.residentForFile('/logs/dddd-eeee-ffff.jsonl'), 'leaving');
});

test('registry: binding still lands when the resident was archived during startup', () => {
  // codex/gemini bind only after transcript discovery — the resident can be
  // unassigned in that window, and the session must stay seated regardless.
  const { registry, store, addResident } = registryWith();
  addResident('leaving', 0);
  store.remove('leaving');
  registry.bind('leaving', '/logs/late-binding.jsonl');
  assert.equal(registry.residentForFile('/logs/late-binding.jsonl'), 'leaving');
});

test('registry: bindings are capped at 200, oldest pruned', () => {
  const { database, registry, addResident } = registryWith();
  addResident('busy', 0);
  for (let index = 0; index < 205; index += 1) {
    registry.bind('busy', `fragment-${index}`);
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM session_bindings').get().n, 200);
  // The oldest five are gone, the newest survive.
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM session_bindings WHERE fragment = ?').get('fragment-0').n,
    0
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM session_bindings WHERE fragment = ?').get('fragment-204').n,
    1
  );
});
