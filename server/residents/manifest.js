// Resident team configuration: one directory per resident under
// <dataDirectory>/residents/<name>/ holding resident.json (profile + trigger),
// INSTRUCTIONS.md (the resident's role prompt) and state.json (run bookkeeping).
// The files are the source of truth — the in-app panel and a text editor both
// end up here — so every read goes back to disk instead of caching.
//
// `createManifestStore` takes the filesystem as an injectable dependency so
// the load/save/remove logic can be unit-tested against an in-memory stub.

import fs from 'node:fs';
import path from 'node:path';
import { WEEKDAY_KEYS, parseTimeOfDay } from './scheduler.js';

export const RESIDENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const RESIDENT_CLIS = ['claude', 'codex', 'gemini'];
export const RESIDENT_MODES = ['read-only', 'edit'];
// Mirrors RESIDENT_DESK_COUNT in public/office/layout.js.
export const RESIDENT_SEAT_COUNT = 6;

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
    configuration.seat >= RESIDENT_SEAT_COUNT
  ) {
    errors.push(`seat must be an integer 0..${RESIDENT_SEAT_COUNT - 1}`);
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

export function createManifestStore({ dataDirectory, fileSystem = fs, now = () => Date.now() }) {
  const residentsDirectory = path.join(dataDirectory, 'residents');

  function directoryFor(name) {
    if (!RESIDENT_NAME_PATTERN.test(name)) throw new Error(`invalid resident name: ${name}`);
    return path.join(residentsDirectory, name);
  }

  function readJson(filePath) {
    try {
      return JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  // `withInstructions: false` skips reading INSTRUCTIONS.md — the snapshot
  // path only needs the profile and runs on every broadcast.
  function read(name, { withInstructions = true } = {}) {
    const directory = directoryFor(name);
    const configuration = readJson(path.join(directory, 'resident.json'));
    if (configuration === null) return null;
    let instructions = '';
    if (withInstructions) {
      try {
        instructions = fileSystem.readFileSync(path.join(directory, 'INSTRUCTIONS.md'), 'utf8');
      } catch {
        // A resident without instructions is still listed; the panel warns.
      }
    }
    const state = readJson(path.join(directory, 'state.json')) ?? {};
    return { name, configuration, instructions, state };
  }

  function list(options) {
    let entryNames;
    try {
      entryNames = fileSystem
        .readdirSync(residentsDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && RESIDENT_NAME_PATTERN.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    return entryNames
      .map((name) => read(name, options))
      .filter((entry) => entry !== null && validateResident(entry.configuration).length === 0);
  }

  function save(name, { configuration, instructions }) {
    const errors = validateResident(configuration);
    if (errors.length > 0) throw new Error(errors.join('; '));
    const directory = directoryFor(name);
    fileSystem.mkdirSync(path.join(directory, 'outbox'), { recursive: true });
    fileSystem.writeFileSync(
      path.join(directory, 'resident.json'),
      `${JSON.stringify(configuration, null, 2)}\n`
    );
    fileSystem.writeFileSync(path.join(directory, 'INSTRUCTIONS.md'), instructions ?? '');
  }

  function saveState(name, state) {
    const directory = directoryFor(name);
    fileSystem.mkdirSync(directory, { recursive: true });
    fileSystem.writeFileSync(path.join(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  }

  // Unassigning keeps the directory (reports included) under .removed/ rather
  // than deleting anything; the seat simply frees up.
  function remove(name) {
    const directory = directoryFor(name);
    const removedDirectory = path.join(residentsDirectory, '.removed');
    fileSystem.mkdirSync(removedDirectory, { recursive: true });
    fileSystem.renameSync(directory, path.join(removedDirectory, `${name}-${now()}`));
  }

  return { residentsDirectory, list, read, save, saveState, remove };
}
