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

test('computeLayout: an empty room still sizes for the pre-placed seats', () => {
  // SEAT_COUNT (8) seats over GRID_COLUMNS (4) columns = two rows up front.
  assert.deepEqual(computeLayout(new Set()), { height: 692, breakTop: 542 });
});

test('computeLayout: overflowing the pre-placed seats grows the room', () => {
  // Seat 8 sits on row index 2, beyond the two pre-placed rows.
  assert.deepEqual(computeLayout(new Set([8])), { height: 864, breakTop: 714 });
});

test('deskPosition: fills columns then wraps to the next row', () => {
  assert.deepEqual(deskPosition(0), { x: 400, y: 240 });
  assert.deepEqual(deskPosition(3), { x: 850, y: 240 });
  assert.deepEqual(deskPosition(4), { x: 400, y: 412 });
});

test('residentDeskPosition: two upright columns over two spaced rows', () => {
  assert.deepEqual(residentDeskPosition(0), { x: 86, y: 240 });
  assert.deepEqual(residentDeskPosition(1), { x: 210, y: 240 });
  assert.deepEqual(residentDeskPosition(2), { x: 86, y: 412 });
  assert.deepEqual(residentDeskPosition(3), { x: 210, y: 412 });
});

test('both free-address rows line up with the resident island', () => {
  assert.equal(deskPosition(0).y, residentDeskPosition(0).y);
  assert.equal(deskPosition(4).y, residentDeskPosition(2).y);
});

test('breakSpot: fixed furniture first, then an overflow back row', () => {
  const layout = { breakTop: 490, height: 640 };
  assert.deepEqual(breakSpot(0, layout), { x: 268, y: 582 });
  assert.deepEqual(breakSpot(6, layout), { x: 180, y: 530 });
});

test('doorPosition: anchored to the break-area band', () => {
  assert.deepEqual(doorPosition({ breakTop: 490, height: 640 }), { x: 46, y: 582 });
});
