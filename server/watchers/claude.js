// Watches Claude Code transcripts (~/.claude/projects/**/*.jsonl).
// Transcript lines carry type user/assistant plus metadata such as
// cwd, isSidechain (subagent transcript lines) and tool_use blocks.

import os from 'node:os';
import path from 'node:path';
import { watchJsonl } from '../tail.js';
import { reportEvent } from '../state.js';

const SUBAGENT_TOOL_NAMES = new Set(['Task', 'Agent']);

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

function handleLine(entry, filePath) {
  if (entry.type !== 'user' && entry.type !== 'assistant') return;
  const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();
  const observation = { timestamp };
  if (entry.cwd) {
    observation.cwd = entry.cwd;
    observation.project = path.basename(entry.cwd);
  }
  const report = (extra) => reportEvent('claude', filePath, { ...observation, ...extra });

  if (entry.type === 'user') {
    if (entry.isSidechain) return;
    const text = extractUserText(entry.message);
    if (entry.isMeta || !text || text.startsWith('<')) {
      // Meta/tool_result lines still prove the session is alive.
      report();
      return;
    }
    report({ task: truncate(text, 100), activity: null });
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

    if (entry.isSidechain) {
      report({ subagentActivity: describeToolUse(block) });
      continue;
    }

    if (SUBAGENT_TOOL_NAMES.has(block.name)) {
      const input = block.input ?? {};
      report({
        activity: `Subagent: ${truncate(input.description ?? input.subagent_type, 50)}`,
        subagentStarted: {
          key: block.id,
          label: input.subagent_type ?? input.description ?? 'agent',
        },
      });
    } else if (block.name?.startsWith('mcp__')) {
      const [, server, ...toolParts] = block.name.split('__');
      report({
        activity: `MCP: ${server} / ${toolParts.join('__')}`,
        mcpCall: { server, tool: toolParts.join('__') },
      });
    } else {
      report({ activity: describeToolUse(block) });
    }
  }

  if (!sawToolUse && !entry.isSidechain && stopReason !== 'tool_use') {
    // A plain text answer usually ends the turn.
    report({ turnComplete: true });
  }
}

// tool_result for a Task tool_use marks the subagent as finished.
function handleSubagentEnd(entry, filePath) {
  if (entry.type !== 'user' || entry.isSidechain) return;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === 'tool_result' && block.tool_use_id) {
      reportEvent('claude', filePath, {
        timestamp: entry.timestamp ? Date.parse(entry.timestamp) : Date.now(),
        subagentEnded: { key: block.tool_use_id },
      });
    }
  }
}

export function startClaudeWatcher() {
  watchJsonl({
    rootDirectory: path.join(os.homedir(), '.claude', 'projects'),
    filePattern: /\.jsonl$/,
    maxDepth: 3,
    onLine: (entry, { filePath }) => {
      handleSubagentEnd(entry, filePath);
      handleLine(entry, filePath);
    },
  });
}
