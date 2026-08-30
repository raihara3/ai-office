// Pure geometry for the office scene: where team rooms, desks, break spots
// and the entrance sit, and how seats are assigned. No canvas or DOM here, so
// this module is unit-testable and shared by the renderer.

// The first free-address row shares its y with the team rooms' top desk row
// (both use the same desk anchor), so the islands line up horizontally.
// Kept low enough that a desk's nameplate chip (drawn 106px above the anchor)
// stays clear of the wall's baseboard.
export const FIRST_ROW_Y = 240;
// The packing limit for rows: a desk's nameplate chip starts 106px above its
// anchor, while the row above extends 64px below its anchor (the subagent
// mini-avatars and their labels), leaving a couple of pixels of clearance.
export const ROW_SPACING = 172;
export const GRID_COLUMNS = 3;
// Six seats are furnished up front (two rows of three); sessions beyond that
// still overflow onto extra rows below.
export const SEAT_COUNT = 6;
export const COLUMN_SPACING = 150;

// Team rooms: fixed partitions pinned to the top-left edge, laid left to
// right in team order. Every room is three desk columns wide (124px pitch
// plus a 20px margin each side — the same footprint the single resident room
// had), and grows downward by rows of ceil(seatCount / 3).
export const ROOM_Y = 104;
export const ROOM_WIDTH = 404;
export const ROOM_GAP = 40;
export const ROOM_COLUMNS = 3;
// Mirrors MAX_TEAM_SEATS in server/residents/resident-store.js.
export const MAX_TEAM_SEATS = 12;
const DESK_COLUMN_PITCH = 124;
const MIN_WIDTH = 960;
// Clearance between the free grid's last column anchor and the right wall,
// preserving the pre-teams 960-wide scene's margin.
const RIGHT_MARGIN = 136;
// Aisle between the last team room and the free grid's first desk anchor.
const FREE_GRID_GAP = 112;

// One room rect per team, in snapshot (creation) order.
export function teamRooms(teams) {
  return teams.map((team, index) => {
    const rows = Math.max(1, Math.ceil(team.seatCount / ROOM_COLUMNS));
    return {
      id: team.id,
      name: team.name,
      seatCount: team.seatCount,
      rows,
      x: 8 + index * (ROOM_WIDTH + ROOM_GAP),
      y: ROOM_Y,
      width: ROOM_WIDTH,
      // 6 seats → 2 rows → 344, pixel-identical to the pre-teams room.
      height: rows * ROW_SPACING,
    };
  });
}

// Desk anchor within a room; index 0..seatCount-1, three columns per row.
export function roomDeskPosition(room, index) {
  const centerX = room.x + room.width / 2;
  return {
    x: centerX + ((index % ROOM_COLUMNS) - 1) * DESK_COLUMN_PITCH,
    y: FIRST_ROW_Y + Math.floor(index / ROOM_COLUMNS) * ROW_SPACING,
  };
}

// The whiteboard on the top wall, between the first two windows: resident
// team reports to the human are posted here, so it is a click target.
export const WHITEBOARD = { x: 188, y: 16, width: 96, height: 58 };

// The clickable area of a team desk, spanning the nameplate chip (106px
// above the anchor) down past the chair, matching the drawn furniture.
export function roomDeskHitRect(room, index) {
  const desk = roomDeskPosition(room, index);
  return { x: desk.x - 58, y: desk.y - 106, width: 116, height: 132 };
}

// The desk hit area splits into two stacked targets so a tap can tell the
// monitor from the avatar: the upper band covers the nameplate chip and the
// monitor (the desktop surface sits at -46), opening the activity view; the
// lower band covers the desk, chair and avatar, opening the settings panel.
// The split leaves no dead zone — together the bands tile roomDeskHitRect.
export function roomMonitorHitRect(room, index) {
  const desk = roomDeskPosition(room, index);
  return { x: desk.x - 58, y: desk.y - 106, width: 116, height: 62 };
}

// The clickable band around the room's name label (drawn at x+8, y+22).
// Checked before desk hit rects: row 0's nameplate chips start at y 134, so
// the 30px band only overlaps dead room padding, never a desk target.
export function teamLabelHitRect(room) {
  return { x: room.x, y: room.y, width: 180, height: 30 };
}

// The lowest seat index not present in `usedSeats`. The grid fills from the
// top-left as sessions appear, reusing seats freed when avatars leave.
export function lowestFreeSeat(usedSeats) {
  let seat = 0;
  while (usedSeats.has(seat)) seat += 1;
  return seat;
}

// The whole scene: team rooms, where the free-address grid starts, and the
// world size. Width grows with the team count; height grows with the deepest
// desk row (team rooms or free-address overflow); the break area and the
// entrance are anchored to the bottom edge.
export function computeLayout(usedSeats, teams = []) {
  const rooms = teamRooms(teams);
  const last = rooms[rooms.length - 1];
  const freeGridX = (last ? last.x + last.width : 8) + FREE_GRID_GAP;
  let maxRows = Math.ceil(SEAT_COUNT / GRID_COLUMNS);
  for (const room of rooms) maxRows = Math.max(maxRows, room.rows);
  for (const seat of usedSeats) {
    maxRows = Math.max(maxRows, Math.floor(seat / GRID_COLUMNS) + 1);
  }
  const lastRowY = FIRST_ROW_Y + (maxRows - 1) * ROW_SPACING;
  const height = Math.max(640, lastRowY + 280);
  const breakTop = height - 150;
  const width = Math.max(
    MIN_WIDTH,
    freeGridX + (GRID_COLUMNS - 1) * COLUMN_SPACING + RIGHT_MARGIN
  );
  return { width, height, breakTop, freeGridX, rooms };
}

// Free-address desk anchor; the grid starts right of the last team room.
export function deskPosition(seat, freeGridX) {
  return {
    x: freeGridX + (seat % GRID_COLUMNS) * COLUMN_SPACING,
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
