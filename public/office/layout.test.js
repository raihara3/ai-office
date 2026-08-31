// Unit tests for the pure office geometry (layout.js). No canvas or DOM is
// touched, so these run under `node --test` like the server-side suites.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLayout,
  elevatorPosition,
  entranceObstacles,
  entranceSpot,
  roomDeskPosition,
  roomDeskHitRect,
  roomMonitorHitRect,
  teamLabelHitRect,
  teamRooms,
  ENTRANCE_HEIGHT,
  PARTITION_HEIGHT,
  WHITEBOARD,
} from './layout.js';

const DEFAULT_TEAMS = [{ id: 'default', name: '常駐チーム', seatCount: 6 }];

test('teamRooms: a 6-seat team reproduces the pre-teams room pixel for pixel', () => {
  const [room] = teamRooms(DEFAULT_TEAMS);
  assert.deepEqual(
    { x: room.x, y: room.y, width: room.width, height: room.height },
    { x: 8, y: 104, width: 404, height: 344 }
  );
});

test('teamRooms: rooms line up left to right, rows follow seat count', () => {
  const rooms = teamRooms([
    { id: 'a', name: 'A', seatCount: 6 },
    { id: 'b', name: 'B', seatCount: 12 },
    { id: 'c', name: 'C', seatCount: 1 },
  ]);
  assert.equal(rooms[1].x, 452); // 8 + 404 + 40
  assert.equal(rooms[2].x, 896);
  assert.equal(rooms[1].rows, 4);
  assert.equal(rooms[1].height, 688);
  assert.equal(rooms[2].rows, 1);
  assert.equal(rooms[2].height, 172);
});

test('teamRooms: a fourth room wraps to a new band below the first', () => {
  const rooms = teamRooms([
    { id: 'a', name: 'A', seatCount: 6 }, // 2 rows, height 344
    { id: 'b', name: 'B', seatCount: 3 },
    { id: 'c', name: 'C', seatCount: 3 },
    { id: 'd', name: 'D', seatCount: 3 },
  ]);
  // First three stay in the top band, wrapping back to x=8 on the fourth.
  assert.equal(rooms[3].x, 8);
  // Band drops below the tallest top-band room (344) plus the 64 air gap.
  assert.equal(rooms[3].y, 104 + 344 + 64);
  // Desks track the wrapped room down.
  assert.equal(roomDeskPosition(rooms[3], 0).y, rooms[3].y + 136);
});

test('roomDeskPosition: three upright columns over spaced rows', () => {
  const [room] = teamRooms(DEFAULT_TEAMS);
  assert.deepEqual(roomDeskPosition(room, 0), { x: 86, y: 240 });
  assert.deepEqual(roomDeskPosition(room, 1), { x: 210, y: 240 });
  assert.deepEqual(roomDeskPosition(room, 2), { x: 334, y: 240 });
  assert.deepEqual(roomDeskPosition(room, 3), { x: 86, y: 412 });
  assert.deepEqual(roomDeskPosition(room, 5), { x: 334, y: 412 });
  // A second room's desks shift with the room.
  const second = teamRooms([...DEFAULT_TEAMS, { id: 'b', name: 'B', seatCount: 6 }])[1];
  assert.deepEqual(roomDeskPosition(second, 0), { x: 530, y: 240 });
});

test('roomDeskPosition: desks pack into a near-square grid by seat count', () => {
  // 4 seats → a 2×2 grid centered in a 2-column room (width 280, x 86 / 210).
  const [four] = teamRooms([{ id: 'a', name: 'A', seatCount: 4 }]);
  assert.equal(four.width, 280);
  assert.deepEqual(roomDeskPosition(four, 0), { x: 86, y: 240 });
  assert.deepEqual(roomDeskPosition(four, 1), { x: 210, y: 240 });
  assert.deepEqual(roomDeskPosition(four, 2), { x: 86, y: 412 });
  assert.deepEqual(roomDeskPosition(four, 3), { x: 210, y: 412 });
  // 3 seats share the 4-seat layout: two columns, second row half full.
  const [three] = teamRooms([{ id: 'b', name: 'B', seatCount: 3 }]);
  assert.equal(three.width, 280);
  assert.deepEqual(roomDeskPosition(three, 2), { x: 86, y: 412 });
  // 2 seats → a single column in a narrow 1-column room (width 156, x 86).
  const [two] = teamRooms([{ id: 'c', name: 'C', seatCount: 2 }]);
  assert.equal(two.width, 156);
  assert.deepEqual(roomDeskPosition(two, 0), { x: 86, y: 240 });
  assert.deepEqual(roomDeskPosition(two, 1), { x: 86, y: 412 });
});

test('teamRooms: small teams grow taller as desks stack into rows', () => {
  const rooms = teamRooms([
    { id: 'a', name: 'A', seatCount: 2 }, // 1 column → 2 rows
    { id: 'b', name: 'B', seatCount: 4 }, // 2 columns → 2 rows
    { id: 'c', name: 'C', seatCount: 5 }, // 3 columns → 2 rows
  ]);
  assert.deepEqual([rooms[0].rows, rooms[1].rows, rooms[2].rows], [2, 2, 2]);
  assert.equal(rooms[0].height, 344);
});

test('computeLayout: one 6-seat team reproduces the classic scene heights', () => {
  const layout = computeLayout(DEFAULT_TEAMS);
  assert.equal(layout.height, 692);
  assert.equal(layout.entranceTop, 692 - ENTRANCE_HEIGHT);
  assert.equal(layout.width, 960); // rooms end at 412, floored to MIN_WIDTH
});

