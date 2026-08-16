// Unit tests for the break-room small-talk state machine (small-talk.js).
// Randomness is injected so speaker/reply selection is deterministic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSmallTalk } from './small-talk.js';

// A random() that replays a fixed queue, then falls back to 0.
function stubRandom(values) {
  const queue = [...values];
  return () => (queue.length > 0 ? queue.shift() : 0);
}

const LINES = [['hi', 'yo']];

test('stays quiet until at least two avatars are resting', () => {
  const smallTalk = createSmallTalk({ random: stubRandom([]), lines: LINES });
  smallTalk.update(10_000, ['a']);
  assert.equal(smallTalk.bubbleFor('a'), null);
});

test('speak then reply, driven by the clock', () => {
  // random() -> speakerIndex 'a', replyIndex 'b', line 0.
  const smallTalk = createSmallTalk({ random: stubRandom([0, 0, 0]), lines: LINES });

  smallTalk.update(5_000, ['a', 'b']);
  assert.equal(smallTalk.bubbleFor('a'), 'hi');
  assert.equal(smallTalk.bubbleFor('b'), null);

  // Past the speak window: the reply lands.
  smallTalk.update(7_800, ['a', 'b']);
  assert.equal(smallTalk.bubbleFor('b'), 'yo');
  assert.equal(smallTalk.bubbleFor('a'), null);
});

test('resets to idle if a conversation partner leaves the break area', () => {
  const smallTalk = createSmallTalk({ random: stubRandom([0, 0, 0]), lines: LINES });
  smallTalk.update(5_000, ['a', 'b']);
  assert.equal(smallTalk.bubbleFor('a'), 'hi');

  // 'b' went back to work; the bubble clears.
  smallTalk.update(6_000, ['a']);
  assert.equal(smallTalk.bubbleFor('a'), null);
});
