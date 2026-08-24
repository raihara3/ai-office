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

test('buildHeadlessCommand: claude edit mode bypasses permission prompts', () => {
  const { args } = buildHeadlessCommand({
    cli: 'claude',
    mode: 'edit',
    prompt: 'p',
    sessionId: 's',
  });
  const flagIndex = args.indexOf('--permission-mode');
  assert.notEqual(flagIndex, -1);
  assert.equal(args[flagIndex + 1], 'bypassPermissions');
  assert.ok(!args.includes('--allowedTools'));
});

test('buildHeadlessCommand: codex maps mode to the sandbox flag', () => {
  assert.deepEqual(
    buildHeadlessCommand({ cli: 'codex', mode: 'read-only', prompt: 'p', sessionId: 's' }).args,
    ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', 'p']
  );
  assert.deepEqual(
    buildHeadlessCommand({ cli: 'codex', mode: 'edit', prompt: 'p', sessionId: 's' }).args,
    ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', 'p']
  );
});

test('buildHeadlessCommand: gemini trusts the workspace and maps mode to the approval flag', () => {
  assert.deepEqual(
    buildHeadlessCommand({ cli: 'gemini', mode: 'read-only', prompt: 'p', sessionId: 's' }).args,
    ['--approval-mode', 'plan', '--skip-trust', '-p', 'p']
  );
  assert.deepEqual(
    buildHeadlessCommand({ cli: 'gemini', mode: 'edit', prompt: 'p', sessionId: 's' }).args,
    ['--approval-mode', 'yolo', '--skip-trust', '-p', 'p']
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

test('splitReportLevel: accepts a standalone marker line anywhere in the message', () => {
  assert.deepEqual(splitReportLevel('作業内容の説明。\n\nLEVEL: review-needed\n確認してください'), {
    level: 'review-needed',
    body: '作業内容の説明。\n\n確認してください',
  });
  assert.deepEqual(splitReportLevel('説明。\n\nLEVEL: review-needed'), {
    level: 'review-needed',
    body: '説明。',
  });
  // Prose that merely mentions the marker inline is not a marker.
  assert.deepEqual(splitReportLevel('review-needed で終了する場合は LEVEL: review-needed と書く'), {
    level: 'info',
    body: 'review-needed で終了する場合は LEVEL: review-needed と書く',
  });
});
