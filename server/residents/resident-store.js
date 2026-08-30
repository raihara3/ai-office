// Resident team configuration: one row per resident in the residents table
// of office.db, with instructions as a column (edited in-app) and run
// bookkeeping alongside. Teams are 1:N — every resident belongs to exactly
// one team, the seeded 'default' team until team management ships. The
// public API stays name-based: names identify active residents, ids carry
// the foreign keys underneath. Archiving sets archived_at — never a delete —
// so cards and reports keep resolving their author's name forever.

import { randomUUID } from 'node:crypto';
import { WEEKDAY_KEYS, parseTimeOfDay } from './scheduler.js';

export const RESIDENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const RESIDENT_CLIS = ['claude', 'codex', 'gemini'];
export const RESIDENT_MODES = ['read-only', 'edit'];
// Mirrors MAX_TEAM_SEATS in public/office/layout.js (3 columns × 4 rows);
// the effective per-team bound is the team's seat_count.
export const MIN_TEAM_SEATS = 1;
export const MAX_TEAM_SEATS = 12;
export const DEFAULT_TEAM_ID = 'default';

function isValidWeekdayList(days) {
  return Array.isArray(days) && days.length > 0 && days.every((d) => WEEKDAY_KEYS.includes(d));
}

function validateTrigger(trigger, errors) {
  if (trigger?.type === 'schedule') {
    if (!isValidWeekdayList(trigger.days)) errors.push('trigger.days must list weekdays (mon..sun)');
    if (
      !Array.isArray(trigger.times) ||
      trigger.times.length === 0 ||
      trigger.times.some((t) => parseTimeOfDay(t) === null)
    ) {
      errors.push('trigger.times must list HH:MM times');
    }
    return;
  }
  if (trigger?.type === 'interval') {
    if (!Number.isInteger(trigger.minutes) || trigger.minutes < 1) {
      errors.push('trigger.minutes must be a positive integer');
    }
    if (trigger.activeDays !== undefined && trigger.activeDays !== null && !isValidWeekdayList(trigger.activeDays)) {
      errors.push('trigger.activeDays must list weekdays (mon..sun)');
    }
    if (trigger.activeHours !== undefined && trigger.activeHours !== null) {
      if (
        parseTimeOfDay(trigger.activeHours.start) === null ||
        parseTimeOfDay(trigger.activeHours.end) === null
      ) {
        errors.push('trigger.activeHours must be {start: HH:MM, end: HH:MM}');
      }
    }
    return;
  }
  errors.push('trigger.type must be "schedule" or "interval"');
}

// Returns a list of human-readable problems; an empty list means valid.
export function validateResident(configuration) {
  const errors = [];
  if (typeof configuration?.displayName !== 'string' || configuration.displayName.trim() === '') {
    errors.push('displayName is required');
  }
  if (
    !Number.isInteger(configuration?.seat) ||
    configuration.seat < 0 ||
    configuration.seat >= MAX_TEAM_SEATS
  ) {
    errors.push(`seat must be an integer 0..${MAX_TEAM_SEATS - 1}`);
  }
  if (!RESIDENT_CLIS.includes(configuration?.cli)) {
    errors.push(`cli must be one of ${RESIDENT_CLIS.join(', ')}`);
  }
  if (!RESIDENT_MODES.includes(configuration?.mode)) {
    errors.push(`mode must be one of ${RESIDENT_MODES.join(', ')}`);
  }
  if (typeof configuration?.workingDirectory !== 'string' || configuration.workingDirectory.trim() === '') {
    errors.push('workingDirectory is required');
  }
  if (
    configuration?.precheck !== undefined &&
    configuration.precheck !== null &&
    typeof configuration.precheck !== 'string'
  ) {
    errors.push('precheck must be a shell command string or null');
  }
  if (typeof configuration?.enabled !== 'boolean') {
    errors.push('enabled must be a boolean');
  }
  validateTrigger(configuration?.trigger, errors);
  return errors;
}

