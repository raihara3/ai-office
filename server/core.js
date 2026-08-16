// Application core: owns the state store, the HR cleanup, and the CLI
// watchers, wired together and decoupled from any transport (HTTP, IPC, …).
// A transport adapter consumes the returned handle; tests can drive the core
// directly without a network layer.

import { createState } from './state.js';
import { createCleanup } from './cleanup.js';
import { startClaudeWatcher } from './watchers/claude.js';
import { startCodexWatcher } from './watchers/codex.js';
import { startGeminiWatcher } from './watchers/gemini.js';

// Status can flip from working to break purely by time passing, so re-derive
// and re-broadcast often enough that the flip lands close to the grace period.
const REFRESH_INTERVAL_MS = 2_000;

export function createCore({ now } = {}) {
  const state = createState({ now });
  const cleanup = createCleanup({ state, now });
  let refreshTimer = null;

  function start() {
    if (refreshTimer !== null) return;
    const report = state.reportEvent;
    startClaudeWatcher({ report });
    startCodexWatcher({ report });
    startGeminiWatcher({ report });
    refreshTimer = setInterval(() => state.refresh(), REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  }

  function stop() {
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  return {
    state,
    start,
    stop,
    subscribe: state.onChange,
    getSnapshot: state.snapshot,
    postMessage: state.postMessage,
    previewCleanup: cleanup.findRetirableSessions,
    runCleanup: cleanup.retireSessions,
  };
}
