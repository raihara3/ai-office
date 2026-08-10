// HR cleanup: find sessions whose CLI process is no longer running and
// retire them (avatar leaves, log file moves to the macOS Trash).
//
// Liveness heuristic: running processes grant "seats" per (CLI, working
// directory) — as many sessions stay alive as there are processes, most
// recently active first. A plain exists-check is not enough because one
// running session would keep every past session of the same directory
// alive forever. Sessions currently shown as "working" are never
// dismissed, and ambiguous cases err on the side of alive.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listSessions, dismissSession, postMessage } from './state.js';

const CLI_EXECUTABLE_NAMES = { claude: 'claude', codex: 'codex', gemini: 'gemini' };

// Host processes (MCP servers, editor/app integrations) are not interactive
// sessions and must not grant seats — e.g. "codex mcp-server" spawned by a
// Claude session would otherwise keep idle MCP-created sessions alive.
const NON_INTERACTIVE_ARGS = /\b(mcp-server|app-server|code-mode-host|mcp serve)\b/;

function findProcessIds() {
  const processIds = { claude: [], codex: [], gemini: [] };
  let psOutput;
  try {
    psOutput = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
  } catch {
    return processIds;
  }
  for (const line of psOutput.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, args] = match;
    if (NON_INTERACTIVE_ARGS.test(args)) continue;
    // The CLI may be invoked via an interpreter or with flags in between
    // (e.g. "node --flag /path/to/claude"), so scan every argv token.
    // False positives only err on the safe side (session stays alive).
    const argv = args.split(/\s+/);
    for (const [cli, executable] of Object.entries(CLI_EXECUTABLE_NAMES)) {
      if (argv.some((token) => path.basename(token) === executable)) {
        processIds[cli].push(pid);
      }
    }
  }
  return processIds;
}

// Normalize symlink differences such as /tmp vs /private/tmp on macOS.
function toRealPath(directory) {
  try {
    return fs.realpathSync(directory);
  } catch {
    return directory;
  }
}

// One running process = one seat, so several processes in the same
// directory keep several sessions alive.
function findWorkingDirectorySeats(processIds) {
  const seats = {};
  for (const [cli, pids] of Object.entries(processIds)) {
    seats[cli] = new Map();
    if (pids.length === 0) continue;
    try {
      // -F n prints "p<pid>" and "n<path>" lines, safe against spaces.
      const lsofOutput = execFileSync(
        'lsof',
        ['-a', '-d', 'cwd', '-p', pids.join(','), '-F', 'n'],
        { encoding: 'utf8' }
      );
      for (const line of lsofOutput.split('\n')) {
        if (!line.startsWith('n')) continue;
        const cwd = toRealPath(line.slice(1));
        seats[cli].set(cwd, (seats[cli].get(cwd) ?? 0) + 1);
      }
    } catch {
      // lsof exits non-zero when some pids vanished; partial output is fine.
    }
  }
  return seats;
}

export function findRetirableSessions() {
  const seatsByCli = findWorkingDirectorySeats(findProcessIds());
  const retirable = [];
  const groups = new Map();

  for (const session of listSessions()) {
    // A session whose log file vanished can never produce events again —
    // it is a ghost regardless of which processes are running.
    if (!fs.existsSync(session.filePath)) {
      if (session.status !== 'working') retirable.push(session);
      continue;
    }
    // Subagents have no process of their own (they run inside the parent)
    // and never resume once done, so they never claim a seat: retire them
    // as soon as they go idle, independent of the parent's liveness.
    if (session.isSubagent) {
      if (session.status !== 'working') retirable.push(session);
      continue;
    }
    const seats = seatsByCli[session.cli];
    let capacity;
    let groupKey;
    if (session.cwd) {
      const realCwd = toRealPath(session.cwd);
      capacity = seats.get(realCwd) ?? 0;
      groupKey = `${session.cli}|${realCwd}`;
    } else if (session.project) {
      // Gemini logs record only the project directory name, not the full path.
      capacity = 0;
      for (const [cwd, count] of seats) {
        if (path.basename(cwd) === session.project) capacity += count;
      }
      groupKey = `${session.cli}|#${session.project}`;
    } else {
      // Unknown workspace: stay alive while any process of this CLI runs.
      if (seats.size === 0 && session.status !== 'working') retirable.push(session);
      continue;
    }

    if (capacity === 0) {
      if (session.status !== 'working') retirable.push(session);
      continue;
    }
    let group = groups.get(groupKey);
    if (!group) {
      group = { capacity, sessions: [] };
      groups.set(groupKey, group);
    }
    group.sessions.push(session);
  }

  // Within each directory, working sessions claim seats first, then the
  // most recently active ones; whoever is left without a seat retires.
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => {
      if ((a.status === 'working') !== (b.status === 'working')) {
        return a.status === 'working' ? -1 : 1;
      }
      return (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0);
    });
    for (const session of group.sessions.slice(group.capacity)) {
      if (session.status !== 'working') retirable.push(session);
    }
  }
  return retirable;
}

function moveToTrash(filePath) {
  // Already gone (ghost session): nothing to move, retirement still counts.
  if (!fs.existsSync(filePath)) return;
  const trashDirectory = path.join(os.homedir(), '.Trash');
  let target = path.join(trashDirectory, path.basename(filePath));
  if (fs.existsSync(target)) {
    const extension = path.extname(target);
    target = path.join(
      trashDirectory,
      `${path.basename(target, extension)}-${Date.now()}${extension}`
    );
  }
  try {
    fs.renameSync(filePath, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    // The home directory can live on another volume; fall back to copy+unlink.
    fs.copyFileSync(filePath, target);
    fs.unlinkSync(filePath);
  }
}

// selectedKeys limits retirement to sessions the user actually confirmed in
// the preview dialog; without it, sessions that became retirable in between
// would be removed sight-unseen.
export function retireSessions(selectedKeys) {
  const retired = [];
  const failed = [];
  let candidates = findRetirableSessions();
  if (Array.isArray(selectedKeys)) {
    const allowed = new Set(selectedKeys);
    candidates = candidates.filter((session) => allowed.has(session.key));
  }
  for (const session of candidates) {
    try {
      moveToTrash(session.filePath);
      dismissSession(session.key);
      retired.push({ key: session.key, cli: session.cli, project: session.project });
    } catch (error) {
      failed.push({ key: session.key, error: error.message });
    }
  }
  postMessage({
    authorKind: 'hr',
    authorName: '人事',
    text:
      retired.length > 0
        ? `@社長 ${retired.length}人退勤しました`
        : '@社長 サボっている人はいませんでした',
    at: Date.now(),
  });
  return { retired, failed };
}
