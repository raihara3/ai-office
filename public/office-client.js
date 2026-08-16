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
    };
  }

  window.OFFICE_CLIENT = { create: createOfficeClient };
})();
