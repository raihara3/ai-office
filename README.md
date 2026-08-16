# AI Office

A Gather-like virtual office that visualizes your local AI coding agents —
Claude Code, Codex CLI and Gemini CLI — as pixel-art coworkers.

Each session (one log file) gets its own avatar and desk on a shared grid
that fills from the top-left as sessions appear. When an agent is actively
working, its avatar sits at
the desk and a speech bubble shows what it is doing right now (current tool
action or the user's request). When idle, the avatar walks to the break room
for a coffee. Subagent runs appear as mini avatars next to the desk, and MCP
tool calls appear as a plug badge with the server name.

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
- `🔌 server` badge: an MCP tool call within the last 60 seconds
- Sidebar: a Slack-like #general channel. User requests post as
  `@Claude (repo) <request>` from 社長 (with a 🫡 reaction once the agent
  starts), agents reply `@社長 作業が完了しました` / `確認をお願いします`,
  and a composer pinned to `@here 仕事がない人は退勤してください` triggers
  the HR cleanup (HR replies with the retiree count). The newest 50
  messages are kept, sorted by time, with dates on non-today entries

### HR cleanup

An HR avatar stands by the entrance (the EXIT door, bottom-left). Clicking it
finds sessions whose CLI process is no longer running. Each running process
grants one "seat" per (CLI, working directory) — checked via `ps` + `lsof` —
and only the most recently active sessions keep a seat; the rest are
considered exited. App/editor-owned sessions (ChatGPT app, VSCode extension)
run inside a host process from an unrelated directory and cannot be seat-
matched, so they are kept only while actively working and become retirable
once idle. Sessions currently shown as working are never retired, and
ambiguous cases err on the side of alive. Retired avatars walk out the
door and their log files are
moved to the macOS Trash (`~/.Trash`), not deleted. Endpoints:
`GET /api/cleanup/preview`, `POST /api/cleanup`.

## Architecture

The core (state + watchers + cleanup) is decoupled from any transport, so it
can be driven by the HTTP/SSE adapter, embedded in Electron, or exercised by
tests. Dependencies point inward: `index.js` → `core.js` → state/watchers/
cleanup; `http.js` only talks to the core's public handle.

```
server/
  index.js          wiring + startServer() (also the Electron embed contract)
  core.js           composes state + watchers + cleanup; lifecycle (start/stop)
  http.js           HTTP static + SSE + /api/* adapter over the core
  state.js          createState() store, deriveStatus() (pure), #general log
  tail.js           JSONL tailing (fs.watch + periodic rescan fallback)
  cleanup.js        createCleanup(): stale-session detection (ps + lsof)
  watchers/
    claude.js       Claude Code transcript parser (handleLine + startWatcher)
    codex.js        Codex rollout log parser
    gemini.js       Gemini chat log parser
public/
  office.js         Canvas rendering (room, desks, avatars, bubbles)
  office-client.js  transport client (SSE + cleanup API), swappable for IPC
  app.js            chat rendering, mention chime, side panel
electron/
  main.js           Electron main: embeds the server, opens the window
  preload.js        placeholder for a future IPC transport
test/
  *.test.js         node:test unit tests (state, cleanup, watchers)
```

## Limitations

- Read-only MVP: the office visualizes state; it does not control the CLIs.
- Gemini log parsing is best-effort — the chat log format varies between
  Gemini CLI versions.
- Codex subagent detection is heuristic (`spawn_agent` style tool names).
- HR cleanup relies on macOS specifics (`lsof`, `~/.Trash`).
