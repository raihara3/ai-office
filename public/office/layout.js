// Pure geometry for the office scene: where team rooms and the entrance
// lobby sit, and how seats are assigned. No canvas or DOM here, so this
// module is unit-testable and shared by the renderer.

// The team rooms' top desk row. Kept low enough that a desk's nameplate chip
// (drawn 106px above the anchor) stays clear of the wall's baseboard.
export const FIRST_ROW_Y = 240;
// The packing limit for rows: a desk's nameplate chip starts 106px above its
// anchor, while the row above extends 64px below its anchor (the subagent
// mini-avatars and their labels), leaving a couple of pixels of clearance.
export const ROW_SPACING = 172;

// Team rooms: fixed partitions pinned to the top-left edge, laid left to
// right in team order and wrapping to a new band after every third room so
// the scene grows downward instead of running ever wider. Every room is
// three desk columns wide (124px pitch plus a 20px margin each side — the
// same footprint the single resident room had), and grows downward by rows
// of ceil(seatCount / deskColumns).
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
// Clearance between the widest room band and the right wall, keeping room
// for the wall-side plants.
const RIGHT_MARGIN = 136;
// The entrance lobby band pinned to the bottom edge of the scene, walled off
// from the work area by a partition; visitors arrive and leave through the
// elevator on its left side.
// Tall enough that a visitor on the bench row (feet at entranceTop + 128)
// keeps its subagent minis and their labels (down to +174) on the canvas.
export const ENTRANCE_HEIGHT = 190;
// The partition wall between the work area and the entrance lobby: plaster
// face, baseboard and the decorative office door are drawn within this band.
export const PARTITION_HEIGHT = 46;

// Desks pack into a near-square grid so small teams keep two shorter rows
// instead of one wide one: 1–2 seats → 1 column, 3–4 → 2, 5–6 → 3, capped at
// the room's three-column width for larger teams (7+ seats wrap to more rows).
export function deskColumns(seatCount) {
  return Math.min(ROOM_COLUMNS, Math.max(1, Math.ceil(seatCount / 2)));
}

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
    const rows = Math.max(1, Math.ceil(team.seatCount / deskColumns(team.seatCount)));
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

// Desk anchor within a room; index 0..seatCount-1, deskColumns(seatCount)
// columns per row, centered under the room's midline.
// The y tracks the room's top edge so desks follow a wrapped room down.
export function roomDeskPosition(room, index) {
  const centerX = room.x + room.width / 2;
  const columns = deskColumns(room.seatCount);
  return {
    x: centerX + ((index % columns) - (columns - 1) / 2) * DESK_COLUMN_PITCH,
    y: room.y + DESK_OFFSET_Y + Math.floor(index / columns) * ROW_SPACING,
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

// The whole scene: team rooms, the entrance lobby band, and the world size.
// Width grows with the widest room band; height grows with the deepest desk
// row; the entrance is anchored to the bottom edge.
export function computeLayout(teams = []) {
  const rooms = teamRooms(teams);
  let roomsRight = 8;
  let lastRowY = FIRST_ROW_Y;
  for (const room of rooms) {
    roomsRight = Math.max(roomsRight, room.x + room.width);
    lastRowY = Math.max(lastRowY, roomDeskPosition(room, room.seatCount - 1).y);
  }
  const height = Math.max(640, lastRowY + 280);
  const entranceTop = height - ENTRANCE_HEIGHT;
  const width = Math.max(MIN_WIDTH, roomsRight + RIGHT_MARGIN);
  return { width, height, entranceTop, rooms };
}

// Lobby furniture, x in world space and y relative to entranceTop. Drawn by
// office.js and grown into the pathfinding obstacles below, and kept here so
// the tests can pin that no waiting spot ever lands inside a blocked rect.
export const ELEVATOR = { x: 12, y: 12, width: 72, height: 136 };
export const RECEPTION = { x: 120, y: 72, width: 140, height: 32 };
export const BENCH = { x: 340, y: 64, width: 230, height: 34 };

// The rects lobby walkers must route around: the partition wall (so a path
// never cuts through the work area), the elevator shell (including its outer
// frame), the reception counter and the bench.
export function entranceObstacles(layout) {
  const top = layout.entranceTop;
  return [
    { x: 0, y: top, width: layout.width, height: PARTITION_HEIGHT },
    { x: ELEVATOR.x - 4, y: top + ELEVATOR.y - 8, width: ELEVATOR.width + 8, height: ELEVATOR.height + 8 },
    { x: RECEPTION.x, y: top + RECEPTION.y, width: RECEPTION.width, height: RECEPTION.height },
    { x: BENCH.x, y: top + BENCH.y, width: BENCH.width, height: BENCH.height },
  ];
}

// Waiting spots for visitors in the entrance lobby: in front of the bench,
// then the open floor to its right. Beyond the fixed spots, extra visitors
// overflow onto a back row along the bottom edge.
export function entranceSpot(index, layout) {
  const top = layout.entranceTop;
  const spots = [
    { x: 360, y: top + 128 },
    { x: 424, y: top + 128 },
    { x: 488, y: top + 128 },
    { x: 552, y: top + 128 },
    { x: 640, y: top + 132 },
    { x: 704, y: top + 132 },
  ];
  if (index < spots.length) return spots[index];
  return { x: 340 + ((index - spots.length) % 8) * 56, y: top + 172 };
}

// Where visitors step in and out of the elevator, just in front of its doors
// on the lobby's left side.
export function elevatorPosition(layout) {
  return { x: 48, y: layout.entranceTop + 158 };
}
