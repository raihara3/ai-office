// Cross-instance guard for the resident tick loop: two servers over the same
// office.db (e.g. the Electron app plus a standalone `npm start` on another
// port) must not both fire triggers, or every board card is run twice. The
// owner keeps a `pid:timestamp` heartbeat in a meta row: it rewrites the
// timestamp every tick, other instances back off while the heartbeat is
// fresh, and a slot whose heartbeat has gone stale (crash, quit, SIGKILL) is
// taken over — so the loop survives whichever instance the user closes first.
// Deliberately no pid liveness probe: after a reboot a stale pid can match an
// unrelated live process and look owned forever, but a silent heartbeat
// cannot lie.

const OWNER_KEY = 'resident_loop_owner';
// Three 30-second ticks: one missed heartbeat is a busy event loop, three is
// a dead instance.
export const STALE_OWNER_MS = 90_000;

export function createLoopOwnership({
  database,
  processId = process.pid,
  now = () => Date.now(),
}) {
  const statements = {
    read: database.prepare('SELECT value FROM meta WHERE key = ?'),
    claim: database.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO NOTHING`
    ),
    // Guarded on the previous value so two instances racing for a stale slot
    // cannot both win: SQLite serializes the updates and the loser's guard
    // no longer matches.
    replace: database.prepare('UPDATE meta SET value = ? WHERE key = ? AND value = ?'),
  };

  // A released slot ('') or unparseable leftover yields nulls, which acquire
  // treats as stale — always safe to take over.
  function parseOwner(value) {
    const match = /^(\d+):(\d+)$/.exec(value);
    if (match === null) return { ownerId: null, heartbeatAt: null };
    return { ownerId: Number(match[1]), heartbeatAt: Number(match[2]) };
  }

  function heartbeatValue() {
    return `${processId}:${now()}`;
  }

  // True when this process owns the loop after the call: refreshes our own
  // heartbeat, backs off while a foreign heartbeat is fresh, takes over stale
  // slots. The guarded replace plus the re-read settle races: whoever's
  // update matched the old value is the owner everyone reads back.
  function acquire() {
    let row = statements.read.get(OWNER_KEY);
    if (row === undefined) {
      statements.claim.run(OWNER_KEY, heartbeatValue());
      row = statements.read.get(OWNER_KEY);
    }
    const { ownerId, heartbeatAt } = parseOwner(row.value);
    if (ownerId !== processId) {
      const fresh = heartbeatAt !== null && now() - heartbeatAt < STALE_OWNER_MS;
      if (fresh) return false;
    }
    statements.replace.run(heartbeatValue(), OWNER_KEY, row.value);
    return parseOwner(statements.read.get(OWNER_KEY).value).ownerId === processId;
  }

  // Hand the loop to whichever instance ticks next rather than making it wait
  // out the stale window. Owner-guarded, so a non-owner's stop() is a no-op.
  function release() {
    const row = statements.read.get(OWNER_KEY);
    if (row === undefined || parseOwner(row.value).ownerId !== processId) return;
    statements.replace.run('', OWNER_KEY, row.value);
  }

  return { acquire, release };
}
