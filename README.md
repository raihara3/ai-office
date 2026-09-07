# AI Office

[日本語版 README](README.ja.md)

![AI Office — your AIs become coworkers](docs/images/banner.png)

A Gather-like virtual office for your local AI coding agents. Claude Code,
Codex CLI and Gemini CLI sessions appear as miniature robot coworkers — and a
resident team of scheduled agents works a kanban board and reports back to
your inbox.

![runtime](https://img.shields.io/badge/runtime-Node.js%20%E2%89%A522.5-brightgreen)
![platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![license](https://img.shields.io/badge/license-MIT-blue)

![The office view: robots at team desks, a kanban strip and the report inbox](docs/images/office-view.png)

## What it does

- **Visualizes your sessions, zero config.** The server tails the transcript
  files each CLI already writes. Start Claude Code (or Codex / Gemini) in any
  terminal and a visitor robot steps out of the elevator into the lobby, with
  a speech bubble showing what it is doing right now. Subagents appear as mini
  avatars; when the turn ends, the robot rides the elevator home.
- **Runs a resident AI team.** Residents are permanently seated agents you
  configure in-app: each one has a CLI, a working directory, instructions and
  either a kanban column it works through or a weekly/interval schedule. Runs
  happen headlessly; the final message lands as a report in your inbox, and
  anything that needs your judgment is flagged for review.
- **Keeps you in the loop with a kanban board and an inbox.** You file task
  cards, residents pick them up, finished cards move to Done, and reports
  link back to their cards. Everything is stored locally in a single SQLite
  file.

## Requirements

- **macOS** (transcript discovery, process cleanup and the data directory are
  macOS-specific)
- **Node.js ≥ 22.5** (`node:sqlite`; the npm scripts pass
  `--experimental-sqlite`, required below 23.4)
- At least one of [Claude Code](https://docs.anthropic.com/en/docs/claude-code),
  [Codex CLI](https://github.com/openai/codex) or
  [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed — for
  the resident team, the CLI must be logged in and on your `PATH`

## Quick start

```sh
git clone https://github.com/raihara3/ai-office.git
cd ai-office
npm start
# open http://localhost:4680  (set PORT to change)
```

Then use an agent as you normally would — run Claude Code in any repository
and watch its avatar arrive in the lobby. No CLI configuration is needed;
sessions are discovered from:

| CLI | Transcripts |
| --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/session-*.jsonl` |

### Desktop app

```sh
npm install       # installs Electron (dev dependency) the first time
npm run electron  # desktop window embedding the same server
npm run dist      # build an unsigned macOS .dmg/.zip via electron-builder
```

The desktop app and `npm start` share one data directory and never double-run
work: a second instance attaches to the running server instead of starting
its own. Builds are unsigned — when opening a downloaded build for the first
time, right-click the app and choose "Open" to pass Gatekeeper.

### Tests

```sh
npm test          # node --test, ~150 tests, no build step
```

## Setting up your resident team

Visitors only mirror what you do in a terminal. Residents work on their own.

1. Press **Team** in the app bar to create a team (a room on the canvas), or
   use the default one.
2. Click an **empty desk** in a team room. The resident form opens:

![The resident form with the edit-mode permission warning shown](docs/images/resident-form.png)

3. Pick the CLI, a working directory, and a **role**:
   - **Kanban** — whenever idle, the resident runs the top card of its board
     column. File a card, and it gets picked up within ~30 seconds.
   - **Scheduled** — the resident ignores the board and runs its
     instructions on a trigger: fixed weekday/time slots, or every N minutes
     inside an optional active window. An optional **precheck command** gates
     each scheduled run: empty output means "nothing to do" and the run is
     skipped.
4. Write the **instructions** — the resident's standing role prompt.

The model field accepts a suggestion or any full model ID; empty keeps the
CLI's default.

### Permissions

- **Read-only** (default) restricts the run to inspection: Claude runs with a
  read-only tool allowlist, Codex with `--sandbox read-only`, Gemini pinned to
  plan mode. Note that Gemini runs skip the folder-trust prompt, which
  re-enables workspace settings such as configured MCP servers — point Gemini
  residents only at directories whose contents you trust.
- **Edit** lets the resident change files and run commands **without approval
  prompts** (headless runs cannot answer them — Claude uses
  `--permission-mode bypassPermissions`, Codex `--sandbox workspace-write`).
  Except for the Codex sandbox, the run is **not confined to its working
  directory**, so enable edit mode only for instructions and directories you
  trust; the form shows this warning whenever you select it.

### Reports and the board

A run's final message is posted to the inbox. A first line of
`LEVEL: review-needed` flags it for you — the linked card moves to your
column, and a scheduled run files a follow-up card automatically.

![A review-needed report opened from the inbox](docs/images/report-dialog.png)

An ok run moves its card to **Done** (cards and reports are archived only by
you — completion never deletes anything). Follow-up notes you add to a card,
and the card's past reports, are replayed into the next run's prompt, so
rework keeps its history. Runs have a 30-minute timeout, one per resident at
a time; an emergency-stop button lives in the resident's activity view.

## Language

The UI, server messages and resident prompts are in **English by default**;
switch to **日本語** in Settings. Reports are written in the language active
when they were generated.

![The same office in Japanese](docs/images/office-view-ja.png)

## Data & privacy

Everything stays on your machine. The server binds to `127.0.0.1` only (with
Host/Origin checks), and all resident-team state — configuration,
instructions, cards, reports — lives in
`~/Library/Application Support/ai-office/office.db`. Nothing is sent
anywhere except the CLI runs you configure yourself.

## How it works

Watchers parse each CLI's transcripts into observations (current tool call,
prompt, subagent spawns, turn completion), merged into per-session state and
pushed to the browser over Server-Sent Events. The frontend is a single
high-DPI Canvas 2D scene; panels are plain DOM. The core is
transport-agnostic: `index.js` → `core.js` → state/watchers/residents, with
`http.js` as the only transport and Electron embedding the same server.

- [docs/architecture.md](docs/architecture.md) — file-by-file breakdown and
  data flow
- [docs/database.md](docs/database.md) — office.db schema (ER diagram,
  conventions)

### Status rules

- **Working** — an event was observed in the last 90 seconds and the turn is
  not complete.
- **Blocked** — a tool call is in flight with no result yet (typically a
  command awaiting permission); the bubble shows ・・・.
- **Waiting** — the agent asked a question or requested approval; the avatar
  raises 🖐️ and a chime rings.
- **Break** — the turn completed or went quiet; the visitor rides the
  elevator out and returns on the next prompt.
- Sessions silent for 3 days expire from the office. A receptionist-driven
  cleanup can also clock out sessions whose CLI process is gone
  (`ps`/`lsof` based).

## Limitations

- macOS only.
- Visitor sessions are visualize-only: the office never controls CLIs you
  started yourself (resident runs, spawned by the office, are the exception).
- Gemini log parsing is best-effort — the format varies between CLI versions.
- Codex subagent detection is heuristic.

## License

[MIT](LICENSE) © raihara3
