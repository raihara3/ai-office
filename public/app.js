// SSE client + Slack-like #general chat rendering.

(() => {
  const chatElement = document.getElementById('chat');
  const composerElement = document.getElementById('composer');
  const sendButton = document.getElementById('composer-send');
  const connectionElement = document.getElementById('connection');

  const CLI_COLORS = { claude: '#d97757', codex: '#e8e8e8', gemini: '#7aa2f7' };
  const AUTHOR_COLORS = { user: '#e0af68', hr: '#8a93a6' };

  function escapeHtml(text) {
    return String(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  // Highlight @社長 / @here / @Claude (repo) style mentions.
  function highlightMentions(escapedText) {
    return escapedText.replace(
      /@(?:社長|here|(?:Claude|Codex|Gemini)(?:\s\([^)]*\))?)/g,
      (mention) => `<span class="mention">${mention}</span>`
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
  let pinnedToBottom = true;
  chatElement.addEventListener('scroll', () => {
    pinnedToBottom =
      chatElement.scrollHeight - chatElement.scrollTop - chatElement.clientHeight < 60;
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
      renderChat(snapshot);
    };
    source.onerror = () => {
      connectionElement.textContent = '○ 再接続待ち…';
    };
  }

  connect();
})();
