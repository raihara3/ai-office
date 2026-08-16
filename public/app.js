// SSE client + Slack-like #general chat rendering.

(() => {
  const chatElement = document.getElementById('chat');
  const composerElement = document.getElementById('composer');
  const sendButton = document.getElementById('composer-send');
  const connectionElement = document.getElementById('connection');
  const client = window.OFFICE_CLIENT.create();

  const CLI_COLORS = { claude: '#d97757', codex: '#e8e8e8', gemini: '#7aa2f7' };
  const AUTHOR_COLORS = { user: '#a9b1d6', hr: '#8a93a6' };

  // Soft, low-volume chime for when the boss (@社長) is freshly mentioned.
  // Synthesized with WebAudio so no audio asset is needed; peak gain is kept
  // small on purpose so the alert stays gentle.
  let audioContext = null;
  function resumeAudioContext() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    if (audioContext === null) audioContext = new AudioCtor();
    if (audioContext.state === 'suspended') audioContext.resume();
    return audioContext;
  }

  // Browsers block WebAudio until it is created/resumed inside a user gesture.
  // Prime it on the first interaction anywhere so a later chime can play.
  // Safari additionally stays locked until a source actually starts inside the
  // gesture, so we play a one-sample silent buffer to fully unlock it.
  function unlockAudio() {
    try {
      const context = resumeAudioContext();
      if (context === null) return;
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, context.sampleRate);
      source.connect(context.destination);
      source.start(0);
    } catch {
      // Ignore; audio simply stays unavailable.
    }
  }
  for (const eventType of ['pointerdown', 'keydown']) {
    window.addEventListener(eventType, unlockAudio, { once: true, capture: true });
  }

  // Play a sequence of gentle sine notes. Each note is {freq, at, duration}
  // in seconds relative to now; peak is the shared linear gain.
  function playChime(notes, peak) {
    try {
      const context = resumeAudioContext();
      if (context === null) return;
      const base = context.currentTime;
      for (const note of notes) {
        const startAt = base + note.at;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(note.freq, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + note.duration);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + note.duration + 0.02);
      }
    } catch {
      // Ignore audio failures (autoplay policy, unsupported browser).
    }
  }

  // A single soft tone when a turn completes.
  function playCompletionChime() {
    playChime([{ freq: 880, at: 0, duration: 0.4 }], 0.3);
  }

  // A doorbell-like descending two-tone (ding-dong) so the boss's request for
  // confirmation stands out from the single completion tone. Louder than the
  // completion chime, with the second note held long to ring out ("pin-poon").
  function playAttentionChime() {
    playChime(
      [
        { freq: 880, at: 0, duration: 0.45 },
        { freq: 660, at: 0.34, duration: 0.95 },
      ],
      0.5
    );
  }

  // Chime once when a snapshot introduces a message that mentions @社長.
  // The first snapshot only seeds the baseline id so history stays silent,
  // and the boss's own messages never trigger their own alert. A request for
  // confirmation (🖐️) gets its own distinct chime.
  let lastSeenMessageId = null;
  function alertOnBossMention(snapshot) {
    const messages = snapshot.messages ?? [];
    let maxId = lastSeenMessageId ?? -1;
    let freshAttention = false;
    let freshCompletion = false;
    for (const message of messages) {
      if (
        lastSeenMessageId !== null &&
        message.id > lastSeenMessageId &&
        message.authorKind !== 'user' &&
        message.text.includes('@社長')
      ) {
        if (message.text.includes('確認をお願いします')) freshAttention = true;
        else freshCompletion = true;
      }
      if (message.id > maxId) maxId = message.id;
    }
    lastSeenMessageId = maxId;
    if (freshAttention) playAttentionChime();
    if (freshCompletion) playCompletionChime();
  }

  function escapeHtml(text) {
    return String(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  // Highlight @社長 / @here / @Claude (repo) style mentions.
  // Mentions of the user (@社長) get Slack's "you were mentioned" amber.
  function highlightMentions(escapedText) {
    return escapedText.replace(
      /@(?:社長|here|(?:Claude|Codex|Gemini)(?:\s\([^)]*\))?)/g,
      (mention) =>
        `<span class="mention${mention === '@社長' ? ' self' : ''}">${mention}</span>`
    );
  }

  function avatarChip(message, color) {
    const kind =
      message.authorKind === 'agent' ? message.cli : message.authorKind;
    const faceUrl = window.OFFICE.faceDataUrl(kind);
    if (!faceUrl) {
      return `<div class="msg-avatar" style="background:${color}22;color:${color}">?</div>`;
    }
    return `<img class="msg-avatar face" src="${faceUrl}" alt="" style="background:${color}22">`;
  }

  function authorColor(message) {
    if (message.authorKind === 'agent') return CLI_COLORS[message.cli] ?? '#a9b1d6';
    return AUTHOR_COLORS[message.authorKind] ?? '#a9b1d6';
  }

  function formatTime(at) {
    const date = new Date(at);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
  }

  // Keep the view pinned to the newest message unless the user scrolled up.
  // The scrollbar only shows while actually scrolling.
  let pinnedToBottom = true;
  let scrollbarHideTimer = null;
  chatElement.addEventListener('scroll', () => {
    pinnedToBottom =
      chatElement.scrollHeight - chatElement.scrollTop - chatElement.clientHeight < 60;
    chatElement.classList.add('scrolling');
    clearTimeout(scrollbarHideTimer);
    scrollbarHideTimer = setTimeout(() => chatElement.classList.remove('scrolling'), 800);
  });

  function renderChat(snapshot) {
    chatElement.innerHTML = (snapshot.messages ?? [])
      .map((message) => {
        const color = authorColor(message);
        const reactions = message.reactions.length
          ? `<div class="reactions">${message.reactions
              .map((emoji) => `<span class="reaction">${emoji} 1</span>`)
              .join('')}</div>`
          : '';
        return `
          <div class="message">
            ${avatarChip(message, color)}
            <div class="msg-body">
              <div class="msg-head">
                <span class="msg-name" style="color:${color}">${escapeHtml(message.authorName)}</span>
                <span class="msg-time">${formatTime(message.at)}</span>
              </div>
              <div class="msg-text">${highlightMentions(escapeHtml(message.text))}</div>
              ${reactions}
            </div>
          </div>`;
      })
      .join('');
    if (pinnedToBottom) chatElement.scrollTop = chatElement.scrollHeight;
  }

  let cleanupInFlight = false;
  composerElement.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (cleanupInFlight) return;
    cleanupInFlight = true;
    sendButton.disabled = true;
    try {
      const result = await client.runCleanup(
        document.getElementById('composer-input').value
      );
      window.OFFICE.hrSay(
        result.retired.length > 0
          ? `${result.retired.length}人が退勤しました`
          : 'サボっている人はいませんでした'
      );
    } catch {
      window.OFFICE.hrSay('退勤処理に失敗しました');
    } finally {
      cleanupInFlight = false;
      sendButton.disabled = false;
    }
  });

  client.connect({
    onSnapshot: (snapshot) => {
      window.OFFICE.setState(snapshot);
      alertOnBossMention(snapshot);
      renderChat(snapshot);
    },
    onStatus: (status) => {
      connectionElement.textContent =
        status === 'connected' ? '● 接続中' : '○ 再接続待ち…';
    },
  });
})();
