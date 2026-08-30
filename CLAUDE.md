# CLAUDE.md

Guidance for Claude Code (interactive and scheduled resident sessions)
working in this repository.

## Project

A Gather-like virtual office that visualizes local AI coding agent sessions
(Claude Code / Codex CLI / Gemini CLI) as pixel-art coworkers. The server
has no npm runtime dependencies; persistence is SQLite via the built-in
`node:sqlite` (npm scripts pass `--experimental-sqlite` for Node 22,
Electron's Node 24 needs no flag).

## Commands

- `npm start` — run the server at http://localhost:4680
- `npm test` — run the full test suite (node:test, ~140 tests, no build step)
- `npm run electron` — desktop app embedding the same server

## Repository map

- `public/office.js` — canvas rendering: office layout, resident desks, entrance-lobby visitors, window/sky day-night scenery
- `public/office/` — layout geometry (team rooms + entrance lobby), sprite specs, desk-avoiding pathfinding
- `public/app.js`, `public/office-client.js` — UI shell and server polling
- `server/core.js`, `server/state.js` — session state assembled from CLI transcripts
- `server/watchers/` — transcript parsers per CLI (claude / codex / gemini)
- `server/residents/` — resident team: `scheduler.js` (trigger timing), `runner.js` (headless CLI spawn), `residents.js` (tick loop and prompt), `database.js` (office.db opener/migrations), `resident-store.js` (residents/teams tables), `registry.js` (session bindings), `whiteboard.js` (reports), `board.js` (kanban task cards), `resident-import.js` / `legacy-import.js` (one-time file-store imports)
- `docs/architecture.md` — full architecture notes
- `docs/database.md` — office.db schema (ER diagram, indexes, conventions)

## Resident team facts (asked repeatedly — check here first)

- A resident run is a headless CLI spawn from `runner.js` with a **30-minute
  timeout** (SIGTERM, then SIGKILL after 10 seconds).
- `schedule` triggers fire at fixed weekday/time slots; a slot missed while
  the machine was asleep still fires up to **1 hour late**
  (`MISSED_RUN_GRACE_MS`); older slots are skipped, never caught up.
  `interval` triggers fire when the last run started ≥ N minutes ago, inside
  the optional active window. After the PC wakes from sleep, execution
  resumes automatically on the next tick — no manual restart needed.
  A trigger firing only starts a run when there is actually work to do: a
  card must be assigned to the resident on the board **and**, if a precheck
  command is set, its output must be non-empty. With no assigned card the
  team stays quiet instead of filing a meaningless report every interval.
- Claude residents in `edit` mode run with `--permission-mode
  bypassPermissions` because headless runs cannot answer approval prompts;
  `read-only` mode is restricted to an inspection-tool allowlist. Gemini
  residents always run with `--skip-trust` for the same reason — without it
  Gemini refuses to start headless outside a trusted folder. Skipping trust
  re-enables workspace settings (e.g. `.gemini/settings.json` MCP servers),
  so `read-only` mode also pins `--approval-mode plan`; still, point gemini
  residents only at directories whose contents you trust. Codex residents run
  `codex exec` with `--skip-git-repo-check` for the same reason — without it
  Codex refuses to start when the working directory is not a git repo
  (`Not inside a trusted directory…`); the `--sandbox` flag
  (`read-only`/`workspace-write`) still bounds what the run may touch.
- The run's final message is posted to the whiteboard; `LEVEL: review-needed`
  on its first line flags it for a human. A report stays on the board until
  the human archives it or the card it links to is archived — archiving a
  card archives its un-pinned reports too (pinned reports stay).
- Everything the resident team persists lives in `<dataDir>/office.db`
  (opened by `database.js`): resident configuration + instructions + run
  state (`residents` table, edited in-app), teams (`teams`, 1:N — every
  resident belongs to one team, default id `default`), session bindings
  (`session_bindings`), reports and cards. Cards/reports reference residents
  by foreign-keyed id; the HTTP API stays name-based (`'user'` = the human's
  column). Teams are user-managed (name + seat count 1..12, both editable;
  deleting a team with residents or the last team is refused); the canvas
  draws one room per team, three rooms per band wrapping to the next band
  below, and seats are unique per (team, seat). Archiving sets `archived_at` — rows are never deleted, and
  listings filter to active rows. See `docs/database.md` for the ER diagram.
- Task queue: the kanban board (`board.js`; rows in the `cards` table, each
  card assigned to one resident or the user). The UI groups columns by team —
  user first, one per team (each card tagged with its assignee's avatar), then
  a 完了 column of done cards. An idle resident whose trigger is not due works
  the **top card** of its column (precheck is skipped — the card is the
  trigger). An ok run marks the card done (it moves to 完了 and stays there
  until the human archives it explicitly — completion never deletes); a
  review-needed or failed run moves it to the user column. A trigger-driven
  run ending review-needed auto-files a card in the user column.

## Git / GitHub

- `origin` is an SSH URL but no SSH key is available here: pushing over SSH
  fails with `Permission denied (publickey)`. **Push via `gh` or an explicit
  HTTPS URL** (`gh` is authenticated for HTTPS). Do not retry SSH pushes.
- Scheduled sessions must `git checkout main` and branch from it before
  making changes — a previous run may have left another branch checked out.
