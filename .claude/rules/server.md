---
paths:
  - "server/**"
---

# Server conventions

- Persistent stores (residents/teams, session bindings, whiteboard, board)
  are tables in `<dataDir>/office.db`, opened by `residents/database.js`
  (WAL, schema migrations via `PRAGMA user_version`, foreign keys enforced —
  node:sqlite's default). Removal is always `archived_at = now()` — never a
  `DELETE` — and listings filter `archived_at IS NULL`. Two sanctioned
  exceptions: `session_bindings` prunes past its cap with DELETE (operational
  cache, not user data), and `run_usage` is an append-only log with no
  `archived_at` (rows are never updated or removed; totals scope to active
  residents instead).
- Store public APIs speak resident names (`'user'` = the human sentinel);
  foreign keys underneath use ids. Writes resolve names against active
  residents only; display joins include archived residents so history keeps
  its names. Quote `"trigger"` and `"read"` in SQL, and compare nullable id
  columns with `IS ?`, never `= ?`.
- Store factories take injectable `{ database, now = () => Date.now() }` and
  tests open `':memory:'` databases via `openDatabase`; the one-time
  importers additionally take `{ fileSystem = fs }` with in-memory stubs.
- User-facing text produced at runtime (reports, mentions, prompts, run
  errors) goes through `translate()` from `server/i18n.js`, with new keys in
  both the `en` and `ja` dictionaries. Generated text is data written in the
  language current at generation time — never retranslate stored text.
  `residents.js` syncs the module-level current language from the settings
  store, so watchers and the runner translate without database access.
- `http.js` is the only transport layer: it parses requests and calls `core`
  methods, and domain logic lives behind `core`. Every state-changing (non-GET)
  endpoint must be guarded with `isForbiddenOrigin(request)` before doing work.
