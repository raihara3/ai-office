// HR cleanup: find sessions whose CLI process is no longer running and
// retire them (the avatar leaves). The clock-out is recorded in the state
// store as a tombstone; the CLI's log file is left untouched on disk.
//
// Liveness heuristic: running processes grant "seats" per (CLI, working
// directory) — as many sessions stay alive as there are processes, most
// recently active first. A plain exists-check is not enough because one
// running session would keep every past session of the same directory
// alive forever. Sessions currently shown as "working" are never
// dismissed, and ambiguous cases err on the side of alive.
//
// `createCleanup` takes the state instance plus the OS-inspection functions
// (process list, open files, file existence) as injectable dependencies, so
// the retirement logic can be unit-tested against canned `ps`/`lsof` output
// without touching real processes or the filesystem.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CLI_EXECUTABLE_NAMES = { claude: 'claude', codex: 'codex', gemini: 'gemini' };

// A Codex Desktop thread holds <session-id>.lock open under this directory for
// the whole conversation (between turns included), so a held lock is the
// authoritative "this chat is still open" signal for app-owned sessions.
const THREAD_WRITER_LOCKS_DIR = path.join(os.homedir(), '.codex', 'thread-writer-locks');

// Codex rollout files are named rollout-<timestamp>-<session-id>.jsonl; the
// session id is also the writer-lock's basename.
const CODEX_SESSION_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function codexSessionId(filePath) {
  const match = CODEX_SESSION_ID.exec(filePath);
  return match ? match[1].toLowerCase() : null;
}

// MCP server processes are not interactive sessions and must not grant
// seats — e.g. "codex mcp-server" spawned by a Claude session would
// otherwise keep idle MCP-created sessions alive.
const NON_INTERACTIVE_ARGS = /\b(mcp-server|mcp serve)\b/;

// App/editor hosts (ChatGPT app, VSCode extension) own real interactive
// sessions but run with an unrelated cwd, so they are matched by presence
// rather than by directory.
const APP_HOST_ARGS = /\b(app-server|code-mode-host)\b/;

// Normalize symlink differences such as /tmp vs /private/tmp on macOS.
function toRealPath(directory) {
  try {
    return fs.realpathSync(directory);
  } catch {
    return directory;
  }
}

// Directory-name matching for CLIs that only record a project name (Gemini
// derives it from the workspace, sometimes dropping leading dots), so match
// any path segment of the cwd, ignoring leading dots.
export function cwdMatchesProject(cwd, project) {
  return cwd
    .split(path.sep)
    .some((segment) => segment.replace(/^\.+/, '') === project);
}

function defaultRunProcessList() {
  return execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
}

function defaultRunOpenFiles(pids) {
  // -F n prints "p<pid>" and "n<path>" lines, safe against spaces.
  return execFileSync('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-F', 'n'], {
    encoding: 'utf8',
  });
}

function parseLockIds(lsofOutput) {
  const ids = new Set();
  for (const line of lsofOutput.split('\n')) {
    if (!line.startsWith('n')) continue;
    const base = path.basename(line.slice(1));
    if (base.endsWith('.lock')) ids.add(base.slice(0, -'.lock'.length).toLowerCase());
  }
  return ids;
}

// Session ids of Codex Desktop threads whose writer lock is held open right
// now. Returns null when the check itself cannot run (e.g. lsof missing) so
// callers can err on the side of "still alive" and never retire a live chat.
function defaultListLiveLockIds() {
  try {
    // +D lists open files anywhere under the directory, regardless of which
    // process (the Electron app holds the lock, not the `codex` binary).
    const output = execFileSync('lsof', ['-F', 'n', '+D', THREAD_WRITER_LOCKS_DIR], {
      encoding: 'utf8',
    });
    return parseLockIds(output);
  } catch (error) {
    // lsof exits non-zero both when nothing is open (authoritatively none) and
    // when the directory is absent; partial stdout is still meaningful.
    if (typeof error.stdout === 'string' && error.stdout) return parseLockIds(error.stdout);
    if (error.code === 'ENOENT') return null; // lsof binary itself is missing
    return new Set();
  }
}

