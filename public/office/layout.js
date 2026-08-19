// Pure geometry for the office scene: where desks, break spots and the
// entrance sit, and how seats are assigned. No canvas or DOM here, so this
// module is unit-testable and shared by the renderer.

export const CANVAS_WIDTH = 960;
// The first free-address row shares its y with the resident island's top row
// (both use the same desk anchor), so the two islands line up horizontally.
// Kept low enough that a desk's nameplate chip (drawn 106px above the anchor)
// stays clear of the wall's baseboard.
export const FIRST_ROW_Y = 240;
// The packing limit for rows: a desk's nameplate chip starts 106px above its
// anchor, while the row above extends 64px below its anchor (the subagent
// mini-avatars and their labels), leaving a couple of pixels of clearance.
export const ROW_SPACING = 172;
export const GRID_COLUMNS = 4;
// Eight seats are furnished up front (two rows of four); sessions beyond that
// still overflow onto extra rows below.
export const SEAT_COUNT = 8;
// The main desk grid starts right of the resident-team room, leaving an
// aisle between the room's right edge (288) and the first desk's left edge.
export const FIRST_COLUMN_X = 400;
export const COLUMN_SPACING = 150;

// The resident team's room pinned to the top-left edge: a fixed partition
// holding a fixed island of full-size desks, independent of live sessions.
// Unlike the main grid it never grows, so it stays put as the office fills up.
export const RESIDENT_ROOM = { x: 8, y: 104, width: 280, height: 344 };
export const RESIDENT_DESK_COUNT = 4;

// An island of four full-size desks in two columns and two rows, all upright
// (monitor sitting on the desktop). The rows are spaced far enough apart that
// every desk — the top row included — shows an empty chair tucked beneath it,
// and the columns keep a margin to the side walls so nothing overflows them.
// The anchor matches deskPosition's, and both rows share the free-address
// grid's FIRST_ROW_Y / ROW_SPACING so the two islands line up horizontally.
export function residentDeskPosition(index) {
  const centerX = RESIDENT_ROOM.x + 140;
  const columnOffset = 62;
  const topY = FIRST_ROW_Y;
  const bottomY = topY + ROW_SPACING;
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

// Room height grows with the number of occupied rows — never below the two
// rows of pre-placed seats; the break area and the entrance are anchored to
// the bottom edge rather than floating below the last desk row.
export function computeLayout(usedSeats) {
  let maxRows = Math.ceil(SEAT_COUNT / GRID_COLUMNS);
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
