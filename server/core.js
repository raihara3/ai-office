// Application core: owns the state store, the CLI watchers and the resident
// team, wired together and decoupled from any transport (HTTP, IPC, …). A
// transport adapter consumes the returned handle; tests can drive the core
// directly without a network layer.

import { createState } from './state.js';
import { createResidents, DEFAULT_DATA_DIRECTORY } from './residents/residents.js';
import { startClaudeWatcher } from './watchers/claude.js';
import { startCodexWatcher } from './watchers/codex.js';
import { startGeminiWatcher } from './watchers/gemini.js';

// Status can flip from working to break purely by time passing, so re-derive
// and re-broadcast often enough that the flip lands close to the grace period.
const REFRESH_INTERVAL_MS = 2_000;

// The window scenery follows the server's local timezone: daylight runs
// 06:00–17:59 (blue sky), the rest of the day shows a starry night sky.
const DAYLIGHT_START_HOUR = 6;
const DAYLIGHT_END_HOUR = 18;
export function skyPhaseFor(timestamp) {
  const hour = new Date(timestamp).getHours();
  return hour >= DAYLIGHT_START_HOUR && hour < DAYLIGHT_END_HOUR ? 'day' : 'night';
}

export function createCore({ now, dataDirectory = DEFAULT_DATA_DIRECTORY } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  // The state store asks whether a log belongs to a resident (to mute the
  // #general request/reply exchange), and the residents module posts into the
  // state — resolve the cycle by letting the closure capture `residents`.
  let residents;
  const state = createState({
    now,
    isResidentFile: (filePath) => residents.residentForFile(filePath) !== null,
    dataDirectory,
  });
  residents = createResidents({ state, now, dataDirectory });
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
      teams: residents.listTeams(),
      whiteboard: residents.whiteboardCounts(),
      board: residents.boardCounts(),
      officeName: residents.getOfficeName(),
      sky: skyPhaseFor(clock()),
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
    listResidents: residents.list,
    listTeams: residents.listTeams,
    saveTeam: residents.saveTeam,
    deleteTeam: residents.deleteTeam,
    saveResident: residents.save,
    deleteResident: residents.remove,
    runResident: residents.runNow,
    stopResident: residents.stopNow,
    listReports: residents.listReports,
    markReportRead: residents.markReportRead,
    toggleReportFavorite: residents.toggleReportFavorite,
    archiveReport: residents.archiveReport,
    listBoard: residents.listBoardCards,
    createBoardCard: residents.createBoardCard,
    moveBoardCard: residents.moveBoardCard,
    markBoardCardDone: residents.markBoardCardDone,
    archiveBoardCard: residents.archiveBoardCard,
    updateBoardCard: residents.updateBoardCard,
    appendBoardNote: residents.appendBoardNote,
    getOfficeName: residents.getOfficeName,
    saveOfficeName: residents.saveOfficeName,
  };
}
