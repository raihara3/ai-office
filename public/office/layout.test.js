// Unit tests for the pure office geometry (layout.js). No canvas or DOM is
// touched, so these run under `node --test` like the server-side suites.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addTeamSlot,
  computeLayout,
  deskPosition,
  breakSpot,
  doorPosition,
  lowestFreeSeat,
  roomDeskPosition,
  roomDeskHitRect,
  roomMonitorHitRect,
  teamLabelHitRect,
  teamRooms,
  WHITEBOARD,
} from './layout.js';

const DEFAULT_TEAMS = [{ id: 'default', name: '常駐チーム', seatCount: 6 }];

test('lowestFreeSeat: empty -> 0, contiguous -> next, gap -> fills gap', () => {
  assert.equal(lowestFreeSeat(new Set()), 0);
  assert.equal(lowestFreeSeat(new Set([0, 1, 2])), 3);
  assert.equal(lowestFreeSeat(new Set([0, 2, 3])), 1);
});

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

test('roomDeskPosition: three upright columns over spaced rows', () => {
  const [room] = teamRooms(DEFAULT_TEAMS);
  assert.deepEqual(roomDeskPosition(room, 0), { x: 86, y: 240 });
  assert.deepEqual(roomDeskPosition(room, 1), { x: 210, y: 240 });
  assert.deepEqual(roomDeskPosition(room, 2), { x: 334, y: 240 });
  assert.deepEqual(roomDeskPosition(room, 3), { x: 86, y: 412 });
  assert.deepEqual(roomDeskPosition(room, 5), { x: 334, y: 412 });
  // A second room's desks shift with the room.
  const second = teamRooms([...DEFAULT_TEAMS, { id: 'b', name: 'B', seatCount: 3 }])[1];
  assert.deepEqual(roomDeskPosition(second, 0), { x: 530, y: 240 });
});

test('addTeamSlot: after the last room, or at the left edge with no teams', () => {
  const rooms = teamRooms(DEFAULT_TEAMS);
  assert.deepEqual(addTeamSlot(rooms), { x: 452, y: 104, width: 120, height: 172 });
  assert.equal(addTeamSlot([]).x, 8);
});

test('computeLayout: one 6-seat team reproduces the classic scene heights', () => {
  const layout = computeLayout(new Set(), DEFAULT_TEAMS);
  assert.equal(layout.height, 692);
  assert.equal(layout.breakTop, 542);
  assert.equal(layout.freeGridX, 684); // add slot 452..572 + gap
  assert.equal(layout.width, 1120); // free grid last column 984 + margin
});

test('computeLayout: overflowing the pre-placed rows grows the room', () => {
  const layout = computeLayout(new Set([6]), DEFAULT_TEAMS);
  assert.equal(layout.height, 864);
  assert.equal(layout.breakTop, 714);
});

test('computeLayout: a tall team room grows the world and stays above the break area', () => {
  const layout = computeLayout(new Set(), [{ id: 'a', name: 'A', seatCount: 12 }]);
  assert.equal(layout.height, 1036);
  assert.equal(layout.breakTop, 886);
  const [room] = layout.rooms;
  assert.ok(room.y + room.height <= layout.breakTop);
});

test('deskPosition: fills columns then wraps, anchored to freeGridX', () => {
  const { freeGridX } = computeLayout(new Set(), DEFAULT_TEAMS);
  assert.deepEqual(deskPosition(0, freeGridX), { x: 684, y: 240 });
  assert.deepEqual(deskPosition(2, freeGridX), { x: 984, y: 240 });
  assert.deepEqual(deskPosition(3, freeGridX), { x: 684, y: 412 });
});

test('free-address rows line up with the team rooms', () => {
  const layout = computeLayout(new Set(), DEFAULT_TEAMS);
  const [room] = layout.rooms;
  assert.equal(deskPosition(0, layout.freeGridX).y, roomDeskPosition(room, 0).y);
  assert.equal(deskPosition(3, layout.freeGridX).y, roomDeskPosition(room, 3).y);
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

test('breakSpot: fixed furniture first, then an overflow back row', () => {
  const layout = { breakTop: 490, height: 640 };
  assert.deepEqual(breakSpot(0, layout), { x: 268, y: 582 });
  assert.deepEqual(breakSpot(6, layout), { x: 180, y: 530 });
});

test('doorPosition: anchored to the break-area band', () => {
  assert.deepEqual(doorPosition({ breakTop: 490, height: 640 }), { x: 46, y: 582 });
});
