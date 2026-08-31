// User-editable office settings: one row per preference in the settings table
// of office.db (a key-value store). The public API is intent-named rather than
// raw key-value, so validation and defaults live in one place. Currently the
// only setting is the office name shown on the entrance sign.

export const MAX_OFFICE_NAME_LENGTH = 10;
export const DEFAULT_OFFICE_NAME = 'AI OFFICE';
const OFFICE_NAME_KEY = 'officeName';

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

  return { getOfficeName, setOfficeName };
}
