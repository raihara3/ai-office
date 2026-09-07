// Token usage per resident run: one append-only row in the run_usage table of
// office.db per finished run, recorded by the residents module from the state
// store's per-session accumulation. The public API speaks resident names like
// the other stores; totals list active residents only — the labor-cost panel
// shows the current roster, and an archived resident's rows simply wait for
// it to return. The store takes the database handle as an injectable
// dependency — tests open ':memory:'.

import { randomUUID } from 'node:crypto';

const RECENT_WINDOW_MS = 30 * 24 * 60 * 60_000;

export function createUsageStore({ database, now = () => Date.now() }) {
  const statements = {
    // Active preferred, archived accepted: a resident unassigned while its
    // run was still in flight must not lose that run's usage.
    residentIdByName: database.prepare(
      'SELECT id FROM residents WHERE name = ? ORDER BY (archived_at IS NULL) DESC LIMIT 1'
    ),
    insert: database.prepare(
      `INSERT INTO run_usage (id, resident_id, started_at, finished_at, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    // One row per active resident (zeroes before its first recorded run),
    // ordered like the office roster: team, then seat.
    totals: database.prepare(
      `SELECT res.name AS resident,
              COUNT(u.id) AS runCount,
              COALESCE(SUM(u.input_tokens), 0) AS inputTokens,
              COALESCE(SUM(u.output_tokens), 0) AS outputTokens,
              COALESCE(SUM(CASE WHEN u.finished_at >= ? THEN u.input_tokens ELSE 0 END), 0) AS recentInputTokens,
              COALESCE(SUM(CASE WHEN u.finished_at >= ? THEN u.output_tokens ELSE 0 END), 0) AS recentOutputTokens
       FROM residents res
       LEFT JOIN run_usage u ON u.resident_id = res.id
       WHERE res.archived_at IS NULL
       GROUP BY res.id
       ORDER BY res.team_id, res.seat`
    ),
  };

  function recordRun(residentName, { startedAt, finishedAt, inputTokens, outputTokens }) {
    const resident = statements.residentIdByName.get(residentName);
    if (resident === undefined) throw new Error(`unknown resident: ${residentName}`);
    const id = randomUUID();
    statements.insert.run(id, resident.id, startedAt, finishedAt, inputTokens, outputTokens);
    return id;
  }

  // Cumulative and recent (last 30 days) token totals per active resident.
  function totals() {
    const recentSince = now() - RECENT_WINDOW_MS;
    return statements.totals.all(recentSince, recentSince).map((row) => ({
      resident: row.resident,
      runCount: row.runCount,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      recentInputTokens: row.recentInputTokens,
      recentOutputTokens: row.recentOutputTokens,
    }));
  }

  return { recordRun, totals };
}
