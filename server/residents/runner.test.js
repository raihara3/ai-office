// Unit tests for the headless runner's pure parts (runner.js): command
// building per CLI/mode, result extraction and the report-level marker.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildHeadlessCommand, extractResultText, splitReportLevel } from './runner.js';

test('buildHeadlessCommand: claude pins the session id and restricts read-only tools', () => {
  const { command, args } = buildHeadlessCommand({
    cli: 'claude',
    mode: 'read-only',
    prompt: 'do it',
    sessionId: 'abc-123',
  });
  assert.equal(command, 'claude');
  assert.deepEqual(args.slice(0, 4), ['-p', 'do it', '--session-id', 'abc-123']);
  assert.ok(args.includes('--allowedTools'));
  assert.ok(!args.includes('--permission-mode'));
});

test('buildHeadlessCommand: claude edit mode accepts edits instead of allowlisting', () => {
  const { args } = buildHeadlessCommand({
    cli: 'claude',
    mode: 'edit',
    prompt: 'p',
    sessionId: 's',
  });
  assert.ok(args.includes('--permission-mode'));
  assert.ok(!args.includes('--allowedTools'));
});

test('buildHeadlessCommand: codex maps mode to the sandbox flag', () => {
  assert.deepEqual(
    buildHeadlessCommand({ cli: 'codex', mode: 'read-only', prompt: 'p', sessionId: 's' }).args,
    ['exec', '--sandbox', 'read-only', 'p']
  );
  assert.deepEqual(
    buildHeadlessCommand({ cli: 'codex', mode: 'edit', prompt: 'p', sessionId: 's' }).args,
    ['exec', '--sandbox', 'workspace-write', 'p']
  );
});

test('buildHeadlessCommand: gemini stays read-only unless edit mode is chosen', () => {
  assert.deepEqual(
    buildHeadlessCommand({ cli: 'gemini', mode: 'read-only', prompt: 'p', sessionId: 's' }).args,
    ['-p', 'p']
  );
  assert.deepEqual(
    buildHeadlessCommand({ cli: 'gemini', mode: 'edit', prompt: 'p', sessionId: 's' }).args,
    ['--approval-mode', 'auto_edit', '-p', 'p']
  );
});

test('extractResultText: unwraps claude JSON output and falls back to raw text', () => {
  assert.equal(
    extractResultText('claude', JSON.stringify({ result: 'レポート本文' })),
    'レポート本文'
  );
  assert.equal(extractResultText('claude', 'not json'), 'not json');
  assert.equal(extractResultText('codex', '[32mdone[0m'), 'done');
});

test('splitReportLevel: peels the review marker off the first line', () => {
  assert.deepEqual(splitReportLevel('LEVEL: review-needed\nPRを確認してください'), {
    level: 'review-needed',
    body: 'PRを確認してください',
  });
  assert.deepEqual(splitReportLevel('異常なし'), { level: 'info', body: '異常なし' });
});
