// Purely cosmetic small talk between avatars resting in the break area: one
// speaks, a beat later another replies, then it goes quiet for a while. The
// state machine is isolated here (randomness injectable) so it can be driven
// deterministically in tests, away from the render loop.

export const SMALL_TALK_LINES = [
  ['おつかれさま〜', 'おつかれさまです'],
  ['そっち忙しそうだね', 'それほどでもないよ'],
  ['最近どう?', 'ぼちぼちです'],
  ['ここのコーヒーおいしいね', 'わかる'],
  ['休憩は大事だね', 'ほんとそれ'],
  ['今日は調子いいかも', 'いいですね〜'],
];

export function createSmallTalk({ random = Math.random, lines = SMALL_TALK_LINES } = {}) {
  const state = {
    phase: 'idle',
    nextAt: 5000,
    phaseUntil: 0,
    speakerKey: null,
    replyKey: null,
    line: null,
  };

  // Advance the machine for the current frame. `restingKeys` are the avatars
  // currently on break and thus eligible to chat.
  function update(time, restingKeys) {
    if (state.phase === 'idle') {
      if (time < state.nextAt || restingKeys.length < 2) return;
      const speakerIndex = Math.floor(random() * restingKeys.length);
      let replyIndex = Math.floor(random() * (restingKeys.length - 1));
      if (replyIndex >= speakerIndex) replyIndex += 1;
      state.speakerKey = restingKeys[speakerIndex];
      state.replyKey = restingKeys[replyIndex];
      state.line = lines[Math.floor(random() * lines.length)];
      state.phase = 'speak';
      state.phaseUntil = time + 2800;
      return;
    }
    const bothResting =
      restingKeys.includes(state.speakerKey) && restingKeys.includes(state.replyKey);
    if (!bothResting) {
      state.phase = 'idle';
      state.nextAt = time + 6000;
      return;
    }
    if (time >= state.phaseUntil) {
      if (state.phase === 'speak') {
        state.phase = 'reply';
        state.phaseUntil = time + 2800;
      } else {
        state.phase = 'idle';
        state.nextAt = time + 9000 + random() * 12000;
      }
    }
  }

  // The line an avatar should show this frame, or null if it isn't its turn.
  function bubbleFor(key) {
    if (state.phase === 'speak' && key === state.speakerKey) return state.line[0];
    if (state.phase === 'reply' && key === state.replyKey) return state.line[1];
    return null;
  }

  return { update, bubbleFor };
}
