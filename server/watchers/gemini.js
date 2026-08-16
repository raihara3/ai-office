// Watches Gemini CLI chat logs (~/.gemini/tmp/<project>/chats/session-*.jsonl).
// The first line is session metadata; later lines are state patches such as
// {"$set": {"messages": [...]}}. Message shapes vary between versions, so we
// walk the JSON generically looking for message-like objects.
//
// `handleLine` takes an injected `report` (the state's reportEvent) so it can
// be unit-tested with a stub; `startGeminiWatcher` wires it to the real store.

import os from 'node:os';
import path from 'node:path';
import { watchJsonl } from '../tail.js';

const NATIVE_TOOL_NAMES = new Set([
  'run_shell_command', 'read_file', 'read_many_files', 'write_file', 'replace',
  'glob', 'search_file_content', 'list_directory', 'google_web_search',
  'web_fetch', 'save_memory',
]);

const INSPECT_TOOL_NAMES = new Set([
  'read_file', 'read_many_files', 'glob', 'search_file_content',
  'list_directory', 'google_web_search', 'web_fetch',
]);

function truncate(text, max = 80) {
  if (!text) return null;
  const single = String(text).replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

function collectMessages(value, found) {
  if (Array.isArray(value)) {
    for (const item of value) collectMessages(item, found);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (
    (value.type === 'user' || value.type === 'gemini' || value.type === 'choice') &&
    value.content !== undefined
  ) {
    found.push(value);
    return;
  }
  for (const nested of Object.values(value)) collectMessages(nested, found);
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part && typeof part.text === 'string' && part.text.trim()) return part.text;
  }
  return null;
}

function collectFunctionCalls(value, found) {
  if (Array.isArray(value)) {
    for (const item of value) collectFunctionCalls(item, found);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (value.functionCall && typeof value.functionCall.name === 'string') {
    found.push(value.functionCall);
  }
  if (typeof value.name === 'string' && (value.args !== undefined || value.arguments !== undefined)) {
    found.push(value);
  }
  for (const nested of Object.values(value)) collectFunctionCalls(nested, found);
}

function projectFromPath(filePath) {
  // ~/.gemini/tmp/<project>/chats/session-*.jsonl
  const segments = filePath.split(path.sep);
  const chatsIndex = segments.lastIndexOf('chats');
  return chatsIndex > 0 ? segments[chatsIndex - 1] : null;
}

export function handleLine(entry, filePath, report) {
  const messages = [];
  collectMessages(entry, messages);
  if (messages.length === 0) return;

  const project = projectFromPath(filePath);

  for (const message of messages) {
    const timestamp = message.timestamp ? Date.parse(message.timestamp) : Date.now();
    const observation = { timestamp, project };
    const text = extractText(message.content);

    if (message.type === 'choice') {
      // Gemini is showing the user a choice prompt and blocks on the answer.
      report('gemini', filePath, { ...observation, waitingForUser: true });
      continue;
    }

    if (message.type === 'user') {
      // Skip injected context blocks; real prompts are plain text.
      if (text && !text.startsWith('<')) {
        observation.task = truncate(text, 100);
        observation.activity = null;
        observation.activityKind = 'think';
      }
      report('gemini', filePath, observation);
      continue;
    }

    // message.type === 'gemini'
    const functionCalls = [];
    collectFunctionCalls(message.content, functionCalls);
    if (functionCalls.length > 0) {
      for (const call of functionCalls) {
        if (!NATIVE_TOOL_NAMES.has(call.name) && call.name.includes('__')) {
          const [server, ...toolParts] = call.name.split('__').filter(Boolean);
          report('gemini', filePath, {
            ...observation,
            activity: `MCP: ${server} / ${toolParts.join('__')}`,
            activityKind: 'work',
            mcpCall: { server, tool: toolParts.join('__') },
          });
        } else {
          report('gemini', filePath, {
            ...observation,
            activity: call.name,
            activityKind: INSPECT_TOOL_NAMES.has(call.name) ? 'inspect' : 'work',
          });
        }
      }
    } else if (text) {
      report('gemini', filePath, { ...observation, turnComplete: true });
    } else {
      report('gemini', filePath, observation);
    }
  }
}

export function startGeminiWatcher({ report }) {
  watchJsonl({
    rootDirectory: path.join(os.homedir(), '.gemini', 'tmp'),
    filePattern: /^session-.*\.jsonl$/,
    maxDepth: 3,
    onLine: (entry, { filePath }) => handleLine(entry, filePath, report),
  });
}
