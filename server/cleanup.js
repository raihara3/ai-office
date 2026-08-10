// HR cleanup: find sessions whose CLI process is no longer running and
// retire them (avatar leaves, log file moves to the macOS Trash).
//
// Liveness heuristic: a session is considered alive when a process of the
// same CLI is running with the session's working directory as its cwd.
// Sessions currently shown as "working" are never dismissed, and ambiguous
// cases (no cwd recorded, matching process exists) err on the side of alive.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listSessions, dismissSession } from './state.js';

const CLI_EXECUTABLE_NAMES = { claude: 'claude', codex: 'codex', gemini: 'gemini' };

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

function findWorkingDirectories(processIds) {
  const cwds = {};
  for (const [cli, pids] of Object.entries(processIds)) {
    cwds[cli] = new Set();
    if (pids.length === 0) continue;
    try {
      // -F n prints "p<pid>" and "n<path>" lines, safe against spaces.
      const lsofOutput = execFileSync(
        'lsof',
        ['-a', '-d', 'cwd', '-p', pids.join(','), '-F', 'n'],
        { encoding: 'utf8' }
      );
      for (const line of lsofOutput.split('\n')) {
        if (line.startsWith('n')) cwds[cli].add(toRealPath(line.slice(1)));
      }
    } catch {
      // lsof exits non-zero when some pids vanished; partial output is fine.
    }
  }
  return cwds;
}

function isSessionAlive(session, liveCwds) {
  const cwds = liveCwds[session.cli];
  if (!cwds || cwds.size === 0) return false;
  if (session.cwd) return cwds.has(toRealPath(session.cwd));
  if (session.project) {
    // Gemini logs record only the project directory name, not the full path.
    for (const cwd of cwds) {
      if (path.basename(cwd) === session.project) return true;
    }
    return false;
  }
  // Unknown workspace: be conservative while any process of this CLI runs.
  return true;
}

export function findRetirableSessions() {
  const liveCwds = findWorkingDirectories(findProcessIds());
  return listSessions().filter(
    (session) => session.status !== 'working' && !isSessionAlive(session, liveCwds)
  );
}

function moveToTrash(filePath) {
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
  return { retired, failed };
}
