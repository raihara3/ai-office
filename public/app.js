// SSE client: Kanban top bar, report inbox and overlay panels.

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

  // The HR cleanup, kept as a single button: retire everyone with no work
  // left, tagged with the boss's standing directive.
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

  // --- overlay panels (whiteboard + resident seats) ---------------------
  // The canvas reports clicks on the whiteboard / resident desks as window
  // events (see office.js); the DOM panels live here.

  const overlayElement = document.getElementById('overlay');
  const whiteboardPanel = document.getElementById('whiteboard-panel');
  const activityPanel = document.getElementById('activity-panel');
  const activityView = document.getElementById('activity-view');
  const residentPanel = document.getElementById('resident-panel');
  const reportListElement = document.getElementById('inbox-list');
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

  function field(id) {
    return document.getElementById(id);
  }

  function closeOverlay() {
    overlayElement.hidden = true;
    whiteboardPanel.hidden = true;
    activityPanel.hidden = true;
    residentPanel.hidden = true;
    activityName = null;
  }
  overlayElement.addEventListener('click', (event) => {
    if (event.target === overlayElement) closeOverlay();
  });
  for (const button of document.querySelectorAll('.overlay-close')) {
    button.addEventListener('click', closeOverlay);
  }
  window.addEventListener('keydown', (event) => {
    // The card modal (its own Escape handler) sits above the overlay; let it
    // take Escape first so one press closes only the topmost layer.
    if (event.key === 'Escape' && cardModal.hidden && !overlayElement.hidden) {
      closeOverlay();
    }
  });

  // --- whiteboard panel -------------------------------------------------

  function linkify(escapedText) {
    return escapedText.replace(
      /https?:\/\/[^\s<]+/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
    );
  }

  function renderReports(reports) {
    if (reports.length === 0) {
      reportListElement.innerHTML =
        '<div class="report-empty">報告はまだありません</div>';
      return;
    }
    reportListElement.innerHTML = reports
      .map(
        (report) => `
          <div class="report${report.read ? '' : ' unread'}" data-id="${escapeHtml(report.id)}">
            <div class="report-head">
              <span class="report-level ${escapeHtml(report.level)}">${report.level === 'review-needed' ? '要確認' : '報告'}</span>
              <span class="report-title">${escapeHtml(report.title)}</span>
              <span class="report-time">${formatTime(report.createdAt)}</span>
              <button type="button" class="report-archive" title="ボードから外す">✕</button>
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
          client.markReportRead(reportElement.dataset.id).catch(() => {});
        }
      });
      reportElement.querySelector('.report-archive').addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          const { ok } = await client.archiveReport(reportElement.dataset.id);
          if (ok) {
            reportElement.remove();
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

  // --- kanban board -----------------------------------------------------
  // Columns are assignees: the user first, then the residents in seat order.
  // The compact top bar mirrors the board (a few cards per column); the
  // full board lives in the overlay, where cards are dragged to reorder
  // (top card = worked next) or to reassign.

  const boardView = document.getElementById('board-view');
  const boardColumnsElement = document.getElementById('board-columns');
  const cardDetailElement = document.getElementById('card-detail');
  const topbarColumnsElement = document.getElementById('topbar-columns');

  // How many cards each compact top-bar column previews before "+N more".
  const TOPBAR_CARD_LIMIT = 3;

  let latestSnapshot = null;
  let boardCards = [];
  let draggingCardId = null;

  function boardColumns() {
    const residents = [...(latestSnapshot?.residents ?? [])].sort((a, b) => a.seat - b.seat);
    return [
      { key: 'user', label: 'あなた(社長)' },
      ...residents.map((resident) => ({ key: resident.name, label: resident.displayName })),
    ];
  }

  // Group the cards into their columns once; both the overlay board and the
  // compact top bar render from this. Cards assigned to a resident that no
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
    renderTopbar();
    if (!whiteboardPanel.hidden && cardDetailElement.hidden) renderBoard();
  }

  // The compact top bar: one column per assignee with a count badge and the
  // first few cards. Clicking anywhere opens the full board overlay.
  function renderTopbar() {
    const { columns, grouped } = groupedCards();
    topbarColumnsElement.innerHTML = columns
      .map((column) => {
        const cards = grouped.get(column.key);
        const preview = cards
          .slice(0, TOPBAR_CARD_LIMIT)
          .map(
            (card) => `
              <div class="topbar-card${card.working ? ' working' : ''}">
                <span class="topbar-card-title">${escapeHtml(card.title)}</span>
                ${cardBadges(card)}
              </div>`
          )
          .join('');
        const overflow =
          cards.length > TOPBAR_CARD_LIMIT
            ? `<div class="topbar-more">+${cards.length - TOPBAR_CARD_LIMIT}</div>`
            : '';
        return `
          <div class="topbar-column">
            <div class="topbar-column-head">
              <span class="topbar-column-name">${escapeHtml(column.label)}</span>
              <span class="topbar-column-count">${cards.length}</span>
            </div>
            ${preview}${overflow}
          </div>`;
      })
      .join('');
  }
  topbarColumnsElement.addEventListener('click', openWhiteboard);

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
    for (const marked of boardColumnsElement.querySelectorAll('.drop-before')) {
      marked.classList.remove('drop-before');
    }
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
        cardElement.classList.add('drop-before');
      });
      cardElement.addEventListener('drop', (event) => {
        event.preventDefault();
        event.stopPropagation();
        dropCard(cardElement.closest('.board-cards').dataset.column, cardElement.dataset.id);
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

  function fillCardAssignees() {
    const select = field('card-assignee');
    select.innerHTML = boardColumns()
      .map(
        (column) =>
          `<option value="${escapeHtml(column.key)}">${escapeHtml(column.label)}</option>`
      )
      .join('');
    // Default to the first resident — filing a task to yourself is the rare case.
    if (select.options.length > 1) select.selectedIndex = 1;
  }

  // --- card creation modal ----------------------------------------------
  // Filing a task is a standalone modal (its own backdrop above the overlay),
  // so it opens from both the top bar and the expanded board.

  const cardModal = document.getElementById('card-modal');
  const cardForm = document.getElementById('card-form');

  function openCardModal() {
    fillCardAssignees();
    cardModal.hidden = false;
    field('card-title').focus();
  }
  function closeCardModal() {
    cardModal.hidden = true;
    cardForm.reset();
  }
  for (const id of ['card-add', 'card-add-overlay']) {
    field(id).addEventListener('click', openCardModal);
  }
  field('card-modal-close').addEventListener('click', closeCardModal);
  cardModal.addEventListener('click', (event) => {
    if (event.target === cardModal) closeCardModal();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !cardModal.hidden) closeCardModal();
  });

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
      closeCardModal();
    } catch {
      // Fall through: reload shows the board as it really is.
    }
    refreshBoard();
  });

  async function openCardDetail(id) {
    const card = boardCards.find((c) => c.id === id);
    if (!card) return;
    const assigneeLabel =
      boardColumns().find((column) => column.key === card.assignee)?.label ?? card.assignee;
    boardView.hidden = true;
    cardDetailElement.hidden = false;
    cardDetailElement.innerHTML = `
      <button type="button" id="card-detail-back">← ボードに戻る</button>
      <div class="card-detail-head">
        <span class="card-detail-title">${escapeHtml(card.title)}</span>
        <span class="card-detail-assignee">担当: ${escapeHtml(assigneeLabel)}${card.working ? ' ・作業中' : ''}</span>
      </div>
      <div class="card-detail-body">${linkify(escapeHtml(card.body || '(本文なし)'))}</div>
      <div id="card-reports"><div class="report-empty">報告を読み込み中…</div></div>
      <form id="card-note-form">
        <textarea id="card-note-text" rows="2" placeholder="追記(次回実行のプロンプトに含まれます)"></textarea>
        <div class="form-actions">
          <button type="submit">追記する</button>
          <button type="button" id="card-detail-archive"${card.working ? ' disabled' : ''}>完了(ボードから外す)</button>
        </div>
      </form>`;
    field('card-detail-back').addEventListener('click', () => {
      cardDetailElement.hidden = true;
      boardView.hidden = false;
      refreshBoard();
    });
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
      cardDetailElement.hidden = true;
      boardView.hidden = false;
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

  // Re-fetch the board when a snapshot shows run/card activity so the top bar
  // (always visible) and the open overlay stay current — but never mid-drag or
  // while the detail view is up front.
  let boardSignature = null;
  function maybeRefreshBoard(snapshot) {
    const signature = JSON.stringify([
      snapshot.board,
      (snapshot.residents ?? []).map((resident) => resident.busy),
    ]);
    const changed = boardSignature !== null && signature !== boardSignature;
    boardSignature = signature;
    if (!changed || draggingCardId !== null) return;
    if (!whiteboardPanel.hidden && !cardDetailElement.hidden) return;
    refreshBoard();
  }

  function openWhiteboard() {
    overlayElement.hidden = false;
    whiteboardPanel.hidden = false;
    residentPanel.hidden = true;
    cardDetailElement.hidden = true;
    boardView.hidden = false;
    refreshBoard();
  }
  window.addEventListener('office:whiteboard-open', openWhiteboard);
  document.getElementById('board-expand').addEventListener('click', openWhiteboard);

  // --- resident panel ---------------------------------------------------

  let panelSeat = null;
  let panelIsNew = true;

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

  // The activity view shows one resident's live work: what its current
  // session is doing right now (task, running tool, subagents, MCP calls),
  // or its idle / next-run state when no session is live. It reads the same
  // office snapshot the canvas draws from, so tapping the monitor never hits
  // the server — the panel just re-renders on each snapshot while it is open.
  const ACTIVITY_STATUS_LABELS = {
    working: '作業中',
    blocked: '確認待ち',
    waiting: '入力待ち',
    break: '離席中',
  };
  const ACTIVITY_KIND_LABELS = { inspect: '確認中', think: '考え中', work: '作業中' };
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
    const kind = ACTIVITY_KIND_LABELS[session.activityKind];
    const rows = [
      `<div class="activity-status ${escapeHtml(session.status)}">${escapeHtml(
        ACTIVITY_STATUS_LABELS[session.status] ?? session.status
      )}</div>`,
    ];
    if (session.task) rows.push(activityRow('指示', escapeHtml(session.task)));
    if (session.activity) {
      const prefix = kind ? `[${escapeHtml(kind)}] ` : '';
      rows.push(activityRow('実行中', `${prefix}${escapeHtml(session.activity)}`));
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
    document.getElementById('activity-panel-title').textContent = resident
      ? `${resident.displayName} の作業状況`
      : '作業状況';
    activityView.innerHTML = activityBody(resident, activityName ? residentSession(activityName) : null);
  }

  function openActivityPanel(name) {
    activityName = name;
    overlayElement.hidden = false;
    activityPanel.hidden = false;
    whiteboardPanel.hidden = true;
    residentPanel.hidden = true;
    renderActivity();
  }
  window.addEventListener('office:resident-activity-open', (event) =>
    openActivityPanel(event.detail.name)
  );

  async function openResidentPanel(seat, name) {
    panelSeat = seat;
    overlayElement.hidden = false;
    residentPanel.hidden = false;
    whiteboardPanel.hidden = true;
    let entry = null;
    if (name) {
      try {
        const { residents } = await client.listResidents();
        entry = residents.find((r) => r.name === name) ?? null;
      } catch {
        // Treat as a new assignment if the fetch fails.
      }
    }
    panelIsNew = entry === null;
    document.getElementById('resident-panel-title').textContent = panelIsNew
      ? `常駐員を追加(席 ${seat + 1})`
      : `${entry.configuration.displayName}(席 ${seat + 1})`;
    fillResidentForm(entry);
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
      closeOverlay();
    } catch (error) {
      showResidentError(error.message);
    }
  });

  field('resident-run').addEventListener('click', async () => {
    try {
      await client.runResident(field('resident-name').value.trim());
      closeOverlay();
    } catch (error) {
      showResidentError(error.message);
    }
  });

  field('resident-unassign').addEventListener('click', async () => {
    const name = field('resident-name').value.trim();
    if (!window.confirm(`${name} の割り当てを解除しますか?(設定と報告はアーカイブされます)`)) return;
    try {
      await client.deleteResident(name);
      closeOverlay();
    } catch (error) {
      showResidentError(error.message);
    }
  });

  // The top bar and the inbox are always on screen, so both load on the first
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
      renderTopbar();
      if (!activityPanel.hidden) renderActivity();
      maybeRefreshBoard(snapshot);
      maybeRefreshInbox(snapshot);
    },
    onStatus: (status) => {
      connectionElement.textContent =
        status === 'connected' ? '● 接続中' : '○ 再接続待ち…';
    },
  });
})();
