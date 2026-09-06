// User-editable office settings: one row per preference in the settings table
// of office.db (a key-value store). The public API is intent-named rather than
// raw key-value, so validation and defaults live in one place. Currently the
// only setting is the office name shown on the entrance sign.

export const MAX_OFFICE_NAME_LENGTH = 10;
export const DEFAULT_OFFICE_NAME = 'AI OFFICE';
const OFFICE_NAME_KEY = 'officeName';

const BOARD_COLUMN_ORDER_KEY = 'boardColumnOrder';
// A saved order lists at most the two fixed columns (user, done) plus one per
// team; teams are bounded only by the canvas, so cap generously rather than
// tightly. Keys are opaque here — the client maps them to live columns.
export const MAX_BOARD_COLUMN_KEYS = 200;
const MAX_BOARD_COLUMN_KEY_LENGTH = 128;

export function createSettingsStore({ database }) {
  const statements = {
    read: database.prepare('SELECT value FROM settings WHERE key = ?'),
    upsert: database.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ),
  };

  // Unset until the human saves one, so the sign keeps its built-in label
  // until then.
  function getOfficeName() {
    const row = statements.read.get(OFFICE_NAME_KEY);
    return row === undefined ? DEFAULT_OFFICE_NAME : row.value;
  }

  // Length is counted in code points, not UTF-16 units, so a 10-character
  // name of multibyte glyphs is accepted rather than mis-rejected.
  function setOfficeName(name) {
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (cleanName === '') throw new Error('office name is required');
    if ([...cleanName].length > MAX_OFFICE_NAME_LENGTH) {
      throw new Error(`office name must be ${MAX_OFFICE_NAME_LENGTH} characters or fewer`);
    }
    statements.upsert.run(OFFICE_NAME_KEY, cleanName);
    return cleanName;
  }

  // The board's left-to-right column order as a list of column keys ('user',
  // 'done', or 'team:<id>'). Empty until the human reorders, so the board keeps
  // its natural order (user, teams by creation, done) until then. Keys are
  // opaque here; the client maps them onto the live columns and drops stale ones.
  function getBoardColumnOrder() {
    const row = statements.read.get(BOARD_COLUMN_ORDER_KEY);
    if (row === undefined) return [];
    try {
      const parsed = JSON.parse(row.value);
      return Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : [];
    } catch {
      return [];
    }
  }

  // Persists a deduplicated, trimmed list of column keys. Order is honored;
  // blank or overlong keys are dropped rather than rejected so a stray entry
  // never blocks a save.
  function setBoardColumnOrder(order) {
    if (!Array.isArray(order)) throw new Error('column order must be an array of keys');
    const seen = new Set();
    const cleaned = [];
    for (const key of order) {
      if (typeof key !== 'string') throw new Error('column order keys must be strings');
      const trimmed = key.trim();
      if (trimmed === '' || trimmed.length > MAX_BOARD_COLUMN_KEY_LENGTH || seen.has(trimmed)) continue;
      seen.add(trimmed);
      cleaned.push(trimmed);
    }
    if (cleaned.length > MAX_BOARD_COLUMN_KEYS) {
      throw new Error(`column order must list ${MAX_BOARD_COLUMN_KEYS} keys or fewer`);
    }
    statements.upsert.run(BOARD_COLUMN_ORDER_KEY, JSON.stringify(cleaned));
    return cleaned;
  }

  return { getOfficeName, setOfficeName, getBoardColumnOrder, setBoardColumnOrder };
}