export function createResidentStore({ database, now = () => Date.now() }) {
  const COLUMNS =
    'id, team_id, name, display_name, cli, mode, seat, working_directory, "trigger", precheck, enabled, last_run_at, last_outcome, last_finished_at';
  const statements = {
    read: database.prepare(
      `SELECT ${COLUMNS} FROM residents WHERE name = ? AND archived_at IS NULL`
    ),
    readWithInstructions: database.prepare(
      `SELECT ${COLUMNS}, instructions FROM residents WHERE name = ? AND archived_at IS NULL`
    ),
    // ORDER BY name matches the alphabetical directory order the file store
    // used to produce.
    list: database.prepare(
      `SELECT ${COLUMNS} FROM residents WHERE archived_at IS NULL ORDER BY name`
    ),
    listWithInstructions: database.prepare(
      `SELECT ${COLUMNS}, instructions FROM residents WHERE archived_at IS NULL ORDER BY name`
    ),
    seatHolder: database.prepare(
      'SELECT name FROM residents WHERE team_id = ? AND seat = ? AND archived_at IS NULL AND name <> ?'
    ),
    readTeam: database.prepare(
      'SELECT id, name, seat_count FROM teams WHERE id = ? AND archived_at IS NULL'
    ),
    // rowid = insertion order: stable "creation order" even when tests inject
    // clocks older than the migration's own timestamps.
    oldestTeam: database.prepare(
      'SELECT id FROM teams WHERE archived_at IS NULL ORDER BY rowid LIMIT 1'
    ),
    teamNameHolder: database.prepare(
      'SELECT id FROM teams WHERE name = ? AND archived_at IS NULL AND id <> ?'
    ),
    insertTeam: database.prepare(
      'INSERT INTO teams (id, name, seat_count, created_at) VALUES (?, ?, ?, ?)'
    ),
    updateTeam: database.prepare(
      'UPDATE teams SET name = ?, seat_count = ? WHERE id = ? AND archived_at IS NULL'
    ),
    archiveTeam: database.prepare(
      'UPDATE teams SET archived_at = ? WHERE id = ? AND archived_at IS NULL'
    ),
    teamResidentCount: database.prepare(
      'SELECT COUNT(*) AS n FROM residents WHERE team_id = ? AND archived_at IS NULL'
    ),
    teamSeatOverflow: database.prepare(
      'SELECT name FROM residents WHERE team_id = ? AND seat >= ? AND archived_at IS NULL ORDER BY seat'
    ),
    activeTeamCount: database.prepare(
      'SELECT COUNT(*) AS n FROM teams WHERE archived_at IS NULL'
    ),
    insert: database.prepare(
      `INSERT INTO residents (id, team_id, name, display_name, cli, mode, seat, working_directory, "trigger", precheck, enabled, instructions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    // Editing preserves id, created_at and the run-state columns; the team
    // follows the desk the drawer was opened from.
    update: database.prepare(
      `UPDATE residents SET team_id = ?, display_name = ?, cli = ?, mode = ?, seat = ?, working_directory = ?,
        "trigger" = ?, precheck = ?, enabled = ?, instructions = ?, updated_at = ?
       WHERE name = ? AND archived_at IS NULL`
    ),
    saveState: database.prepare(
      `UPDATE residents SET last_run_at = ?, last_outcome = ?, last_finished_at = ?
       WHERE name = ? AND archived_at IS NULL`
    ),
    archive: database.prepare(
      'UPDATE residents SET archived_at = ? WHERE name = ? AND archived_at IS NULL'
    ),
    listTeams: database.prepare(
      'SELECT id, name, seat_count FROM teams WHERE archived_at IS NULL ORDER BY rowid'
    ),
  };

  function assertName(name) {
    if (!RESIDENT_NAME_PATTERN.test(name)) throw new Error(`invalid resident name: ${name}`);
    // 'user' is the kanban sentinel for the human's column; a resident with
    // that name would resolve to the human's inbox and run its cards.
    if (name === 'user') throw new Error('"user" is reserved for the human');
  }

  function entryFromRow(row) {
    return {
      id: row.id,
      teamId: row.team_id,
      name: row.name,
      configuration: {
        displayName: row.display_name,
        seat: row.seat,
        cli: row.cli,
        mode: row.mode,
        workingDirectory: row.working_directory,
        trigger: JSON.parse(row.trigger),
        precheck: row.precheck,
        enabled: row.enabled === 1,
      },
      instructions: row.instructions ?? '',
      state: {
        lastRunAt: row.last_run_at,
        lastOutcome: row.last_outcome,
        lastFinishedAt: row.last_finished_at,
      },
    };
  }

  // `withInstructions: false` skips the instructions column — the snapshot
  // path only needs the profile and runs on every broadcast.
  function read(name, { withInstructions = true } = {}) {
    assertName(name);
    const row = (withInstructions ? statements.readWithInstructions : statements.read).get(name);
    return row === undefined ? null : entryFromRow(row);
  }

  function list({ withInstructions = true } = {}) {
    const rows = (withInstructions ? statements.listWithInstructions : statements.list).all();
    return rows.map(entryFromRow);
  }

  function save(name, { configuration, instructions, teamId }) {
    assertName(name);
    const errors = validateResident(configuration);
    if (errors.length > 0) throw new Error(errors.join('; '));
    // The team follows the desk the drawer was opened from; an edit without
    // an explicit team keeps the current one, a brand-new resident defaults
    // to the oldest team.
    const existing = statements.read.get(name);
    const targetTeamId = teamId ?? existing?.team_id ?? statements.oldestTeam.get()?.id;
    const team = targetTeamId === undefined ? undefined : statements.readTeam.get(targetTeamId);
    if (team === undefined) throw new Error(`unknown team: ${targetTeamId}`);
    if (configuration.seat >= team.seat_count) {
      throw new Error(`seat must be an integer 0..${team.seat_count - 1}`);
    }
    // The canvas draws one resident per desk, so a seat can only hold one
    // active resident per team; the drawer surfaces this message on a 400.
    const holder = statements.seatHolder.get(team.id, configuration.seat, name);
    if (holder !== undefined) {
      throw new Error(`seat ${configuration.seat} is already taken by ${holder.name}`);
    }
    const values = [
      configuration.displayName,
      configuration.cli,
      configuration.mode,
      configuration.seat,
      configuration.workingDirectory,
      JSON.stringify(configuration.trigger),
      configuration.precheck ?? null,
      configuration.enabled ? 1 : 0,
      instructions ?? '',
    ];
    if (existing !== undefined) {
      statements.update.run(team.id, ...values, now(), name);
    } else {
      statements.insert.run(randomUUID(), team.id, name, ...values, now(), now());
    }
  }

  function saveTeam({ id = null, name, seatCount } = {}) {
    let existing;
    if (id !== null) {
      existing = statements.readTeam.get(id);
      if (existing === undefined) throw new Error(`unknown team: ${id}`);
    }
    const mergedName = name !== undefined ? name : existing?.name;
    const cleanName = typeof mergedName === 'string' ? mergedName.trim() : '';
    if (cleanName === '') throw new Error('team name is required');
    const mergedSeatCount = seatCount !== undefined ? seatCount : existing?.seat_count;
    if (
      !Number.isInteger(mergedSeatCount) ||
      mergedSeatCount < MIN_TEAM_SEATS ||
      mergedSeatCount > MAX_TEAM_SEATS
    ) {
      throw new Error(`seatCount must be an integer ${MIN_TEAM_SEATS}..${MAX_TEAM_SEATS}`);
    }
    if (statements.teamNameHolder.get(cleanName, existing?.id ?? '') !== undefined) {
      throw new Error(`team name "${cleanName}" is already in use`);
    }
    if (existing !== undefined) {
      // Shrinking must not strand a resident on a desk that stops existing.
      const overflow = statements.teamSeatOverflow.all(existing.id, mergedSeatCount);
      if (overflow.length > 0) {
        throw new Error(
          `cannot shrink to ${mergedSeatCount} seats: ${overflow.map((row) => row.name).join(', ')} sit(s) beyond seat ${mergedSeatCount - 1}`
        );
      }
      statements.updateTeam.run(cleanName, mergedSeatCount, existing.id);
      return existing.id;
    }
    const newId = randomUUID();
    statements.insertTeam.run(newId, cleanName, mergedSeatCount, now());
    return newId;
  }

  function deleteTeam(id) {
    const team = statements.readTeam.get(id);
    if (team === undefined) throw new Error(`unknown team: ${id}`);
    const residentCount = statements.teamResidentCount.get(id).n;
    if (residentCount > 0) {
      throw new Error(`team "${team.name}" still has ${residentCount} resident(s); unassign them first`);
    }
    if (statements.activeTeamCount.get().n === 1) throw new Error('cannot delete the last team');
    statements.archiveTeam.run(now(), id);
  }

  function saveState(name, state) {
    assertName(name);
    statements.saveState.run(
      state?.lastRunAt ?? null,
      state?.lastOutcome ?? null,
      state?.lastFinishedAt ?? null,
      name
    );
  }

  // Unassigning archives the row rather than deleting it; the seat simply
  // frees up, and cards/reports keep resolving the name for display.
  function remove(name) {
    assertName(name);
    if (statements.archive.run(now(), name).changes === 0) {
      throw new Error(`unknown resident: ${name}`);
    }
  }

  function listTeams() {
    return statements.listTeams
      .all()
      .map((row) => ({ id: row.id, name: row.name, seatCount: row.seat_count }));
  }

  return { list, read, save, saveState, remove, listTeams, saveTeam, deleteTeam };
}
