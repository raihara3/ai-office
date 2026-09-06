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
- Canvas hit targets and zoom use logical scene dimensions, not the high-DPI
  backing store. Keep `data-scene-width` / `data-scene-height` in sync with
  `layout.js`; cache static material rendering instead of rebuilding it per frame.
- Preserve the user-selected gray, dark, off-white and brown palette: brown
  wood desks and reception counter, neutral gray and soft off-white (`#ededed`,
  not pure white) walls and floors, charcoal metalwork, dark-brown wooden team
  and office name signs, and a dark gray floor lamp shade. Keep the wall clock
  digital with a 24-hour display. Avoid green tints in interior materials;
  preserve plant foliage and outdoor scenery.
  Keep the approved furnishing types and placement, CLI avatar colors, geometry
  and movement paths unchanged when refining interior colors. Use matte faces
  for wood, plaster and fabric; reserve gradients for light, sky and subtle
  metal reflections. Keep hard fixtures angular and cushions softer instead
  of sharing one radius.