export function createCleanup({
  state,
  runProcessList = defaultRunProcessList,
  runOpenFiles = defaultRunOpenFiles,
  listLiveLockIds = defaultListLiveLockIds,
  fileExists = fs.existsSync,
  // Resident-team sessions are permanent staff: HR never retires them.
  isProtected = () => false,
}) {
  function findProcessIds() {
    const processIds = { claude: [], codex: [], gemini: [] };
    const appHostRunning = { claude: false, codex: false, gemini: false };
    let psOutput;
    try {
      psOutput = runProcessList();
    } catch {
      return { processIds, appHostRunning };
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
          if (APP_HOST_ARGS.test(args)) {
            appHostRunning[cli] = true;
          } else {
            processIds[cli].push(pid);
          }
        }
      }
    }
    return { processIds, appHostRunning };
  }

  // One running process = one seat, so several processes in the same
  // directory keep several sessions alive.
  function findWorkingDirectorySeats(processIds) {
    const seats = {};
    for (const [cli, pids] of Object.entries(processIds)) {
      seats[cli] = new Map();
      if (pids.length === 0) continue;
      try {
        const lsofOutput = runOpenFiles(pids);
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

  function findRetirableSessions() {
    const { processIds, appHostRunning } = findProcessIds();
    const seatsByCli = findWorkingDirectorySeats(processIds);
    const retirable = [];
    const groups = new Map();
    // Computed on demand (one lsof) only when an app-owned Codex session needs it.
    let liveLockIdsCache;
    const getLiveLockIds = () => {
      if (liveLockIdsCache === undefined) liveLockIdsCache = listLiveLockIds();
      return liveLockIdsCache;
    };

    for (const session of state.listSessions()) {
      if (isProtected(session)) continue;
      // A session whose log file vanished can never produce events again —
      // it is a ghost regardless of which processes are running.
      if (!fileExists(session.filePath)) {
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
      // App/editor-owned sessions (Codex Desktop, VSCode extension) run inside
      // the host process from an unrelated directory, so they cannot be matched
      // by cwd. Keep them while actively working or blocked. When idle, a Codex
      // Desktop conversation is NOT closed — it holds its per-thread writer lock
      // open for the whole thread — so a held lock means "still open" and the
      // session must not be retired (retiring would clock out a conversation the
      // app is still writing to). Only once the lock is released does it retire.
      // Other app CLIs have no such signal and retire on idle as before.
      if (session.clientKind === 'app' && appHostRunning[session.cli]) {
        if (session.status === 'working' || session.status === 'blocked') continue;
        if (session.cli === 'codex') {
          const liveLockIds = getLiveLockIds();
          if (liveLockIds === null) continue; // cannot tell → assume alive
          const sessionId = codexSessionId(session.filePath);
          if (sessionId && liveLockIds.has(sessionId)) continue;
        }
        retirable.push(session);
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
          if (cwdMatchesProject(cwd, session.project)) capacity += count;
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

  // selectedKeys limits retirement to sessions the user actually confirmed in
  // the preview dialog; without it, sessions that became retirable in between
  // would be removed sight-unseen.
  function retireSessions(selectedKeys) {
    const retired = [];
    const failed = [];
    let candidates = findRetirableSessions();
    if (Array.isArray(selectedKeys)) {
      const allowed = new Set(selectedKeys);
      candidates = candidates.filter((session) => allowed.has(session.key));
    }
    for (const session of candidates) {
      try {
        state.dismissSession(session.key);
        retired.push({ key: session.key, cli: session.cli, project: session.project });
      } catch (error) {
        failed.push({ key: session.key, error: error.message });
      }
    }
    return { retired, failed };
  }

  return { findRetirableSessions, retireSessions };
}
