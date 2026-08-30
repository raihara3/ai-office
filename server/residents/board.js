// The kanban board: one row per task card in the cards table of office.db.
// Columns are foreign-keyed resident ids — NULL is the human user's column —
// but the public API speaks names ('user' or a resident name): writes resolve
// a name to an active resident's id, listings join the name back, including
// for archived residents so an unassigned resident's leftover cards still
// show who they belonged to. Display order within a column is the position
// column, dense-renumbered on every move. A new card takes MAX(position)+1
// and lands at the bottom of its column. Archiving sets archived_at instead
// of deleting — never a delete — mirroring the whiteboard's conventions.

import { randomUUID } from 'node:crypto';

const MAX_CARDS = 100;

export const USER_COLUMN = 'user';

export function createBoard({ database, now = () => Date.now() }) {
  const statements = {
    residentIdByName: database.prepare(
      'SELECT id FROM residents WHERE name = ? AND archived_at IS NULL'
    ),
    // Active preferred, archived accepted — origin records provenance, and a
    // resident unassigned while its run was still in flight must not crash
    // the finish handler that files its card.
    anyResidentIdByName: database.prepare(
      'SELECT id FROM residents WHERE name = ? ORDER BY (archived_at IS NULL) DESC LIMIT 1'
    ),
    insert: database.prepare(
      `INSERT INTO cards (id, title, assignee_id, origin_id, body, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?,
               COALESCE((SELECT MAX(position) + 1 FROM cards WHERE assignee_id IS ? AND archived_at IS NULL), 0),
               ?, ?)`
    ),
    listActive: database.prepare(
      `SELECT c.id, c.title, COALESCE(a.name, '${USER_COLUMN}') AS assignee,
              COALESCE(o.name, '${USER_COLUMN}') AS origin,
              c.body, c.created_at, c.updated_at
       FROM cards c
       LEFT JOIN residents a ON a.id = c.assignee_id
       LEFT JOIN residents o ON o.id = c.origin_id
       WHERE c.archived_at IS NULL
       ORDER BY assignee, c.position, c.created_at LIMIT ${MAX_CARDS}`
    ),
    getActive: database.prepare(
      'SELECT id, assignee_id, body FROM cards WHERE id = ? AND archived_at IS NULL'
    ),
    // The whole column, no LIMIT: renumbering must never depend on what the
    // capped listing happens to show. NULL columns need IS, not =.
    columnIdsExcept: database.prepare(
      `SELECT id FROM cards WHERE assignee_id IS ? AND archived_at IS NULL AND id <> ?
       ORDER BY position, created_at`
    ),
    setAssignee: database.prepare('UPDATE cards SET assignee_id = ?, updated_at = ? WHERE id = ?'),
    setPosition: database.prepare('UPDATE cards SET position = ? WHERE id = ?'),
    setBody: database.prepare('UPDATE cards SET body = ?, updated_at = ? WHERE id = ?'),
    archive: database.prepare(
      'UPDATE cards SET archived_at = ? WHERE id = ? AND archived_at IS NULL'
    ),
    top: database.prepare(
      `SELECT c.id, c.title, COALESCE(a.name, '${USER_COLUMN}') AS assignee,
              COALESCE(o.name, '${USER_COLUMN}') AS origin,
              c.body, c.created_at, c.updated_at
       FROM cards c
       LEFT JOIN residents a ON a.id = c.assignee_id
       LEFT JOIN residents o ON o.id = c.origin_id
       WHERE c.assignee_id IS ? AND c.archived_at IS NULL
       ORDER BY c.position, c.created_at LIMIT 1`
    ),
    // Counted over the same capped window the listing shows, mirroring the
    // whiteboard's badge behavior.
    counts: database.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(assignee_id IS NULL), 0) AS "user"
       FROM (SELECT c.assignee_id FROM cards c
             LEFT JOIN residents a ON a.id = c.assignee_id
             WHERE c.archived_at IS NULL
             ORDER BY COALESCE(a.name, '${USER_COLUMN}'), c.position, c.created_at LIMIT ${MAX_CARDS})`
    ),
  };

  // The column id for a public assignee value: NULL for the user column,
  // otherwise the active resident's id. Unknown names throw — a second guard
  // behind residents.js's assertAssignee.
  function toColumnId(assignee) {
    if (assignee === USER_COLUMN) return null;
    const row = statements.residentIdByName.get(assignee);
    if (row === undefined) throw new Error(`unknown assignee: ${assignee}`);
    return row.id;
  }

  // Same, but archived residents resolve too — used for origin only.
  function toOriginId(origin) {
    if (origin === USER_COLUMN) return null;
    const row = statements.anyResidentIdByName.get(origin);
    if (row === undefined) throw new Error(`unknown origin: ${origin}`);
    return row.id;
  }

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
    const assigneeId = toColumnId(assignee);
    statements.insert.run(
      id,
      cleanTitle,
      assigneeId,
      toOriginId(origin),
      String(body ?? '').trim(),
      assigneeId,
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
    // Resolve outside the transaction so an unknown assignee never leaves one
    // open.
    const targetColumnId = assignee !== undefined ? toColumnId(assignee) : undefined;
    database.exec('BEGIN');
    try {
      const row = statements.getActive.get(id);
      if (row === undefined) {
        database.exec('ROLLBACK');
        return false;
      }
      const columnId = targetColumnId !== undefined ? targetColumnId : row.assignee_id;
      if (columnId !== row.assignee_id) statements.setAssignee.run(columnId, now(), id);
      const columnIds = statements.columnIdsExcept.all(columnId, id).map((entry) => entry.id);
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

  // The next task for a resident: the top card of its column. Only active
  // residents resolve, so an archived resident's leftover cards are never
  // picked up.
  function topCardFor(assignee) {
    const row =
      assignee === USER_COLUMN ? null : statements.residentIdByName.get(assignee);
    if (assignee !== USER_COLUMN && row === undefined) return null;
    const card = statements.top.get(assignee === USER_COLUMN ? null : row.id);
    return card === undefined ? null : cardFromRow(card);
  }

  // Card totals for the canvas badge; the user column is the human's inbox.
  function counts() {
    const row = statements.counts.get();
    return { total: row.total, user: row.user };
  }

  return { createCard, listCards, moveCard, archiveCard, appendNote, topCardFor, counts };
}
