// The SQLite database behind the whiteboard and board stores: one file at
// <dataDirectory>/office.db, opened synchronously at boot. Schema versions are
// tracked with PRAGMA user_version; each MIGRATIONS entry moves the schema up
// one version inside its own transaction. A database written by a newer app
// version is refused rather than guessed at. Statements are prepared by the
// stores themselves — this module only owns opening and migrating.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Exported so the migration test can build an old-version fixture and walk
// it forward through openDatabase.
export const MIGRATIONS = [
  // Version 1: meta (import marker and future flags), reports, cards.
  // Archiving sets archived_at instead of deleting, so a mis-click never
  // loses data and archived rows stay queryable; the partial indexes cover
  // the active-row listings.
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE reports (
    id          TEXT PRIMARY KEY,
    resident    TEXT NOT NULL,
    title       TEXT NOT NULL,
    level       TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'review-needed')),
    task        TEXT,
    body        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    "read"      INTEGER NOT NULL DEFAULT 0 CHECK ("read" IN (0, 1)),
    favorite    INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    archived_at INTEGER
  );
  CREATE INDEX reports_active ON reports (created_at DESC) WHERE archived_at IS NULL;

  CREATE TABLE cards (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    assignee    TEXT NOT NULL,
    origin      TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE INDEX cards_column ON cards (assignee, position) WHERE archived_at IS NULL;
  `,
  // Version 2: residents move from per-resident files into the database,
  // teams arrive (1:N teams→residents), and session bindings replace the
  // whole-file-rewritten session-registry.json. cards/reports are rebuilt so
  // assignee/origin/resident name strings become foreign-keyed resident ids
  // (NULL = the human user). Existing name values are copied verbatim into
  // the id columns: the resident importer that runs right after migration
  // inserts imported residents with id = legacy name, which makes those
  // values resolve. "trigger" is an SQL keyword — quoted like "read".
  `
  CREATE TABLE teams (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE UNIQUE INDEX teams_active_name ON teams (name) WHERE archived_at IS NULL;
  INSERT INTO teams (id, name, created_at)
    VALUES ('default', 'office', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

  CREATE TABLE residents (
    id                TEXT PRIMARY KEY,
    team_id           TEXT NOT NULL REFERENCES teams(id),
    name              TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    cli               TEXT NOT NULL CHECK (cli IN ('claude', 'codex', 'gemini')),
    mode              TEXT NOT NULL CHECK (mode IN ('read-only', 'edit')),
    seat              INTEGER NOT NULL,
    working_directory TEXT NOT NULL,
    "trigger"         TEXT NOT NULL,
    precheck          TEXT,
    enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    instructions      TEXT NOT NULL DEFAULT '',
    last_run_at       INTEGER,
    last_outcome      TEXT,
    last_finished_at  INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    archived_at       INTEGER
  );
  CREATE UNIQUE INDEX residents_active_name ON residents (name) WHERE archived_at IS NULL;
  CREATE INDEX residents_active_team ON residents (team_id) WHERE archived_at IS NULL;

  CREATE TABLE session_bindings (
    fragment    TEXT PRIMARY KEY,
    resident_id TEXT NOT NULL REFERENCES residents(id),
    at          INTEGER NOT NULL
  );
  CREATE INDEX session_bindings_at ON session_bindings (at DESC);

  CREATE TABLE cards_v2 (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    assignee_id TEXT REFERENCES residents(id),
    origin_id   TEXT REFERENCES residents(id),
    body        TEXT NOT NULL DEFAULT '',
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    archived_at INTEGER
  );
  INSERT INTO cards_v2 (id, title, assignee_id, origin_id, body, position, created_at, updated_at, archived_at)
    SELECT id, title,
           CASE WHEN assignee = 'user' THEN NULL ELSE assignee END,
           CASE WHEN origin = 'user' THEN NULL ELSE origin END,
           body, position, created_at, updated_at, archived_at
    FROM cards;
  DROP TABLE cards;
  ALTER TABLE cards_v2 RENAME TO cards;
  CREATE INDEX cards_column ON cards (assignee_id, position) WHERE archived_at IS NULL;

  CREATE TABLE reports_v2 (
    id          TEXT PRIMARY KEY,
    resident_id TEXT NOT NULL REFERENCES residents(id),
    title       TEXT NOT NULL,
    level       TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'review-needed')),
    task        TEXT,
    body        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    "read"      INTEGER NOT NULL DEFAULT 0 CHECK ("read" IN (0, 1)),
    favorite    INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    archived_at INTEGER
  );
  INSERT INTO reports_v2 (id, resident_id, title, level, task, body, created_at, "read", favorite, archived_at)
    SELECT id, resident, title, level, task, body, created_at, "read", favorite, archived_at
    FROM reports;
  DROP TABLE reports;
  ALTER TABLE reports_v2 RENAME TO reports;
  CREATE INDEX reports_active ON reports (created_at DESC) WHERE archived_at IS NULL;
  `,
  // Version 3: teams become user-managed — a per-team seat count arrives, and
  // the seeded default team takes over the label the canvas used to hardcode.
  // The rename only fires while the name is still the seeded 'office', so a
  // team the user has renamed stays untouched.
  `
  ALTER TABLE teams ADD COLUMN seat_count INTEGER NOT NULL DEFAULT 6
    CHECK (seat_count BETWEEN 1 AND 12);
  UPDATE teams SET name = '常駐チーム' WHERE id = 'default' AND name = 'office';
  `,
  // Version 4: cards gain a done state. A finished ok run now moves its card
  // into the board's 完了 column (done_at set) instead of archiving it, so the
  // human sees what was completed and archives it explicitly. done_at is
  // independent of assignee_id: a done card keeps naming its resident, and the
  // per-column ordering/top-card lookup skips done cards.
  `
  ALTER TABLE cards ADD COLUMN done_at INTEGER;
  `,
  // Version 5: user-editable office settings. A key-value table for the
  // handful of preferences the human sets in-app (currently just the office
  // name shown on the entrance sign). Kept separate from `meta`, which holds
  // internal import markers rather than user data.
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function openDatabase({ location }) {
  if (location !== ':memory:') {
    fs.mkdirSync(path.dirname(location), { recursive: true });
  }
  const database = new DatabaseSync(location);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA synchronous = NORMAL');
  const version = database.prepare('PRAGMA user_version').get().user_version;
  if (version > MIGRATIONS.length) {
    database.close();
    throw new Error(
      `${location} is at schema version ${version}, newer than this app understands (${MIGRATIONS.length})`
    );
  }
  // node:sqlite enables foreign keys by default. The v2 rebuild copies name
  // strings into not-yet-resolvable id columns (the resident importer fills
  // the parent rows right after), so enforcement pauses for the migrations
  // only. The pragma is a no-op inside a transaction, hence outside the loop.
  database.exec('PRAGMA foreign_keys = OFF');
  for (let next = version; next < MIGRATIONS.length; next += 1) {
    database.exec('BEGIN');
    try {
      database.exec(MIGRATIONS[next]);
      database.exec(`PRAGMA user_version = ${next + 1}`);
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Keep the original error — a failing ROLLBACK must not mask it.
      }
      database.close();
      throw error;
    }
  }
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}