test('computeLayout: a tall team room grows the world above the entrance', () => {
  const layout = computeLayout([{ id: 'a', name: 'A', seatCount: 12 }]);
  assert.equal(layout.height, 1036);
  assert.equal(layout.entranceTop, 1036 - ENTRANCE_HEIGHT);
  const [room] = layout.rooms;
  assert.ok(room.y + room.height <= layout.entranceTop);
});

test('computeLayout: a full band of rooms widens the world past MIN_WIDTH', () => {
  const layout = computeLayout([
    { id: 'a', name: 'A', seatCount: 3 },
    { id: 'b', name: 'B', seatCount: 3 },
    { id: 'c', name: 'C', seatCount: 3 },
  ]);
  // Each 3-seat room shrinks to 2 columns (width 280); the third ends at
  // 648 + 280, and the right margin (one room gap) clears the wall.
  assert.equal(layout.width, 648 + 280 + 40);
});

test('a room contains every desk row including the chairs', () => {
  for (const seatCount of [1, 6, 12]) {
    const [room] = teamRooms([{ id: 'a', name: 'A', seatCount }]);
    const lastDesk = roomDeskPosition(room, seatCount - 1);
    assert.ok(lastDesk.y + 36 <= room.y + room.height);
  }
});

test('roomDeskHitRect: covers the desk from nameplate to chair', () => {
  const [room] = teamRooms(DEFAULT_TEAMS);
  const desk = roomDeskPosition(room, 1);
  const hit = roomDeskHitRect(room, 1);
  assert.ok(hit.x <= desk.x - 56 && hit.x + hit.width >= desk.x + 56);
  assert.ok(hit.y <= desk.y - 106 && hit.y + hit.height >= desk.y + 20);
});

test('roomMonitorHitRect: caps the desk top and clears the avatar', () => {
  const [room] = teamRooms(DEFAULT_TEAMS);
  const desk = roomDeskPosition(room, 1);
  const deskRect = roomDeskHitRect(room, 1);
  const monitor = roomMonitorHitRect(room, 1);
  // Shares the desk's top-left, so the two bands tile from a common origin.
  assert.equal(monitor.x, deskRect.x);
  assert.equal(monitor.y, deskRect.y);
  assert.equal(monitor.width, deskRect.width);
  // Covers the monitor screen (drawn down to desk.y - 50)...
  assert.ok(monitor.y + monitor.height >= desk.y - 50);
  // ...but stops above the avatar (drawn at desk.y + 18), leaving it to the
  // settings target below.
  assert.ok(monitor.y + monitor.height < desk.y + 18);
});

test('teamLabelHitRect: sits in the room top band, clear of desk targets', () => {
  const [room] = teamRooms(DEFAULT_TEAMS);
  const label = teamLabelHitRect(room);
  assert.ok(label.x >= room.x && label.y >= room.y);
  // Row 0's desk hit rects start at 240 - 106 = 134; the label band ends above.
  assert.ok(label.y + label.height <= roomDeskHitRect(room, 0).y);
});

test('whiteboard hangs on the top wall above the first room', () => {
  const [room] = teamRooms(DEFAULT_TEAMS);
  assert.ok(WHITEBOARD.y + WHITEBOARD.height <= 96);
  assert.ok(WHITEBOARD.x + WHITEBOARD.width <= room.x + room.width);
});

test('entranceSpot: fixed lobby spots first, then an overflow back row', () => {
  const layout = computeLayout(DEFAULT_TEAMS);
  const top = layout.entranceTop;
  assert.deepEqual(entranceSpot(0, layout), { x: 360, y: top + 128 });
  assert.deepEqual(entranceSpot(5, layout), { x: 704, y: top + 132 });
  assert.deepEqual(entranceSpot(6, layout), { x: 340, y: top + 172 });
  // Every spot stays inside the lobby, below the partition wall.
  for (let index = 0; index < 14; index += 1) {
    const spot = entranceSpot(index, layout);
    assert.ok(spot.y > top + PARTITION_HEIGHT && spot.y < layout.height);
  }
});

test('no waiting spot or the elevator stop lands inside a blocked rect', () => {
  // Mirrors OBSTACLE_MARGIN in pathfinding.js: a walk target inside an
  // obstacle grown by this margin could strand an avatar outside its goal.
  const margin = 4;
  const clearOf = (point, rect) =>
    point.x < rect.x - margin ||
    point.x > rect.x + rect.width + margin ||
    point.y < rect.y - margin ||
    point.y > rect.y + rect.height + margin;
  const layout = computeLayout(DEFAULT_TEAMS);
  const obstacles = entranceObstacles(layout);
  const targets = [elevatorPosition(layout)];
  for (let index = 0; index < 14; index += 1) targets.push(entranceSpot(index, layout));
  for (const target of targets) {
    for (const rect of obstacles) {
      assert.ok(clearOf(target, rect), `(${target.x}, ${target.y}) blocked`);
    }
  }
});

test('elevatorPosition: anchored in front of the lobby elevator doors', () => {
  const layout = computeLayout(DEFAULT_TEAMS);
  const elevator = elevatorPosition(layout);
  assert.deepEqual(elevator, { x: 48, y: layout.entranceTop + 158 });
  assert.ok(elevator.y > layout.entranceTop + PARTITION_HEIGHT);
  assert.ok(elevator.y < layout.height);
});
