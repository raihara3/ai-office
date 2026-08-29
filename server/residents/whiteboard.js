// The whiteboard: reports from resident team members to the human, stored in
// the reports table of office.db. Read and favorite (pinned) are plain
// columns; archiving sets archived_at instead of deleting, so a mis-click
// never loses a report and archived rows stay queryable. The store takes the
// database handle as an injectable dependency — tests open ':memory:'.

import { randomUUID } from 'node:crypto';

const MAX_REPORTS = 100;

export function createWhiteboard({ database, now = () => Date.now() }) {
  const statements = {
    insert: database.prepare(
      `INSERT INTO reports (id, resident, title, level, task, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
    listActive: database.prepare(
      `SELECT id, resident, title, level, task, body, created_at, "read", favorite
       FROM reports WHERE archived_at IS NULL
       ORDER BY created_at DESC, id LIMIT ${MAX_REPORTS}`
    ),
    markRead: database.prepare(
      'UPDATE reports SET "read" = 1 WHERE id = ? AND archived_at IS NULL'
    ),
    getFavorite: database.prepare(
      'SELECT favorite FROM reports WHERE id = ? AND archived_at IS NULL'
    ),
    setFavorite: database.prepare('UPDATE reports SET favorite = ? WHERE id = ?'),
    // Favorited reports are pinned to the board and cannot be archived — the
    // WHERE clause simply refuses them. Archiving also clears the read flag,
    // like the sidecar entry used to go with the archived file.
    archive: database.prepare(
      `UPDATE reports SET archived_at = ?, "read" = 0
       WHERE id = ? AND archived_at IS NULL AND favorite = 0`
    ),
    // Counted over the same capped window the listing shows, so the badge
    // never reports unread rows the panel cannot display.
    counts: database.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM("read" = 0), 0) AS unread,
              COALESCE(SUM("read" = 0 AND level = 'review-needed'), 0) AS reviewNeeded
       FROM (SELECT "read", level FROM reports WHERE archived_at IS NULL
             ORDER BY created_at DESC, id LIMIT ${MAX_REPORTS})`
    ),
  };

  // `task` optionally links the report to the kanban card whose run produced
  // it, so the card detail view can pull the report in.
  function saveReport(residentName, { title, level, body, createdAt, task = null }) {
    const id = randomUUID();
    statements.insert.run(
      id,
      residentName,
      title,
      level === 'review-needed' ? 'review-needed' : 'info',
      task,
      String(body ?? '').trim(),
      createdAt
    );
    return id;
  }

  function listReports() {
    return statements.listActive.all().map((row) => ({
      id: row.id,
      resident: row.resident,
      title: row.title,
      level: row.level,
      task: row.task,
      createdAt: row.created_at,
      read: row.read === 1,
      favorite: row.favorite === 1,
      body: row.body,
    }));
  }

  function markRead(id) {
    return statements.markRead.run(id).changes > 0;
  }

  // Pin/unpin a report. Returns the resulting favorite flag, or null when
  // there is no such report.
  function toggleFavorite(id) {
    const row = statements.getFavorite.get(id);
    if (row === undefined) return null;
    const favorite = row.favorite === 0;
    statements.setFavorite.run(favorite ? 1 : 0, id);
    return favorite;
  }

  function archiveReport(id) {
    return statements.archive.run(now(), id).changes > 0;
  }

  // Unread totals for the canvas badge; pushed with every snapshot.
  function counts() {
    const row = statements.counts.get();
    return { total: row.total, unread: row.unread, reviewNeeded: row.reviewNeeded };
  }

  return { saveReport, listReports, markRead, toggleFavorite, archiveReport, counts };
}
