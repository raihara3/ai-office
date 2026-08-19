// Headless CLI runner for resident team members. A run spawns the resident's
// CLI in non-interactive mode inside its working directory; the CLI writes its
// usual session transcript, which the existing tail → watcher → state pipeline
// picks up for visualization. The runner's own jobs are: build the command,
// bind the session to the resident in the registry (so it seats at the
// resident island, not the free-address grid), enforce the timeout, and hand
// the final output text back for the whiteboard report.
//
// Command building and output parsing are exported as pure functions so they
// can be unit-tested without spawning anything.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUN_TIMEOUT_MS = 30 * 60_000;
const KILL_ESCALATION_MS = 10_000;
const OUTPUT_CAP_BYTES = 1024 * 1024;
// Codex/Gemini pick their own session file; poll briefly after spawn to find
// and bind it.
const SESSION_FILE_POLL_INTERVAL_MS = 2_000;
const SESSION_FILE_POLL_ATTEMPTS = 15;

// Tools a read-only Claude resident may use: inspection and reporting only.
const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite'];

export function expandHomeDirectory(directory) {
  return directory.replace(/^~(?=\/|$)/, os.homedir());
}

// The headless invocation per CLI and permission mode. Claude accepts an
// explicit session id (which names its transcript file); Codex and Gemini do
// not, so their transcripts are discovered after spawn instead.
export function buildHeadlessCommand({ cli, mode, prompt, sessionId }) {
  if (cli === 'claude') {
    const args = ['-p', prompt, '--session-id', sessionId, '--output-format', 'json'];
    if (mode === 'edit') args.push('--permission-mode', 'acceptEdits');
    else args.push('--allowedTools', ...CLAUDE_READ_ONLY_TOOLS);
    return { command: 'claude', args };
  }
  if (cli === 'codex') {
    const sandbox = mode === 'edit' ? 'workspace-write' : 'read-only';
    return { command: 'codex', args: ['exec', '--sandbox', sandbox, prompt] };
  }
  const args = mode === 'edit' ? ['--approval-mode', 'auto_edit', '-p', prompt] : ['-p', prompt];
  return { command: 'gemini', args };
}

// The agent's final message from captured stdout. Claude's JSON output format
// wraps it in {result}; the other CLIs print it directly (ANSI stripped).
export function extractResultText(cli, stdout) {
  const cleaned = stdout.replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (cli === 'claude') {
    try {
      const parsed = JSON.parse(cleaned);
      if (typeof parsed.result === 'string') return parsed.result;
    } catch {
      // Fall through to the raw text (e.g. the CLI errored before JSON).
    }
  }
  return cleaned;
}

// The shared preamble tells agents to flag reports that need a human;
// `splitReportLevel` peels that marker off the final message.
export function splitReportLevel(text) {
  const match = /^LEVEL:\s*(review-needed|info)\s*/i.exec(text);
  if (!match) return { level: 'info', body: text.trim() };
  return { level: match[1].toLowerCase(), body: text.slice(match[0].length).trim() };
}

// Transcript roots for the CLIs that pick their own session file.
const SESSION_LOG_ROOTS = {
  codex: () => ({
    rootDirectory: path.join(os.homedir(), '.codex', 'sessions'),
    filePattern: /rollout-.*\.jsonl$/,
    maxDepth: 4,
  }),
  gemini: () => ({
    rootDirectory: path.join(os.homedir(), '.gemini', 'tmp'),
    filePattern: /session-.*\.jsonl$/,
    maxDepth: 3,
  }),
};

function findFilesModifiedSince(directory, filePattern, sinceMs, depth, results) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) findFilesModifiedSince(entryPath, filePattern, sinceMs, depth - 1, results);
    } else if (filePattern.test(entry.name)) {
      try {
        const modifiedAt = fs.statSync(entryPath).mtimeMs;
        if (modifiedAt >= sinceMs) results.push({ filePath: entryPath, modifiedAt });
      } catch {
        // Raced with a delete; skip.
      }
    }
  }
}

// The newest session log created/updated since `sinceMs` — assumed to be the
// run we just spawned. Ambiguity (a concurrent interactive session) only
// affects seating, never data, and resolves on the next resident run.
function defaultFindNewSessionFile(cli, sinceMs) {
  const roots = SESSION_LOG_ROOTS[cli];
  if (!roots) return null;
  const { rootDirectory, filePattern, maxDepth } = roots();
  const results = [];
  findFilesModifiedSince(rootDirectory, filePattern, sinceMs, maxDepth, results);
  results.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return results.length > 0 ? results[0].filePath : null;
}

export function createRunner({
  registry,
  now = () => Date.now(),
  spawnProcess = spawn,
  findNewSessionFile = defaultFindNewSessionFile,
  runTimeoutMs = RUN_TIMEOUT_MS,
}) {
  const running = new Map();

  function isRunning(residentName) {
    return running.has(residentName);
  }

  // Poll for the transcript the spawned CLI opened and bind it. Stops once
  // found, when attempts run out, or when the run already finished.
  function bindDiscoveredSession(resident, startedAt) {
    let attempts = 0;
    const poll = setInterval(() => {
      attempts += 1;
      const sessionFile = findNewSessionFile(resident.cli, startedAt - SESSION_FILE_POLL_INTERVAL_MS);
      if (sessionFile !== null) {
        registry.bind(resident.name, sessionFile);
        clearInterval(poll);
      } else if (attempts >= SESSION_FILE_POLL_ATTEMPTS || !running.has(resident.name)) {
        clearInterval(poll);
      }
    }, SESSION_FILE_POLL_INTERVAL_MS);
    poll.unref?.();
  }

  // Starts a headless run; returns false when this resident is already
  // running. `onFinished({outcome, resultText})` fires exactly once with
  // outcome 'ok' | 'error' | 'timeout'.
  function run(resident, { prompt, onFinished }) {
    if (running.has(resident.name)) return false;
    const startedAt = now();
    const sessionId = crypto.randomUUID();
    const { command, args } = buildHeadlessCommand({
      cli: resident.cli,
      mode: resident.mode,
      prompt,
      sessionId,
    });

    let child;
    try {
      child = spawnProcess(command, args, {
        cwd: expandHomeDirectory(resident.workingDirectory),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      onFinished({ outcome: 'error', resultText: `起動に失敗しました: ${error.message}` });
      return true;
    }
    running.set(resident.name, child);

    if (resident.cli === 'claude') registry.bind(resident.name, sessionId);
    else bindDiscoveredSession(resident, startedAt);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_CAP_BYTES) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < OUTPUT_CAP_BYTES) stderr += chunk;
    });

    let finished = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A CLI that traps SIGTERM would otherwise wedge the resident as busy
      // forever; escalate so `close` always eventually fires.
      const forceKill = setTimeout(() => {
        if (!finished) child.kill('SIGKILL');
      }, KILL_ESCALATION_MS);
      forceKill.unref?.();
    }, runTimeoutMs);
    timeout.unref?.();

    const finish = (outcome, resultText) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      running.delete(resident.name);
      onFinished({ outcome, resultText });
    };

    child.on('error', (error) => finish('error', `実行に失敗しました: ${error.message}`));
    child.on('close', (code) => {
      const resultText = extractResultText(resident.cli, stdout);
      if (timedOut) {
        finish('timeout', resultText || '実行がタイムアウトしました');
      } else if (code === 0) {
        finish('ok', resultText || '(出力なし)');
      } else {
        finish('error', resultText || stderr.trim() || `終了コード ${code}`);
      }
    });
    return true;
  }

  return { run, isRunning };
}
