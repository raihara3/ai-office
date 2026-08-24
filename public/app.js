// SSE client: app bar, kanban strip, report inbox, board view and the right
// drawer (card detail / task filing / resident settings / activity).

(() => {
  const connectionElement = document.getElementById('connection');
  const client = window.OFFICE_CLIENT.create();

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

  // A single soft tone when a report lands in the inbox.
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

  // Chime once when a snapshot introduces a message that mentions @社長. Only
  // two events are worth a sound: a session raising 🖐️ because it needs the
  // boss's permission or answer (確認をお願いします → attention chime), and a
  // report landing in the inbox (報告を掲示しました → completion chime, or the
  // attention chime when the report is flagged review-needed). A plain
  // turn-completion from a regular session is neither, so it stays silent.
  // The first snapshot only seeds the baseline id so history stays silent,
  // and the boss's own messages never trigger their own alert.
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
        else if (message.text.includes('報告を掲示しました')) freshCompletion = true;
      }
      if (message.id > maxId) maxId = message.id;
    }
    lastSeenMessageId = maxId;
    if (freshAttention) playAttentionChime();
    if (freshCompletion) playCompletionChime();
  }

  // Quotes are escaped too: escaped text is interpolated into attribute
  // values (e.g. linkify's href), where a raw quote would break out.
  function escapeHtml(text) {
    return String(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
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

  function field(id) {
    return document.getElementById(id);
  }

  // Light/dark theme toggle. index.html already applied the stored (or
  // system-preferred) theme before first paint; this only flips and persists.
  const themeToggle = document.getElementById('theme-toggle');
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
    themeToggle.title = theme === 'dark' ? 'ライトモードに切り替え' : 'ダークモードに切り替え';
  }
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem('ai-office-theme', next);
    } catch {
      // Storage blocked: the theme still flips, it just won't persist.
    }
  });

  // The HR cleanup, kept as a single app-bar button: retire everyone with no
  // work left, tagged with the boss's standing directive.
  const CLEANUP_DIRECTIVE = '@here 仕事がない人は退勤してください';
  const cleanupButton = document.getElementById('cleanup-run');
  let cleanupInFlight = false;
  cleanupButton.addEventListener('click', async () => {
    if (cleanupInFlight) return;
    cleanupInFlight = true;
    cleanupButton.disabled = true;
    try {
      const result = await client.runCleanup(CLEANUP_DIRECTIVE);
      window.OFFICE.hrSay(
        result.retired.length > 0
          ? `${result.retired.length}人が退勤しました`
          : 'サボっている人はいませんでした'
      );
    } catch {
      window.OFFICE.hrSay('退勤処理に失敗しました');
    } finally {
      cleanupInFlight = false;
      cleanupButton.disabled = false;
    }
  });

  // --- right drawer -------------------------------------------------------
  // A single slide-in drawer replaces the old stacked modals. It hosts one
  // section at a time: card detail, the task filing form, a resident's live
  // activity, or the resident settings form.

  const drawerElement = document.getElementById('drawer');
  const drawerTitleElement = document.getElementById('drawer-title');
  const DRAWER_SECTION_IDS = ['card-detail', 'card-form', 'activity-wrap', 'resident-form'];

  function openDrawer(sectionId, title) {
    for (const id of DRAWER_SECTION_IDS) field(id).hidden = id !== sectionId;
    drawerTitleElement.textContent = title;
    drawerElement.hidden = false;
  }

  function closeDrawer() {
    drawerElement.hidden = true;
    for (const id of DRAWER_SECTION_IDS) field(id).hidden = true;
    cardForm.reset();
    activityName = null;
  }
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawerElement.hidden) closeDrawer();
  });

  // --- view tabs: office canvas / full board ------------------------------

  const officeWrapElement = document.getElementById('office-wrap');
  const boardViewElement = document.getElementById('board-view');

  function setView(view) {
    officeWrapElement.hidden = view !== 'office';
    boardViewElement.hidden = view !== 'board';
    for (const tab of document.querySelectorAll('.view-tab')) {
      const active = tab.dataset.view === view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (view === 'board') renderBoard();
  }
  for (const tab of document.querySelectorAll('.view-tab')) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  }
  // Clicking the whiteboard on the canvas opens the full board in place.
  window.addEventListener('office:whiteboard-open', () => setView('board'));

  // --- inbox --------------------------------------------------------------

  const reportListElement = document.getElementById('inbox-list');
  const inboxSummaryElement = document.getElementById('inbox-summary');
  let latestReports = [];

  function linkify(escapedText) {
    return escapedText.replace(
      /https?:\/\/[^\s<]+/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
    );
  }

  function renderInboxSummary() {
    const unread = latestReports.filter((report) => !report.read).length;
    const review = latestReports.filter(
      (report) => report.level === 'review-needed' && !report.read
    ).length;
    if (review > 0) {
      inboxSummaryElement.innerHTML = `<span class="summary-review">要確認 ${review}</span> ・ 未読 ${unread}`;
    } else {
      inboxSummaryElement.textContent = unread > 0 ? `未読 ${unread}` : 'すべて確認済み';
    }
  }

  function renderReports(reports) {
    latestReports = reports;
    renderInboxSummary();
    if (reports.length === 0) {
      reportListElement.innerHTML =
        '<div class="report-empty">報告はまだありません</div>';
      return;
    }
    reportListElement.innerHTML = reports
      .map(
        (report) => `
          <div class="report${report.read ? '' : ' unread'}${report.favorite ? ' favorite' : ''}" data-id="${escapeHtml(report.id)}">
            <div class="report-head">
              <span class="report-level ${escapeHtml(report.level)}">${report.level === 'review-needed' ? '要確認' : '報告'}</span>
              <span class="report-title">${escapeHtml(report.title)}</span>
              <span class="report-time">${formatTime(report.createdAt)}</span>
              <button type="button" class="report-favorite" title="お気に入り" aria-pressed="${report.favorite ? 'true' : 'false'}">${report.favorite ? '★' : '☆'}</button>
              <button type="button" class="report-archive" title="ボードから外す"${report.favorite ? ' disabled' : ''}>✕</button>
            </div>
            <div class="report-body" hidden>${linkify(escapeHtml(report.body))}</div>
          </div>`
      )
      .join('');
    for (const reportElement of reportListElement.querySelectorAll('.report')) {
      reportElement.querySelector('.report-head').addEventListener('click', () => {
        const body = reportElement.querySelector('.report-body');
        body.hidden = !body.hidden;
        if (!body.hidden && reportElement.classList.contains('unread')) {
          reportElement.classList.remove('unread');
          const report = latestReports.find((entry) => entry.id === reportElement.dataset.id);
          if (report) report.read = true;
          renderInboxSummary();
          client.markReportRead(reportElement.dataset.id).catch(() => {});
        }
      });
      reportElement.querySelector('.report-favorite').addEventListener('click', async (event) => {
        event.stopPropagation();
        const favoriteButton = event.currentTarget;
        try {
          const { favorite } = await client.toggleReportFavorite(reportElement.dataset.id);
          if (typeof favorite === 'boolean') {
            reportElement.classList.toggle('favorite', favorite);
            favoriteButton.textContent = favorite ? '★' : '☆';
            favoriteButton.setAttribute('aria-pressed', favorite ? 'true' : 'false');
            // A favorited report is pinned: its archive button is disabled.
            reportElement.querySelector('.report-archive').disabled = favorite;
            return;
          }
        } catch {
          // Fall through: reload so the panel reflects what is really on disk.
        }
        loadReports();
      });
      reportElement.querySelector('.report-archive').addEventListener('click', async (event) => {
        event.stopPropagation();
        if (event.currentTarget.disabled) return;
        try {
          const { ok } = await client.archiveReport(reportElement.dataset.id);
          if (ok) {
            reportElement.remove();
            latestReports = latestReports.filter(
              (entry) => entry.id !== reportElement.dataset.id
            );
            renderInboxSummary();
            if (reportListElement.querySelector('.report') === null) renderReports([]);
            return;
          }
        } catch {
          // Fall through: reload so the panel reflects what is really on disk.
        }
        loadReports();
      });
    }
  }

  async function loadReports() {
    reportListElement.innerHTML = '<div class="report-empty">読み込み中…</div>';
    try {
      const { reports } = await client.listReports();
      renderReports(reports ?? []);
    } catch {
      reportListElement.innerHTML =
        '<div class="report-empty">読み込みに失敗しました</div>';
    }
  }

  // --- kanban board -------------------------------------------------------
  // Columns are assignees: the user first, then the residents in seat order.
  // The compact strip under the app bar mirrors the board (a few cards per
  // column); the full board is the "ボード" view, where cards are dragged to
  // reorder (top card = worked next) or to reassign.

  const boardColumnsElement = document.getElementById('board-columns');
  const stripElement = document.getElementById('kanban-strip');

  // How many cards each compact strip column previews before "+N more".
  const STRIP_CARD_LIMIT = 3;

  // Assignee chips reuse the pixel avatars' vendor colors so the strip and
  // the canvas describe the same coworker in the same hue.
  const VENDOR_COLORS = { claude: '#d97757', codex: '#24292f', gemini: '#4285f4' };
  const USER_COLOR = '#64748b';

  let latestSnapshot = null;
  let boardCards = [];
  let draggingCardId = null;

  function boardColumns() {
    const residents = [...(latestSnapshot?.residents ?? [])].sort((a, b) => a.seat - b.seat);
    return [
      { key: 'user', label: 'あなた(社長)', color: USER_COLOR, busy: false },
      ...residents.map((resident) => ({
        key: resident.name,
        label: resident.displayName,
        color: VENDOR_COLORS[resident.cli] ?? USER_COLOR,
        busy: resident.busy === true,
      })),
    ];
  }

  function assigneeChip(column) {
    return `<span class="assignee-chip" style="background:${escapeHtml(column.color)}">${escapeHtml([...column.label][0] ?? '?')}</span>`;
  }

  // Group the cards into their columns once; both the full board and the
  // compact strip render from this. Cards assigned to a resident that no
  // longer exists land in the user column with a warning badge.
  function groupedCards() {
    const columns = boardColumns();
    const known = new Set(columns.map((column) => column.key));
    const grouped = new Map(columns.map((column) => [column.key, []]));
    for (const card of boardCards) {
      const key = known.has(card.assignee) ? card.assignee : 'user';
      grouped.get(key).push({ ...card, orphaned: !known.has(card.assignee) });
    }
    return { columns, grouped };
  }

  async function refreshBoard() {
    try {
      const { cards } = await client.listBoard();
      boardCards = cards ?? [];
    } catch {
      boardCards = [];
    }
    renderStrip();
    if (!boardViewElement.hidden) renderBoard();
  }

  // The compact strip: one column per assignee with the count, a live
  // "作業中" badge while the resident's run is going, the first few cards and
  // a quick-add button that files a task to that assignee.
  function renderStrip() {
    const { columns, grouped } = groupedCards();
    stripElement.innerHTML = columns
      .map((column) => {
        const cards = grouped.get(column.key);
        const preview = cards
          .slice(0, STRIP_CARD_LIMIT)
          .map(
            (card) => `
              <div class="strip-card${card.working ? ' working' : ''}" data-id="${escapeHtml(card.id)}">
                <span class="strip-card-title">${escapeHtml(card.title)}</span>
                ${cardBadges(card)}
              </div>`
          )
          .join('');
        const overflow =
          cards.length > STRIP_CARD_LIMIT
            ? `<div class="strip-more">ほか ${cards.length - STRIP_CARD_LIMIT} 件</div>`
            : '';
        const empty = cards.length === 0 ? '<div class="strip-empty">タスクなし</div>' : '';
        return `
          <div class="strip-column">
            <div class="strip-column-head">
              ${assigneeChip(column)}
              <span class="strip-column-name">${escapeHtml(column.label)}</span>
              <span class="strip-column-count">${cards.length}</span>
              ${column.busy ? '<span class="strip-busy">作業中</span>' : ''}
              <button type="button" class="strip-add" data-assignee="${escapeHtml(column.key)}" title="${escapeHtml(column.label)}にタスクを起票">＋</button>
            </div>
            ${preview}${overflow}${empty}
          </div>`;
      })
      .join('');
  }

  // One delegated listener: the strip is rebuilt on board refreshes, and
  // per-element listeners would drop a click that spans a rebuild.
  stripElement.addEventListener('click', (event) => {
    const addButton = event.target.closest('.strip-add');
    if (addButton !== null) {
      openCardForm(addButton.dataset.assignee);
      return;
    }
    const cardElement = event.target.closest('.strip-card');
    if (cardElement !== null) openCardDetail(cardElement.dataset.id);
  });

  function cardBadges(card) {
    const badges = [];
    if (card.working) badges.push('<span class="card-badge working">作業中</span>');
    else if (card.assignee === 'user' && card.reported) {
      badges.push('<span class="card-badge review">要確認</span>');
    }
    if (card.orphaned) badges.push('<span class="card-badge orphaned">担当不在</span>');
    return badges.join('');
  }

  function renderBoard() {
    const { columns, grouped } = groupedCards();
    boardColumnsElement.innerHTML = columns
      .map(
        (column) => `
          <div class="board-column">
            <div class="board-column-head">
              ${assigneeChip(column)}
              <span class="board-column-name">${escapeHtml(column.label)}</span>
              <span class="board-column-count">${grouped.get(column.key).length}</span>
            </div>
            <div class="board-cards" data-column="${escapeHtml(column.key)}">
              ${grouped
                .get(column.key)
                .map(
                  (card) => `
                    <div class="board-card${card.working ? ' working' : ''}" data-id="${escapeHtml(card.id)}" draggable="${card.working ? 'false' : 'true'}">
                      <div class="board-card-title">${escapeHtml(card.title)}</div>
                      <div class="board-card-meta">${cardBadges(card)}<span class="board-card-time">${formatTime(card.createdAt)}</span></div>
                    </div>`
                )
                .join('')}
            </div>
          </div>`
      )
      .join('');
    attachBoardHandlers();
  }

  function clearDropMarkers() {
    for (const marked of boardColumnsElement.querySelectorAll('.drop-before, .drop-after')) {
      marked.classList.remove('drop-before', 'drop-after');
    }
  }

  // Which card the dragged card lands in front of, based on whether the
  // pointer sits over the top or bottom half of the hovered card. The bottom
  // half targets the next card (null past the last one), so a card can be
  // dropped into the very last slot of its column, not only above a card.
  function insertBeforeId(cardElement, event) {
    const rect = cardElement.getBoundingClientRect();
    if (event.clientY <= rect.top + rect.height / 2) return cardElement.dataset.id;
    const next = cardElement.nextElementSibling;
    return next === null ? null : next.dataset.id;
  }

  function attachBoardHandlers() {
    for (const cardElement of boardColumnsElement.querySelectorAll('.board-card')) {
      cardElement.addEventListener('click', () => openCardDetail(cardElement.dataset.id));
      cardElement.addEventListener('dragstart', (event) => {
        draggingCardId = cardElement.dataset.id;
        event.dataTransfer.effectAllowed = 'move';
      });
      cardElement.addEventListener('dragend', () => {
        draggingCardId = null;
        clearDropMarkers();
      });
      cardElement.addEventListener('dragover', (event) => {
        if (draggingCardId === null || draggingCardId === cardElement.dataset.id) return;
        event.preventDefault();
        event.stopPropagation();
        clearDropMarkers();
        const rect = cardElement.getBoundingClientRect();
        cardElement.classList.add(
          event.clientY <= rect.top + rect.height / 2 ? 'drop-before' : 'drop-after'
        );
      });
      cardElement.addEventListener('drop', (event) => {
        event.preventDefault();
        event.stopPropagation();
        dropCard(cardElement.closest('.board-cards').dataset.column, insertBeforeId(cardElement, event));
      });
    }
    for (const listElement of boardColumnsElement.querySelectorAll('.board-cards')) {
      listElement.addEventListener('dragover', (event) => {
        if (draggingCardId !== null) event.preventDefault();
      });
      listElement.addEventListener('drop', (event) => {
        event.preventDefault();
        dropCard(listElement.dataset.column, null);
      });
    }
  }

  // Drop the dragged card into `column`, before `beforeId` (null = at the
  // end). The index sent to the server counts positions in the target column
  // with the dragged card excluded — the same list the server splices into.
  async function dropCard(column, beforeId) {
    const id = draggingCardId;
    draggingCardId = null;
    clearDropMarkers();
    if (id === null || id === beforeId) return;
    const columnIds = [
      ...boardColumnsElement.querySelectorAll(
        `.board-cards[data-column="${CSS.escape(column)}"] .board-card`
      ),
    ]
      .map((element) => element.dataset.id)
      .filter((cardId) => cardId !== id);
    const beforeAt = beforeId === null ? -1 : columnIds.indexOf(beforeId);
    try {
      await client.moveCard(id, column, beforeAt === -1 ? columnIds.length : beforeAt);
    } catch {
      // Fall through: reload so the board reflects what is really on disk.
    }
    refreshBoard();
  }

  // --- task filing (drawer form) ------------------------------------------

  const cardForm = document.getElementById('card-form');

  function fillCardAssignees(preselect) {
    const select = field('card-assignee');
    const columns = boardColumns();
    select.innerHTML = columns
      .map(
        (column) =>
          `<option value="${escapeHtml(column.key)}">${escapeHtml(column.label)}</option>`
      )
      .join('');
    if (preselect && columns.some((column) => column.key === preselect)) {
      select.value = preselect;
      return;
    }
    // Default to the first resident — filing a task to yourself is the rare case.
    if (select.options.length > 1) select.selectedIndex = 1;
  }

  function openCardForm(assignee) {
    fillCardAssignees(assignee);
    openDrawer('card-form', 'タスクを起票');
    field('card-title').focus();
  }
  document.getElementById('card-add').addEventListener('click', () => openCardForm(null));

  cardForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = field('card-title').value.trim();
    if (title === '') return;
    try {
      await client.createCard({
        title,
        body: field('card-body').value,
        assignee: field('card-assignee').value,
      });
      closeDrawer();
    } catch {
      // Fall through: reload shows the board as it really is.
    }
    refreshBoard();
  });

  // --- card detail (drawer) -----------------------------------------------

  const cardDetailElement = document.getElementById('card-detail');

  function openCardDetail(id) {
    const card = boardCards.find((c) => c.id === id);
    if (!card) return;
    const column =
      boardColumns().find((entry) => entry.key === card.assignee) ??
      { key: card.assignee, label: card.assignee, color: USER_COLOR };
    cardDetailElement.innerHTML = `
      <div class="card-detail-head">
        <span class="card-detail-title">${escapeHtml(card.title)}</span>
        <span class="card-detail-assignee">${assigneeChip(column)} ${escapeHtml(column.label)}${card.working ? ' <span class="card-badge working">作業中</span>' : ''}</span>
      </div>
      <div class="card-detail-body">${linkify(escapeHtml(card.body || '(本文なし)'))}</div>
      <div id="card-reports"><div class="report-empty">報告を読み込み中…</div></div>
      <form id="card-note-form">
        <textarea id="card-note-text" rows="2" placeholder="追記(次回実行のプロンプトに含まれます)"></textarea>
        <div class="form-actions">
          <button type="submit" class="primary-button">追記する</button>
          <button type="button" id="card-detail-archive"${card.working ? ' disabled' : ''}>完了(ボードから外す)</button>
        </div>
      </form>`;
    openDrawer('card-detail', 'タスク詳細');
    field('card-note-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = field('card-note-text').value.trim();
      if (text === '') return;
      try {
        await client.appendCardNote(id, text);
        await refreshBoard();
      } catch {
        // Fall through: reopen shows the card as it really is.
      }
      openCardDetail(id);
    });
    field('card-detail-archive').addEventListener('click', async () => {
      try {
        await client.archiveCard(id);
      } catch {
        // Fall through: the board reload below shows what really happened.
      }
      closeDrawer();
      refreshBoard();
    });
    renderCardReports(id);
  }

  // Reports whose frontmatter carries this card's id, newest first. Viewing
  // them from the card counts as reading them.
  async function renderCardReports(id) {
    const container = field('card-reports');
    try {
      const { reports } = await client.listReports();
      const linked = (reports ?? []).filter((report) => report.task === id);
      if (linked.length === 0) {
        container.innerHTML = '<div class="report-empty">このタスクの報告はまだありません</div>';
        return;
      }
      container.innerHTML = linked
        .map(
          (report) => `
            <div class="report">
              <div class="report-head">
                <span class="report-level ${escapeHtml(report.level)}">${report.level === 'review-needed' ? '要確認' : '報告'}</span>
                <span class="report-title">${escapeHtml(report.title)}</span>
                <span class="report-time">${formatTime(report.createdAt)}</span>
              </div>
              <div class="report-body">${linkify(escapeHtml(report.body))}</div>
            </div>`
        )
        .join('');
      for (const report of linked) {
        if (!report.read) client.markReportRead(report.id).catch(() => {});
      }
    } catch {
      container.innerHTML = '<div class="report-empty">報告の読み込みに失敗しました</div>';
    }
  }

  // Re-fetch the board when a snapshot shows run/card activity so the strip
  // (always visible) and the board view stay current — but never mid-drag.
  let boardSignature = null;
  function maybeRefreshBoard(snapshot) {
    const signature = JSON.stringify([
      snapshot.board,
      (snapshot.residents ?? []).map((resident) => resident.busy),
    ]);
    const changed = boardSignature !== null && signature !== boardSignature;
    boardSignature = signature;
    if (changed && draggingCardId === null) refreshBoard();
  }

  // --- resident settings (drawer) -----------------------------------------

  const residentForm = document.getElementById('resident-form');
  const residentError = document.getElementById('resident-error');

  const WEEKDAYS = [
    ['mon', '月'],
    ['tue', '火'],
    ['wed', '水'],
    ['thu', '木'],
    ['fri', '金'],
    ['sat', '土'],
    ['sun', '日'],
  ];
  for (const containerId of ['schedule-days', 'interval-days']) {
    document.getElementById(containerId).innerHTML = WEEKDAYS.map(
      ([key, label]) =>
        `<label><input type="checkbox" value="${key}">${label}</label>`
    ).join('');
  }

  function checkedDays(containerId) {
    return [...document.querySelectorAll(`#${containerId} input:checked`)].map(
      (input) => input.value
    );
  }

  function setCheckedDays(containerId, days) {
    for (const input of document.querySelectorAll(`#${containerId} input`)) {
      input.checked = (days ?? []).includes(input.value);
    }
  }

  let panelSeat = null;

  function showTriggerSection(type) {
    document.getElementById('trigger-schedule').hidden = type !== 'schedule';
    document.getElementById('trigger-interval').hidden = type !== 'interval';
  }
  field('resident-trigger-type').addEventListener('change', (event) =>
    showTriggerSection(event.target.value)
  );

  function fillResidentForm(entry) {
    const configuration = entry?.configuration;
    field('resident-name').value = entry?.name ?? '';
    field('resident-name').disabled = entry !== null;
    field('resident-display-name').value = configuration?.displayName ?? '';
    field('resident-cli').value = configuration?.cli ?? 'claude';
    field('resident-mode').value = configuration?.mode ?? 'read-only';
    field('resident-working-directory').value = configuration?.workingDirectory ?? '';
    field('resident-precheck').value = configuration?.precheck ?? '';
    field('resident-instructions').value = entry?.instructions ?? '';
    field('resident-enabled').checked = configuration?.enabled ?? true;
    const trigger = configuration?.trigger ?? { type: 'schedule' };
    field('resident-trigger-type').value = trigger.type;
    showTriggerSection(trigger.type);
    setCheckedDays('schedule-days', trigger.type === 'schedule' ? trigger.days : ['mon']);
    field('schedule-times').value =
      trigger.type === 'schedule' ? (trigger.times ?? []).join(', ') : '09:00';
    field('interval-minutes').value = trigger.type === 'interval' ? trigger.minutes : 30;
    setCheckedDays('interval-days', trigger.type === 'interval' ? trigger.activeDays : []);
    field('interval-start').value = trigger.activeHours?.start ?? '';
    field('interval-end').value = trigger.activeHours?.end ?? '';
    field('resident-run').disabled = entry === null;
    field('resident-unassign').disabled = entry === null;
    residentError.hidden = true;
  }

  function collectTrigger() {
    if (field('resident-trigger-type').value === 'schedule') {
      return {
        type: 'schedule',
        days: checkedDays('schedule-days'),
        times: field('schedule-times')
          .value.split(',')
          .map((text) => text.trim())
          .filter((text) => text !== ''),
      };
    }
    const trigger = { type: 'interval', minutes: Number(field('interval-minutes').value) };
    const activeDays = checkedDays('interval-days');
    if (activeDays.length > 0 && activeDays.length < 7) trigger.activeDays = activeDays;
    if (field('interval-start').value && field('interval-end').value) {
      trigger.activeHours = {
        start: field('interval-start').value,
        end: field('interval-end').value,
      };
    }
    return trigger;
  }

  function showResidentError(message) {
    residentError.textContent = message;
    residentError.hidden = false;
  }

  async function openResidentPanel(seat, name) {
    panelSeat = seat;
    let entry = null;
    if (name) {
      try {
        const { residents } = await client.listResidents();
        entry = residents.find((r) => r.name === name) ?? null;
      } catch {
        // Treat as a new assignment if the fetch fails.
      }
    }
    fillResidentForm(entry);
    openDrawer(
      'resident-form',
      entry === null
        ? `常駐員を追加(席 ${seat + 1})`
        : `${entry.configuration.displayName}(席 ${seat + 1})`
    );
  }
  window.addEventListener('office:resident-seat-open', (event) =>
    openResidentPanel(event.detail.seat, event.detail.name)
  );

  residentForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = field('resident-name').value.trim();
    try {
      await client.saveResident(name, {
        configuration: {
          displayName: field('resident-display-name').value.trim(),
          seat: panelSeat,
          cli: field('resident-cli').value,
          mode: field('resident-mode').value,
          workingDirectory: field('resident-working-directory').value.trim(),
          trigger: collectTrigger(),
          precheck: field('resident-precheck').value.trim() || null,
          enabled: field('resident-enabled').checked,
        },
        instructions: field('resident-instructions').value,
      });
      closeDrawer();
    } catch (error) {
      showResidentError(error.message);
    }
  });

  field('resident-run').addEventListener('click', async () => {
    try {
      await client.runResident(field('resident-name').value.trim());
      closeDrawer();
    } catch (error) {
      showResidentError(error.message);
    }
  });

  field('resident-unassign').addEventListener('click', async () => {
    const name = field('resident-name').value.trim();
    if (!window.confirm(`${name} の割り当てを解除しますか?(設定と報告はアーカイブされます)`)) return;
    try {
      await client.deleteResident(name);
      closeDrawer();
    } catch (error) {
      showResidentError(error.message);
    }
  });

  // --- activity view (drawer) ---------------------------------------------
  // Shows one resident's live work: what its current session is doing right
  // now (task, running tool, subagents, MCP calls), or its idle / next-run
  // state when no session is live. It reads the same office snapshot the
  // canvas draws from, so opening it never hits the server — the section just
  // re-renders on each snapshot while it is open.
  const ACTIVITY_STATUS_LABELS = {
    working: '作業中',
    blocked: '確認待ち',
    waiting: '入力待ち',
    break: '離席中',
  };
  const ACTIVITY_KIND_LABELS = { inspect: '確認中', think: '考え中', work: '作業中' };
  const activityView = document.getElementById('activity-view');
  let activityName = null;

  // The latest live session bound to a resident, or null when it is idle.
  function residentSession(name) {
    let latest = null;
    for (const employee of latestSnapshot?.employees ?? []) {
      if (employee.resident !== name) continue;
      if (latest === null || (employee.lastEventAt ?? 0) > (latest.lastEventAt ?? 0)) {
        latest = employee;
      }
    }
    return latest;
  }

  function activityRow(label, value) {
    return `<div class="activity-field"><span class="activity-label">${escapeHtml(label)}</span>${value}</div>`;
  }

  function activityBody(resident, session) {
    if (resident === null) {
      return '<p class="activity-empty">常駐員が割り当てられていません。</p>';
    }
    if (session === null) {
      const state = resident.busy
        ? '起動中…'
        : resident.lastRunAt
          ? `前回実行 ${formatTime(resident.lastRunAt)}(${resident.lastOutcome ?? '—'})`
          : 'まだ実行されていません';
      const next = resident.nextRunAt ? `次回予定 ${formatTime(resident.nextRunAt)}` : '';
      return [
        '<p class="activity-empty">セッションは動いていません。</p>',
        activityRow('状態', escapeHtml(state)),
        next ? activityRow('次回', escapeHtml(next)) : '',
      ].join('');
    }
    const rows = [
      `<div class="activity-status ${escapeHtml(session.status)}">${escapeHtml(
        ACTIVITY_STATUS_LABELS[session.status] ?? session.status
      )}</div>`,
    ];
    // The instruction is the board card title, not the transcript's first
    // message — a resident's prompt is mostly its role/rules, which would bury
    // the actual task.
    if (resident.activeTask) rows.push(activityRow('指示', escapeHtml(resident.activeTask)));
    if (session.activityLog?.length) {
      const items = session.activityLog
        .map((entry) => {
          const entryKind = ACTIVITY_KIND_LABELS[entry.activityKind];
          const prefix = entryKind ? `[${escapeHtml(entryKind)}] ` : '';
          return `<li>${prefix}${escapeHtml(entry.activity)}</li>`;
        })
        .join('');
      rows.push(activityRow('作業ログ', `<ol class="activity-log">${items}</ol>`));
    }
    if (session.subagents?.length) {
      rows.push(
        activityRow(
          'サブエージェント',
          session.subagents.map((sub) => escapeHtml(sub.activity ?? sub.label ?? '作業中')).join(' / ')
        )
      );
    }
    if (session.mcpCalls?.length) {
      rows.push(
        activityRow(
          'MCP',
          session.mcpCalls.map((call) => escapeHtml(`${call.server} / ${call.tool}`)).join(' / ')
        )
      );
    }
    return rows.join('');
  }

  function renderActivity() {
    const resident =
      (latestSnapshot?.residents ?? []).find((r) => r.name === activityName) ?? null;
    drawerTitleElement.textContent = resident
      ? `${resident.displayName} の作業状況`
      : '作業状況';
    activityView.innerHTML = activityBody(resident, activityName ? residentSession(activityName) : null);
  }

  function openActivityPanel(name) {
    activityName = name;
    openDrawer('activity-wrap', '作業状況');
    renderActivity();
  }
  window.addEventListener('office:resident-activity-open', (event) =>
    openActivityPanel(event.detail.name)
  );

  // The strip and the inbox are always on screen, so both load on the first
  // snapshot and refresh only when their data actually changes: the board on
  // run/card activity, the inbox when a report is added or removed (using the
  // total, so marking one read never collapses an open report).
  let firstSnapshot = true;
  let inboxSignature = null;
  function maybeRefreshInbox(snapshot) {
    const signature = snapshot.whiteboard?.total ?? 0;
    const changed = inboxSignature !== null && signature !== inboxSignature;
    inboxSignature = signature;
    if (changed) loadReports();
  }

  client.connect({
    onSnapshot: (snapshot) => {
      latestSnapshot = snapshot;
      window.OFFICE.setState(snapshot);
      alertOnBossMention(snapshot);
      if (firstSnapshot) {
        firstSnapshot = false;
        refreshBoard();
        loadReports();
        inboxSignature = snapshot.whiteboard?.total ?? 0;
        boardSignature = JSON.stringify([
          snapshot.board,
          (snapshot.residents ?? []).map((resident) => resident.busy),
        ]);
        return;
      }
      if (activityName !== null && !field('activity-wrap').hidden) renderActivity();
      maybeRefreshBoard(snapshot);
      maybeRefreshInbox(snapshot);
    },
    onStatus: (status) => {
      connectionElement.textContent = status === 'connected' ? '接続中' : '再接続待ち…';
      connectionElement.classList.toggle('connected', status === 'connected');
    },
  });
})();
