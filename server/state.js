// Central store for session state. One CLI session (= one log file) is one
// office member. Watchers push raw observations here; this module derives
// working/break status and broadcasts snapshots to SSE clients.

const WORKING_IDLE_TIMEOUT_MS = 90_000;
const TURN_COMPLETE_GRACE_MS = 5_000;
const SUBAGENT_EXPIRE_MS = 30 * 60_000;
const MCP_BADGE_EXPIRE_MS = 60_000;
const SESSION_EXPIRE_MS = 24 * 60 * 60_000;

export const CLI_INFO = {
  claude: { name: 'Claude Code', vendor: 'anthropic', mention: 'Claude' },
  codex: { name: 'Codex', vendor: 'openai', mention: 'Codex' },
  gemini: { name: 'Gemini', vendor: 'google', mention: 'Gemini' },
};

// Slack-like #general channel log, rebuilt from the replayed events.
const MAX_MESSAGES = 50;
const messages = [];
let nextMessageId = 1;

export function postMessage({ authorKind, authorName, cli = null, text, at }) {
  const id = nextMessageId;
  nextMessageId += 1;
  messages.push({ id, authorKind, authorName, cli, text, at, reactions: [] });
  messages.sort((a, b) => a.at - b.at || a.id - b.id);
  if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
  scheduleBroadcast();
  return id;
}

function addReaction(messageId, emoji) {
  const message = messages.find((m) => m.id === messageId);
  if (message && !message.reactions.includes(emoji)) {
    message.reactions.push(emoji);
    scheduleBroadcast();
  }
}

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
      activityKind: null,
      subagents: [],
      mcpCalls: [],
      firstSeenAt: eventAt,
      lastEventAt: null,
      turnCompletedAt: null,
      waitingForUser: false,
      isSubagent: false,
      reactionPendingMessageId: null,
    };
    sessions.set(key, session);
  }

  const previousTask = session.task;
  const wasTurnComplete = session.turnCompletedAt !== null;
  const wasWaiting = session.waitingForUser;

  if (session.lastEventAt === null || eventAt > session.lastEventAt) {
    session.lastEventAt = eventAt;
  }
  if (eventAt < session.firstSeenAt) session.firstSeenAt = eventAt;

  if (observation.project !== undefined) session.project = observation.project;
  if (observation.cwd !== undefined) session.cwd = observation.cwd;
  if (observation.task !== undefined) session.task = observation.task;
  if (observation.activity !== undefined) session.activity = observation.activity;
  if (observation.activityKind !== undefined) session.activityKind = observation.activityKind;

  if (observation.turnComplete) {
    session.turnCompletedAt = eventAt;
  } else {
    session.turnCompletedAt = null;
  }
  // Any later event (e.g. the tool_result carrying the answer) clears it.
  session.waitingForUser = observation.waitingForUser === true;
  if (observation.isSubagent) session.isSubagent = true;

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

  // #general channel: user requests, 🫡 on pickup, agent replies.
  // Subagent sessions stay silent — their requests are internal. Old
  // replayed conversations are welcome as history: the log keeps the
  // newest MAX_MESSAGES entries sorted by time, dates shown in the UI.
  if (!session.isSubagent) {
    const displayName = `${CLI_INFO[cli].mention} (${session.project ?? '?'})`;
    if (observation.task !== undefined && observation.task && observation.task !== previousTask) {
      session.reactionPendingMessageId = postMessage({
        authorKind: 'user',
        authorName: '社長',
        cli,
        text: `@${displayName} ${observation.task}`,
        at: eventAt,
      });
    } else if (
      session.reactionPendingMessageId &&
      // Any sign of the agent responding counts as picking the task up:
      // tool activity, thinking, or even a plain text answer (Codex and
      // Gemini often reply without using a single tool).
      (observation.activity ||
        observation.activityKind ||
        observation.turnComplete ||
        observation.mcpCall ||
        observation.subagentStarted)
    ) {
      addReaction(session.reactionPendingMessageId, '🫡');
      session.reactionPendingMessageId = null;
    }
    if (observation.turnComplete && !wasTurnComplete && session.task) {
      postMessage({
        authorKind: 'agent',
        authorName: displayName,
        cli,
        text: '@社長 作業が完了しました',
        at: eventAt,
      });
    }
    if (session.waitingForUser && !wasWaiting && session.task) {
      postMessage({
        authorKind: 'agent',
        authorName: displayName,
        cli,
        text: '@社長 確認をお願いします',
        at: eventAt,
      });
    }
  }

  scheduleBroadcast();
}

function deriveStatus(session, now) {
  if (session.lastEventAt === null) return 'break';
  // Waiting for the user has no idle timeout — the human may take a while.
  if (session.waitingForUser) return 'waiting';
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
      lastEventAt: session.lastEventAt,
      isSubagent: session.isSubagent,
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
      task: status !== 'break' ? session.task : null,
      activity: status !== 'break' ? session.activity : null,
      activityKind: status !== 'break' ? session.activityKind : null,
      subagents: status === 'working' ? session.subagents : [],
      isSubagent: session.isSubagent,
      mcpCalls: session.mcpCalls.filter((c) => now - c.at < MCP_BADGE_EXPIRE_MS),
      firstSeenAt: session.firstSeenAt,
      lastEventAt: session.lastEventAt,
    });
  }
  list.sort((a, b) => a.firstSeenAt - b.firstSeenAt || (a.key < b.key ? -1 : 1));
  return { at: now, employees: list, messages };
}

// Status can flip from working to break purely by time passing, so
// re-evaluate often enough that the flip lands close to the grace period.
setInterval(scheduleBroadcast, 2_000).unref();
