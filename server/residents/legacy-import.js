// One-time import of the legacy Markdown stores into office.db. Before the
// SQLite migration, reports lived as md+frontmatter files under
// residents/<name>/outbox/ and cards under board/, with volatile state
// (read/favorite flags, drag order) in sidecar JSONs. This module reads all
// of that, inserts it in a single transaction together with a marker row in
// meta, and only after the commit deletes the imported source files. The
// marker — not table emptiness — decides whether the import already ran, so
// a user who empties the board never re-triggers it.

import fs from 'node:fs';
import path from 'node:path';
import { ensureResidentId } from './resident-import.js';

const IMPORT_MARKER_KEY = 'legacyImportedAt';
const USER_SENTINEL = 'user';

// A minimal "key: value" frontmatter block — no YAML nesting, by design.
// Moved from whiteboard.js when the stores went to SQLite; the importer is
// its only remaining consumer.
export function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { attributes: {}, body: text };
  const attributes = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    attributes[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { attributes, body: text.slice(match[0].length) };
}

function readJson(fileSystem, filePath) {
  try {
    return JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function listMarkdownFiles(fileSystem, directory) {
  try {
    return fileSystem.readdirSync(directory).filter((name) => name.endsWith('.md'));
  } catch {
    return [];
  }
}

function collectReports({ dataDirectory, fileSystem, now }) {
  const residentsDirectory = path.join(dataDirectory, 'residents');
  const sidecar = readJson(fileSystem, path.join(dataDirectory, 'whiteboard-state.json'));
  const readIds = new Set(Array.isArray(sidecar?.readIds) ? sidecar.readIds : []);
  const favoriteIds = new Set(Array.isArray(sidecar?.favoriteIds) ? sidecar.favoriteIds : []);
  let residentNames;
  try {
    residentNames = fileSystem
      .readdirSync(residentsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return { reports: [], filePaths: [], directories: [] };
  }
  const reports = [];
  const filePaths = [];
  const directories = [];
  for (const residentName of residentNames) {
    const outboxDirectory = path.join(residentsDirectory, residentName, 'outbox');
    directories.push(path.join(outboxDirectory, '.archived'), outboxDirectory);
    for (const { directory, archived } of [
      { directory: outboxDirectory, archived: false },
      { directory: path.join(outboxDirectory, '.archived'), archived: true },
    ]) {
      for (const fileName of listMarkdownFiles(fileSystem, directory)) {
        const filePath = path.join(directory, fileName);
        let text;
        try {
          text = fileSystem.readFileSync(filePath, 'utf8');
        } catch {
          continue;
        }
        const { attributes, body } = parseFrontmatter(text);
        const id = `${residentName}/${fileName}`;
        reports.push({
          id,
          resident: residentName,
          title: attributes.title ?? fileName,
          level: attributes.level === 'review-needed' ? 'review-needed' : 'info',
          task: attributes.task ?? null,
          body: body.trim(),
          createdAt: Number(attributes.createdAt) || 0,
          read: readIds.has(id) ? 1 : 0,
          favorite: favoriteIds.has(id) ? 1 : 0,
          archivedAt: archived ? now() : null,
        });
        filePaths.push(filePath);
      }
    }
  }
  return { reports, filePaths, directories };
}

function collectCards({ dataDirectory, fileSystem, now }) {
  const boardDirectory = path.join(dataDirectory, 'board');
  const sidecar = readJson(fileSystem, path.join(dataDirectory, 'board-state.json'));
  const order = sidecar?.order ?? {};
  const cards = [];
  const filePaths = [];
  const directories = [path.join(boardDirectory, '.archived'), boardDirectory];
  for (const { directory, archived } of [
    { directory: boardDirectory, archived: false },
    { directory: path.join(boardDirectory, '.archived'), archived: true },
  ]) {
    for (const fileName of listMarkdownFiles(fileSystem, directory)) {
      const filePath = path.join(directory, fileName);
      let text;
      try {
        text = fileSystem.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      const { attributes, body } = parseFrontmatter(text);
      cards.push({
        id: fileName,
        title: attributes.title || fileName,
        assignee: attributes.assignee || 'user',
        origin: attributes.origin || 'user',
        body: body.trim(),
        createdAt: Number(attributes.createdAt) || 0,
        updatedAt: Number(attributes.updatedAt) || Number(attributes.createdAt) || 0,
        position: 0,
        archivedAt: archived ? now() : null,
      });
      filePaths.push(filePath);
    }
  }
  // Positions mirror the legacy display order: ids listed in the sidecar come
  // first (in that order), the rest follow by creation time.
  const byColumn = new Map();
  for (const card of cards) {
    if (card.archivedAt !== null) continue;
    if (!byColumn.has(card.assignee)) byColumn.set(card.assignee, []);
    byColumn.get(card.assignee).push(card);
  }
  for (const [column, columnCards] of byColumn) {
    const listed = Array.isArray(order[column]) ? order[column] : [];
    const rank = new Map(listed.map((id, index) => [id, index]));
    columnCards.sort((a, b) => {
      const rankA = rank.has(a.id) ? rank.get(a.id) : Infinity;
      const rankB = rank.has(b.id) ? rank.get(b.id) : Infinity;
      if (rankA !== rankB) return rankA - rankB;
      return a.createdAt - b.createdAt;
    });
    columnCards.forEach((card, index) => {
      card.position = index;
    });
  }
  return { cards, filePaths, directories };
}

function removeImportedFiles({ dataDirectory, fileSystem, filePaths, directories }) {
  const leftovers = [];
  for (const filePath of filePaths) {
    try {
      fileSystem.unlinkSync(filePath);
    } catch {
      leftovers.push(filePath);
    }
  }
  for (const sidecarName of ['whiteboard-state.json', 'board-state.json']) {
    const sidecarPath = path.join(dataDirectory, sidecarName);
    try {
      if (fileSystem.existsSync(sidecarPath)) fileSystem.unlinkSync(sidecarPath);
    } catch {
      leftovers.push(sidecarPath);
    }
  }
  // Remove the now-empty legacy directories, deepest first, whether or not
  // they still held files to import; a non-empty or absent directory simply
  // refuses and is left alone.
  for (const directory of [...new Set(directories)].sort((a, b) => b.length - a.length)) {
    try {
      fileSystem.rmdirSync(directory);
    } catch {
      // Still holds foreign files, or never existed — leave it be.
    }
  }
  if (leftovers.length > 0) {
    console.warn(
      `legacy import: ${leftovers.length} imported file(s) could not be deleted (harmless, the meta marker prevents re-import)`
    );
  }
}

export function importLegacyData(database, { dataDirectory, fileSystem = fs, now = () => Date.now() }) {
  const marker = database.prepare('SELECT value FROM meta WHERE key = ?').get(IMPORT_MARKER_KEY);
  if (marker !== undefined) return { reports: 0, cards: 0 };

  const reportSweep = collectReports({ dataDirectory, fileSystem, now });
  const cardSweep = collectCards({ dataDirectory, fileSystem, now });
  const { reports } = reportSweep;
  const { cards } = cardSweep;

  // OR IGNORE: the legacy stores could hold an active and an archived file
  // with the same name (= same id here). Dropping the duplicate beats a
  // primary-key throw, which would roll back the marker and re-fail on every
  // boot.
  const insertReport = database.prepare(
    `INSERT OR IGNORE INTO reports (id, resident_id, title, level, task, body, created_at, "read", favorite, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertCard = database.prepare(
    `INSERT OR IGNORE INTO cards (id, title, assignee_id, origin_id, body, position, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  database.exec('BEGIN');
  try {
    // Frontmatter can name residents that no longer exist anywhere;
    // ensureResidentId gives those an archived ghost row so the foreign keys
    // hold. 'user' marks the human, who is not a resident — NULL.
    const toResidentId = (name) =>
      name === USER_SENTINEL || !name ? null : ensureResidentId(database, name, now);
    for (const report of reports) {
      insertReport.run(
        report.id,
        ensureResidentId(database, report.resident, now),
        report.title,
        report.level,
        report.task,
        report.body,
        report.createdAt,
        report.read,
        report.favorite,
        report.archivedAt
      );
    }
    for (const card of cards) {
      insertCard.run(
        card.id,
        card.title,
        toResidentId(card.assignee),
        toResidentId(card.origin),
        card.body,
        card.position,
        card.createdAt,
        card.updatedAt,
        card.archivedAt
      );
    }
    database.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(IMPORT_MARKER_KEY, String(now()));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  // Only after the commit do the source files go away, and only the ones that
  // were actually imported; a failure above deletes nothing.
  removeImportedFiles({
    dataDirectory,
    fileSystem,
    filePaths: [...reportSweep.filePaths, ...cardSweep.filePaths],
    directories: [...reportSweep.directories, ...cardSweep.directories],
  });
  return { reports: reports.length, cards: cards.length };
}
