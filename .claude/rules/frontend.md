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
- Any CSS rule that sets `display` on an element toggled with the `hidden`
  attribute (e.g. `#resident-form { display: flex }`) overrides the UA's
  `display: none`; pair it with an explicit `#id[hidden] { display: none; }`
  rule (see `#office-wrap[hidden]` etc. in `public/style.css`).
