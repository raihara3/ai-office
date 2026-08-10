// SSE client + side-panel rendering.

(() => {
  const cardsElement = document.getElementById('cards');
  const connectionElement = document.getElementById('connection');

  const STATUS_LABELS = { working: '作業中', break: '休憩中', waiting: '応答待ち' };

  function escapeHtml(text) {
    return String(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function renderPanel(snapshot) {
    const grouped = new Map();
    for (const employee of snapshot.employees) {
      if (!grouped.has(employee.cli)) grouped.set(employee.cli, []);
      grouped.get(employee.cli).push(employee);
    }
    cardsElement.innerHTML = [...grouped.entries()]
      .map(([cli, employees]) => {
        const header = `<h2 class="group vendor-${cli}">${escapeHtml(employees[0].name)} <span>${employees.length}</span></h2>`;
        return header + employees.map(renderCard).join('');
      })
      .join('');

    function renderCard(employee) {
        const rows = [];
        if (employee.task) {
          rows.push(`<div class="row"><span class="label">依頼</span>${escapeHtml(employee.task)}</div>`);
        }
        if (employee.activity) {
          rows.push(`<div class="row"><span class="label">作業</span>${escapeHtml(employee.activity)}</div>`);
        }
        const badges = [
          ...employee.subagents.map(
            (subagent) =>
              `<span class="badge subagent">🤖 ${escapeHtml(subagent.label)}${
                subagent.activity ? `: ${escapeHtml(subagent.activity)}` : ''
              }</span>`
          ),
          ...employee.mcpCalls.map(
            (call) => `<span class="badge mcp">🔌 ${escapeHtml(call.server)}/${escapeHtml(call.tool)}</span>`
          ),
        ];
        if (badges.length > 0) {
          rows.push(`<div class="row">${badges.join('')}</div>`);
        }
        if (employee.lastEventAt) {
          const seconds = Math.round((snapshot.at - employee.lastEventAt) / 1000);
          const ago =
            seconds < 60
              ? `${seconds}秒前`
              : seconds < 3600
                ? `${Math.round(seconds / 60)}分前`
                : `${Math.round(seconds / 3600)}時間前`;
          rows.push(`<div class="row"><span class="label">最終活動</span>${ago}</div>`);
        }
        return `
          <div class="card">
            <div class="head">
              <span class="dot ${employee.status}"></span>
              <span class="name">${escapeHtml(employee.project ?? employee.name)}</span>
              <span class="status-label">${STATUS_LABELS[employee.status] ?? employee.status}</span>
            </div>
            ${rows.join('')}
          </div>`;
    }
  }

  function connect() {
    const source = new EventSource('/events');
    source.onopen = () => {
      connectionElement.textContent = '● 接続中';
    };
    source.onmessage = (event) => {
      const snapshot = JSON.parse(event.data);
      window.OFFICE.setState(snapshot);
      renderPanel(snapshot);
    };
    source.onerror = () => {
      connectionElement.textContent = '○ 再接続待ち…';
    };
  }

  connect();
})();
