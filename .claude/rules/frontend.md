---
paths:
  - "public/**"
---

# Frontend conventions

- Panels render via `innerHTML` template strings; every interpolated dynamic
  value must pass through `escapeHtml` (see `public/app.js`) before insertion.
- Keep the module split: DOM panels in `app.js`, canvas drawing in
  `office.js`, server communication in `office-client.js` — do not fetch from
  `office.js` or touch the canvas from `app.js`.
