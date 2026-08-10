# AI Office

A Gather-like virtual office that visualizes your local AI coding agents —
Claude Code, Codex CLI and Gemini CLI — as pixel-art coworkers.

Each session (one log file) gets its own avatar and desk, grouped into
per-vendor islands that grow as sessions appear. When an agent is actively
working, its avatar sits at
the desk and a speech bubble shows what it is doing right now (current tool
action or the user's request). When idle, the avatar walks to the break room
for a coffee. Subagent runs appear as mini avatars next to the desk, and MCP
tool calls appear as a plug badge with the server name.

![status](https://img.shields.io/badge/runtime-Node.js%20%E2%89%A520-brightgreen)

## Usage

```sh
npm start
# open http://localhost:4680
```

No dependencies — Node.js standard library only. Set `PORT` to change the
listen port.

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
- **Break**: the turn completed (15-second grace period) or no recent events.
- Sessions with no events for 24 hours expire from the office (their log
  files are no longer tailed).

### Visualization

- Speech bubble: current tool action, falling back to the user's request
- Desk nameplate: the repository (project) name, with `#n` suffixes when
  several sessions share the same repository
- Mini avatars beside the desk: running subagents (label = agent type)
- `🔌 server` badge: an MCP tool call within the last 60 seconds
- Side panel: project, request, activity, subagents, MCP calls, last activity

### HR cleanup

An HR avatar stands by the entrance (the EXIT door, bottom-left). Clicking it
finds sessions whose CLI process is no longer running — a session counts as
alive when a process of the same CLI runs with the session's working
directory (checked via `ps` + `lsof`); sessions currently shown as working
are never retired, and ambiguous cases err on the side of alive. After a
browser confirm, retired avatars walk out the door and their log files are
moved to the macOS Trash (`~/.Trash`), not deleted. Endpoints:
`GET /api/cleanup/preview`, `POST /api/cleanup`.

## Architecture

```
server/
  index.js          HTTP static server + SSE endpoint (/events, /api/state)
  state.js          employee state store + status derivation + broadcast
  tail.js           JSONL tailing (fs.watch + periodic rescan fallback)
  cleanup.js        stale-session detection (ps + lsof) + move logs to Trash
  watchers/
    claude.js       Claude Code transcript parser
    codex.js        Codex rollout log parser
    gemini.js       Gemini chat log parser
public/
  office.js         Canvas rendering (room, desks, avatars, bubbles)
  app.js            SSE client + side panel
```

## Limitations

- Read-only MVP: the office visualizes state; it does not control the CLIs.
- Gemini log parsing is best-effort — the chat log format varies between
  Gemini CLI versions.
- Codex subagent detection is heuristic (`spawn_agent` style tool names).
- HR cleanup relies on macOS specifics (`lsof`, `~/.Trash`).
