// Application core: owns the state store, the HR cleanup, the CLI watchers
// and the resident team, wired together and decoupled from any transport
// (HTTP, IPC, …). A transport adapter consumes the returned handle; tests can
// drive the core directly without a network layer.

import { createState } from './state.js';
import { createCleanup } from './cleanup.js';
import { createResidents } from './residents/residents.js';
import { startClaudeWatcher } from './watchers/claude.js';
import { startCodexWatcher } from './watchers/codex.js';
import { startGeminiWatcher } from './watchers/gemini.js';

// Status can flip from working to break purely by time passing, so re-derive
// and re-broadcast often enough that the flip lands close to the grace period.
const REFRESH_INTERVAL_MS = 2_000;

export function createCore({ now, dataDirectory } = {}) {
  // The state store asks whether a log belongs to a resident (to mute the
  // #general request/reply exchange), and the residents module posts into the
  // state — resolve the cycle by letting the closure capture `residents`.
  let residents;
  const state = createState({
    now,
    isResidentFile: (filePath) => residents.residentForFile(filePath) !== null,
  });
  residents = createResidents({ state, now, dataDirectory });
  const cleanup = createCleanup({
    state,
    now,
    isProtected: (session) => residents.residentForFile(session.filePath) !== null,
  });
  let refreshTimer = null;

  // Session keys are `${cli}:${filePath}`.
  function filePathOfEmployee(employee) {
    return employee.key.slice(employee.cli.length + 1);
  }

  // Overlay the resident-team data on the raw state snapshot: tag each
  // employee with its owning resident (the frontend seats those at the
  // resident island instead of the free-address grid) and attach the resident
  // roster and the whiteboard unread counts.
  function augmentSnapshot(snap) {
    return {
      ...snap,
      employees: snap.employees.map((employee) => ({
        ...employee,
        resident: residents.residentForFile(filePathOfEmployee(employee)),
      })),
      residents: residents.snapshotData(),
      whiteboard: residents.whiteboardCounts(),
    };
  }

  function start() {
    if (refreshTimer !== null) return;
    const report = state.reportEvent;
    startClaudeWatcher({ report });
    startCodexWatcher({ report });
    startGeminiWatcher({ report });
    residents.start();
    refreshTimer = setInterval(() => state.refresh(), REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  }

  function stop() {
    residents.stop();
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  return {
    state,
    start,
    stop,
    subscribe: (listener) => state.onChange((snap) => listener(augmentSnapshot(snap))),
    getSnapshot: () => augmentSnapshot(state.snapshot()),
    postMessage: state.postMessage,
    previewCleanup: cleanup.findRetirableSessions,
    runCleanup: cleanup.retireSessions,
    listResidents: residents.list,
    saveResident: residents.save,
    deleteResident: residents.remove,
    runResident: residents.runNow,
    listReports: residents.listReports,
    markReportRead: residents.markReportRead,
    archiveReport: residents.archiveReport,
  };
}
