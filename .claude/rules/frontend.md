---
paths:
  - "public/**"
---

# Frontend conventions

- Panels render via `innerHTML` template strings; every interpolated dynamic
  value must pass through `escapeHtml` (see `public/app.js`) before insertion,
  or `renderMarkdown` from `markdown.js` for report and task bodies. The Markdown
  renderer escapes raw HTML and permits only HTTP(S)/mailto links. Copy actions
  must preserve the original text.
- No user-facing string literals: static markup keeps English base text plus
  `data-i18n` (or `data-i18n-placeholder` / `data-i18n-title` /
  `data-i18n-aria-label`) filled by `translateMarkup()`; dynamic strings call
  `translate(key, parameters)` from `public/i18n.js` at render time, never at
  module init — a cached label would survive a language switch. Add every new
  key to BOTH the `en` and `ja` dictionaries.
- Keep the module split: DOM panels in `app.js`, canvas drawing in
  `office.js`, server communication in `office-client.js` — do not fetch from
  `office.js` or touch the canvas from `app.js`.
- Any CSS rule that sets `display` on an element toggled with the `hidden`
  attribute (e.g. `#resident-form { display: flex }`) overrides the UA's
  `display: none`; pair it with an explicit `#id[hidden] { display: none; }`
  rule (see `#office-wrap[hidden]` etc. in `public/style.css`).
- Keep Kanban status badges and Enter/Space card activation consistent across
  office and full-board views. Preserve scroll positions and unfinished execution
  order; sort only completed cards newest first by `doneAt`.
- Use neutral off-white/gray panels and orange status accents with matching
  dark-theme tokens. The accent is `#ff7b00`; on light surfaces `--primary`
  deepens it to keep AA contrast, dark surfaces use `#ff7b00` directly. Report
  bodies open in the native dialog.
- Button icons are SVG `<symbol>` sprites defined once in `index.html` and
  referenced via `<use href="#icon-...">` — static markup inlines the
  reference, dynamic markup uses the `icon(name)` helper in `app.js`. Never
  use text glyphs (＋/✕/☆…) or emojis as icons. Buttons are pill-shaped
  (`border-radius: 999px`, icon-only ones `50%`) and lay out icon+label with
  `inline-flex` + `gap`.
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
