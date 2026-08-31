// Session state store. One CLI session (= one log file) is one office member.
// Watchers push raw observations in; this module derives working/break status,
// keeps the Slack-like #general log, and notifies subscribers of snapshots.
//
// `createState` returns an isolated instance with an injectable clock, so the
// derivation and messaging logic can be unit-tested without real time or
// module-global state. `deriveStatus` is exported separately as a pure
// function for the same reason.

const WORKING_IDLE_TIMEOUT_MS = 90_000;
const TURN_COMPLETE_GRACE_MS = 5_000;
const SUBAGENT_EXPIRE_MS = 30 * 60_000;
const MCP_BADGE_EXPIRE_MS = 60_000;
const SESSION_EXPIRE_MS = 3 * 24 * 60 * 60_000;
const MAX_MESSAGES = 50;
// The activity view stocks the flow of a turn's tool calls rather than only
// its latest one; this caps the oldest entries so a long run stays bounded.
const MAX_ACTIVITY_LOG = 100;

export const CLI_INFO = {
  claude: { name: 'Claude Code', vendor: 'anthropic', mention: 'Claude' },
  codex: { name: 'Codex', vendor: 'openai', mention: 'Codex' },
  gemini: { name: 'Gemini', vendor: 'google', mention: 'Gemini' },
};

// Pure: map a session and the current time to its display status.
export function deriveStatus(session, now) {
  if (session.lastEventAt === null) return 'break';
  // Waiting for the user has no idle timeout — the human may take a while.
  if (session.waitingForUser) return 'waiting';
  if (now - session.lastEventAt > WORKING_IDLE_TIMEOUT_MS) {
    // An MCP one-shot has no user to unblock it and no host process keeping
    // it resident; a codex MCP call also ends without a task_complete. Once it
    // falls idle it has finished, so it rides the elevator home instead of
    // lingering forever as a blocked visitor.
    if (session.clientKind === 'mcp') return 'break';
    // A tool call still in flight (e.g. a command awaiting permission) means
    // the member is blocked at their desk, not resting.
    return session.pendingTool ? 'blocked' : 'break';
  }
  if (
    session.turnCompletedAt !== null &&
    now - session.turnCompletedAt > TURN_COMPLETE_GRACE_MS
  ) {
    return 'break';
  }
  return 'working';
}

// A resident avatar mirrors a headless run process, not a person: it is only
// "at work" while that run is live. Once the run ends — finished, timed out,
// or emergency-stopped — the CLI is killed mid-tool, freezing its transcript
// in a state deriveStatus reads as working (briefly) then blocked (for days,
// until the log expires). This clocks such a stranded resident session off the
// moment its run is gone, so an emergency stop actually stops the avatar.
// `resident` is the owning resident's name (or null for free-address sessions);
// `residentBusy` is whether that resident's run process is still live. Non-
// resident sessions and live runs keep their derived status untouched.
// By design a resident archived mid-run reads as not-busy (snapshotData lists
// active residents only, while the registry keeps binding its session), so its
// avatar is clocked off here even while the CLI still runs — an archived
// resident has no seat to keep working, and its run still finishes and reports.
export function presenceAwareStatus(status, { resident, residentBusy }) {
  if (resident !== null && !residentBusy && (status === 'working' || status === 'blocked')) {
    return 'break';
  }
  return status;
}

// A fresh session shell. Split out so `reportEvent` reads as "get or create,
// then apply the observation" rather than inlining a 20-field literal.
function createSession(key, cli, filePath, eventAt) {
  return {
    key,
    cli,
    filePath,
    project: null,
    cwd: null,
    task: null,
    activity: null,
    activityKind: null,
    activityLog: [],
    subagents: [],
    mcpCalls: [],
    firstSeenAt: eventAt,
    lastEventAt: null,
    turnCompletedAt: null,
    waitingForUser: false,
    pendingTool: false,
    isSubagent: false,
    clientKind: null,
  };
}

// Each of the following applies one facet of an observation to a session by
// mutation. They are pure with respect to module state (no clock, no I/O), so
// the whole state store stays deterministic and unit-testable through
// `createState`.

function applyTiming(session, eventAt) {
  if (session.lastEventAt === null || eventAt > session.lastEventAt) {
    session.lastEventAt = eventAt;
  }
  if (eventAt < session.firstSeenAt) session.firstSeenAt = eventAt;
}

function applyFields(session, observation) {
  if (observation.project !== undefined) session.project = observation.project;
  if (observation.cwd !== undefined) session.cwd = observation.cwd;
  if (observation.task !== undefined) session.task = observation.task;
  if (observation.activity !== undefined) session.activity = observation.activity;
  if (observation.activityKind !== undefined) session.activityKind = observation.activityKind;
  if (observation.isSubagent) session.isSubagent = true;
  if (observation.clientKind !== undefined) session.clientKind = observation.clientKind;
}

// Stock the flow of a turn so the activity view shows the sequence of steps,
// not just the latest one. A fresh instruction starts a new flow; every
// non-empty activity is appended, oldest entries dropped past the cap.
function applyActivityLog(session, observation) {
  if (observation.task !== undefined && observation.task) session.activityLog = [];
  if (!observation.activity) return;
  session.activityLog.push({
    activity: observation.activity,
    activityKind: observation.activityKind ?? null,
  });
  if (session.activityLog.length > MAX_ACTIVITY_LOG) session.activityLog.shift();
}

