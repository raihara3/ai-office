// Resident team orchestrator: composes the resident store, scheduler, session
// registry, runner, whiteboard and kanban board into one handle for the core.
// A tick loop re-reads the resident rows, fires due triggers, gates trigger
// runs on both their precheck command and an assigned board card, works the
// top card of each idle resident's board column, and turns finished runs into
// whiteboard reports plus a #general notification.

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createBoard, USER_COLUMN } from './board.js';
import { openDatabase } from './database.js';
import { importLegacyData } from './legacy-import.js';
import { importResidents } from './resident-import.js';
import { createResidentStore } from './resident-store.js';
import { createSessionRegistry } from './registry.js';
import { createRunner, expandHomeDirectory, splitReportLevel } from './runner.js';
import { createWhiteboard } from './whiteboard.js';
import { isDue, nextRunAt } from './scheduler.js';

const TICK_INTERVAL_MS = 30_000;
const PRECHECK_TIMEOUT_MS = 30_000;
const PRECHECK_OUTPUT_CAP = 16 * 1024;

// Shared by the browser server and the Electron app: the same directory
// Electron's app.getPath('userData') resolves to on macOS, so both modes see
// one resident team.
export const DEFAULT_DATA_DIRECTORY = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'ai-office'
);

// Rules every resident follows regardless of role; the role-specific
// instructions (edited in the resident drawer) are appended below this.
function buildPrompt(configuration, instructions, precheckOutput, task) {
  const sections = [
    `あなたは AI Office の常駐チームの一員「${configuration.displayName}」です。以下のルールと役割指示に従って作業してください。`,
    [
      '共通ルール:',
      '- 最後のメッセージが人間向けの報告としてそのままホワイトボードに掲示されます。日本語で簡潔にまとめてください。',
      '- 人間による確認・レビュー・判断が必要な場合は、最終メッセージの1行目に「LEVEL: review-needed」とだけ書き、2行目以降に本文を続けてください。本文の途中や末尾には書かないでください。',
    ].join('\n'),
    `## 役割指示\n\n${instructions.trim()}`,
  ];
  if (task) {
    sections.push(
      `## 今回のタスク(カンバンボードより)\n\n### ${task.title}\n\n${task.body}`.trim()
    );
  }
  if (precheckOutput) {
    sections.push(`## 事前チェックの出力\n\n\`\`\`\n${precheckOutput.trim()}\n\`\`\``);
  }
  return sections.join('\n\n');
}

function defaultRunPrecheck(command, workingDirectory) {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', command],
      {
        cwd: expandHomeDirectory(workingDirectory),
        timeout: PRECHECK_TIMEOUT_MS,
        maxBuffer: PRECHECK_OUTPUT_CAP,
        encoding: 'utf8',
      },
      (error, stdout) => {
        // A failing precheck means "no work found" — the agent run is simply
        // skipped rather than surfacing an error every interval.
        resolve(error ? '' : stdout);
      }
    );
  });
}

