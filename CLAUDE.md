# CLAUDE.md

Guidance for Claude Code (interactive and scheduled resident sessions)
working in this repository.

## Project

A Gather-like virtual office that visualizes local AI coding agent sessions
(Claude Code / Codex CLI / Gemini CLI) as pixel-art coworkers. The server
uses the Node.js standard library only — no runtime dependencies.

## Commands

- `npm start` — run the server at http://localhost:4680
- `npm test` — run the full test suite (node:test, ~90 tests, no build step)
- `npm run electron` — desktop app embedding the same server

## Repository map

- `public/office.js` — canvas rendering: office layout, avatars and walking, window/sky day-night scenery
- `public/office/` — layout grid, small talk, sprite specs, desk-avoiding pathfinding
- `public/app.js`, `public/office-client.js` — UI shell and server polling
- `server/core.js`, `server/state.js` — session state assembled from CLI transcripts
- `server/watchers/` — transcript parsers per CLI (claude / codex / gemini)
- `server/residents/` — resident team: `scheduler.js` (trigger timing), `runner.js` (headless CLI spawn), `residents.js` (tick loop and prompt), `whiteboard.js` (reports), `board.js` (kanban task cards)
- `docs/architecture.md` — full architecture notes

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
  `read-only` mode is restricted to an inspection-tool allowlist.
- The run's final message is posted to the whiteboard; `LEVEL: review-needed`
  on its first line flags it for a human.
- Task queue: the kanban board (`board.js`; cards under
  `<dataDir>/board/*.md`, columns = assignee). An idle resident whose
  trigger is not due works the **top card** of its column (precheck is
  skipped — the card is the trigger). An ok run auto-archives the card; a
  review-needed or failed run moves it to the user column. A trigger-driven
  run ending review-needed auto-files a card in the user column.

## Git / GitHub

- `origin` is an SSH URL but no SSH key is available here: pushing over SSH
  fails with `Permission denied (publickey)`. **Push via `gh` or an explicit
  HTTPS URL** (`gh` is authenticated for HTTPS). Do not retry SSH pushes.
- Scheduled sessions must `git checkout main` and branch from it before
  making changes — a previous run may have left another branch checked out.