function applyTurnState(session, observation, eventAt) {
  session.turnCompletedAt = observation.turnComplete ? eventAt : null;
  // Any later event (e.g. the tool_result carrying the answer) clears it.
  session.waitingForUser = observation.waitingForUser === true;
  // Track whether the session is mid-turn (a command or reply in progress) so
  // the idle timeout keeps it at its desk — most importantly during a command
  // awaiting the boss's permission, but also long-running commands or long
  // replies — instead of sending it on a break. Only a completed turn (or an
  // explicit wait for user input) clears it; plain liveness lines such as tool
  // results or meta entries leave it untouched, so a still-pending tool is
  // never mistaken for an idle session.
  if (observation.turnComplete || observation.waitingForUser === true) {
    session.pendingTool = false;
  } else if (observation.activityKind !== undefined || observation.task) {
    session.pendingTool = true;
  }
}

function applySubagents(session, observation, eventAt) {
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
}

function applyMcpCall(session, observation, eventAt) {
  if (!observation.mcpCall) return;
  session.mcpCalls.push({
    server: observation.mcpCall.server,
    tool: observation.mcpCall.tool,
    at: eventAt,
  });
  if (session.mcpCalls.length > 10) session.mcpCalls.shift();
}

// `isResidentFile` marks session logs spawned by the resident team: their
// runs are scheduled, not requested by the boss, so the #general request/
// reply exchange is suppressed (the residents module posts its own report
// notification instead).
export function createState({
  now = () => Date.now(),
  isResidentFile = () => false,
} = {}) {
  const sessions = new Map();
  const changeListeners = new Set();
  const messages = [];
  let nextMessageId = 1;
  let broadcastScheduled = false;

  function emit() {
    const snap = snapshot();
    for (const listener of changeListeners) listener(snap);
  }

  function scheduleBroadcast() {
    if (broadcastScheduled) return;
    broadcastScheduled = true;
    setTimeout(() => {
      broadcastScheduled = false;
      emit();
    }, 100).unref?.();
  }

  function onChange(listener) {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  }

  function postMessage({ authorKind, authorName, cli = null, text, at }) {
    const id = nextMessageId;
    nextMessageId += 1;
    messages.push({ id, authorKind, authorName, cli, text, at });
    messages.sort((a, b) => a.at - b.at || a.id - b.id);
    if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
    scheduleBroadcast();
    return id;
  }

  // A session that has started waiting for the boss's answer or permission
  // posts a fresh @社長 mention so the client rings the attention chime. The
  // #general log is no longer rendered — this message exists only to drive that
  // chime — and subagent sessions stay silent (their work is internal). `before`
  // holds the waiting flag captured before the observation was applied, so the
  // message fires only on the edge into waiting. The log keeps the newest
  // MAX_MESSAGES entries sorted by time.
  function updateGeneralChannel(session, observation, eventAt, before) {
    if (session.waitingForUser && !before.waiting && session.task) {
      postMessage({
        authorKind: 'agent',
        authorName: `${CLI_INFO[session.cli].mention} (${session.project ?? '?'})`,
        cli: session.cli,
        text: '@社長 確認をお願いします',
        at: eventAt,
      });
    }
  }

  function reportEvent(cli, filePath, observation) {
    if (!CLI_INFO[cli]) return;
    const key = `${cli}:${filePath}`;
    const eventAt = observation.timestamp ?? now();

    let session = sessions.get(key);
    if (!session) {
      session = createSession(key, cli, filePath, eventAt);
      sessions.set(key, session);
    }

    // Snapshot the waiting flag before the observation mutates it; the
    // attention-chime message fires only on the edge into waiting.
    const before = {
      waiting: session.waitingForUser,
    };

    applyTiming(session, eventAt);
    applyFields(session, observation);
    applyActivityLog(session, observation);
    applyTurnState(session, observation, eventAt);
    applySubagents(session, observation, eventAt);
    applyMcpCall(session, observation, eventAt);

    if (!session.isSubagent && !isResidentFile(session.filePath)) {
      updateGeneralChannel(session, observation, eventAt, before);
    }

    scheduleBroadcast();
  }

  function snapshot() {
    const currentTime = now();
    const list = [];
    for (const session of sessions.values()) {
      if (session.lastEventAt !== null && currentTime - session.lastEventAt > SESSION_EXPIRE_MS) {
        sessions.delete(session.key);
        continue;
      }
      session.subagents = session.subagents.filter(
        (s) => currentTime - s.startedAt < SUBAGENT_EXPIRE_MS
      );
      const status = deriveStatus(session, currentTime);
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
        activityLog: status !== 'break' ? session.activityLog : [],
        subagents: status === 'working' || status === 'blocked' ? session.subagents : [],
        isSubagent: session.isSubagent,
        mcpCalls: session.mcpCalls.filter((c) => currentTime - c.at < MCP_BADGE_EXPIRE_MS),
        firstSeenAt: session.firstSeenAt,
        lastEventAt: session.lastEventAt,
      });
    }
    list.sort((a, b) => a.firstSeenAt - b.firstSeenAt || (a.key < b.key ? -1 : 1));
    return { at: currentTime, employees: list, messages };
  }

  return {
    reportEvent,
    postMessage,
    snapshot,
    onChange,
    // Force a fresh snapshot broadcast; the core calls this on a timer so a
    // working→break flip (driven purely by elapsed time) still reaches clients.
    refresh: emit,
  };
}
