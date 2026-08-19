// Pure geometry for the office scene: where desks, break spots and the
// entrance sit, and how seats are assigned. No canvas or DOM here, so this
// module is unit-testable and shared by the renderer.

export const CANVAS_WIDTH = 960;
export const FIRST_ROW_Y = 260;
export const ROW_SPACING = 190;
export const GRID_COLUMNS = 5;
// The main desk grid is shifted right of the resident-team room that occupies
// the left edge; the column spacing is tightened so five columns still fit.
export const FIRST_COLUMN_X = 360;
export const COLUMN_SPACING = 134;

// The resident team's room pinned to the top-left edge: a fixed partition
// holding a fixed island of full-size desks, independent of live sessions.
// Unlike the main grid it never grows, so it stays put as the office fills up.
export const RESIDENT_ROOM = { x: 8, y: 104, width: 280, height: 298 };
export const RESIDENT_DESK_COUNT = 4;

// An island of four full-size desks in two columns and two rows, all upright
// (monitor sitting on the desktop). The rows are spaced far enough apart that
// every desk — the top row included — shows an empty chair tucked beneath it,
// and the columns keep a margin to the side walls so nothing overflows them.
export function residentDeskPosition(index) {
  const centerX = RESIDENT_ROOM.x + 140;
  const columnOffset = 62;
  const topY = RESIDENT_ROOM.y + 96;
  const bottomY = topY + 128;
  const layout = [
    { x: centerX - columnOffset, y: topY },
    { x: centerX + columnOffset, y: topY },
    { x: centerX - columnOffset, y: bottomY },
    { x: centerX + columnOffset, y: bottomY },
  ];
  return layout[index];
}

// The lowest seat index not present in `usedSeats`. The grid fills from the
// top-left as sessions appear, reusing seats freed when avatars leave.
export function lowestFreeSeat(usedSeats) {
  let seat = 0;
  while (usedSeats.has(seat)) seat += 1;
  return seat;
}

// Room height grows with the number of occupied rows; the break area and the
// entrance are anchored to the bottom edge rather than floating below the last
// desk row.
export function computeLayout(usedSeats) {
  let maxRows = 1;
  for (const seat of usedSeats) {
    maxRows = Math.max(maxRows, Math.floor(seat / GRID_COLUMNS) + 1);
  }
  const lastRowY = FIRST_ROW_Y + (maxRows - 1) * ROW_SPACING;
  const height = Math.max(640, lastRowY + 280);
  const breakTop = height - 150;
  return { breakTop, height };
}

export function deskPosition(seat) {
  return {
    x: FIRST_COLUMN_X + (seat % GRID_COLUMNS) * COLUMN_SPACING,
    y: FIRST_ROW_Y + Math.floor(seat / GRID_COLUMNS) * ROW_SPACING,
  };
}

// Resting spots anchored to the break-area furniture: café tables and a sofa.
// Beyond the fixed furniture, extra avatars overflow onto a back row.
export function breakSpot(index, layout) {
  const top = layout.breakTop;
  const spots = [
    { x: 268, y: top + 92 },
    { x: 334, y: top + 92 },
    { x: 448, y: top + 92 },
    { x: 514, y: top + 92 },
    { x: 668, y: top + 96 },
    { x: 732, y: top + 96 },
  ];
  if (index < spots.length) return spots[index];
  return { x: 180 + ((index - spots.length) % 8) * 56, y: top + 40 };
}

// The entrance sits on the same horizontal band as the break area.
export function doorPosition(layout) {
  return { x: 46, y: layout.breakTop + 92 };
}
