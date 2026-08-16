// Unit tests for the three CLI watchers' line-parsing (claude/codex/gemini).
// Each watcher exports a pure-ish handleLine(entry, filePath, report) that emits
// observations through the injected report(cli, filePath, observation) callback.
// We inject a spy that captures every emitted observation so we can assert on
// the shapes without touching the filesystem (startXWatcher is never called).

import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { handleLine as claudeHandleLine, handleSubagentEnd } from './claude.js';
import { handleLine as codexHandleLine } from './codex.js';
import { handleLine as geminiHandleLine } from './gemini.js';

// A spy report(): pushes {cli, filePath, observation} for later assertions.
function makeReport() {
  const calls = [];
  const report = (cli, filePath, observation) => {
    calls.push({ cli, filePath, observation });
  };
  return { report, calls };
}

test('claude', async (t) => {
  await t.test('assistant Bash tool_use -> work with string activity', () => {
    const { report, calls } = makeReport();
    claudeHandleLine(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { description: 'run tests' } }],
        },
      },
      '/home/user/.claude/projects/foo/session.jsonl',
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.activityKind, 'work');
    assert.equal(typeof calls[0].observation.activity, 'string');
  });

  await t.test('assistant Read tool_use -> inspect', () => {
    const { report, calls } = makeReport();
    claudeHandleLine(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b/file.txt' } }],
        },
      },
      '/home/user/.claude/projects/foo/session.jsonl',
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.activityKind, 'inspect');
  });

  await t.test('AskUserQuestion -> waitingForUser', () => {
    const { report, calls } = makeReport();
    claudeHandleLine(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: {} }] },
      },
      '/home/user/.claude/projects/foo/session.jsonl',
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.waitingForUser, true);
  });

  await t.test('ExitPlanMode -> waitingForUser with プラン確認待ち', () => {
    const { report, calls } = makeReport();
    claudeHandleLine(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: {} }] },
      },
      '/home/user/.claude/projects/foo/session.jsonl',
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.waitingForUser, true);
    assert.equal(calls[0].observation.activity, 'プラン確認待ち');
  });

  await t.test('mcp__ tool_use -> mcpCall and work', () => {
    const { report, calls } = makeReport();
    claudeHandleLine(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'mcp__server__tool', input: {} }] },
      },
      '/home/user/.claude/projects/foo/session.jsonl',
      report,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].observation.mcpCall, { server: 'server', tool: 'tool' });
    assert.equal(calls[0].observation.activityKind, 'work');
  });

  await t.test('plain text answer (no tool_use, stop_reason end_turn) -> turnComplete', () => {
    const { report, calls } = makeReport();
    claudeHandleLine(
      {
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'All done.' }],
        },
      },
      '/home/user/.claude/projects/foo/session.jsonl',
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.turnComplete, true);
  });

  await t.test('user plain text -> task (truncated) + think', () => {
    const { report, calls } = makeReport();
    claudeHandleLine(
      {
        type: 'user',
        message: { content: 'please fix the bug' },
      },
      '/home/user/.claude/projects/foo/session.jsonl',
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.task, 'please fix the bug');
    assert.equal(calls[0].observation.activityKind, 'think');
  });

  await t.test('user meta / <-prefixed / interrupted -> empty liveness (no task)', () => {
    // isMeta
    {
      const { report, calls } = makeReport();
      claudeHandleLine(
        { type: 'user', isMeta: true, message: { content: 'anything' } },
        '/home/user/.claude/projects/foo/session.jsonl',
        report,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].observation.task, undefined);
    }
    // starts with '<'
    {
      const { report, calls } = makeReport();
      claudeHandleLine(
        { type: 'user', message: { content: '<system-reminder>hi' } },
        '/home/user/.claude/projects/foo/session.jsonl',
        report,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].observation.task, undefined);
    }
    // interruption
    {
      const { report, calls } = makeReport();
      claudeHandleLine(
        { type: 'user', message: { content: '[Request interrupted by user]' } },
        '/home/user/.claude/projects/foo/session.jsonl',
        report,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].observation.task, undefined);
    }
  });

  await t.test('file under /subagents/ sets isSubagent true', () => {
    const { report, calls } = makeReport();
    const subagentPath = ['/home/user/.claude/projects/foo', 'subagents', 'agent-1.jsonl'].join(
      path.sep,
    );
    claudeHandleLine(
      { type: 'user', message: { content: 'do the thing' } },
      subagentPath,
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.isSubagent, true);
  });

  await t.test('handleSubagentEnd: tool_result -> subagentEnded.key === tool_use_id', () => {
    const { report, calls } = makeReport();
    handleSubagentEnd(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_abc123' }],
        },
      },
      '/home/user/.claude/projects/foo/session.jsonl',
      report,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].observation.subagentEnded, { key: 'toolu_abc123' });
  });
});

