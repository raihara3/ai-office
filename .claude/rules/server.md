---
paths:
  - "server/**"
---

# Server conventions

- Persistent stores (whiteboard, board) are tables in `<dataDir>/office.db`,
  opened by `residents/database.js` (WAL, schema migrations via
  `PRAGMA user_version`). Removal is always `archived_at = now()` — never a
  `DELETE` — and listings filter `archived_at IS NULL`.
- SQLite store factories take injectable `{ database, now = () => Date.now() }`
  and tests open `':memory:'` databases via `openDatabase`; file-based stores
  (manifest, registry) keep the `{ fileSystem = fs, now }` injection with
  in-memory stubs.
- `http.js` is the only transport layer: it parses requests and calls `core`
  methods, and domain logic lives behind `core`. Every state-changing (non-GET)
  endpoint must be guarded with `isForbiddenOrigin(request)` before doing work.
