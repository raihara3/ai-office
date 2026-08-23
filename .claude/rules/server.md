---
paths:
  - "server/**"
---

# Server conventions

- Persistent stores (whiteboard, board) keep one Markdown file per item with a
  small frontmatter block; volatile state (ordering, read flags) lives in a
  sidecar JSON so it never rewrites the item files. Removal is always a rename
  into a `.archived/` subdirectory — never a delete — with a timestamp suffix
  on name collisions.
- Export pure parse/format helpers (e.g. `parseFrontmatter`, `formatCard`) for
  direct unit tests; store factories take injectable
  `{ fileSystem = fs, now = () => Date.now() }` so tests run against in-memory
  stubs without touching the disk or the clock.
- `http.js` is the only transport layer: it parses requests and calls `core`
  methods, and domain logic lives behind `core`. Every state-changing (non-GET)
  endpoint must be guarded with `isForbiddenOrigin(request)` before doing work.
