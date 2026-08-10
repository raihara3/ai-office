// Central store for session state. One CLI session (= one log file) is one
// office member. Watchers push raw observations here; this module derives
// working/break status and broadcasts snapshots to SSE clients.

const WORKING_IDLE_TIMEOUT_MS = 90_000;
const TURN_COMPLETE_GRACE_MS = 15_000;
const SUBAGENT_EXPIRE_MS = 30 * 60_000;
const MCP_BADGE_EXPIRE_MS = 60_000;
const SESSION_EXPIRE_MS = 24 * 60 * 60_000;

export const CLI_INFO = {
  claude: { name: 'Claude Code', vendor: 'anthropic' },
  codex: { name: 'Codex', vendor: 'openai' },
  gemini: { name: 'Gemini', vendor: 'google' },
};

const sessions = new Map();
// Keys retired by HR cleanup. The CLI may keep writing to (or recreate) the
// log path, which would resurrect the session on the next rescan — reject
// events for these keys for a while instead.
const DISMISSED_TOMBSTONE_MS = 10 * 60_000;
const dismissedAt = new Map();
const changeListeners = new Set();

export function onChange(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

let broadcastScheduled = false;
function scheduleBroadcast() {
  if (broadcastScheduled) return;
  broadcastScheduled = true;
  setTimeout(() => {
    broadcastScheduled = false;
    const snap = snapshot();
    for (const listener of changeListeners) listener(snap);
  }, 100);
}

export function reportEvent(cli, filePath, observation) {
  if (!CLI_INFO[cli]) return;
  const key = `${cli}:${filePath}`;
  const tombstone = dismissedAt.get(key);
  if (tombstone !== undefined) {
    if (Date.now() - tombstone < DISMISSED_TOMBSTONE_MS) return;
    dismissedAt.delete(key);
  }
  let session = sessions.get(key);
  const eventAt = observation.timestamp ?? Date.now();

  if (!session) {
    session = {
      key,
      cli,
      filePath,
      project: null,
      cwd: null,
      task: null,
      activity: null,
      subagents: [],
      mcpCalls: [],
      firstSeenAt: eventAt,
      lastEventAt: null,
      turnCompletedAt: null,
    };
    sessions.set(key, session);
  }

  if (session.lastEventAt === null || eventAt > session.lastEventAt) {
    session.lastEventAt = eventAt;
  }
  if (eventAt < session.firstSeenAt) session.firstSeenAt = eventAt;

  if (observation.project !== undefined) session.project = observation.project;
  if (observation.cwd !== undefined) session.cwd = observation.cwd;
  if (observation.task !== undefined) session.task = observation.task;
  if (observation.activity !== undefined) session.activity = observation.activity;

  if (observation.turnComplete) {
    session.turnCompletedAt = eventAt;
  } else {
    session.turnCompletedAt = null;
  }

  if (observation.subagentStarted) {
    session.subagents.push({
      key: observation.subagentStarted.key ?? `${eventAt}`,
      label: observation.subagentStarted.label,
      activity: null,
      startedAt: eventAt,
    });
  }
  if (observation.subagentActivity && session.subagents.length > 0) {
    session.subagents[session.subagents.length - 1].activity = observation.subagentActivity;
  }
  if (observation.subagentEnded) {
    session.subagents = session.subagents.filter(
      (s) => s.key !== observation.subagentEnded.key
    );
  }
  if (observation.mcpCall) {
    session.mcpCalls.push({
      server: observation.mcpCall.server,
      tool: observation.mcpCall.tool,
      at: eventAt,
    });
    if (session.mcpCalls.length > 10) session.mcpCalls.shift();
  }

  scheduleBroadcast();
}

function deriveStatus(session, now) {
  if (session.lastEventAt === null) return 'break';
  if (now - session.lastEventAt > WORKING_IDLE_TIMEOUT_MS) return 'break';
  if (
    session.turnCompletedAt !== null &&
    now - session.turnCompletedAt > TURN_COMPLETE_GRACE_MS
  ) {
    return 'break';
  }
  return 'working';
}

// Used by the HR cleanup flow to inspect and dismiss sessions.
export function listSessions() {
  const now = Date.now();
  return [...sessions.values()]
    .map((session) => ({
      key: session.key,
      cli: session.cli,
      filePath: session.filePath,
      project: session.project,
      cwd: session.cwd,
      status: deriveStatus(session, now),
    }));
}

export function dismissSession(key) {
  if (!sessions.delete(key)) return;
  dismissedAt.set(key, Date.now());
  scheduleBroadcast();
}

export function snapshot() {
  const now = Date.now();
  const list = [];
  for (const session of sessions.values()) {
    if (session.lastEventAt !== null && now - session.lastEventAt > SESSION_EXPIRE_MS) {
      sessions.delete(session.key);
      continue;
    }
    session.subagents = session.subagents.filter(
      (s) => now - s.startedAt < SUBAGENT_EXPIRE_MS
    );
    const status = deriveStatus(session, now);
    list.push({
      key: session.key,
      cli: session.cli,
      name: CLI_INFO[session.cli].name,
      vendor: CLI_INFO[session.cli].vendor,
      status,
      project: session.project,
      task: status === 'working' ? session.task : null,
      activity: status === 'working' ? session.activity : null,
      subagents: status === 'working' ? session.subagents : [],
      mcpCalls: session.mcpCalls.filter((c) => now - c.at < MCP_BADGE_EXPIRE_MS),
      firstSeenAt: session.firstSeenAt,
      lastEventAt: session.lastEventAt,
    });
  }
  list.sort((a, b) => a.firstSeenAt - b.firstSeenAt || (a.key < b.key ? -1 : 1));
  return { at: now, employees: list };
}

// Status can flip from working to break purely by time passing,
// so re-evaluate periodically even without new events.
setInterval(scheduleBroadcast, 5_000).unref();
