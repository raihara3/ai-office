// One-time import of the file-based resident configuration into office.db.
// Before schema v2, each resident lived in residents/<name>/ as
// resident.json + INSTRUCTIONS.md + state.json, and session bindings in
// session-registry.json. This reads all of that, inserts it in a single
// transaction together with a marker row in meta, and only after the commit
// deletes the imported source files. Imported residents keep their slug name
// as the row id, which is what makes the verbatim name values the v2
// migration copied into cards/reports id columns resolve as foreign keys.
// Names referenced by cards/reports but absent from disk get an archived
// "ghost" row for the same reason.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TEAM_ID, RESIDENT_NAME_PATTERN, validateResident } from './resident-store.js';

const IMPORT_MARKER_KEY = 'residentsImportedAt';

// A placeholder for a resident name that appears in data but has no
// configuration anywhere: archived from birth, disabled, minimal valid
// fields. Its id equals the name so dangling name references become valid
// foreign keys while the display name survives.
function insertGhost(database, name, at) {
  database
    .prepare(
      `INSERT INTO residents (id, team_id, name, display_name, cli, mode, seat, working_directory, "trigger", enabled, instructions, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, 'claude', 'read-only', 0, '~', '{"type":"interval","minutes":60}', 0, '', ?, ?, ?)`
    )
    .run(name, DEFAULT_TEAM_ID, name, name, at, at, at);
}

// The id of the resident (active preferred, else archived) with this name,
// creating an archived ghost when none exists. Callers run this inside their
// own transaction.
export function ensureResidentId(database, name, now = () => Date.now()) {
  const row = database
    .prepare(
      'SELECT id FROM residents WHERE name = ? ORDER BY (archived_at IS NULL) DESC LIMIT 1'
    )
    .get(name);
  if (row !== undefined) return row.id;
  insertGhost(database, name, now());
  return name;
}

function readJson(fileSystem, filePath) {
  try {
    return JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function collectDiskResidents({ dataDirectory, fileSystem }) {
  const residentsDirectory = path.join(dataDirectory, 'residents');
  let names;
  try {
    names = fileSystem
      .readdirSync(residentsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RESIDENT_NAME_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const residents = [];
  for (const name of names) {
    const directory = path.join(residentsDirectory, name);
    const configuration = readJson(fileSystem, path.join(directory, 'resident.json'));
    if (configuration === null || validateResident(configuration).length > 0) {
      // Never delete what was not imported — skip and leave the files be.
      console.warn(`resident import: skipping ${name} (missing or invalid resident.json)`);
      continue;
    }
    let instructions = '';
    try {
      instructions = fileSystem.readFileSync(path.join(directory, 'INSTRUCTIONS.md'), 'utf8');
    } catch {
      // A resident without instructions imports with an empty prompt.
    }
    const state = readJson(fileSystem, path.join(directory, 'state.json')) ?? {};
    residents.push({ name, directory, configuration, instructions, state });
  }
  return residents;
}

export function importResidents(database, { dataDirectory, fileSystem = fs, now = () => Date.now() }) {
  const marker = database.prepare('SELECT value FROM meta WHERE key = ?').get(IMPORT_MARKER_KEY);
  if (marker !== undefined) return { residents: 0, ghosts: 0, bindings: 0 };

  const diskResidents = collectDiskResidents({ dataDirectory, fileSystem });
  const registry = readJson(fileSystem, path.join(dataDirectory, 'session-registry.json'));
  const diskNames = new Set(diskResidents.map((resident) => resident.name));
  const bindings = (Array.isArray(registry?.bindings) ? registry.bindings : []).filter(
    // Bindings for residents that no longer exist only matter for ~3 days of
    // transcript tailing; dropping them beats resurrecting their owner.
    (binding) => typeof binding?.fragment === 'string' && diskNames.has(binding.resident)
  );

  const insertResident = database.prepare(
    `INSERT OR IGNORE INTO residents (id, team_id, name, display_name, cli, mode, seat, working_directory, "trigger", precheck, enabled, instructions, last_run_at, last_outcome, last_finished_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertBinding = database.prepare(
    'INSERT OR IGNORE INTO session_bindings (fragment, resident_id, at) VALUES (?, ?, ?)'
  );

  let ghostCount = 0;
  database.exec('BEGIN');
  try {
    const importedAt = now();
    for (const { name, configuration, instructions, state } of diskResidents) {
      insertResident.run(
        name, // id = legacy slug name; see the module comment
        DEFAULT_TEAM_ID,
        name,
        configuration.displayName,
        configuration.cli,
        configuration.mode,
        configuration.seat,
        configuration.workingDirectory,
        JSON.stringify(configuration.trigger),
        configuration.precheck ?? null,
        configuration.enabled ? 1 : 0,
        instructions,
        state.lastRunAt ?? null,
        state.lastOutcome ?? null,
        state.lastFinishedAt ?? null,
        importedAt,
        importedAt
      );
    }
    // Any id value in cards/reports that still resolves to no resident is a
    // dangling name from the v2 rebuild — give it a ghost so the foreign
    // keys hold and the name keeps displaying.
    const danglingNames = database
      .prepare(
        `SELECT DISTINCT value FROM (
           SELECT assignee_id AS value FROM cards WHERE assignee_id IS NOT NULL
           UNION SELECT origin_id FROM cards WHERE origin_id IS NOT NULL
           UNION SELECT resident_id FROM reports
         ) WHERE value NOT IN (SELECT id FROM residents)`
      )
      .all()
      .map((row) => row.value);
    for (const name of danglingNames) {
      insertGhost(database, name, importedAt);
      ghostCount += 1;
    }
    for (const binding of bindings) {
      insertBinding.run(binding.fragment, binding.resident, Number(binding.at) || importedAt);
    }
    database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      IMPORT_MARKER_KEY,
      String(importedAt)
    );
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Keep the original error — a failing ROLLBACK must not mask it.
    }
    throw error;
  }

  // Only after the commit do the source files go away, and only for the
  // residents that were actually imported.
  for (const { name, directory } of diskResidents) {
    for (const fileName of ['resident.json', 'INSTRUCTIONS.md', 'state.json']) {
      try {
        fileSystem.unlinkSync(path.join(directory, fileName));
      } catch {
        // Missing or busy — the marker prevents re-import either way.
      }
    }
    try {
      fileSystem.rmdirSync(directory);
    } catch {
      console.warn(`resident import: ${name} directory not empty, left in place`);
    }
  }
  try {
    fileSystem.unlinkSync(path.join(dataDirectory, 'session-registry.json'));
  } catch {
    // Absent on fresh installs.
  }
  try {
    fileSystem.rmdirSync(path.join(dataDirectory, 'residents'));
  } catch {
    // Still holds skipped residents or .removed/ archives — leave it be.
  }
  return { residents: diskResidents.length, ghosts: ghostCount, bindings: bindings.length };
}
