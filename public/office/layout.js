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
// right in team order and wrapping to a new band after every third room so
// the scene grows downward instead of running ever wider. Every room is
// three desk columns wide (124px pitch plus a 20px margin each side — the
// same footprint the single resident room had), and grows downward by rows
// of ceil(seatCount / 3).
export const ROOM_Y = 104;
export const ROOM_WIDTH = 404;
export const ROOM_GAP = 40;
export const ROOM_COLUMNS = 3;
// Rooms per band before wrapping onto the next band below.
export const TEAMS_PER_ROW = 3;
// Vertical air between stacked room bands: clears the deepest desk's avatar
// and subagent minis (which overflow ~28px below the room box) before the
// next band's carpet begins.
export const ROOM_ROW_GAP = 64;
// The top desk row sits this far below its room's top edge, so desks track
// the room when it wraps to a lower band (FIRST_ROW_Y for a top-band room).
const DESK_OFFSET_Y = FIRST_ROW_Y - ROOM_Y;
// Mirrors MAX_TEAM_SEATS in server/residents/resident-store.js.
export const MAX_TEAM_SEATS = 12;
const DESK_COLUMN_PITCH = 124;
const MIN_WIDTH = 960;
// Clearance between the free grid's last column anchor and the right wall,
// preserving the pre-teams 960-wide scene's margin.
const RIGHT_MARGIN = 136;
// Aisle between the last team room and the free grid's first desk anchor.
const FREE_GRID_GAP = 112;

// One room rect per team, in snapshot (creation) order. Rooms fill a band
// left to right and wrap after TEAMS_PER_ROW; each band sits below the
// tallest room of the band above it, so seat-heavy teams never clip.
export function teamRooms(teams) {
  const rooms = [];
  let bandTop = ROOM_Y;
  let bandHeight = 0;
  teams.forEach((team, index) => {
    const column = index % TEAMS_PER_ROW;
    if (index > 0 && column === 0) {
      bandTop += bandHeight + ROOM_ROW_GAP;
      bandHeight = 0;
    }
    const rows = Math.max(1, Math.ceil(team.seatCount / ROOM_COLUMNS));
    // 6 seats → 2 rows → 344, pixel-identical to the pre-teams room.
    const height = rows * ROW_SPACING;
    rooms.push({
      id: team.id,
      name: team.name,
      seatCount: team.seatCount,
      rows,
      x: 8 + column * (ROOM_WIDTH + ROOM_GAP),
      y: bandTop,
      width: ROOM_WIDTH,
      height,
    });
    bandHeight = Math.max(bandHeight, height);
  });
  return rooms;
}

// Desk anchor within a room; index 0..seatCount-1, three columns per row.
// The y tracks the room's top edge so desks follow a wrapped room down.
export function roomDeskPosition(room, index) {
  const centerX = room.x + room.width / 2;
  return {
    x: centerX + ((index % ROOM_COLUMNS) - 1) * DESK_COLUMN_PITCH,
    y: room.y + DESK_OFFSET_Y + Math.floor(index / ROOM_COLUMNS) * ROW_SPACING,
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
  // The free grid clears the widest band, not just the last room, now that
  // rooms wrap; its deepest desk row also floors the world height.
  let roomsRight = 8;
  let lastRowY = FIRST_ROW_Y + (Math.ceil(SEAT_COUNT / GRID_COLUMNS) - 1) * ROW_SPACING;
  for (const room of rooms) {
    roomsRight = Math.max(roomsRight, room.x + room.width);
    lastRowY = Math.max(lastRowY, roomDeskPosition(room, room.seatCount - 1).y);
  }
  const freeGridX = roomsRight + FREE_GRID_GAP;
  for (const seat of usedSeats) {
    lastRowY = Math.max(lastRowY, FIRST_ROW_Y + Math.floor(seat / GRID_COLUMNS) * ROW_SPACING);
  }
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
