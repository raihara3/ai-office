// SSE client + Slack-like #general chat rendering.

(() => {
  const chatElement = document.getElementById('chat');
  const composerElement = document.getElementById('composer');
  const sendButton = document.getElementById('composer-send');
  const connectionElement = document.getElementById('connection');

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

  function playMentionChime() {
    try {
      const context = resumeAudioContext();
      if (context === null) return;
      const startAt = context.currentTime;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.1, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.4);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + 0.42);
    } catch {
      // Ignore audio failures (autoplay policy, unsupported browser).
    }
  }

  // Chime once when a snapshot introduces a message that mentions @社長.
  // The first snapshot only seeds the baseline id so history stays silent,
  // and the boss's own messages never trigger their own alert.
  let lastSeenMessageId = null;
  function alertOnBossMention(snapshot) {
    const messages = snapshot.messages ?? [];
    let maxId = lastSeenMessageId ?? -1;
    let hasFreshMention = false;
    for (const message of messages) {
      if (
        lastSeenMessageId !== null &&
        message.id > lastSeenMessageId &&
        message.authorKind !== 'user' &&
        message.text.includes('@社長')
      ) {
        hasFreshMention = true;
      }
      if (message.id > maxId) maxId = message.id;
    }
    lastSeenMessageId = maxId;
    if (hasFreshMention) playMentionChime();
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
      const preview = await (await fetch('/api/cleanup/preview')).json();
      const result = await (
        await fetch('/api/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            keys: preview.candidates.map((c) => c.key),
            text: document.getElementById('composer-input').value,
          }),
        })
      ).json();
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

  function connect() {
    const source = new EventSource('/events');
    source.onopen = () => {
      connectionElement.textContent = '● 接続中';
    };
    source.onmessage = (event) => {
      const snapshot = JSON.parse(event.data);
      window.OFFICE.setState(snapshot);
      alertOnBossMention(snapshot);
      renderChat(snapshot);
    };
    source.onerror = () => {
      connectionElement.textContent = '○ 再接続待ち…';
    };
  }

  connect();
})();
