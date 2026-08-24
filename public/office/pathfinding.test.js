// Unit tests for the pure grid pathfinding (pathfinding.js). No canvas or DOM,
// so these run under `node --test` like the other ./office/ suites.

import test from 'node:test';
import assert from 'node:assert/strict';

import { deskFootprint, findPath, PATH_CELL } from './pathfinding.js';

// Does any point sampled along the waypoint chain (start included) fall inside
// a raw obstacle rect? Planning keeps a margin, so a clean route never does.
function pathTouches(start, waypoints, obstacles) {
  const points = [start, ...waypoints];
  for (let leg = 0; leg < points.length - 1; leg += 1) {
    const a = points[leg];
    const b = points[leg + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (PATH_CELL / 2)));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      for (const rect of obstacles) {
        if (x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height) {
          return true;
        }
      }
    }
  }
  return false;
}

test('deskFootprint: covers the monitor-to-legs box, clearing the chair below', () => {
  const box = deskFootprint({ x: 200, y: 300 });
  assert.deepEqual(box, { x: 144, y: 216, width: 112, height: 94 });
  // The chair sits at anchor + 18, just past the box's bottom edge (216 + 94).
  assert.ok(300 + 18 > box.y + box.height);
});

test('findPath: an unobstructed hop straightens to a single waypoint at the goal', () => {
  const start = { x: 40, y: 100 };
  const goal = { x: 360, y: 100 };
  const path = findPath(start, goal, [], { width: 400, height: 200 });
  assert.deepEqual(path, [{ x: 360, y: 100 }]);
});

test('findPath: routes around a wall instead of crossing it', () => {
  const bounds = { width: 400, height: 200 };
  // A wall spanning the top, leaving a gap along the bottom band.
  const obstacles = [{ x: 190, y: 0, width: 20, height: 150 }];
  const start = { x: 40, y: 100 };
  const goal = { x: 360, y: 100 };
  const path = findPath(start, goal, obstacles, bounds);
  assert.ok(path.length >= 1);
  // Ends at the goal and never passes through the wall.
  assert.deepEqual(path[path.length - 1], { x: 360, y: 100 });
  assert.equal(pathTouches(start, path, obstacles), false);
});

test('findPath: threads the aisle between two desks in a row', () => {
  const bounds = { width: 400, height: 300 };
  // Two desks 150px apart (the free-address column pitch): a ~38px aisle.
  const obstacles = [deskFootprint({ x: 120, y: 150 }), deskFootprint({ x: 270, y: 150 })];
  const start = { x: 195, y: 40 };
  const goal = { x: 195, y: 260 };
  const path = findPath(start, goal, obstacles, bounds);
  assert.deepEqual(path[path.length - 1], goal);
  assert.equal(pathTouches(start, path, obstacles), false);
});

test('findPath: a fully enclosed goal falls back to a straight hop', () => {
  const bounds = { width: 400, height: 200 };
  // A ring sealing the goal off from the start.
  const obstacles = [
    { x: 280, y: 60, width: 80, height: 10 },
    { x: 280, y: 130, width: 80, height: 10 },
    { x: 280, y: 60, width: 10, height: 80 },
    { x: 350, y: 60, width: 10, height: 80 },
  ];
  const start = { x: 40, y: 100 };
  const goal = { x: 320, y: 100 };
  const path = findPath(start, goal, obstacles, bounds);
  assert.deepEqual(path, [{ x: 320, y: 100 }]);
});
