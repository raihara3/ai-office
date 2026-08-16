// Watches Codex CLI rollout logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
// Lines look like {timestamp, type, payload}. Relevant types:
//   session_meta                 -> cwd (project)
//   event_msg / task_started     -> a turn began
//   event_msg / task_complete    -> a turn finished
//   event_msg / user_message     -> the user's assignment
//   response_item / function_call -> current tool action (incl. MCP tools)
//
// `handleLine` takes an injected `report` (the state's reportEvent) so it can
// be unit-tested with a stub; `startCodexWatcher` wires it to the real store.

import os from 'node:os';
import path from 'node:path';
import { watchJsonl } from '../tail.js';

const NATIVE_TOOL_NAMES = new Set([
  'exec_command', 'shell', 'apply_patch', 'update_plan', 'view_image',
  'web_search', 'read_file', 'write_file', 'list_dir', 'grep', 'spawn_agent',
  'send_message_to_agent', 'wait_for_agent',
]);

const AGENT_TOOL_NAMES = new Set(['spawn_agent', 'send_message_to_agent']);

function truncate(text, max = 80) {
  if (!text) return null;
  const single = String(text).replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

function describeFunctionCall(name, rawArguments) {
  let parsedArguments = {};
  try {
    parsedArguments = JSON.parse(rawArguments ?? '{}');
  } catch {
    // Arguments are best-effort; fall back to the tool name alone.
  }
  switch (name) {
    case 'exec_command':
    case 'shell':
      return truncate(parsedArguments.cmd ?? parsedArguments.command);
    case 'apply_patch':
      return 'Editing files';
    case 'web_search':
      return truncate(parsedArguments.query, 60);
    default:
      return name;
  }
}

function extractItemText(item) {
  const parts = item?.content;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (typeof part?.text === 'string' && part.text.trim()) return part.text;
  }
  return null;
}

// Newer Codex versions wrap turn contents in item_started/item_completed
// events instead of dedicated user_message/function_call events.
function observeItem(item, observation) {
  switch (item.type) {
    case 'UserMessage':
      observation.task = truncate(extractItemText(item), 100);
      observation.activity = null;
      observation.activityKind = 'think';
      break;
    case 'CommandExecution':
      observation.activity = truncate(item.command);
      observation.activityKind = 'work';
      break;
    case 'FileChange':
      observation.activity = 'Editing files';
      observation.activityKind = 'work';
      break;
    case 'McpToolCall': {
      const server = item.server ?? 'mcp';
      const tool = item.tool ?? '';
      observation.activity = `MCP: ${server} / ${tool}`;
      observation.activityKind = 'work';
      observation.mcpCall = { server, tool };
      break;
    }
    case 'WebSearch':
      observation.activity = truncate(item.query, 60);
      observation.activityKind = 'inspect';
      break;
    default:
      // AgentMessage, reasoning etc. still refresh the session's liveness.
      break;
  }
}

export function handleLine(entry, filePath, report) {
  const payload = entry.payload;
  if (!payload) return;
  const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();
  const observation = { timestamp };

  if (entry.type === 'session_meta') {
    if (payload.cwd) {
      observation.cwd = payload.cwd;
      observation.project = path.basename(payload.cwd);
    }
    // Who owns this session decides how HR judges its liveness:
    // 'mcp' one-shots retire eagerly, 'cli' matches its process cwd,
    // 'app' (ChatGPT app / editor extensions) lives with its host process.
    observation.clientKind =
      payload.source === 'mcp'
        ? 'mcp'
        : payload.originator === 'codex_cli_rs'
          ? 'cli'
          : 'app';
    report('codex', filePath, observation);
    return;
  }

  if (entry.type === 'event_msg') {
    switch (payload.type) {
      case 'user_message':
        observation.task = truncate(payload.message, 100);
        observation.activity = null;
        observation.activityKind = 'think';
        break;
      case 'task_started':
        observation.activity = 'Thinking';
        observation.activityKind = 'think';
        break;
      case 'task_complete':
        observation.turnComplete = true;
        break;
      case 'agent_message':
        // Codex produced its answer text; the turn is wrapping up.
        break;
      case 'item_started':
      case 'item_completed':
        observeItem(payload.item ?? {}, observation);
        break;
      default:
        // Approval prompts and input requests block on the user.
        if (/approval_request|user_input|elicitation/.test(payload.type ?? '')) {
          observation.waitingForUser = true;
          break;
        }
        return;
    }
    report('codex', filePath, observation);
    return;
  }

  if (entry.type === 'response_item' && payload.type === 'function_call') {
    const name = payload.name ?? '';
    if (AGENT_TOOL_NAMES.has(name)) {
      report('codex', filePath, {
        ...observation,
        activity: 'Subagent working',
        activityKind: 'work',
        subagentStarted: { key: payload.call_id ?? String(timestamp), label: 'agent' },
      });
    } else if (!NATIVE_TOOL_NAMES.has(name) && /__|\./.test(name)) {
      const parts = name.startsWith('mcp__')
        ? name.split('__').slice(1)
        : name.split(/__|\./);
      const server = parts[0];
      const tool = parts.slice(1).join('__') || name;
      report('codex', filePath, {
        ...observation,
        activity: `MCP: ${server} / ${tool}`,
        activityKind: 'work',
        mcpCall: { server, tool },
      });
    } else {
      report('codex', filePath, {
        ...observation,
        activity: describeFunctionCall(name, payload.arguments),
        activityKind: name === 'web_search' || name === 'read_file' ? 'inspect' : 'work',
      });
    }
  }
}

export function startCodexWatcher({ report }) {
  watchJsonl({
    rootDirectory: path.join(os.homedir(), '.codex', 'sessions'),
    filePattern: /^rollout-.*\.jsonl$/,
    maxDepth: 4,
    onLine: (entry, { filePath }) => handleLine(entry, filePath, report),
  });
}
