# AI Office

A Gather-like virtual office that visualizes your local AI coding agents —
Claude Code, Codex CLI and Gemini CLI — as pixel-art coworkers.

Each session (one log file) gets its own avatar and desk on a shared grid
of six pre-furnished desks (three columns by two rows) that fills from
the top-left; vacant seats show an empty desk, and sessions beyond six
overflow onto extra rows. When an agent is actively
working, its avatar sits at
the desk and a speech bubble shows what it is doing right now (current tool
action or the user's request). When idle, the avatar walks to the break room
for a coffee. Subagent runs appear as mini avatars next to the desk. A
separate desk island in the top-left seats the resident team — permanently
assigned agents that run on schedules and report to a wall whiteboard.

![status](https://img.shields.io/badge/runtime-Node.js%20%E2%89%A520-brightgreen)

## Usage

### Browser (server only)

```sh
npm start
# open http://localhost:4680
```

The server has no runtime dependencies — Node.js standard library only. Set
`PORT` to change the listen port.

### Desktop app (Electron)

```sh
npm install       # installs Electron (a dev dependency) the first time
npm run electron  # launches the desktop window (embeds the server)
npm run dist      # optional: build a macOS .dmg/.zip via electron-builder
```

The Electron main process embeds the same server in-process and points a
window at it, so the browser and desktop paths share all logic. (Don't run
`npm start` and `npm run electron` at once — they would fight over the port.)

### Tests

```sh
npm test          # node --test, no external test framework
```

## How it works

The server tails the local session logs each CLI already writes, so no
configuration changes to any CLI are required:

| Employee | Source |
| --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` (transcripts) |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/session-*.jsonl` |

Parsed observations (current tool call, user prompt, subagent spawns, MCP
tool calls, turn completion) are merged into a per-employee state and pushed
to the browser over Server-Sent Events (`/events`). The frontend is a single
Canvas 2D scene with procedurally drawn pixel avatars.

### Status rules

- **Working**: an event was observed within the last 90 seconds and the turn
  has not completed.
- **Break**: the turn completed (15-second grace period) or no recent events
  and no tool call is still in flight.
- **Blocked**: a tool call was issued but its result has not arrived (most
  notably a command awaiting the user's permission, or a long-running
  command). No idle timeout applies; the avatar stays seated at its desk.
- **Waiting**: the agent asked the user a question or requested approval
  (e.g. `AskUserQuestion`, plan approval, Codex approval requests). No idle
  timeout applies; the avatar stands in front of its desk with a 🖐️ bubble.
- Sessions with no events for 3 days expire from the office (their log
  files are no longer tailed).

### Visualization

- Speech bubble: 確認中 (inspecting) / 考え中 (thinking) / 作業中 (working)
  while at the desk, ・・・ while blocked (a tool call in flight, e.g. awaiting
  permission), ☕ on break, plus おはようございます on arrival and
  お疲れさまでした when walking out
- Desk nameplate: the repository (project) name, in the vendor's color
- Mini avatars beside the desk: running subagents (label = agent type);
  background subagent sessions get their own desk. Both wear a green-and-
  yellow beginner's mark (若葉マーク)
- App bar: the AI OFFICE brand, view tabs (オフィス / ボード) that switch
  between the office canvas and the in-place full board, the connection
  status pill, a 🌙/☀️ light/dark theme toggle (the choice is remembered in
  the browser and defaults to the OS scheme), an アバター退勤 button that
  triggers the HR cleanup and a ＋ タスク button that opens the task-filing
  form in the drawer
- Kanban strip: below the app bar, one column per assignee (user first,
  then residents in seat order) with a vendor-colored assignee chip
  matching the pixel avatars, a card count, a live 作業中 badge while a
  run is going, a preview of the first few cards (`ほか N 件` when more)
  and a per-column ＋ button that files a task with that assignee
  pre-selected
- Sidebar: a report inbox (tray icon + heading `インボックス`) with unread / 要確認
  counts in its header, listing whiteboard reports — click a report head to
  expand its body inline / mark it read, ✕ to archive. The server still
  keeps the newest 50 `#general` messages and a WebAudio chime fires when
  the boss (社長) is freshly mentioned, but the chat is no longer rendered

### HR cleanup

An HR avatar stands by the entrance (the EXIT door, bottom-left). Clicking it
finds sessions whose CLI process is no longer running. Each running process
grants one "seat" per (CLI, working directory) — checked via `ps` + `lsof` —
and only the most recently active sessions keep a seat; the rest are
considered exited. App/editor-owned sessions (ChatGPT app, VSCode extension)
run inside a host process from an unrelated directory and cannot be seat-
matched. A Codex Desktop conversation instead holds a per-thread writer lock
(`~/.codex/thread-writer-locks/<session-id>.lock`) open for its whole life, so
it is kept alive while that lock is held (idle between turns included) and only
becomes retirable once the lock is released; other app hosts, lacking such a
signal, become retirable once idle. Sessions currently shown as working are
never retired, resident-team sessions are permanent staff and never retire,
and ambiguous cases err on the side of alive. Retired avatars
walk out the
door; their log files are left untouched on disk and the clock-out is tracked
in the state store, which ignores replayed log lines up to the member's last
event so a retired session cannot resurrect from a rescan (genuinely newer
activity brings them back). The clock-out is persisted to
`~/Library/Application Support/ai-office/dismissed-sessions.json`, so it
survives a server restart. Endpoints:
`GET /api/cleanup/preview`, `POST /api/cleanup`.

## Resident team

Beyond the free-address grid, a six-desk island in the top-left seats the
resident team: permanently assigned agents, one role each. A resident is
configured declaratively under
`~/Library/Application Support/ai-office/residents/<name>/` —
`resident.json` (display name, seat, CLI, read-only/edit mode, working
directory, trigger, optional precheck, enabled), `INSTRUCTIONS.md` (the role
prompt), `state.json` (run bookkeeping) and `outbox/` (reports). The files
are the source of truth; clicking a resident desk opens an in-app drawer
with the same fields (create, edit, unassign, run now).

Triggers are `{type: "schedule", days, times}` (fixed weekday/time slots;
occurrences still fire up to one hour late, older ones are skipped) or
`{type: "interval", minutes, activeDays?, activeHours?}`. An optional
`precheck` shell command gates interval runs — empty stdout means "nothing
to do" and the agent run is skipped.

A due resident runs its CLI headlessly (`claude -p --session-id <uuid>`,
`codex exec --sandbox …`, `gemini -p`); the read-only / edit mode maps to
the CLI's permission flags. One run per resident at a time, with a
30-minute timeout. The CLI writes its normal transcript, so the existing
tail → watcher → state pipeline visualizes the run; a session registry
(`session-registry.json`) binds the session to its resident so it seats at
the resident island — never the free-address grid — is protected from HR
cleanup, and skips the `#general` request/reply exchange (the resident posts
its own report notification instead).

Resident seats render three states: unassigned (gray avatar facing the
viewer), assigned idle (vendor-colored, screen off, ⏸ when disabled) and
running (facing the monitor, lit screen, status bubble). Residents never go
to the break room or walk out.

A kanban board hands tasks to residents: one card per Markdown file under
`~/Library/Application Support/ai-office/board/` (columns are assignees —
the user or a resident; drag order lives in a `board-state.json` sidecar).
An idle resident whose trigger is not due picks up the top card of its
column — the precheck is skipped, the card is the trigger — and receives
the card body in its prompt. A run that ends ok archives the card into
`board/.archived/` (never deleted); a review-needed or failed run moves the
card to the user column, and a trigger-driven run that ends review-needed
files a user-column card automatically. Reports carry a `task:` frontmatter
line linking them to their card; cards cannot be moved or archived while
their run is in flight.

Run results are saved as frontmatter Markdown reports in the resident's
`outbox/`; the whiteboard on the top wall shows a badge counting unread
reports plus cards waiting in the user column (red when any needs the
human) and, when clicked, switches to the in-place board view (file cards,
drag to reorder or reassign, open a card in the drawer for its body, linked
reports, a follow-up note form and a done button); reports are listed in
the inbox sidebar (read state lives in a `whiteboard-state.json` sidecar).
Each report row has a ✕
button that takes it off the board — the
file is moved to the resident's `outbox/.archived/`, never deleted.
Endpoints: `GET /api/residents`, `PUT`/`DELETE /api/residents/:name`,
`POST /api/residents/:name/run`, `GET /api/whiteboard`,
`POST /api/whiteboard/read`, `POST /api/whiteboard/archive`,
`GET /api/board`, `POST /api/board/create`/`move`/`archive`/`note`.

## Architecture

The core (state + watchers + cleanup) is decoupled from any transport, so it
can be driven by the HTTP/SSE adapter, embedded in Electron, or exercised by
tests. Dependencies point inward: `index.js` → `core.js` → state/watchers/
cleanup; `http.js` only talks to the core's public handle.

For the full file-by-file breakdown, the data flow, and the testing approach,
see [docs/architecture.md](docs/architecture.md).

## Limitations

- Free-address sessions are visualize-only: the office does not control
  CLIs you start yourself (resident runs, spawned headlessly by the office,
  are the exception).
- Gemini log parsing is best-effort — the chat log format varies between
  Gemini CLI versions.
- Codex subagent detection is heuristic (`spawn_agent` style tool names).
- HR cleanup relies on macOS specifics (`lsof`).
