// The kanban board: one row per task card in the cards table of office.db.
// Columns are assignees ('user' or a resident name); display order within a
// column is the position column, dense-renumbered on every move so a drag
// index stays meaningful. A new card takes MAX(position)+1 and lands at the
// bottom of its column. Archiving sets archived_at instead of deleting —
// never a delete — mirroring the whiteboard's conventions.

import { randomUUID } from 'node:crypto';

const MAX_CARDS = 100;

export const USER_COLUMN = 'user';

export function createBoard({ database, now = () => Date.now() }) {
  const statements = {
    insert: database.prepare(
      `INSERT INTO cards (id, title, assignee, origin, body, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?,
               COALESCE((SELECT MAX(position) + 1 FROM cards WHERE assignee = ? AND archived_at IS NULL), 0),
               ?, ?)`
    ),
    listActive: database.prepare(
      `SELECT id, title, assignee, origin, body, created_at, updated_at
       FROM cards WHERE archived_at IS NULL
       ORDER BY assignee, position, created_at LIMIT ${MAX_CARDS}`
    ),
    getActive: database.prepare(
      'SELECT id, title, assignee, origin, body, created_at, updated_at FROM cards WHERE id = ? AND archived_at IS NULL'
    ),
    // The whole column, no LIMIT: renumbering must never depend on what the
    // capped listing happens to show.
    columnIdsExcept: database.prepare(
      `SELECT id FROM cards WHERE assignee = ? AND archived_at IS NULL AND id <> ?
       ORDER BY position, created_at`
    ),
    setAssignee: database.prepare('UPDATE cards SET assignee = ?, updated_at = ? WHERE id = ?'),
    setPosition: database.prepare('UPDATE cards SET position = ? WHERE id = ?'),
    setBody: database.prepare('UPDATE cards SET body = ?, updated_at = ? WHERE id = ?'),
    archive: database.prepare(
      'UPDATE cards SET archived_at = ? WHERE id = ? AND archived_at IS NULL'
    ),
    top: database.prepare(
      `SELECT id, title, assignee, origin, body, created_at, updated_at
       FROM cards WHERE assignee = ? AND archived_at IS NULL
       ORDER BY position, created_at LIMIT 1`
    ),
    // Counted over the same capped window the listing shows, mirroring the
    // whiteboard's badge behavior.
    counts: database.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(assignee = '${USER_COLUMN}'), 0) AS "user"
       FROM (SELECT assignee FROM cards WHERE archived_at IS NULL
             ORDER BY assignee, position, created_at LIMIT ${MAX_CARDS})`
    ),
  };

  function formatNoteDate(at) {
    const date = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function cardFromRow(row) {
    return {
      id: row.id,
      title: row.title,
      assignee: row.assignee,
      origin: row.origin,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      body: row.body,
    };
  }

  function createCard({ title, body, assignee, origin, createdAt }) {
    const id = randomUUID();
    // The title renders on one line everywhere; collapse any newlines.
    const cleanTitle = String(title).replace(/\s+/g, ' ').trim();
    statements.insert.run(
      id,
      cleanTitle,
      assignee,
      origin,
      String(body ?? '').trim(),
      assignee,
      createdAt,
      createdAt
    );
    return id;
  }

  function listCards() {
    return statements.listActive.all().map(cardFromRow);
  }

  // Reassign and/or reorder one card. `index` is the target position within
  // the column as displayed; the whole target column is renumbered densely so
  // the index stays meaningful even after cross-column moves.
  function moveCard(id, { assignee, index } = {}) {
    database.exec('BEGIN');
    try {
      const row = statements.getActive.get(id);
      if (row === undefined) {
        database.exec('ROLLBACK');
        return false;
      }
      const targetColumn = assignee ?? row.assignee;
      if (targetColumn !== row.assignee) statements.setAssignee.run(targetColumn, now(), id);
      const columnIds = statements.columnIdsExcept.all(targetColumn, id).map((entry) => entry.id);
      const insertAt = Number.isInteger(index)
        ? Math.max(0, Math.min(index, columnIds.length))
        : columnIds.length;
      columnIds.splice(insertAt, 0, id);
      columnIds.forEach((cardId, position) => statements.setPosition.run(position, cardId));
      database.exec('COMMIT');
      return true;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Keep the original error — a failing ROLLBACK must not mask it.
      }
      throw error;
    }
  }

  function archiveCard(id) {
    return statements.archive.run(now(), id).changes > 0;
  }

  // A follow-up note from the human, appended to the card body so the next
  // run sees the full history in its prompt.
  function appendNote(id, note) {
    const row = statements.getActive.get(id);
    if (row === undefined) return false;
    const noteText = String(note ?? '').trim();
    if (noteText === '') return false;
    const body = `${row.body}\n\n## 追記 (${formatNoteDate(now())})\n\n${noteText}`.trim();
    statements.setBody.run(body, now(), id);
    return true;
  }

  // The next task for a resident: the top card of its column.
  function topCardFor(assignee) {
    const row = statements.top.get(assignee);
    return row === undefined ? null : cardFromRow(row);
  }

  // Card totals for the canvas badge; the user column is the human's inbox.
  function counts() {
    const row = statements.counts.get();
    return { total: row.total, user: row.user };
  }

  return { createCard, listCards, moveCard, archiveCard, appendNote, topCardFor, counts };
}
