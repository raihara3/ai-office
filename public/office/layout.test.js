// Unit tests for the pure office geometry (layout.js). No canvas or DOM is
// touched, so these run under `node --test` like the server-side suites.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLayout,
  deskPosition,
  breakSpot,
  doorPosition,
  lowestFreeSeat,
  residentDeskPosition,
} from './layout.js';

test('lowestFreeSeat: empty -> 0, contiguous -> next, gap -> fills gap', () => {
  assert.equal(lowestFreeSeat(new Set()), 0);
  assert.equal(lowestFreeSeat(new Set([0, 1, 2])), 3);
  assert.equal(lowestFreeSeat(new Set([0, 2, 3])), 1);
});

test('computeLayout: empty room uses the minimum height', () => {
  assert.deepEqual(computeLayout(new Set()), { height: 640, breakTop: 490 });
});

test('computeLayout: a second row grows the room height', () => {
  // Seat 5 sits on row index 1, so the room needs two rows of desks.
  assert.deepEqual(computeLayout(new Set([5])), { height: 730, breakTop: 580 });
});

test('deskPosition: fills columns then wraps to the next row', () => {
  assert.deepEqual(deskPosition(0), { x: 360, y: 260 });
  assert.deepEqual(deskPosition(4), { x: 896, y: 260 });
  assert.deepEqual(deskPosition(5), { x: 360, y: 450 });
});

test('residentDeskPosition: two upright columns over two spaced rows', () => {
  assert.deepEqual(residentDeskPosition(0), { x: 86, y: 200 });
  assert.deepEqual(residentDeskPosition(1), { x: 210, y: 200 });
  assert.deepEqual(residentDeskPosition(2), { x: 86, y: 328 });
  assert.deepEqual(residentDeskPosition(3), { x: 210, y: 328 });
});

test('breakSpot: fixed furniture first, then an overflow back row', () => {
  const layout = { breakTop: 490, height: 640 };
  assert.deepEqual(breakSpot(0, layout), { x: 268, y: 582 });
  assert.deepEqual(breakSpot(6, layout), { x: 180, y: 530 });
});

test('doorPosition: anchored to the break-area band', () => {
  assert.deepEqual(doorPosition({ breakTop: 490, height: 640 }), { x: 46, y: 582 });
});
