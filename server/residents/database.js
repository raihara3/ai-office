// The SQLite database behind the whiteboard and board stores: one file at
// <dataDirectory>/office.db, opened synchronously at boot. Schema versions are
// tracked with PRAGMA user_version; each MIGRATIONS entry moves the schema up
// one version inside its own transaction. A database written by a newer app
// version is refused rather than guessed at. Statements are prepared by the
// stores themselves — this module only owns opening and migrating.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
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
  for (let next = version; next < MIGRATIONS.length; next += 1) {
    database.exec('BEGIN');
    try {
      database.exec(MIGRATIONS[next]);
      database.exec(`PRAGMA user_version = ${next + 1}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      database.close();
      throw error;
    }
  }
  return database;
}
