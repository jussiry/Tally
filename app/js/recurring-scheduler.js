/*
Runs recurring payments while the app is open: at start-up, whenever the app
comes back into view, and once a minute. Each run sends every payment that has
fallen due (commands/recurring-payment.js), so payments missed while the app
was closed go out as soon as it opens, each dated when it fell due.

A browser gives a web app no way to wake on a timer, so nothing runs while the
app is closed. The relay fills the gap with a reminder: the realtime client
registers the next due time of each payment (buildRecurringReminders in
recurring.js) and the relay pushes it then if none of the user's devices is
connected, so the user knows to open the app. "Remind to send recurring
payments" in the notification settings turns this off.

Only one tab runs at a time (a Web Lock); a second device racing this one sends
the same transaction ids, which the tallies dedupe.
@category entry
*/

import { sendDueRecurringPayments } from "./commands/recurring-payment.js";
import { showNotification } from "./ui/notifications.js";

const CHECK_INTERVAL_MS = 60_000;
const LOCK_NAME = "tally-recurring-payments";

let running = false;

const runOnce = async () => {
  if (running) return;
  running = true;
  try {
    const sent = navigator.locks
      ? await navigator.locks.request(LOCK_NAME, () => sendDueRecurringPayments())
      : await sendDueRecurringPayments();
    if (sent.length) announce(sent);
  } catch (error) {
    console.warn("[recurring] run failed:", error);
  } finally {
    running = false;
  }
};

// A toast per friend, so catching up on many missed payments doesn't stack
// one for each. No OS notification: payments go out only while the app runs.
const announce = (sent) => {
  const byFriend = new Map();
  sent.forEach((item) => byFriend.set(item.friendId, [...(byFriend.get(item.friendId) ?? []), item]));
  byFriend.forEach((items, friendId) => {
    const total = items.reduce((sum, item) => sum + item.amount, 0);
    const what = items.length === 1 ? "a recurring payment" : `${items.length} recurring payments`;
    const notification = {
      text: `Sent ${what} of €${total.toFixed(2)} to ${items[0].friendName}`,
      hash: `friend/${friendId}`,
      friendId,
    };
    showNotification(notification);
  });
};

export const startRecurringScheduler = () => {
  void runOnce();
  window.setInterval(runOnce, CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void runOnce();
  });
};
