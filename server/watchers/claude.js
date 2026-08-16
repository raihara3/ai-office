// Watches Claude Code transcripts (~/.claude/projects/**/*.jsonl).
// Transcript lines carry type user/assistant plus metadata such as
// cwd, isSidechain (subagent transcript lines) and tool_use blocks.
//
// `handleLine` / `handleSubagentEnd` take an injected `report` (the state's
// reportEvent) so they can be unit-tested with a stub. `startClaudeWatcher`
// wires them to the real store.

import os from 'node:os';
import path from 'node:path';
import { watchJsonl } from '../tail.js';

const SUBAGENT_TOOL_NAMES = new Set(['Task', 'Agent']);

// Read-only tools show as "確認中" in the bubble; everything else "作業中".
const INSPECT_TOOL_NAMES = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'NotebookRead',
  'TodoRead', 'BashOutput', 'TaskList', 'TaskGet',
]);

function truncate(text, max = 80) {
  if (!text) return null;
  const single = String(text).replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

function describeToolUse(block) {
  const input = block.input ?? {};
  switch (block.name) {
    case 'Bash':
      return truncate(input.description ?? input.command);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return input.file_path
        ? `${block.name}: ${path.basename(input.file_path)}`
        : block.name;
    case 'Grep':
    case 'Glob':
      return `${block.name}: ${truncate(input.pattern, 40)}`;
    case 'WebSearch':
    case 'WebFetch':
      return truncate(input.query ?? input.url, 60);
    default:
      return block.name;
  }
}

function extractUserText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    // tool_result blocks are also delivered as user messages; skip them.
    if (block?.type === 'text' && block.text) return block.text;
    if (block?.type === 'tool_result') return null;
  }
  return null;
}

export function handleLine(entry, filePath, report) {
  if (entry.type !== 'user' && entry.type !== 'assistant') return;
  const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();
  const observation = { timestamp };
  // Background subagents get their own transcript under
  // <parent-session-id>/subagents/agent-*.jsonl. Every line in such a file
  // carries isSidechain, but relative to its own session they are the main
  // conversation — only treat isSidechain as "someone else's lines" in the
  // parent transcript, or turn completion would never be detected here.
  const isSubagentFile = filePath.includes(`${path.sep}subagents${path.sep}`);
  if (isSubagentFile) observation.isSubagent = true;
  const sidechain = entry.isSidechain === true && !isSubagentFile;
  if (entry.cwd) {
    observation.cwd = entry.cwd;
    observation.project = path.basename(entry.cwd);
  }
  const emit = (extra) => report('claude', filePath, { ...observation, ...extra });

  if (entry.type === 'user') {
    if (sidechain) return;
    const text = extractUserText(entry.message);
    if (entry.isMeta || !text || text.startsWith('<') || text.startsWith('[Request interrupted')) {
      // Meta/tool_result/interruption lines still prove the session is alive.
      emit();
      return;
    }
    emit({ task: truncate(text, 100), activity: null, activityKind: 'think' });
    return;
  }

  // assistant line
  const content = entry.message?.content;
  if (!Array.isArray(content)) return;
  const stopReason = entry.message?.stop_reason;
  let sawToolUse = false;

  for (const block of content) {
    if (block?.type !== 'tool_use') continue;
    sawToolUse = true;

    if (sidechain) {
      emit({ subagentActivity: describeToolUse(block) });
      continue;
    }

    if (block.name === 'AskUserQuestion' || block.name === 'ExitPlanMode') {
      emit({
        activity: block.name === 'ExitPlanMode' ? 'プラン確認待ち' : '質問への回答待ち',
        waitingForUser: true,
      });
    } else if (SUBAGENT_TOOL_NAMES.has(block.name)) {
      const input = block.input ?? {};
      emit({
        activity: `Subagent: ${truncate(input.description ?? input.subagent_type, 50)}`,
        activityKind: 'work',
        subagentStarted: {
          key: block.id,
          label: input.subagent_type ?? input.description ?? 'agent',
        },
      });
    } else if (block.name?.startsWith('mcp__')) {
      const [, server, ...toolParts] = block.name.split('__');
      emit({
        activity: `MCP: ${server} / ${toolParts.join('__')}`,
        activityKind: 'work',
        mcpCall: { server, tool: toolParts.join('__') },
      });
    } else {
      emit({
        activity: describeToolUse(block),
        activityKind: INSPECT_TOOL_NAMES.has(block.name) ? 'inspect' : 'work',
      });
    }
  }

  if (!sawToolUse && !sidechain && stopReason !== 'tool_use') {
    // A plain text answer usually ends the turn.
    emit({ turnComplete: true });
  }
}

// tool_result for a Task tool_use marks the subagent as finished.
export function handleSubagentEnd(entry, filePath, report) {
  if (entry.type !== 'user' || entry.isSidechain) return;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === 'tool_result' && block.tool_use_id) {
      report('claude', filePath, {
        timestamp: entry.timestamp ? Date.parse(entry.timestamp) : Date.now(),
        subagentEnded: { key: block.tool_use_id },
      });
    }
  }
}

export function startClaudeWatcher({ report }) {
  watchJsonl({
    rootDirectory: path.join(os.homedir(), '.claude', 'projects'),
    filePattern: /\.jsonl$/,
    maxDepth: 3,
    onLine: (entry, { filePath }) => {
      handleSubagentEnd(entry, filePath, report);
      handleLine(entry, filePath, report);
    },
  });
}
