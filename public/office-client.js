// Transport layer for the office UI: wraps the SSE state stream and the HR
// cleanup HTTP calls so the rendering/audio code stays independent of *how*
// data arrives. Swapping SSE for Electron IPC later means changing only this
// file, not the UI. Exposed as window.OFFICE_CLIENT, matching window.OFFICE.

(() => {
  function createOfficeClient() {
    return {
      // Subscribe to state snapshots. onSnapshot(snapshot) fires per frame;
      // onStatus('connected' | 'reconnecting') fires on connection changes.
      // Reconnection is automatic (native EventSource behaviour).
      connect({ onSnapshot, onStatus }) {
        const source = new EventSource('/events');
        source.onopen = () => onStatus?.('connected');
        source.onmessage = (event) => onSnapshot?.(JSON.parse(event.data));
        source.onerror = () => onStatus?.('reconnecting');
        return source;
      },

      // Run the HR cleanup for everyone currently retirable, tagged with the
      // boss's directive `text`. Resolves to the { retired, failed } result.
      async runCleanup(text) {
        const preview = await (await fetch('/api/cleanup/preview')).json();
        const response = await fetch('/api/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: preview.candidates.map((c) => c.key), text }),
        });
        return response.json();
      },

      // Resident team management. Errors surface as thrown Error objects with
      // the server's message, so the panel can show them verbatim.
      async listResidents() {
        return (await fetch('/api/residents')).json();
      },
      async saveResident(name, payload) {
        return requestJson(`/api/residents/${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      },
      async deleteResident(name) {
        return requestJson(`/api/residents/${encodeURIComponent(name)}`, { method: 'DELETE' });
      },
      async runResident(name) {
        return requestJson(`/api/residents/${encodeURIComponent(name)}/run`, { method: 'POST' });
      },

      // The whiteboard: full reports (bodies included) and read receipts.
      async listReports() {
        return (await fetch('/api/whiteboard')).json();
      },
      async markReportRead(id) {
        return requestJson('/api/whiteboard/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
      },
      // Takes a report off the board (the file is archived, not deleted).
      async archiveReport(id) {
        return requestJson('/api/whiteboard/archive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
      },

      // The kanban board: task cards, drag ordering, archiving and follow-up
      // notes.
      async listBoard() {
        return (await fetch('/api/board')).json();
      },
      async createCard({ title, body, assignee }) {
        return postBoardAction('create', { title, body, assignee });
      },
      async moveCard(id, assignee, index) {
        return postBoardAction('move', { id, assignee, index });
      },
      // Takes a card off the board (the file is archived, not deleted).
      async archiveCard(id) {
        return postBoardAction('archive', { id });
      },
      async appendCardNote(id, text) {
        return postBoardAction('note', { id, text });
      },
    };
  }

  async function postBoardAction(action, payload) {
    return requestJson(`/api/board/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  }

  window.OFFICE_CLIENT = { create: createOfficeClient };
})();