test('codex', async (t) => {
  await t.test('session_meta source mcp -> clientKind mcp + cwd/project', () => {
    const { report, calls } = makeReport();
    codexHandleLine(
      { type: 'session_meta', payload: { source: 'mcp', cwd: '/work/proj' } },
      '/home/user/.codex/sessions/2026/08/16/rollout-x.jsonl',
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.clientKind, 'mcp');
    assert.equal(calls[0].observation.cwd, '/work/proj');
    assert.equal(calls[0].observation.project, 'proj');
  });

  await t.test('session_meta originator codex_cli_rs -> clientKind cli', () => {
    const { report, calls } = makeReport();
    codexHandleLine(
      { type: 'session_meta', payload: { originator: 'codex_cli_rs', cwd: '/work/proj' } },
      '/home/user/.codex/sessions/2026/08/16/rollout-x.jsonl',
      report,
    );
    assert.equal(calls[0].observation.clientKind, 'cli');
  });

  await t.test('session_meta other -> clientKind app', () => {
    const { report, calls } = makeReport();
    codexHandleLine(
      { type: 'session_meta', payload: { originator: 'vscode', cwd: '/work/proj' } },
      '/home/user/.codex/sessions/2026/08/16/rollout-x.jsonl',
      report,
    );
    assert.equal(calls[0].observation.clientKind, 'app');
  });

  await t.test('event_msg user_message -> task + think', () => {
    const { report, calls } = makeReport();
    codexHandleLine(
      { type: 'event_msg', payload: { type: 'user_message', message: 'add a feature' } },
      '/home/user/.codex/sessions/2026/08/16/rollout-x.jsonl',
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.task, 'add a feature');
    assert.equal(calls[0].observation.activityKind, 'think');
  });

  await t.test('event_msg task_complete -> turnComplete', () => {
    const { report, calls } = makeReport();
    codexHandleLine(
      { type: 'event_msg', payload: { type: 'task_complete' } },
      '/home/user/.codex/sessions/2026/08/16/rollout-x.jsonl',
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.turnComplete, true);
  });

  await t.test('event_msg approval_request type -> waitingForUser', () => {
    const { report, calls } = makeReport();
    codexHandleLine(
      { type: 'event_msg', payload: { type: 'exec_approval_request' } },
      '/home/user/.codex/sessions/2026/08/16/rollout-x.jsonl',
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.waitingForUser, true);
  });

  await t.test('response_item function_call MCP-style name -> mcpCall', () => {
    const { report, calls } = makeReport();
    codexHandleLine(
      {
        type: 'response_item',
        payload: { type: 'function_call', name: 'mcp__server__tool', arguments: '{}' },
      },
      '/home/user/.codex/sessions/2026/08/16/rollout-x.jsonl',
      report,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].observation.mcpCall, { server: 'server', tool: 'tool' });
    assert.equal(calls[0].observation.activityKind, 'work');
  });
});

test('gemini', async (t) => {
  const geminiPath = ['/home/user/.gemini/tmp/myproject', 'chats', 'session-1.jsonl'].join(
    path.sep,
  );

  await t.test('user message in $set patch -> task + think', () => {
    const { report, calls } = makeReport();
    geminiHandleLine(
      { $set: { messages: [{ type: 'user', content: 'do X' }] } },
      geminiPath,
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.task, 'do X');
    assert.equal(calls[0].observation.activityKind, 'think');
  });

  await t.test('gemini functionCall read_file -> inspect', () => {
    const { report, calls } = makeReport();
    geminiHandleLine(
      { $set: { messages: [{ type: 'gemini', content: [{ functionCall: { name: 'read_file' } }] }] } },
      geminiPath,
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.activityKind, 'inspect');
  });

  await t.test('choice message -> waitingForUser', () => {
    const { report, calls } = makeReport();
    geminiHandleLine(
      { $set: { messages: [{ type: 'choice', content: 'pick one' }] } },
      geminiPath,
      report,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.waitingForUser, true);
  });

  await t.test('bare object (no patch wrapper) is still collected', () => {
    const { report, calls } = makeReport();
    geminiHandleLine({ type: 'user', content: 'bare prompt' }, geminiPath, report);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].observation.task, 'bare prompt');
    assert.equal(calls[0].observation.activityKind, 'think');
  });
});