export function createResidents({
  state,
  dataDirectory = DEFAULT_DATA_DIRECTORY,
  now = () => Date.now(),
  runPrecheck = defaultRunPrecheck,
  database = null,
  residentStore = null,
  registry = null,
  whiteboard = null,
  board = null,
  runner = null,
} = {}) {
  // The database only opens when a store actually needs it, so tests that
  // inject stubs never touch the disk. The one-time imports run right after
  // the first open: resident files first, so the legacy Markdown import's
  // foreign keys can resolve.
  let ownedDatabase = null;
  if (residentStore === null || registry === null || whiteboard === null || board === null) {
    if (database === null) {
      database = openDatabase({ location: path.join(dataDirectory, 'office.db') });
      ownedDatabase = database;
    }
    importResidents(database, { dataDirectory, now });
    importLegacyData(database, { dataDirectory, now });
    residentStore ??= createResidentStore({ database, now });
    registry ??= createSessionRegistry({ database, now });
    whiteboard ??= createWhiteboard({ database, now });
    board ??= createBoard({ database, now });
  }
  runner ??= createRunner({ registry, now });
  let tickTimer = null;
  // Cards currently being worked, by resident name. In-memory on purpose:
  // if the server dies mid-run the card simply stays in its column and the
  // next tick relaunches it — no recovery bookkeeping needed. The card (not
  // just its id) is kept so the activity view can show the task title instead
  // of the whole prompt the CLI actually receives.
  const activeCards = new Map();
  // Residents whose launch() is still awaiting its precheck; keeps a slow
  // precheck from letting the same tick pick up a board card concurrently.
  const launching = new Set();

  function formatRunDate(at) {
    const date = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function handleFinished(entry, { outcome, resultText }, task = null) {
    const { configuration } = entry;
    activeCards.delete(entry.name);
    const finishedAt = now();
    const { level, body } = splitReportLevel(resultText);
    const reportLevel = outcome === 'ok' ? level : 'review-needed';
    const reportBody =
      outcome === 'ok' ? body : `実行が正常に終了しませんでした(${outcome})。\n\n${body}`;
    const title = `${configuration.displayName} ${formatRunDate(finishedAt)}`;
    // A trigger-driven run that needs a human joins the board as a card in
    // the user column, so follow-up is tracked like any other task. Filed
    // before the report so the report can carry the card id.
    let taskId = task?.id ?? null;
    if (taskId === null && reportLevel === 'review-needed') {
      taskId = board.createCard({
        title,
        body: '定期実行が要確認で終了しました。リンクされた報告を確認してください。',
        assignee: USER_COLUMN,
        origin: entry.name,
        createdAt: finishedAt,
      });
    }
    whiteboard.saveReport(entry.name, {
      title,
      level: reportLevel,
      body: reportBody,
      createdAt: finishedAt,
      task: taskId,
    });
    if (task !== null) {
      // An ok run moves the card into the 完了 column (it stays on the board
      // until the human archives it); a review-needed run hands it back.
      if (reportLevel === 'info') board.markCardDone(task.id);
      else board.moveCard(task.id, { assignee: USER_COLUMN });
    }
    residentStore.saveState(entry.name, {
      ...entry.state,
      lastFinishedAt: finishedAt,
      lastOutcome: outcome,
    });
    state.postMessage({
      authorKind: 'agent',
      authorName: configuration.displayName,
      cli: configuration.cli,
      text:
        reportLevel === 'review-needed'
          ? '@社長 確認をお願いします(ホワイトボードに報告を掲示しました)'
          : `@社長 ${task !== null ? `タスク「${task.title}」` : '作業'}が完了しました(ホワイトボードに報告を掲示しました)`,
      at: finishedAt,
    });
    state.refresh();
  }

  // Start one run. `gateOnPrecheck` is true for scheduled ticks and false for
  // the panel's 今すぐ実行 button. A gated trigger run only starts when there is
  // actually work to do: a card must be assigned to this resident on the board
  // AND, if a precheck command is set, its output must be non-empty. Either
  // gate empty means "nothing to do" and the agent is skipped entirely. A board
  // card passed as `task` bypasses both gates — the card's existence is the
  // trigger.
  async function launch(entry, { gateOnPrecheck, task = null }) {
    const { configuration } = entry;
    const startedAt = now();
    launching.add(entry.name);
    try {
      // Record the attempt first so a slow precheck cannot double-fire the
      // trigger on the next tick.
      entry.state = { ...entry.state, lastRunAt: startedAt };
      residentStore.saveState(entry.name, entry.state);

      // A firing trigger is not enough on its own: with no assigned card the
      // team stays quiet instead of filing a meaningless report every interval.
      if (gateOnPrecheck && task === null && board.topCardFor(entry.name) === null) {
        residentStore.saveState(entry.name, { ...entry.state, lastOutcome: 'skipped' });
        return false;
      }

      let precheckOutput = null;
      if (configuration.precheck && task === null) {
        precheckOutput = await runPrecheck(configuration.precheck, configuration.workingDirectory);
        if (gateOnPrecheck && precheckOutput.trim() === '') {
          residentStore.saveState(entry.name, { ...entry.state, lastOutcome: 'skipped' });
          return false;
        }
      }
      const started = runner.run(
        {
          name: entry.name,
          displayName: configuration.displayName,
          cli: configuration.cli,
          mode: configuration.mode,
          workingDirectory: configuration.workingDirectory,
        },
        {
          prompt: buildPrompt(configuration, entry.instructions, precheckOutput, task),
          onFinished: (result) => handleFinished(entry, result, task),
        }
      );
      if (started && task !== null) activeCards.set(entry.name, task);
      if (started) state.refresh();
      return started;
    } finally {
      launching.delete(entry.name);
    }
  }

  function tick() {
    for (const entry of residentStore.list()) {
      if (!entry.configuration.enabled) continue;
      if (runner.isRunning(entry.name) || launching.has(entry.name)) continue;
      if (isDue(entry.configuration.trigger, entry.state.lastRunAt ?? null, now())) {
        launch(entry, { gateOnPrecheck: true });
        continue;
      }
      // Idle with no trigger due: work the board. The top card of this
      // resident's column is the next task — column order is priority.
      const card = board.topCardFor(entry.name);
      if (card !== null) launch(entry, { gateOnPrecheck: false, task: card });
    }
  }

  function start() {
    if (tickTimer !== null) return;
    tickTimer = setInterval(tick, TICK_INTERVAL_MS);
    tickTimer.unref?.();
    tick();
  }

  function stop() {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    // Closing checkpoints the WAL; only a database this module opened is ours
    // to close.
    if (ownedDatabase !== null) {
      try {
        ownedDatabase.close();
      } catch {
        // Already closed — stop() must stay idempotent.
      }
      ownedDatabase = null;
    }
  }

  // Lightweight per-snapshot data for the canvas (no instructions text).
  function snapshotData() {
    const currentTime = now();
    return residentStore.list({ withInstructions: false }).map((entry) => ({
      name: entry.name,
      teamId: entry.teamId,
      displayName: entry.configuration.displayName,
      seat: entry.configuration.seat,
      cli: entry.configuration.cli,
      mode: entry.configuration.mode,
      enabled: entry.configuration.enabled,
      busy: runner.isRunning(entry.name),
      // The title of the board card the resident is working, so the activity
      // view can label it without exposing the full prompt sent to the CLI.
      activeTask: activeCards.get(entry.name)?.title ?? null,
      lastRunAt: entry.state.lastRunAt ?? null,
      lastOutcome: entry.state.lastOutcome ?? null,
      nextRunAt: entry.configuration.enabled
        ? nextRunAt(entry.configuration.trigger, entry.state.lastRunAt ?? null, currentTime)
        : null,
    }));
  }

  // Full detail for the resident panel, instructions included.
  function list() {
    return residentStore.list().map((entry) => ({
      id: entry.id,
      teamId: entry.teamId,
      name: entry.name,
      configuration: entry.configuration,
      instructions: entry.instructions,
      state: entry.state,
      busy: runner.isRunning(entry.name),
    }));
  }

  function save(name, { configuration, instructions, teamId }) {
    residentStore.save(name, { configuration, instructions, teamId });
    state.refresh();
  }

  function saveTeam(team) {
    const id = residentStore.saveTeam(team);
    state.refresh();
    return id;
  }

  function deleteTeam(id) {
    residentStore.deleteTeam(id);
    state.refresh();
  }

  function remove(name) {
    residentStore.remove(name);
    state.refresh();
  }

  function runNow(name) {
    const entry = residentStore.read(name);
    if (entry === null) throw new Error(`unknown resident: ${name}`);
    if (runner.isRunning(name)) throw new Error('already running');
    return launch(entry, { gateOnPrecheck: false });
  }

  function markReportRead(id) {
    const changed = whiteboard.markRead(id);
    if (changed) state.refresh();
    return changed;
  }

  function toggleReportFavorite(id) {
    const favorite = whiteboard.toggleFavorite(id);
    if (favorite !== null) state.refresh();
    return favorite;
  }

  function archiveReport(id) {
    const changed = whiteboard.archiveReport(id);
    if (changed) state.refresh();
    return changed;
  }

  // Kanban board operations. Moving or archiving is refused while the card's
  // run is in flight, so the finishing handler never acts on a stale card.
  function isWorkingCard(id) {
    for (const [residentName, card] of activeCards) {
      if (card.id === id && runner.isRunning(residentName)) return true;
    }
    return false;
  }

  function assertAssignee(assignee) {
    if (assignee === USER_COLUMN) return;
    if (residentStore.read(assignee, { withInstructions: false }) === null) {
      throw new Error(`unknown assignee: ${assignee}`);
    }
  }

  function listBoardCards() {
    // `reported` marks cards a run has already reported on — the frontend
    // badges those as needing the human when they sit in the user column,
    // regardless of who originally filed the card.
    const reportedTaskIds = new Set(
      whiteboard
        .listReports()
        .map((report) => report.task)
        .filter(Boolean)
    );
    return board.listCards().map((card) => ({
      ...card,
      working: isWorkingCard(card.id),
      reported: reportedTaskIds.has(card.id),
    }));
  }

  function createBoardCard({ title, body, assignee }) {
    assertAssignee(assignee);
    const id = board.createCard({ title, body, assignee, origin: USER_COLUMN, createdAt: now() });
    state.refresh();
    return id;
  }

  function moveBoardCard(id, { assignee, index }) {
    if (assignee !== undefined) assertAssignee(assignee);
    if (isWorkingCard(id)) return false;
    const changed = board.moveCard(id, { assignee, index });
    if (changed) state.refresh();
    return changed;
  }

  function markBoardCardDone(id) {
    if (isWorkingCard(id)) return false;
    const changed = board.markCardDone(id);
    if (changed) state.refresh();
    return changed;
  }

  function archiveBoardCard(id) {
    if (isWorkingCard(id)) return false;
    const changed = board.archiveCard(id);
    // Reports stay on the board until the human archives them or the card they
    // belong to is archived; do the latter here so an archived card takes its
    // reports with it.
    if (changed) {
      whiteboard.archiveReportsForTask(id);
      state.refresh();
    }
    return changed;
  }

  function appendBoardNote(id, text) {
    const changed = board.appendNote(id, text);
    if (changed) state.refresh();
    return changed;
  }

  return {
    start,
    stop,
    tick,
    snapshotData,
    list,
    listTeams: residentStore.listTeams,
    saveTeam,
    deleteTeam,
    save,
    remove,
    runNow,
    residentForFile: registry.residentForFile,
    listReports: whiteboard.listReports,
    markReportRead,
    toggleReportFavorite,
    archiveReport,
    whiteboardCounts: whiteboard.counts,
    listBoardCards,
    createBoardCard,
    moveBoardCard,
    markBoardCardDone,
    archiveBoardCard,
    appendBoardNote,
    boardCounts: board.counts,
  };
}
