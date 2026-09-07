// OS-notification adapter over core snapshots: watches for the moments the
// office needs the human — an interactive session starting to wait for an
// answer, one stuck on a pending tool call (typically a permission prompt),
// or a review-needed report landing on the whiteboard — and hands them to an
// injected delivery callback. Delivery is owned by the embedder: the Electron
// main process shows native notifications and a menu-bar badge, the
// standalone server calls Notification Center via osascript. Resident
// sessions are skipped — a headless run has no prompt the human could answer,
// and its needs surface as review-needed reports instead.

import { translate } from './i18n.js';

// `subscribe` is core.subscribe (augmented snapshots). `notify({title, body})`
// delivers one notification; `updateBadge(count)` receives the number of
// items needing the human whenever it changes. Returns the unsubscribe
// function. The first snapshot only seeds the baseline so a restart never
// re-notifies about sessions already waiting.
export function createNotificationWatcher({ subscribe, notify, updateBadge = () => {} }) {
  let previousStatuses = null;
  let previousReviewNeeded = null;
  let previousBadge = null;

  // The subscriber runs inside the state store's broadcast loop, where an
  // exception would escalate out of the refresh timer and take the server
  // down — delivery failures must stay the delivery's problem.
  function deliver(callback, payload) {
    try {
      callback(payload);
    } catch (error) {
      console.error(`[ai-office] notification delivery failed: ${error.message}`);
    }
  }

  return subscribe((snapshot) => {
    const interactive = (snapshot.employees ?? []).filter(
      (employee) => employee.resident === null && !employee.isSubagent
    );
    const stuck = interactive.filter(
      (employee) => employee.status === 'waiting' || employee.status === 'blocked'
    );
    const reviewNeeded = snapshot.whiteboard?.reviewNeeded ?? 0;

    const badge = stuck.length + reviewNeeded;
    if (badge !== previousBadge) {
      previousBadge = badge;
      deliver(updateBadge, badge);
    }

    const title = snapshot.officeName ?? 'AI Office';
    if (previousStatuses !== null) {
      for (const employee of stuck) {
        const before = previousStatuses.get(employee.key) ?? null;
        // waiting and blocked both mean "needs the boss": notify on the edge
        // into either, not when one merely turns into the other.
        if (before === 'waiting' || before === 'blocked') continue;
        const name = `${employee.name} (${employee.project ?? '?'})`;
        deliver(notify, {
          title,
          body: translate(
            employee.status === 'waiting' ? 'notification.waiting' : 'notification.blocked',
            { name }
          ),
        });
      }
      if (reviewNeeded > previousReviewNeeded) {
        deliver(notify, { title, body: translate('notification.reviewNeeded') });
      }
    }
    previousStatuses = new Map(interactive.map((employee) => [employee.key, employee.status]));
    previousReviewNeeded = reviewNeeded;
  });
}
