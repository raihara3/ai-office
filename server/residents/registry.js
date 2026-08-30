// Session registry: the persistent mapping that keeps resident-run sessions
// off the free-address grid. The runner binds a path fragment — Claude's
// explicit session id, or the discovered transcript path for CLIs without an
// id flag — to a resident; the core then asks `residentForFile` for every
// session log the watchers pick up. Bindings live in the session_bindings
// table of office.db, so concurrent processes append rows instead of
// rewriting a whole file (the JSON-file predecessor lost bindings that way).
// Matching stays in JS: path fragments must match exactly, uuid fragments as
// a substring, newest first across both kinds — spelling that out beats a
// LIKE-escape contraption for ≤200 rows.

const MAX_BINDINGS = 200;

export function createSessionRegistry({ database, now = () => Date.now() }) {
  const statements = {
    // Active preferred, archived accepted: the runner only binds residents it
    // actually launched, and a resident unassigned while its run was still
    // starting up (codex/gemini bind after transcript discovery) must still
    // get its session seated and muted.
    residentIdByName: database.prepare(
      'SELECT id FROM residents WHERE name = ? ORDER BY (archived_at IS NULL) DESC LIMIT 1'
    ),
    insert: database.prepare(
      'INSERT OR IGNORE INTO session_bindings (fragment, resident_id, at) VALUES (?, ?, ?)'
    ),
    // Old bindings only matter while their transcripts are still tailed
    // (sessions expire from the office after 3 days), so a modest cap keeps
    // the table small. This DELETE is the sanctioned exception to the
    // archive-never-delete convention: bindings are an operational cache,
    // not user data.
    prune: database.prepare(
      `DELETE FROM session_bindings WHERE fragment IN (
         SELECT fragment FROM session_bindings ORDER BY at DESC LIMIT -1 OFFSET ${MAX_BINDINGS}
       )`
    ),
    // No archived filter: a resident archived mid-run must still keep its
    // session seated and muted until the transcript expires.
    listNewestFirst: database.prepare(
      `SELECT b.fragment, r.name AS resident FROM session_bindings b
       JOIN residents r ON r.id = b.resident_id
       ORDER BY b.at DESC, b.fragment`
    ),
  };

  function bind(residentName, pathFragment) {
    if (!pathFragment) return;
    const row = statements.residentIdByName.get(residentName);
    if (row === undefined) {
      console.warn(`session registry: no resident named ${residentName}, not binding`);
      return;
    }
    statements.insert.run(pathFragment, row.id, now());
    statements.prune.run();
  }

  // The resident owning this session log, or null for free-address sessions.
  // Newest bindings win, matching how a rebound fragment should behave.
  // A fragment that is itself a path (Codex/Gemini transcript discovery) must
  // match exactly — substring matching could mis-attribute an unrelated
  // session whose path merely contains it. Session-id fragments (Claude) are
  // UUIDs, where a substring match within the path is unambiguous.
  function residentForFile(sessionFilePath) {
    for (const { fragment, resident } of statements.listNewestFirst.all()) {
      const matches = fragment.includes('/')
        ? sessionFilePath === fragment
        : sessionFilePath.includes(fragment);
      if (matches) return resident;
    }
    return null;
  }

  return { bind, residentForFile };
}
